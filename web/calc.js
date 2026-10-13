/* HVAC Field Assistant — on-device calculators (no network).
 *
 * Mirrors the server formulas in src/knowledge/{refrigerants,electrical,chiller}.ts so the Readings tab keeps working
 * on a roof with no signal (the wave-2 field calculators — leak rate, gas meter clock, CO air-free, sensible CFM, static,
 * fan laws, belt drive, voltage drop, NEC motor FLA, capacitor and motor replacement — are mirrored line for line;
 * parity with the server is asserted in web/app.test.ts). Results use the server's shape ({ kind, values, interpretation, warnings }) so the
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

  /* ---------------- wave 2 calculators (mirror src/knowledge/electrical.ts; formulas as the interpretation states) ---------------- */
  const LEAK_RATE_FORMULA = "leak rate % = (lb added ÷ full charge lb) × (365 ÷ days since last add) × 100";
  const LEAK_RATE_THRESHOLDS = { comfort_cooling: 10, commercial_refrigeration: 20, industrial_process: 30, other: 10 };
  const HFC_APPLICABILITY_LBS = 15;
  const LEAK_RATE_MAX_DAYS = 365;
  const r2 = (n) => Math.round(n * 100) / 100;
  function thresholdFor(applianceType) {
    return applianceType && Object.prototype.hasOwnProperty.call(LEAK_RATE_THRESHOLDS, applianceType) ? LEAK_RATE_THRESHOLDS[applianceType] : LEAK_RATE_THRESHOLDS.other;
  }
  function leakRuleApplies(fullChargeLbs) {
    return isNum(fullChargeLbs) && fullChargeLbs >= HFC_APPLICABILITY_LBS;
  }
  /**
   * EPA annualizing method: (added ÷ full charge) × (365 ÷ days) × 100, with days clamped to 1…365
   * (days = min(365, max(1, days)): an add more than a year after the previous one is annualized over one year).
   */
  function annualizedLeakRate({ addedLbs, fullChargeLbs, daysSinceLastAdd }) {
    if (!(isNum(addedLbs) && addedLbs > 0)) return { ratePct: null, days: null, formula: LEAK_RATE_FORMULA, reason: "amount added must be a positive number of pounds" };
    if (!(isNum(fullChargeLbs) && fullChargeLbs > 0)) return { ratePct: null, days: null, formula: LEAK_RATE_FORMULA, reason: "full charge of the appliance is not recorded (set full_charge_lbs on the unit)" };
    if (!isNum(daysSinceLastAdd)) return { ratePct: null, days: null, formula: LEAK_RATE_FORMULA, reason: "days since the last add are unknown (no previous add and no installation date on record)" };
    const days = Math.min(LEAK_RATE_MAX_DAYS, Math.max(1, daysSinceLastAdd));
    return { ratePct: r2((addedLbs / fullChargeLbs) * (365 / days) * 100), days, formula: LEAK_RATE_FORMULA };
  }

  function leakRate(req) {
    const v = validator();
    const ok = [v.check("addedLbs", req.addedLbs, { positive: true }), v.check("fullChargeLbs", req.fullChargeLbs, { positive: true }), v.check("daysSinceLastAdd", req.daysSinceLastAdd, { nonNegative: true })].every(Boolean);
    if (!ok) return result("leak_rate", {}, [`Enter pounds added, the appliance full charge (lb) and days since the previous add. ${LEAK_RATE_FORMULA}.`], v.warnings);
    const threshold = thresholdFor(req.applianceType);
    const lr = annualizedLeakRate({ addedLbs: req.addedLbs, fullChargeLbs: req.fullChargeLbs, daysSinceLastAdd: req.daysSinceLastAdd });
    const rate = lr.ratePct;
    const exceeded = rate > threshold;
    const values = { leakRatePct: rate, thresholdPct: threshold, exceeded: exceeded ? 1 : 0, daysUsed: lr.days, applies: leakRuleApplies(req.fullChargeLbs) ? 1 : 0 };
    const interp = [
      `Leak rate = (${req.addedLbs} ÷ ${req.fullChargeLbs}) × (365 ÷ ${lr.days}) × 100 = ${rate} % per year (EPA annualizing method; days below 1 count as 1, above 365 as 365).`,
      exceeded
        ? `EXCEEDS the ${threshold} % threshold for ${req.applianceType || "comfort cooling (default)"} (40 CFR 84.106): repair within 30 days of this add (120 if a shutdown is needed), initial verification test before adding refrigerant again, follow-up verification within 10 days, and keep the records 3 years.`
        : `Below the ${threshold} % threshold for ${req.applianceType || "comfort cooling (default)"} (40 CFR 84.106). Log the add anyway: the next add is annualized from this date.`,
      leakRuleApplies(req.fullChargeLbs)
        ? "The HFC leak-repair rule applies from 15 lb full charge (ODS such as R-22: from 50 lb under 40 CFR 82.157)."
        : `Full charge ${req.fullChargeLbs} lb is below the 15 lb HFC applicability (50 lb for ODS); the rate is informational.`,
    ];
    return result("leak_rate", values, interp, v.warnings);
  }

  function gasMeterClock(req) {
    const v = validator();
    const ok = [v.check("dialCuft", req.dialCuft, { positive: true }), v.check("secondsPerRev", req.secondsPerRev, { positive: true })].every(Boolean);
    v.check("heatingValueBtuPerCuft", req.heatingValueBtuPerCuft, { positive: true, optional: true });
    v.check("revolutions", req.revolutions, { positive: true, optional: true });
    v.check("nameplateInputBtuh", req.nameplateInputBtuh, { positive: true, optional: true });
    if (!ok) return result("gas_meter_clock", {}, ["Enter the test dial size (ft³ per revolution: 1/2, 1, 2, 5), the seconds for one (or more) revolutions with only this appliance firing at high fire, and the gas heating value (default 1000 BTU/ft³)."], v.warnings);
    const hv = isNum(req.heatingValueBtuPerCuft) && req.heatingValueBtuPerCuft > 0 ? req.heatingValueBtuPerCuft : 1000;
    const revs = isNum(req.revolutions) && req.revolutions > 0 ? req.revolutions : 1;
    const cfh = (3600 * req.dialCuft * revs) / req.secondsPerRev;
    const btuh = cfh * hv;
    const values = { cfh: round(cfh, 2), btuh: Math.round(btuh), heatingValueBtuPerCuft: hv };
    const interp = [`CFH = 3600 × ${req.dialCuft} ft³ × ${revs} rev ÷ ${req.secondsPerRev} s = ${round(cfh, 2)} ft³/h; input = CFH × ${hv} BTU/ft³ = ${Math.round(btuh).toLocaleString("en-US")} BTU/h.`];
    if (isNum(req.nameplateInputBtuh) && req.nameplateInputBtuh > 0) {
      const pct = (100 * btuh) / req.nameplateInputBtuh;
      values.percentOfNameplate = round(pct, 1);
      values.pass = Math.abs(pct - 100) <= 5 ? 1 : 0;
      if (Math.abs(pct - 100) <= 5) interp.push(`${round(pct, 1)} % of the ${req.nameplateInputBtuh.toLocaleString("en-US")} BTU/h nameplate input — within ±5 %, firing rate correct.`);
      else if (pct < 95) interp.push(`${round(pct, 1)} % of nameplate — UNDER-FIRED: low manifold pressure, undersized orifices/gas line, low inlet pressure, or derated for altitude (check the rating plate for a high-altitude derate before adjusting).`);
      else interp.push(`${round(pct, 1)} % of nameplate — OVER-FIRED: manifold pressure too high or wrong orifices (LP vs natural); over-firing cracks heat exchangers. Reduce manifold pressure to the rating plate value and re-clock.`);
    }
    interp.push("Clock with every other gas appliance off, the unit at steady high fire; ask the utility for the local heating value (typically 1000–1050 BTU/ft³) and use the meter's pressure correction if it reads at elevated pressure.");
    return result("gas_meter_clock", values, interp, v.warnings);
  }

  function combustionCo(req) {
    const v = validator();
    const ok = [v.check("coPpm", req.coPpm, { nonNegative: true }), v.check("o2Pct", req.o2Pct, { nonNegative: true })].every(Boolean);
    v.check("ambientCoPpm", req.ambientCoPpm, { nonNegative: true, optional: true });
    if (!ok) return result("combustion_co", {}, ["Enter the flue CO (ppm, as measured) and flue O2 (%) from the analyzer at steady state; ambient CO (ppm) in the space is optional."], v.warnings);
    const values = {};
    const interp = [];
    if (req.o2Pct >= 20.9) {
      v.warnings.push("O2 at or above 20.9 % means no combustion products are reaching the probe (or the probe is in room air): air-free CO cannot be computed.");
    } else {
      const af = (req.coPpm * 20.9) / (20.9 - req.o2Pct);
      values.coAirFreePpm = Math.round(af);
      values.excessAirPct = round((req.o2Pct / (20.9 - req.o2Pct)) * 100, 1);
      interp.push(`CO air-free = ${req.coPpm} × 20.9 ÷ (20.9 − ${req.o2Pct}) = ${Math.round(af)} ppm (excess air ≈ ${round((req.o2Pct / (20.9 - req.o2Pct)) * 100, 0)} %).`);
      if (af >= 400) {
        values.flag = 2;
        interp.push("≥ 400 ppm air-free: at or above the ANSI Z21.47 / CSA 2.3 ceiling for a gas furnace — take the appliance out of service until the cause is fixed (over-firing, flame impingement, cracked or restricted heat exchanger, poor combustion air, misaligned burners).");
      } else if (af >= 100) {
        values.flag = 1;
        interp.push("100–399 ppm air-free: above the NCI 100 ppm action level — find and fix the cause (burner alignment, gas pressure, heat exchanger, combustion air) before leaving; re-test after the repair. Rising CO as the unit warms up points to a heat-exchanger crack.");
      } else {
        values.flag = 0;
        interp.push("< 100 ppm air-free: acceptable combustion (good burners run well under 50 ppm). Record it as the baseline for the next visit.");
      }
    }
    if (isNum(req.ambientCoPpm)) {
      values.ambientCoPpm = req.ambientCoPpm;
      if (req.ambientCoPpm > 20) {
        values.stopWork = 1;
        interp.push(`Ambient CO ${req.ambientCoPpm} ppm > 20 ppm: STOP WORK, ventilate, shut the appliance down and get people out until the source is found; ambient should be 0–9 ppm.`);
      } else if (req.ambientCoPpm > 9) {
        values.stopWork = 0;
        interp.push(`Ambient CO ${req.ambientCoPpm} ppm (above the 9 ppm ASHRAE comfort guideline): find the source (venting, spillage, flue leak) before leaving.`);
      } else {
        values.stopWork = 0;
        interp.push(`Ambient CO ${req.ambientCoPpm} ppm: normal.`);
      }
    }
    interp.push("Measure in the flue upstream of any draft hood/dilution at steady state (5–10 min); air-free normalizes CO to undiluted flue gas so readings compare across appliances and excess-air settings.");
    return result("combustion_co", values, interp, v.warnings);
  }

  function sensibleCfm(req) {
    const v = validator();
    const ok = [v.check("btuh", req.btuh, { positive: true }), v.check("deltaTF", req.deltaTF, { positive: true })].every(Boolean);
    v.check("tons", req.tons, { positive: true, optional: true });
    if (!ok) return result("sensible_cfm", {}, ["Enter the sensible BTU/h (heat output, or electric heat kW × 3412) and the measured temperature change (°F) across the coil or heater."], v.warnings);
    const cfm = req.btuh / (1.08 * req.deltaTF);
    const values = { cfm: Math.round(cfm) };
    const interp = [`CFM = BTU/h ÷ (1.08 × ΔT) = ${req.btuh.toLocaleString("en-US")} ÷ (1.08 × ${req.deltaTF}) = ${Math.round(cfm).toLocaleString("en-US")} CFM (1.08 = 0.075 lb/ft³ × 0.24 BTU/lb·°F × 60 min, standard air at sea level).`];
    if (isNum(req.tons) && req.tons > 0) {
      const perTon = cfm / req.tons;
      values.cfmPerTon = Math.round(perTon);
      if (perTon < 350) interp.push(`${Math.round(perTon)} CFM/ton — below the 350–450 CFM/ton design band: low airflow (filters, coil, blower speed, static). Expect low suction and a frosting coil.`);
      else if (perTon > 450) interp.push(`${Math.round(perTon)} CFM/ton — above the 350–450 CFM/ton band: high airflow (less latent removal, high suction); fine for dry climates or sensible-only loads.`);
      else interp.push(`${Math.round(perTon)} CFM/ton — within the 350–450 CFM/ton design band (400 nominal).`);
    }
    interp.push("Use sensible heat only (electric heat is the cleanest source: kW × 3412 at 100 %); for a cooling coil the ΔT must be dry-bulb with the latent part excluded, so prefer the heat-rise method. At altitude multiply 1.08 by the air-density ratio.");
    return result("sensible_cfm", values, interp, v.warnings);
  }

  function staticPressure(req) {
    const v = validator();
    const ok = [v.check("supplyInWc", req.supplyInWc), v.check("returnInWc", req.returnInWc)].every(Boolean);
    v.check("ratedMaxInWc", req.ratedMaxInWc, { positive: true, optional: true });
    if (!ok) return result("static_pressure", {}, ["Enter supply static (after the coil/heat exchanger) and return static (before the filter) in inches w.c.; the return is normally a negative number and the magnitude is used."], v.warnings);
    const blower = req.blowerType === "ecm" ? "ecm" : "psc";
    const rated = isNum(req.ratedMaxInWc) && req.ratedMaxInWc > 0 ? req.ratedMaxInWc : blower === "ecm" ? 0.8 : 0.5;
    const tesp = Math.abs(req.supplyInWc) + Math.abs(req.returnInWc);
    const pct = (100 * tesp) / rated;
    const values = { tespInWc: round(tesp, 2), ratedMaxInWc: rated, percentOfRated: round(pct, 0), overMax: tesp > rated ? 1 : 0 };
    const interp = [`TESP = |supply ${req.supplyInWc}| + |return ${req.returnInWc}| = ${round(tesp, 2)} in. wc, ${round(pct, 0)} % of the ${rated} in. wc rating (${isNum(req.ratedMaxInWc) && req.ratedMaxInWc > 0 ? "nameplate" : blower === "ecm" ? "ECM default 0.8" : "PSC default 0.5"}).`];
    if (tesp > rated) interp.push("OVER the rated maximum: airflow is below design — filters loaded, dirty coil, undersized or restricted duct, closed dampers, wrong blower speed/sheave. An ECM will ramp up and draw more watts; a PSC simply moves less air.");
    else if (pct >= 80) interp.push("Within rating but high: check filter condition and coil cleanliness before it climbs over the maximum.");
    else interp.push("Within rating. If airflow is still low, look at the blower (belt, speed tap, wheel) rather than the duct.");
    interp.push("Split the total: return side over ~0.3 in. wc = filter/return duct restriction; supply side over ~0.3 in. wc = coil or supply duct. Measure with the blower on high and the filters in; the nameplate maximum is at the rated airflow.");
    return result("static_pressure", values, interp, v.warnings);
  }

  function fanLaws(req) {
    const v = validator();
    const ok = [v.check("rpm1", req.rpm1, { positive: true }), v.check("rpm2", req.rpm2, { positive: true })].every(Boolean);
    v.check("cfm1", req.cfm1, { nonNegative: true, optional: true });
    v.check("sp1", req.sp1, { nonNegative: true, optional: true });
    v.check("bhp1", req.bhp1, { nonNegative: true, optional: true });
    if (!ok) return result("fan_laws", {}, ["Enter the current and the new fan RPM plus any of the current CFM, static pressure and brake horsepower to scale."], v.warnings);
    const ratio = req.rpm2 / req.rpm1;
    const values = { speedRatio: round(ratio, 4) };
    const interp = [`Speed ratio ${req.rpm2} ÷ ${req.rpm1} = ${round(ratio, 3)}: CFM scales with the ratio, static pressure with the ratio², power with the ratio³ (fan affinity laws).`];
    if (isNum(req.cfm1)) {
      values.cfm2 = Math.round(req.cfm1 * ratio);
      interp.push(`CFM2 = ${req.cfm1} × ${round(ratio, 3)} = ${Math.round(req.cfm1 * ratio)} CFM.`);
    }
    if (isNum(req.sp1)) {
      values.sp2 = round(req.sp1 * ratio * ratio, 3);
      interp.push(`SP2 = ${req.sp1} × ${round(ratio, 3)}² = ${round(req.sp1 * ratio * ratio, 3)} in. wc.`);
    }
    if (isNum(req.bhp1)) {
      values.bhp2 = round(req.bhp1 * ratio ** 3, 3);
      interp.push(`BHP2 = ${req.bhp1} × ${round(ratio, 3)}³ = ${round(req.bhp1 * ratio ** 3, 3)} hp${req.bhp1 * ratio ** 3 > req.bhp1 ? " — check the motor nameplate HP / service factor and amps before speeding up" : ""}.`);
    }
    interp.push("Valid for the same fan and duct system (speed change only). A 10 % speed increase costs ~33 % more power; confirm motor HP, amps, sheave range and the belt before changing sheaves.");
    return result("fan_laws", values, interp, v.warnings);
  }

  function beltDrive(req) {
    const v = validator();
    const ok = [v.check("motorRpm", req.motorRpm, { positive: true }), v.check("motorSheaveIn", req.motorSheaveIn, { positive: true }), v.check("fanSheaveIn", req.fanSheaveIn, { positive: true })].every(Boolean);
    v.check("centerDistanceIn", req.centerDistanceIn, { positive: true, optional: true });
    if (!ok) return result("belt_drive", {}, ["Enter motor RPM, motor (driver) sheave pitch diameter and fan (driven) sheave pitch diameter in inches; the shaft center distance adds belt length and deflection."], v.warnings);
    const fanRpm = (req.motorRpm * req.motorSheaveIn) / req.fanSheaveIn;
    const values = { fanRpm: Math.round(fanRpm), ratio: round(req.motorSheaveIn / req.fanSheaveIn, 4) };
    const interp = [`Fan RPM = motor RPM × motor sheave ÷ fan sheave = ${req.motorRpm} × ${req.motorSheaveIn} ÷ ${req.fanSheaveIn} = ${Math.round(fanRpm)} RPM (pitch diameters; ratio ${round(req.motorSheaveIn / req.fanSheaveIn, 3)}).`];
    if (isNum(req.centerDistanceIn) && req.centerDistanceIn > 0) {
      const C = req.centerDistanceIn;
      const D = Math.max(req.motorSheaveIn, req.fanSheaveIn);
      const d = Math.min(req.motorSheaveIn, req.fanSheaveIn);
      const L = 2 * C + 1.57 * (D + d) + (D - d) ** 2 / (4 * C);
      const spanSq = C * C - ((D - d) / 2) ** 2;
      const span = spanSq > 0 ? Math.sqrt(spanSq) : C;
      const deflection = span / 64;
      values.beltLengthIn = round(L, 2);
      values.spanIn = round(span, 2);
      values.deflectionIn = round(deflection, 3);
      interp.push(`Belt length L = 2C + 1.57(D + d) + (D − d)² ÷ (4C) = 2×${C} + 1.57×(${D} + ${d}) + (${D} − ${d})² ÷ (4×${C}) = ${round(L, 2)} in. (pitch length; pick the nearest standard belt and take up the difference with the motor base).`);
      interp.push(`Tension check: span ≈ ${round(span, 2)} in. → deflection target = span ÷ 64 = ${round(deflection, 3)} in. (1/64 in. per inch of span) at the belt maker's deflection force; re-tension new belts after the first 24 h run-in.`);
    } else {
      interp.push("Add the center distance for the belt length (L = 2C + 1.57(D + d) + (D − d)²/4C) and the deflection target (span ÷ 64).");
    }
    interp.push("Align sheaves with a straightedge (≤ 1/16 in. offset), check sheave grooves with a gauge (worn grooves eat belts), and never pry a belt on. Motor amps at the new fan RPM must stay within nameplate FLA × SF.");
    return result("belt_drive", values, interp, v.warnings);
  }

  /** NEC Chapter 9 Table 8 conductor areas (circular mils). */
  const AWG_CMIL = { "14": 4110, "12": 6530, "10": 10380, "8": 16510, "6": 26240, "4": 41740, "3": 52620, "2": 66360, "1": 83690, "1/0": 105600, "2/0": 133100, "3/0": 167800, "4/0": 211600, "250": 250000, "300": 300000, "350": 350000, "400": 400000, "500": 500000 };
  function normalizeAwg(raw) {
    if (typeof raw !== "string") return undefined;
    let s = raw.trim().toUpperCase().replace(/\s+/g, "").replace(/^#/, "").replace(/AWG$/, "").replace(/(KCMIL|MCM)$/, "").replace(/-/g, "/");
    const aughts = { "0": "1/0", "00": "2/0", "000": "3/0", "0000": "4/0" };
    if (aughts[s]) s = aughts[s];
    return AWG_CMIL[s] !== undefined ? s : undefined;
  }

  function voltageDrop(req) {
    const v = validator();
    const ok = [v.check("volts", req.volts, { positive: true }), v.check("amps", req.amps, { positive: true }), v.check("oneWayFt", req.oneWayFt, { positive: true })].every(Boolean);
    let cm = isNum(req.circularMils) && req.circularMils > 0 ? req.circularMils : undefined;
    const awgKey = normalizeAwg(req.awg);
    if (cm === undefined && awgKey) cm = AWG_CMIL[awgKey];
    if (cm === undefined) v.warnings.push(req.awg ? `Unknown conductor size "${req.awg}" (use 14…4/0 AWG or 250…500 kcmil), or give circular_mils.` : "Conductor size required: awg (14…4/0, 250…500 kcmil) or circular_mils.");
    if (!ok || cm === undefined) return result("voltage_drop", {}, ["Enter system volts, load amps, one-way run length in feet, and the conductor size (AWG/kcmil or circular mils); material cu (default) or al; phase 1 (default) or 3."], v.warnings);
    const material = req.material === "al" ? "al" : "cu";
    const K = material === "al" ? 21.2 : 12.9;
    const phase = req.phase === 3 ? 3 : 1;
    const factor = phase === 3 ? 1.732 : 2;
    const vd = (factor * K * req.amps * req.oneWayFt) / cm;
    const pct = (100 * vd) / req.volts;
    const values = { voltageDrop: round(vd, 2), voltageDropPct: round(pct, 2), circularMils: cm, k: K, voltsAtLoad: round(req.volts - vd, 1), flag: pct > 5 ? 2 : pct > 3 ? 1 : 0 };
    const interp = [
      `VD = ${factor} × K × I × L ÷ CM = ${factor} × ${K} × ${req.amps} A × ${req.oneWayFt} ft ÷ ${cm.toLocaleString("en-US")} cmil = ${round(vd, 2)} V = ${round(pct, 2)} % of ${req.volts} V (K = ${K} Ω·cmil/ft for ${material === "al" ? "aluminum" : "copper"} at 75 °C; ${phase === 3 ? "1.732 for three-phase" : "2 for the round trip, single-phase"}; ${awgKey ? `${awgKey} ${cm >= 250000 ? "kcmil" : "AWG"}` : "given cmil"}).`,
    ];
    if (pct > 5) interp.push("Above 5 %: exceeds the NEC-recommended total (feeder + branch) drop — motors run hot and start poorly; upsize the conductor or shorten the run.");
    else if (pct > 3) interp.push("Above 3 %: exceeds the NEC-recommended branch-circuit drop (informational notes to 210.19 / 215.2); acceptable only if the feeder is short so the total stays ≤ 5 %.");
    else interp.push("Within the 3 % branch-circuit recommendation.");
    interp.push("Use running amps (or MCA for sizing); measure volts at the unit under load to confirm. Low voltage at the compressor raises amps roughly in proportion and shortens contactor and motor life.");
    return result("voltage_drop", values, interp, v.warnings);
  }

  /** NEC Table 430.248 (1-ph) and 430.250 (3-ph) full-load currents. */
  const NEC_FLA_1PH = {
    "0.167": { 115: 4.4, 230: 2.2 }, "0.25": { 115: 5.8, 230: 2.9 }, "0.333": { 115: 7.2, 230: 3.6 }, "0.5": { 115: 9.8, 230: 4.9 }, "0.75": { 115: 13.8, 230: 6.9 }, "1": { 115: 16, 230: 8 },
    "1.5": { 115: 20, 230: 10 }, "2": { 115: 24, 230: 12 }, "3": { 115: 34, 230: 17 }, "5": { 115: 56, 230: 28 }, "7.5": { 115: 80, 230: 40 }, "10": { 115: 100, 230: 50 },
  };
  const NEC_FLA_3PH = {
    "0.5": { 208: 2.4, 230: 2.2, 460: 1.1, 575: 0.9 }, "0.75": { 208: 3.5, 230: 3.2, 460: 1.6, 575: 1.3 }, "1": { 208: 4.6, 230: 4.2, 460: 2.1, 575: 1.7 }, "1.5": { 208: 6.6, 230: 6.0, 460: 3.0, 575: 2.4 },
    "2": { 208: 7.5, 230: 6.8, 460: 3.4, 575: 2.7 }, "3": { 208: 10.6, 230: 9.6, 460: 4.8, 575: 3.9 }, "5": { 208: 16.7, 230: 15.2, 460: 7.6, 575: 6.1 }, "7.5": { 208: 24.2, 230: 22, 460: 11, 575: 9 },
    "10": { 208: 30.8, 230: 28, 460: 14, 575: 11 }, "15": { 208: 46.2, 230: 42, 460: 21, 575: 17 }, "20": { 208: 59.4, 230: 54, 460: 27, 575: 22 }, "25": { 208: 74.8, 230: 68, 460: 34, 575: 27 },
    "30": { 208: 88, 230: 80, 460: 40, 575: 32 }, "40": { 208: 114, 230: 104, 460: 52, 575: 41 }, "50": { 208: 143, 230: 130, 460: 65, 575: 52 }, "60": { 208: 169, 230: 154, 460: 77, 575: 62 },
    "75": { 208: 211, 230: 192, 460: 96, 575: 77 }, "100": { 208: 273, 230: 248, 460: 124, 575: 99 }, "125": { 208: 343, 230: 312, 460: 156, 575: 125 }, "150": { 208: 396, 230: 360, 460: 180, 575: 144 },
    "200": { 208: 528, 230: 480, 460: 240, 575: 192 },
  };
  function nearestKey(keys, target) {
    const sorted = keys.map((k) => ({ k, n: Number(k) })).sort((a, b) => a.n - b.n);
    for (const { k, n } of sorted) {
      if (Math.abs(n - target) < 0.02) return { key: k, exact: true };
      if (n > target) return { key: k, exact: false };
    }
    return undefined;
  }

  function motorFla(req) {
    const v = validator();
    const ok = [v.check("hp", req.hp, { positive: true }), v.check("volts", req.volts, { positive: true })].every(Boolean);
    const phase = req.phase === 3 ? 3 : req.phase === 1 ? 1 : undefined;
    if (phase === undefined) v.warnings.push(`phase must be 1 or 3 (got ${String(req.phase)}).`);
    if (!ok || phase === undefined) return result("motor_fla", {}, ["Enter motor HP, nameplate volts and phase; returns the NEC Table 430.248 (1-ph 115/230 V) or 430.250 (3-ph 208/230/460/575 V) full-load current and the 125 % conductor ampacity."], v.warnings);
    const table = phase === 3 ? NEC_FLA_3PH : NEC_FLA_1PH;
    const columns = phase === 3 ? [208, 230, 460, 575] : [115, 230];
    const col = columns.reduce((best, c) => (Math.abs(c - req.volts) < Math.abs(best - req.volts) ? c : best), columns[0]);
    const hpPick = nearestKey(Object.keys(table), req.hp);
    if (!hpPick) {
      v.warnings.push(`${req.hp} HP is above the ${phase === 3 ? "200 HP" : "10 HP"} end of the table on file.`);
      return result("motor_fla", {}, [`No table entry for ${req.hp} HP ${phase}-phase; use NEC Table 430.${phase === 3 ? "250" : "248"} directly.`], v.warnings);
    }
    const fla = table[hpPick.key][col];
    const values = { tableFla: fla, tableVolts: col, tableHp: Number(hpPick.key), conductorAmps125: round(fla * 1.25, 1), overloadMax125: round(fla * 1.25, 1) };
    const interp = [
      `NEC Table 430.${phase === 3 ? "250" : "248"}: ${hpPick.key} HP, ${phase}-phase, ${col} V column → ${fla} A full-load current${hpPick.exact ? "" : ` (next size up from ${req.hp} HP)`}${Math.abs(col - req.volts) > 12 ? ` (nearest column to ${req.volts} V)` : ""}.`,
      `Conductor minimum ampacity = 125 % × ${fla} = ${round(fla * 1.25, 1)} A (NEC 430.22); overload setting from the NAMEPLATE FLA × 115–125 % (430.32), not this table; short-circuit protection per 430.52 (inverse-time breaker up to 250 %).`,
      "The table figure is for sizing conductors, disconnects and short-circuit protection; the nameplate FLA is what the motor actually draws at rated load and is what the overload must protect. Hermetic compressors use RLA/MCA/MOP from the equipment nameplate instead.",
    ];
    return result("motor_fla", values, interp, v.warnings);
  }

  function capacitorReplacement(req) {
    const v = validator();
    const ok = [v.check("ratedUf", req.ratedUf, { positive: true }), v.check("ratedV", req.ratedV, { positive: true }), v.check("replacementUf", req.replacementUf, { positive: true }), v.check("replacementV", req.replacementV, { positive: true })].every(Boolean);
    if (!ok) return result("capacitor_replacement", {}, ["Enter the original capacitor's µF and voltage rating and the replacement's µF and voltage."], v.warnings);
    const dev = ((req.replacementUf - req.ratedUf) / req.ratedUf) * 100;
    const ufOk = Math.abs(dev) <= 6;
    const vOk = req.replacementV >= req.ratedV;
    const values = { deviationPct: round(dev, 1), microfaradsOk: ufOk ? 1 : 0, voltageOk: vOk ? 1 : 0, ok: ufOk && vOk ? 1 : 0 };
    const interp = [
      `µF: ${req.replacementUf} vs ${req.ratedUf} rated = ${dev >= 0 ? "+" : ""}${round(dev, 1)} % (${ufOk ? "within" : "OUTSIDE"} the ±6 % replacement tolerance). Voltage: ${req.replacementV} V vs ${req.ratedV} V rated (${vOk ? "equal or higher — OK" : "LOWER — not allowed"}).`,
    ];
    if (ufOk && vOk) interp.push("Acceptable substitute. The µF sets the phase shift the motor was designed for; a higher voltage rating only adds margin (a 440 V can replaces a 370 V one, never the reverse).");
    else {
      if (!ufOk) interp.push(`Wrong capacitance: ${dev < 0 ? "too small — the motor runs hot, draws more amps and may not start" : "too large — the motor overheats and the capacitor sees higher current"}. Use the motor's rated µF (match the dual-cap HERM/FAN sections separately).`);
      if (!vOk) interp.push("Voltage rating too low: the capacitor will fail early. Choose ≥ the original voltage rating.");
    }
    interp.push("Also match the type (run capacitors are continuous-duty oil-filled; start capacitors are electrolytic, −0/+20 % and intermittent), terminal count (dual run: C / HERM / FAN) and mounting. Discharge through a bleed resistor before handling.");
    return result("capacitor_replacement", values, interp, v.warnings);
  }

  function motorReplacement(req) {
    const v = validator();
    const values = {};
    if (isNum(req.hp) && req.hp > 0) values.hp = req.hp;
    if (isNum(req.rpm) && req.rpm > 0) values.rpm = req.rpm;
    if (isNum(req.volts) && req.volts > 0) values.volts = req.volts;
    if (req.phase === 1 || req.phase === 3) values.phase = req.phase;
    if (isNum(req.shaftDiaIn) && req.shaftDiaIn > 0) values.shaftDiaIn = req.shaftDiaIn;
    const given = (label, val) => (val === undefined || val === null || val === "" ? `${label}: not given — read it off the old motor` : `${label}: ${String(val)}`);
    const interp = [
      "Motor replacement checklist — what MUST match and what may be substituted:",
      `${given("RPM", req.rpm)} — must match (1725 vs 1140 vs 3450; a different speed changes airflow and amps by the fan laws). Multi-speed motors: same number of speeds and lead configuration.`,
      `${given("Volts", req.volts)} / ${given("phase", req.phase)} — must match the supply; 208-230 V dual-rated motors are fine on either; never a 230 V single-phase motor on 460 V three-phase.`,
      `${given("HP", req.hp)} — equal, or the next size up ONLY if the nameplate amps stay within the existing contactor, overload/breaker and wiring and the drive/sheave can load it; never smaller.`,
      `${given("Rotation (from the shaft end)", req.rotationFromShaftEnd)} — state it from the shaft end (${req.rotationFromShaftEnd === "cw" ? "CW" : req.rotationFromShaftEnd === "ccw" ? "CCW" : "CW or CCW"}); counter catalogs and parts counters often list it from the lead/opposite end — ask which. Prefer a reversible motor and verify at startup with the belt off.`,
      `${given("Frame", req.frame)} — NEMA frame fixes the mounting dimensions (shaft height, bolt pattern) and ${given("shaft diameter", req.shaftDiaIn)}${isNum(req.shaftDiaIn) ? " in." : ""}: must match or you need an adapter base and a new sheave/blade hub; check shaft length and keyway too.`,
      `${given("Enclosure", req.enclosure)} — ODP indoors only; TEFC / TEAO / weatherproof for condenser fans and rooftops; belly-band condenser fan motors need the correct direction of airflow over the motor.`,
      "Also match: bearing type (ball for belt drives), service factor, capacitor requirement (PSC motors need the µF on the plate — bring the capacitor), lead count/connector (ECM/X13 modules are programmed per model: replace with the OEM part or a programmable aftermarket module), and thermal protection (auto vs manual reset).",
      "Before energizing: megger the new motor, check rotation with the belt off / blade free, then measure amps against the nameplate FLA at full airflow.",
    ];
    if (Object.keys(values).length === 0) v.warnings.push("No motor attributes given; the checklist is generic.");
    return result("motor_replacement", values, interp, v.warnings);
  }

  /* ---------------- chiller (offline: derived values only; findings need the server) ---------------- */
  /**
   * Mirrors the arithmetic of src/knowledge/chiller.ts for ChillerMeasurements (camelCase): CHW ΔT, tons
   * (500 × gpm × ΔT ÷ 12000), evaporator approach (CHW supply − evap sat), condenser approach (cond sat − leaving
   * condenser water, or − outdoor DB), condenser water ΔT, amps as % RLA. Saturation temperatures come from the
   * entered sat temps, else from the PT cache when a pressure was given (`satAt(psig)` → °F or null).
   */
  function chillerLocal(m, satAt) {
    const d = {};
    const notes = [];
    let condenserType = m.condenserType === "water_cooled" || m.condenserType === "air_cooled" ? m.condenserType : "unknown";
    if (condenserType === "unknown") {
      if (isNum(m.condWaterOutF) || isNum(m.condWaterInF)) condenserType = "water_cooled";
      else if (isNum(m.outdoorDbF)) condenserType = "air_cooled";
    }
    let evapSat = isNum(m.evapSatF) ? m.evapSatF : undefined;
    let condSat = isNum(m.condSatF) ? m.condSatF : undefined;
    if (evapSat === undefined && isNum(m.evapPressurePsig)) {
      const t = typeof satAt === "function" ? satAt(m.evapPressurePsig, "dew") : null;
      if (isNum(t)) evapSat = t;
      else notes.push("Evaporator pressure could not be converted offline (no cached PT point): enter the saturated temperature from the chiller display, or reconnect.");
    }
    if (condSat === undefined && isNum(m.condPressurePsig)) {
      const t = typeof satAt === "function" ? satAt(m.condPressurePsig, "bubble") : null;
      if (isNum(t)) condSat = t;
      else notes.push("Condenser pressure could not be converted offline (no cached PT point): enter the saturated temperature from the chiller display, or reconnect.");
    }
    if (evapSat !== undefined) d.evapSatF = round(evapSat, 1);
    if (condSat !== undefined) d.condSatF = round(condSat, 1);
    if (isNum(m.chwSupplyF) && isNum(m.chwReturnF)) {
      d.chwDeltaTF = round(m.chwReturnF - m.chwSupplyF, 1);
      if (isNum(m.chwFlowGpm) && m.chwFlowGpm > 0) d.tons = round((500 * m.chwFlowGpm * d.chwDeltaTF) / 12000, 1);
    }
    if (isNum(m.chwSupplyF) && evapSat !== undefined) d.evapApproachF = round(m.chwSupplyF - evapSat, 1);
    if (condSat !== undefined) {
      if (condenserType === "water_cooled" && isNum(m.condWaterOutF)) d.condApproachF = round(condSat - m.condWaterOutF, 1);
      else if (condenserType === "air_cooled" && isNum(m.outdoorDbF)) d.condApproachF = round(condSat - m.outdoorDbF, 1);
    }
    if (isNum(m.condWaterInF) && isNum(m.condWaterOutF)) d.condWaterDeltaTF = round(m.condWaterOutF - m.condWaterInF, 1);
    if (isNum(m.compressorAmps) && isNum(m.rla) && m.rla > 0) d.ampsPercentRla = round((100 * m.compressorAmps) / m.rla, 1);
    const bits = [];
    if (d.chwDeltaTF !== undefined) bits.push(`CHW ${m.chwReturnF}→${m.chwSupplyF} °F (ΔT ${d.chwDeltaTF}${d.tons !== undefined ? `, ${d.tons} tons` : ""})`);
    if (d.evapApproachF !== undefined) bits.push(`evap approach ${d.evapApproachF} °F`);
    if (d.condApproachF !== undefined) bits.push(`cond approach ${d.condApproachF} °F (${condenserType === "water_cooled" ? "water" : "air"}-cooled)`);
    if (d.ampsPercentRla !== undefined) bits.push(`${d.ampsPercentRla} % RLA`);
    notes.push("Computed on this device: ΔT, tons and approaches only. Findings (fouling, flow, freeze, overload, oil bands) need the server — reconnect and evaluate again.");
    return { measurements: m, condenserType, derived: d, validity: { ok: true, issues: [] }, findings: [], missing: [], summary: bits.length ? `${bits.join("; ")}.` : "Not enough readings for approaches; enter CHW supply plus evaporator saturated temperature.", notes, source: "device", offline: true };
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
      case "leak_rate":
        return leakRate(req);
      case "gas_meter_clock":
        return gasMeterClock(req);
      case "combustion_co":
        return combustionCo(req);
      case "sensible_cfm":
        return sensibleCfm(req);
      case "static_pressure":
        return staticPressure(req);
      case "fan_laws":
        return fanLaws(req);
      case "belt_drive":
        return beltDrive(req);
      case "voltage_drop":
        return voltageDrop(req);
      case "motor_fla":
        return motorFla(req);
      case "capacitor_replacement":
        return capacitorReplacement(req);
      case "motor_replacement":
        return motorReplacement(req);
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
    // wave 2 (offline mirrors of the server calculators + chiller arithmetic)
    leakRate, gasMeterClock, combustionCo, sensibleCfm, staticPressure, fanLaws, beltDrive, voltageDrop, motorFla, capacitorReplacement, motorReplacement,
    annualizedLeakRate, thresholdFor, leakRuleApplies, LEAK_RATE_MAX_DAYS, normalizeAwg, AWG_CMIL, NEC_FLA_1PH, NEC_FLA_3PH, chillerLocal,
    OFFLINE_KINDS: ["voltage_imbalance", "current_imbalance", "capacitor_under_load", "temp_rise_cfm", "winding_check", "leak_rate", "gas_meter_clock", "combustion_co", "sensible_cfm", "static_pressure", "fan_laws", "belt_drive", "voltage_drop", "motor_fla", "capacitor_replacement", "motor_replacement"],
  };
})();
