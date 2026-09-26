/* HVAC Field Assistant — on-device calculators (no network).
 *
 * Mirrors the server formulas in src/knowledge/{refrigerants,electrical}.ts so the Readings tab keeps working
 * on a roof with no signal. Results use the server's shape ({ kind, values, interpretation, warnings }) so the
 * UI renders them the same way, plus a `source` tag ("device" | "cache") the UI shows as a label.
 *
 * PT data lives on the server. Every successful /api/reference/pt answer is cached (last 20) and, offline,
 * a lookup is served from the cache — exact match first, else a linear interpolation between two cached
 * points of the same refrigerant that bracket the request (clearly labelled as an estimate).
 *
 * Exposed as globalThis.HVAC_CALC. Plain script, no dependencies.
 */
"use strict";

(function () {
  const SEA_LEVEL_PATM_PSIA = 14.696;
  const PT_CACHE_KEY = "hvac.ptCache";
  const CALC_CACHE_KEY = "hvac.calcCache";
  const PT_CACHE_MAX = 20;
  const CALC_CACHE_MAX = 30;
  const OPEN_OHMS = 1e6;
  const SHORT_OHMS = 0.05;
  const NEMA_DERATE_POINTS = [[0, 1], [1, 1], [2, 0.95], [3, 0.88], [4, 0.82], [5, 0.75]];

  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

  function storageGet(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode / quota */
    }
  }

  /* ---------------- atmosphere / elevation ---------------- */
  function patmPsia(elevationFt) {
    const ft = isNum(elevationFt) ? elevationFt : 0;
    if (ft <= 0) return SEA_LEVEL_PATM_PSIA;
    return round(SEA_LEVEL_PATM_PSIA * Math.pow(1 - 6.8754e-6 * ft, 5.2559), 3);
  }
  /** Field gauge reading at elevation → sea-level-basis psig for table lookup. */
  function fieldToSeaLevelPsig(psig, elevationFt) {
    return psig + (SEA_LEVEL_PATM_PSIA - patmPsia(elevationFt));
  }
  function elevationNote(elevationFt) {
    const diff = round(SEA_LEVEL_PATM_PSIA - patmPsia(elevationFt), 1);
    return `At ${Math.round(elevationFt).toLocaleString("en-US")} ft your gauge reads ~${diff} psi lower than a sea-level chart; readings were corrected before lookup.`;
  }

  /* ---------------- PT cache ---------------- */
  function ptKey(refrigerant, q) {
    const r = String(refrigerant || "").replace(/[\s-]/g, "").toUpperCase();
    const elev = isNum(q.elevationFt) && q.elevationFt > 0 ? round(q.elevationFt, 0) : 0;
    if (isNum(q.psig)) return `${r}|p|${round(q.psig, 1)}|${elev}`;
    return `${r}|t|${round(q.tempF, 1)}|${elev}`;
  }
  function ptCacheList() {
    const list = storageGet(PT_CACHE_KEY);
    return Array.isArray(list) ? list : [];
  }
  function ptCachePut(refrigerant, q, result) {
    if (!result || typeof result !== "object") return;
    const key = ptKey(refrigerant, q);
    const list = ptCacheList().filter((e) => e && e.key !== key);
    list.unshift({ key, refrigerant: result.refrigerant || refrigerant, q: { psig: q.psig, tempF: q.tempF, elevationFt: q.elevationFt }, result, at: new Date().toISOString() });
    storageSet(PT_CACHE_KEY, list.slice(0, PT_CACHE_MAX));
  }
  function ptCacheGet(refrigerant, q) {
    const key = ptKey(refrigerant, q);
    const hit = ptCacheList().find((e) => e && e.key === key);
    if (!hit) return null;
    return { ...hit.result, notes: [...(hit.result.notes || []), `Served from the on-device cache (looked up ${fmtWhen(hit.at)}).`], source: "cache", cachedAt: hit.at };
  }
  function fmtWhen(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "earlier";
    const d = new Date(t);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  /**
   * Offline estimate: interpolate between two cached pressure lookups of the same refrigerant (same elevation
   * basis) that bracket the requested pressure. Saturation curves are gently convex, so a linear estimate between
   * points a few psi apart is within a degree; the note says how far apart the anchors were.
   */
  function ptInterpolateFromCache(refrigerant, q) {
    if (!isNum(q.psig)) return null;
    const r = String(refrigerant || "").replace(/[\s-]/g, "").toUpperCase();
    const elev = isNum(q.elevationFt) && q.elevationFt > 0 ? round(q.elevationFt, 0) : 0;
    const pts = ptCacheList()
      .filter((e) => e && e.key.startsWith(`${r}|p|`) && e.key.endsWith(`|${elev}`) && e.result && isNum(e.result.psig) && isNum(e.result.dewTempF) && isNum(e.result.bubbleTempF))
      .map((e) => e.result)
      .sort((a, b) => a.psig - b.psig);
    if (pts.length < 2) return null;
    let lo = null;
    let hi = null;
    for (const p of pts) {
      if (p.psig <= q.psig) lo = p;
      if (p.psig >= q.psig && !hi) hi = p;
    }
    if (!lo || !hi || lo === hi) return null;
    const f = (q.psig - lo.psig) / (hi.psig - lo.psig);
    const lerp = (a, b) => round(a + (b - a) * f, 1);
    const bubble = lerp(lo.bubbleTempF, hi.bubbleTempF);
    const dew = lerp(lo.dewTempF, hi.dewTempF);
    const out = {
      refrigerant: lo.refrigerant || refrigerant,
      safetyClass: lo.safetyClass,
      psig: q.psig,
      bubbleTempF: bubble,
      dewTempF: dew,
      midpointTempF: round((bubble + dew) / 2, 1),
      glideF: lo.glideF,
      notes: [
        `Offline estimate: interpolated between cached lookups at ${lo.psig} and ${hi.psig} psig (${hi.psig - lo.psig} psi apart). Re-run online to confirm.`,
      ],
      source: "cache",
      estimated: true,
    };
    if (elev > 0) out.elevationFt = elev;
    return out;
  }
  /** Cache-only PT lookup (exact, else interpolated). Returns null when nothing usable is cached. */
  function ptLookupOffline(refrigerant, q) {
    return ptCacheGet(refrigerant, q) || ptInterpolateFromCache(refrigerant, q);
  }
  function ptCacheSummary() {
    const list = ptCacheList();
    const byRef = new Map();
    for (const e of list) {
      const id = (e && e.refrigerant) || "?";
      byRef.set(id, (byRef.get(id) || 0) + 1);
    }
    return { count: list.length, refrigerants: [...byRef.entries()] };
  }

  /* ---------------- generic calc result cache ---------------- */
  function calcKey(kind, inputs) {
    const entries = Object.entries(inputs || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${String(v).trim()}`);
    return `${kind}?${entries.join("&")}`;
  }
  function calcCachePut(kind, inputs, result) {
    const key = calcKey(kind, inputs);
    const list = (storageGet(CALC_CACHE_KEY) || []).filter((e) => e && e.key !== key);
    list.unshift({ key, result, at: new Date().toISOString() });
    storageSet(CALC_CACHE_KEY, list.slice(0, CALC_CACHE_MAX));
  }
  function calcCacheGet(kind, inputs) {
    const key = calcKey(kind, inputs);
    const hit = (storageGet(CALC_CACHE_KEY) || []).find((e) => e && e.key === key);
    if (!hit) return null;
    const res = hit.result && typeof hit.result === "object" ? { ...hit.result } : hit.result;
    if (res && typeof res === "object") {
      res.source = "cache";
      res.cachedAt = hit.at;
      res.notes = [...(res.notes || []), `Served from the on-device cache (computed ${fmtWhen(hit.at)}).`];
    }
    return res;
  }

  /* ---------------- superheat / subcooling ---------------- */
  /**
   * m: { refrigerant, suctionPsig?, suctionLineTempF?, liquidPsig?, liquidLineTempF?, elevationFt? }
   * satAt(psigSeaLevel) → { bubbleF, dewF } | null  (from the PT cache offline, or the server online)
   */
  function superheatSubcooling(m, satAt) {
    const notes = [];
    const out = { refrigerant: m.refrigerant, notes, source: "device" };
    const elevationFt = isNum(m.elevationFt) && m.elevationFt > 0 ? m.elevationFt : undefined;
    out.patmPsia = patmPsia(elevationFt);
    if (elevationFt !== undefined && elevationFt > 1000) notes.push(elevationNote(elevationFt));
    let missingSat = false;
    if (isNum(m.suctionPsig)) {
      const psigSL = elevationFt !== undefined ? fieldToSeaLevelPsig(m.suctionPsig, elevationFt) : m.suctionPsig;
      const t = satAt(psigSL);
      if (t && isNum(t.dewF)) {
        out.evapSatF = round(t.dewF, 1);
        if (isNum(m.suctionLineTempF)) {
          out.superheatF = round(m.suctionLineTempF - t.dewF, 1);
          if (out.superheatF < 0) notes.push("Negative superheat: check the line temperature probe placement and the gauge; liquid may be returning to the compressor.");
        }
      } else missingSat = true;
    }
    if (isNum(m.liquidPsig)) {
      const psigSL = elevationFt !== undefined ? fieldToSeaLevelPsig(m.liquidPsig, elevationFt) : m.liquidPsig;
      const t = satAt(psigSL);
      if (t && isNum(t.bubbleF)) {
        out.condSatF = round(t.bubbleF, 1);
        if (isNum(m.liquidLineTempF)) {
          out.subcoolingF = round(t.bubbleF - m.liquidLineTempF, 1);
          if (out.subcoolingF < 0) notes.push("Negative subcooling: liquid line warmer than saturation; verify the pressure is taken at the liquid line, and check for flash gas.");
        }
      } else missingSat = true;
    }
    if (missingSat) notes.push(`No cached saturation point for ${m.refrigerant} at that pressure — this needs a connection (or run a PT lookup for that pressure while online, which the app caches).`);
    notes.push("Superheat = suction line temp − dew point at suction pressure; subcooling = bubble point at liquid pressure − liquid line temp.");
    return out;
  }

  /* ---------------- electrical ---------------- */
  function result(kind, values, interpretation, warnings) {
    return { kind, values, interpretation, warnings, source: "device" };
  }
  function validator() {
    const warnings = [];
    return {
      warnings,
      check(name, value, opts = {}) {
        if (value === undefined || value === null || value === "") {
          if (opts.optional) return false;
          warnings.push(`${name} is required.`);
          return false;
        }
        if (!isNum(value)) {
          warnings.push(`${name} must be a number.`);
          return false;
        }
        if (opts.positive && value <= 0) {
          warnings.push(`${name} must be greater than 0.`);
          return false;
        }
        if (opts.nonNegative && value < 0) {
          warnings.push(`${name} cannot be negative.`);
          return false;
        }
        return true;
      },
    };
  }
  function imbalance(a, b, c) {
    const avg = (a + b + c) / 3;
    const devs = [a, b, c].map((x) => Math.abs(x - avg));
    const maxDeviation = Math.max(...devs);
    const worstLeg = devs.indexOf(maxDeviation) + 1;
    const percent = avg > 0 ? (100 * maxDeviation) / avg : 0;
    return { avg, maxDeviation, percent, worstLeg };
  }
  function nemaDerateFactor(pct) {
    if (!isNum(pct) || pct <= 0) return 1;
    const pts = NEMA_DERATE_POINTS;
    const last = pts[pts.length - 1];
    if (pct >= last[0]) return last[1];
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      if (pct <= x1) return round(y0 + ((y1 - y0) * (pct - x0)) / (x1 - x0), 3);
    }
    return last[1];
  }

  function voltageImbalance(req) {
    const v = validator();
    const ok = [v.check("vab", req.vab, { positive: true }), v.check("vbc", req.vbc, { positive: true }), v.check("vca", req.vca, { positive: true })].every(Boolean);
    if (!ok) return result("voltage_imbalance", {}, ["Enter all three line-to-line voltages (A-B, B-C, C-A), measured at the same point with the unit running."], v.warnings);
    const legs = ["A-B", "B-C", "C-A"];
    const { avg, maxDeviation, percent, worstLeg } = imbalance(req.vab, req.vbc, req.vca);
    const derate = nemaDerateFactor(percent);
    const interp = [`Average ${round(avg, 1)} V; largest deviation ${round(maxDeviation, 1)} V on ${legs[worstLeg - 1]}; voltage imbalance ${round(percent, 2)} % (NEMA MG-1: 100 × max|V − Vavg| / Vavg).`];
    if (percent <= 1) interp.push("Within the NEMA MG-1 1 % guideline — no derating needed. Look elsewhere for the fault.");
    else if (percent <= 2) interp.push(`Above 1 %: investigate the source (utility, loose or corroded lugs, uneven single-phase loads, failing contactor pole). NEMA derate factor ≈ ${derate}.`);
    else if (percent <= 5) interp.push(`Above 2 %: derate per NEMA MG-1 — factor ≈ ${derate} (≈0.95 @ 2 %, 0.88 @ 3 %, 0.82 @ 4 %, 0.75 @ 5 %). Expect current imbalance 6–10× this figure.`);
    else interp.push(`Above 5 %: NEMA MG-1 says do not operate the motor. Shut the unit down and correct the supply before it destroys the compressor (derate floor ${derate}).`);
    interp.push("Measure line-to-line at the unit terminals with the compressor running; if the imbalance drops with the unit off, the problem is in the unit's own wiring or contactor.");
    return result("voltage_imbalance", { average: round(avg, 1), maxDeviation: round(maxDeviation, 2), imbalancePercent: round(percent, 2), derateFactor: derate, worstLeg }, interp, v.warnings);
  }

  function currentImbalance(req) {
    const v = validator();
    const ok = [v.check("ia", req.ia, { nonNegative: true }), v.check("ib", req.ib, { nonNegative: true }), v.check("ic", req.ic, { nonNegative: true })].every(Boolean);
    if (!ok) return result("current_imbalance", {}, ["Enter all three leg currents (L1, L2, L3) clamped one leg at a time with the compressor running steadily."], v.warnings);
    const { avg, maxDeviation, percent, worstLeg } = imbalance(req.ia, req.ib, req.ic);
    const interp = [`Average ${round(avg, 2)} A; largest deviation ${round(maxDeviation, 2)} A on L${worstLeg}; current imbalance ${round(percent, 2)} %.`];
    if (percent <= 10) interp.push("Within the 10 % guideline. Current imbalance runs 6–10× the voltage imbalance, so check the voltage too if this is near the limit.");
    else interp.push("Above 10 %: check the voltage imbalance first (a small voltage imbalance produces a large current imbalance); then a weak contactor pole, a loose lug, or a winding fault. Swap leads at the contactor: if the high leg follows the wire it is supply-side, if it stays with the terminal it is the compressor.");
    return result("current_imbalance", { average: round(avg, 2), maxDeviation: round(maxDeviation, 2), imbalancePercent: round(percent, 2), worstLeg }, interp, v.warnings);
  }

  function capacitorUnderLoad(req) {
    const v = validator();
    const okA = v.check("amps", req.amps, { positive: true });
    const okV = v.check("volts", req.volts, { positive: true });
    const okRated = v.check("ratedUf", req.ratedUf, { positive: true, optional: true });
    const interp = [
      "Formula: µF = 2652 × A / V — amps clamped on the capacitor lead to the START/HERM terminal (or FAN for the fan section), volts across the same capacitor terminals, unit running.",
      "Invalid if the clamp is on the compressor COMMON lead or the line lead — that current includes the run winding and reads far too high.",
    ];
    if (!okA || !okV) return result("capacitor_under_load", {}, interp, v.warnings);
    const uf = (2652 * req.amps) / req.volts;
    const values = { microfarads: round(uf, 1) };
    if (okRated && isNum(req.ratedUf)) {
      const pct = (100 * uf) / req.ratedUf;
      const dev = pct - 100;
      values.percentOfRated = round(pct, 1);
      values.deviationPercent = round(dev, 1);
      values.pass = Math.abs(dev) <= 6 ? 1 : 0;
      if (Math.abs(dev) <= 6) interp.push(`Measured ${round(uf, 1)} µF is ${round(pct, 1)} % of the ${req.ratedUf} µF rating (${dev >= 0 ? "+" : ""}${round(dev, 1)} %) — PASS within ±6 %. Use the tolerance printed on the can if it differs.`);
      else if (dev < 0) interp.push(`Measured ${round(uf, 1)} µF is ${round(pct, 1)} % of the ${req.ratedUf} µF rating (${round(dev, 1)} %) — FAIL, more than 6 % low. Replace with the same µF and equal-or-higher voltage rating.`);
      else interp.push(`Measured ${round(uf, 1)} µF is ${round(pct, 1)} % of the ${req.ratedUf} µF rating (+${round(dev, 1)} %) — reads high. Re-check that the clamp is on the capacitor lead only and volts were read across the capacitor terminals.`);
    } else {
      interp.push(`Measured ${round(uf, 1)} µF under load. Compare against the µF printed on the can (±6 % or the printed tolerance).`);
    }
    interp.push("Also inspect: bulged top, oil leakage, corroded terminals — replace on sight. Discharge through a bleed resistor before touching terminals.");
    return result("capacitor_under_load", values, interp, v.warnings);
  }

  function tempRiseCfm(req) {
    const v = validator();
    const ok = [v.check("inputBtuh", req.inputBtuh, { positive: true }), v.check("efficiencyPercent", req.efficiencyPercent, { positive: true }), v.check("riseF", req.riseF, { positive: true })].every(Boolean);
    if (!ok) return result("temp_rise_cfm", {}, ["Enter heater input BTU/h (gas: nameplate input; electric: kW × 3412), efficiency % (electric heat = 100), and the measured supply − return temperature rise."], v.warnings);
    if (req.efficiencyPercent > 100) v.warnings.push("efficiencyPercent above 100 was used as given; electric heat is 100 %, gas heat typically 80–81 %.");
    const output = req.inputBtuh * (req.efficiencyPercent / 100);
    const cfm = output / (1.08 * req.riseF);
    const interp = [
      `Output ${Math.round(output).toLocaleString("en-US")} BTU/h = input × ${req.efficiencyPercent} %. CFM = output / (1.08 × ΔT) = ${Math.round(cfm).toLocaleString("en-US")} CFM at ${req.riseF} °F rise.`,
      "The 1.08 factor is for standard air at sea level; at high elevation multiply by the local density ratio. For electric heat measure kW from volts × amps (× √3 for 3-phase).",
      "Compare the rise with the nameplate range: above the range = low airflow (filters, coil, belt, static, blower speed); below = high airflow or under-firing.",
    ];
    return result("temp_rise_cfm", { outputBtuh: Math.round(output), cfm: Math.round(cfm) }, interp, v.warnings);
  }

  function windingCheck(req) {
    const v = validator();
    const ok = [v.check("r1", req.r1, { nonNegative: true }), v.check("r2", req.r2, { nonNegative: true }), v.check("r3", req.r3, { nonNegative: true })].every(Boolean);
    const phase = req.phase === 3 ? 3 : 1;
    if (req.phase !== 1 && req.phase !== 3) v.warnings.push(`phase must be 1 or 3; assumed single-phase.`);
    const interp = [];
    if (!ok) {
      interp.push("Single-phase: enter C-S, C-R and S-R ohms. Three-phase: enter T1-T2, T2-T3 and T3-T1 ohms. Power off, leads disconnected at the compressor terminals, low-ohms meter.");
      return result("winding_check", {}, interp, v.warnings);
    }
    const r = [req.r1, req.r2, req.r3];
    const opens = r.map((x) => x >= OPEN_OHMS);
    const shorts = r.map((x) => x <= SHORT_OHMS);
    const values = { r1: req.r1, r2: req.r2, r3: req.r3, openCount: opens.filter(Boolean).length, shortCount: shorts.filter(Boolean).length };
    let pass = 1;
    if (phase === 3) {
      const legs = ["T1-T2", "T2-T3", "T3-T1"];
      const avg = (req.r1 + req.r2 + req.r3) / 3;
      const maxDev = Math.max(...r.map((x) => Math.abs(x - avg)));
      const pct = avg > 0 ? (100 * maxDev) / avg : 0;
      values.average = round(avg, 3);
      values.deviationPercent = round(pct, 1);
      for (let i = 0; i < 3; i++) {
        if (opens[i]) {
          pass = 0;
          interp.push(`${legs[i]} reads open (${r[i]} Ω): open winding or open internal overload. If all three read open on a hot compressor, let it cool 1–2 h and re-test before condemning.`);
        } else if (shorts[i]) {
          pass = 0;
          interp.push(`${legs[i]} reads ≈ 0 Ω (${r[i]} Ω): shorted turns or a shorted terminal — confirm with a good meter and clean terminals, then condemn.`);
        }
      }
      if (pass) {
        if (pct <= 5) interp.push(`Three-phase legs within ±5 % (max deviation ${round(pct, 1)} % of the ${round(avg, 3)} Ω average) — windings balanced; PASS. Follow with a megohm test to ground.`);
        else {
          pass = 0;
          interp.push(`Legs differ by ${round(pct, 1)} % (> 5 %): shorted turns in one winding or a poor terminal connection. Clean the terminals, re-measure with a low-ohms meter, then condemn if it persists.`);
        }
      }
    } else {
      const [cs, cr, sr] = r;
      if (opens[0] && opens[1] && !opens[2]) {
        pass = 0;
        interp.push("C-S and C-R open with S-R intact = the internal overload is open (common pin). Cool the compressor 1–2 hours and re-test before condemning; if it never closes, replace.");
      } else {
        const labels = ["C-S", "C-R", "S-R"];
        for (let i = 0; i < 3; i++) {
          if (opens[i]) {
            pass = 0;
            interp.push(`${labels[i]} reads open (${r[i]} Ω): an open winding path or a burned terminal. Confirm at the compressor pins with the leads removed.`);
          } else if (shorts[i]) {
            pass = 0;
            interp.push(`${labels[i]} reads ≈ 0 Ω (${r[i]} Ω): shorted winding — condemn after confirming with clean pins and a good meter.`);
          }
        }
      }
      if (pass) {
        const sum = cs + cr;
        const err = sr > 0 ? (100 * Math.abs(sum - sr)) / sr : 100;
        values.csPlusCr = round(sum, 3);
        values.sumErrorPercent = round(err, 1);
        if (err <= 10) interp.push(`C-S (${cs} Ω) + C-R (${cr} Ω) = ${round(sum, 3)} Ω vs S-R ${sr} Ω (${round(err, 1)} % off) — consistent single-phase windings; PASS. C-R should be the lowest and C-S the highest reading.`);
        else {
          pass = 0;
          interp.push(`C-S + C-R = ${round(sum, 3)} Ω does not match S-R ${sr} Ω (${round(err, 1)} % off, > 10 %): re-check pin identification and meter zero; a persistent mismatch points to shorted turns.`);
        }
        if (!(cr <= cs)) interp.push("C-R reads higher than C-S: the pins may be mislabelled (run winding is normally the lowest resistance). Verify with the terminal layout diagram.");
      }
    }
    values.pass = pass;
    interp.push("Also megohm each terminal to ground at 500 VDC: > 100 MΩ good, < 20 MΩ investigate, < 1 MΩ condemn. Never megger in a vacuum.");
    return result("winding_check", values, interp, v.warnings);
  }

  /** Dispatch matching POST /api/calc/electrical for the kinds available on-device; null when not supported offline. */
  function electrical(req) {
    switch (req && req.kind) {
      case "voltage_imbalance":
        return voltageImbalance(req);
      case "current_imbalance":
        return currentImbalance(req);
      case "capacitor_under_load":
        return capacitorUnderLoad(req);
      case "temp_rise_cfm":
        return tempRiseCfm(req);
      case "winding_check":
        return windingCheck(req);
      default:
        return null;
    }
  }

  globalThis.HVAC_CALC = {
    patmPsia, fieldToSeaLevelPsig, elevationNote,
    ptCachePut, ptCacheGet, ptInterpolateFromCache, ptLookupOffline, ptCacheSummary,
    calcCachePut, calcCacheGet,
    superheatSubcooling, voltageImbalance, currentImbalance, capacitorUnderLoad, tempRiseCfm, windingCheck, electrical,
    nemaDerateFactor,
  };
})();
