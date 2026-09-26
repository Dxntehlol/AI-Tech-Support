/**
 * Electrical knowledge: calculators (calcElectrical) and fuzzy lookup over the
 * knowledge/electrical/*.json packs (components, procedures, reference topics).
 *
 * Calculators never throw on bad input: they validate (finite, > 0 where required) and
 * return warnings with whatever values could still be derived.
 */
import type {
  ElectricalCalcRequest,
  ElectricalCalcResult,
  ElectricalComponent,
  ElectricalProcedure,
  KnowledgeBase,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

interface Validator {
  warnings: string[];
  /** Returns true when the value is a finite number (and > 0 when `positive`). */
  check(name: string, value: unknown, opts?: { positive?: boolean; nonNegative?: boolean; optional?: boolean }): boolean;
}

function validator(): Validator {
  const warnings: string[] = [];
  return {
    warnings,
    check(name, value, opts = {}) {
      if (value === undefined || value === null) {
        if (!opts.optional) warnings.push(`${name} is required.`);
        return false;
      }
      if (!isNum(value)) {
        warnings.push(`${name} must be a finite number (got ${String(value)}).`);
        return false;
      }
      if (opts.positive && value <= 0) {
        warnings.push(`${name} must be greater than 0 (got ${value}).`);
        return false;
      }
      if (opts.nonNegative && value < 0) {
        warnings.push(`${name} must not be negative (got ${value}).`);
        return false;
      }
      return true;
    },
  };
}

function result(kind: ElectricalCalcRequest["kind"], values: Record<string, number>, interpretation: string[], warnings: string[]): ElectricalCalcResult {
  return { kind, values, interpretation, warnings };
}

/** Local atmospheric pressure (psia) at an elevation in feet (ISA barometric formula). */
export function atmosphericPsia(elevationFt: number | undefined): number {
  const ft = isNum(elevationFt) && elevationFt > -1500 ? elevationFt : 0;
  const m = ft * 0.3048;
  return 14.696 * Math.pow(1 - 2.25577e-5 * m, 5.25588);
}

// ---------------------------------------------------------------------------
// NEMA MG-1 voltage-imbalance derating curve
// ---------------------------------------------------------------------------

/** NEMA MG-1 (Part 14, Fig. 14-1) medium-motor derating curve, piecewise-linear points (% imbalance → factor). */
const NEMA_DERATE_POINTS: [number, number][] = [
  [0, 1.0],
  [1, 1.0],
  [2, 0.95],
  [3, 0.88],
  [4, 0.82],
  [5, 0.75],
];

/** NEMA MG-1 derating factor for a given percent voltage imbalance (1.0 up to 1 %, 0.75 at 5 %, clamped beyond). */
export function nemaDerateFactor(imbalancePercent: number): number {
  if (!isNum(imbalancePercent) || imbalancePercent <= 0) return 1;
  const pts = NEMA_DERATE_POINTS;
  const last = pts[pts.length - 1]!;
  if (imbalancePercent >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    if (imbalancePercent <= x1) {
      return round(y0 + ((imbalancePercent - x0) / (x1 - x0)) * (y1 - y0), 3);
    }
  }
  return last[1];
}

function imbalance(a: number, b: number, c: number): { avg: number; maxDeviation: number; percent: number; worstLeg: number } {
  const avg = (a + b + c) / 3;
  const devs = [Math.abs(a - avg), Math.abs(b - avg), Math.abs(c - avg)];
  let worst = 0;
  for (let i = 1; i < 3; i++) if (devs[i]! > devs[worst]!) worst = i;
  const maxDeviation = devs[worst]!;
  const percent = avg > 0 ? (100 * maxDeviation) / avg : 0;
  return { avg, maxDeviation, percent, worstLeg: worst + 1 };
}

// ---------------------------------------------------------------------------
// Psychrometrics (ASHRAE Fundamentals, IP units)
// ---------------------------------------------------------------------------

/**
 * Saturation pressure of water vapor (psia) at a dry-bulb temperature (°F), ASHRAE Fundamentals
 * ch. 1 (Hyland–Wexler). Over ice below 32 °F, over liquid water above.
 */
export function saturationPressurePsia(tempF: number): number {
  const T = tempF + 459.67; // °R
  let ln: number;
  if (tempF < 32) {
    ln =
      -1.0214165e4 / T +
      -4.8932428 +
      -5.3765794e-3 * T +
      1.9202377e-7 * T * T +
      3.5575832e-10 * T ** 3 +
      -9.0344688e-14 * T ** 4 +
      4.1635019 * Math.log(T);
  } else {
    ln =
      -1.0440397e4 / T +
      -1.129465e1 +
      -2.7022355e-2 * T +
      1.289036e-5 * T * T +
      -2.4780681e-9 * T ** 3 +
      6.5459673 * Math.log(T);
  }
  return Math.exp(ln);
}

/** Humidity ratio (lb water / lb dry air) at saturation for a temperature and total pressure. */
function saturationHumidityRatio(tempF: number, pPsia: number): number {
  const pws = saturationPressurePsia(tempF);
  return (0.621945 * pws) / (pPsia - pws);
}

/** Dew-point temperature (°F) from vapor pressure (psia), by bisection on the saturation curve. */
function dewPointFromVaporPressure(pwPsia: number): number {
  if (!(pwPsia > 0)) return Number.NaN;
  let lo = -80;
  let hi = 200;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (saturationPressurePsia(mid) < pwPsia) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface PsychrometricState {
  dbF: number;
  wbF: number;
  pressurePsia: number;
  humidityRatio: number; // lb/lb
  grainsPerLb: number;
  rhPercent: number;
  dewPointF: number;
  enthalpyBtuPerLb: number;
  specificVolumeFt3PerLb: number;
  vaporPressurePsia: number;
}

/** Standard ASHRAE moist-air state from dry bulb, wet bulb and elevation. */
export function psychrometrics(dbF: number, wbF: number, elevationFt = 0): PsychrometricState {
  const p = atmosphericPsia(elevationFt);
  const wsStar = saturationHumidityRatio(wbF, p);
  // ASHRAE Fundamentals ch. 1, eq. 35 (wet-bulb relation, over liquid water) / eq. 37 (over ice).
  const W =
    wbF >= 32
      ? ((1093 - 0.556 * wbF) * wsStar - 0.24 * (dbF - wbF)) / (1093 + 0.444 * dbF - wbF)
      : ((1220 - 0.04 * wbF) * wsStar - 0.24 * (dbF - wbF)) / (1220 + 0.444 * dbF - 0.48 * wbF);
  const Wc = Math.max(W, 0);
  const pw = (p * Wc) / (0.621945 + Wc);
  const pws = saturationPressurePsia(dbF);
  const rh = Math.min(100, Math.max(0, (100 * pw) / pws));
  const dew = Wc > 0 ? dewPointFromVaporPressure(pw) : Number.NaN;
  const h = 0.24 * dbF + Wc * (1061 + 0.444 * dbF);
  const v = (0.370486 * (dbF + 459.67) * (1 + 1.607858 * Wc)) / p;
  return {
    dbF,
    wbF,
    pressurePsia: p,
    humidityRatio: Wc,
    grainsPerLb: Wc * 7000,
    rhPercent: rh,
    dewPointF: dew,
    enthalpyBtuPerLb: h,
    specificVolumeFt3PerLb: v,
    vaporPressurePsia: pw,
  };
}

// ---------------------------------------------------------------------------
// Calculators
// ---------------------------------------------------------------------------

function calcVoltageImbalance(req: Extract<ElectricalCalcRequest, { kind: "voltage_imbalance" }>): ElectricalCalcResult {
  const v = validator();
  const ok = [v.check("vab", req.vab, { positive: true }), v.check("vbc", req.vbc, { positive: true }), v.check("vca", req.vca, { positive: true })].every(Boolean);
  if (!ok) return result("voltage_imbalance", {}, ["Enter all three line-to-line voltages (A-B, B-C, C-A), measured at the same point with the unit running."], v.warnings);
  const legs = ["A-B", "B-C", "C-A"];
  const { avg, maxDeviation, percent, worstLeg } = imbalance(req.vab, req.vbc, req.vca);
  const derate = nemaDerateFactor(percent);
  const interp: string[] = [
    `Average ${round(avg, 1)} V; largest deviation ${round(maxDeviation, 1)} V on ${legs[worstLeg - 1]}; voltage imbalance ${round(percent, 2)} % (NEMA MG-1: 100 × max|V − Vavg| / Vavg).`,
  ];
  if (percent <= 1) {
    interp.push("Within the NEMA MG-1 1 % guideline — no derating needed. Motors tolerate this; look elsewhere for the fault.");
  } else if (percent <= 2) {
    interp.push(`Above 1 %: investigate the source (utility, loose or corroded lugs, uneven single-phase loads on the same service, failing contactor pole). NEMA derate factor ≈ ${derate}.`);
  } else if (percent <= 5) {
    interp.push(`Above 2 %: motors must be derated per NEMA MG-1 — derate factor ≈ ${derate} (≈0.95 @ 2 %, 0.88 @ 3 %, 0.82 @ 4 %, 0.75 @ 5 %). Winding heating rises roughly with the square of the imbalance (≈ 2 × %² percent extra heat); expect current imbalance 6–10× this figure.`);
  } else {
    interp.push(`Above 5 %: NEMA MG-1 says do not operate the motor. Shut the unit down and correct the supply (utility, open/high-resistance connection, blown fuse on one leg) before it destroys the compressor. Derate factor shown is the 5 % floor (${derate}).`);
  }
  interp.push("Measure line-to-line at the unit terminals with the compressor running; if the imbalance drops with the unit off, the problem is in the unit's own wiring or contactor. Confirm which leg deviates and whether the same leg is high or low at the panel.");
  return result(
    "voltage_imbalance",
    {
      average: round(avg, 1),
      maxDeviation: round(maxDeviation, 2),
      imbalancePercent: round(percent, 2),
      derateFactor: derate,
      worstLeg,
    },
    interp,
    v.warnings,
  );
}

function calcCurrentImbalance(req: Extract<ElectricalCalcRequest, { kind: "current_imbalance" }>): ElectricalCalcResult {
  const v = validator();
  const ok = [v.check("ia", req.ia, { nonNegative: true }), v.check("ib", req.ib, { nonNegative: true }), v.check("ic", req.ic, { nonNegative: true })].every(Boolean);
  if (!ok) return result("current_imbalance", {}, ["Enter all three leg currents (L1, L2, L3) clamped one leg at a time with the compressor running steadily."], v.warnings);
  const { avg, maxDeviation, percent, worstLeg } = imbalance(req.ia, req.ib, req.ic);
  const zeroLegs = [req.ia, req.ib, req.ic].filter((x) => x === 0).length;
  const interp: string[] = [
    `Average ${round(avg, 1)} A; largest deviation ${round(maxDeviation, 1)} A on L${worstLeg}; current imbalance ${round(percent, 1)} % (100 × max|I − Iavg| / Iavg).`,
  ];
  if (zeroLegs > 0) {
    interp.push("A leg reading 0 A means single-phasing (blown fuse, open contactor pole, broken wire) — stop the compressor immediately; it will overheat on the remaining two legs.");
  } else if (percent <= 10) {
    interp.push("Within the 10 % guideline. A current imbalance is normally 6–10× the voltage imbalance; roll the leads (swap L1→T2, L2→T3, L3→T1) — if the high leg follows the supply, the problem is upstream; if it stays on the compressor terminal, suspect the winding.");
  } else {
    interp.push("Above 10 %: check voltage imbalance first (the current imbalance is typically 6–10× the voltage imbalance). If voltage is balanced, roll the three leads one position at the contactor: the high leg following the line = supply/contactor problem; staying with the motor terminal = winding or terminal problem.");
    interp.push("Also check contactor contacts (drop across each pole under load < 0.5 V), lug torque, and heat-damaged wire at the compressor terminal block.");
  }
  return result(
    "current_imbalance",
    { average: round(avg, 2), maxDeviation: round(maxDeviation, 2), imbalancePercent: round(percent, 2), worstLeg },
    interp,
    v.warnings,
  );
}

function calcCapacitorUnderLoad(req: Extract<ElectricalCalcRequest, { kind: "capacitor_under_load" }>): ElectricalCalcResult {
  const v = validator();
  const okA = v.check("amps", req.amps, { positive: true });
  const okV = v.check("volts", req.volts, { positive: true });
  const okRated = v.check("ratedUf", req.ratedUf, { positive: true, optional: true });
  const interp: string[] = [
    "Formula: µF = 2652 × A / V — amps clamped on the capacitor lead that goes to the START/HERM terminal (or the FAN terminal for the fan section), volts across the same capacitor terminals, unit running.",
    "Invalid if the clamp is on the compressor COMMON lead or the line lead — that current includes the run winding and reads far too high. Measure at the capacitor terminal wire only.",
  ];
  if (!okA || !okV) return result("capacitor_under_load", {}, interp, v.warnings);
  const uf = (2652 * req.amps) / req.volts;
  const values: Record<string, number> = { microfarads: round(uf, 1) };
  if (okRated && req.ratedUf !== undefined) {
    const pct = (100 * uf) / req.ratedUf;
    const dev = pct - 100;
    values.percentOfRated = round(pct, 1);
    values.deviationPercent = round(dev, 1);
    values.pass = Math.abs(dev) <= 6 ? 1 : 0;
    if (Math.abs(dev) <= 6) {
      interp.push(`Measured ${round(uf, 1)} µF is ${round(pct, 1)} % of the ${req.ratedUf} µF rating (${dev >= 0 ? "+" : ""}${round(dev, 1)} %) — PASS within ±6 %. Use the tolerance printed on the can if it differs (±5 % or ±10 % on some).`);
    } else if (dev < 0) {
      interp.push(`Measured ${round(uf, 1)} µF is ${round(pct, 1)} % of the ${req.ratedUf} µF rating (${round(dev, 1)} %) — FAIL, more than 6 % low. A weak run capacitor raises compressor amps and temperature and can cause hum/no-start; replace with the same µF and equal-or-higher voltage rating.`);
    } else {
      interp.push(`Measured ${round(uf, 1)} µF is ${round(pct, 1)} % of the ${req.ratedUf} µF rating (+${round(dev, 1)} %) — reads high. Re-check that the clamp is on the capacitor lead only (not common) and that volts were read across the capacitor terminals; a genuinely high reading above +6 % is also outside tolerance.`);
    }
  } else {
    interp.push(`Measured ${round(uf, 1)} µF under load. Compare against the µF printed on the can (±6 % or the printed tolerance).`);
  }
  interp.push("Also inspect: bulged/domed top, oil leakage, corroded terminals — replace on sight regardless of the reading. Discharge through a bleed resistor (20 kΩ, 5 W or similar) before touching terminals.");
  return result("capacitor_under_load", values, interp, v.warnings);
}

function calcAmpsVsRla(req: Extract<ElectricalCalcRequest, { kind: "amps_vs_rla" }>): ElectricalCalcResult {
  const v = validator();
  const ok = [v.check("amps", req.amps, { nonNegative: true }), v.check("rla", req.rla, { positive: true })].every(Boolean);
  if (!ok) return result("amps_vs_rla", {}, ["Enter measured compressor amps and the nameplate RLA (Rated Load Amps)."], v.warnings);
  const pct = (100 * req.amps) / req.rla;
  const interp: string[] = [`Measured ${req.amps} A is ${round(pct, 0)} % of RLA ${req.rla} A.`];
  if (req.amps === 0) {
    interp.push("0 A: the compressor is not running — check contactor pull-in, line voltage at the load side, and the compressor windings/overload before anything else.");
  } else if (pct < 50) {
    interp.push("Well below RLA (< 50 %): the compressor is doing little work — suspect low charge / loss of refrigerant, a scroll running backwards (3-phase, loud, no pumping), broken valves/scroll set, closed suction valve, or the unit at minimum capacity (digital/variable, unloaded). Compare with suction pressure and superheat.");
  } else if (pct < 75) {
    interp.push("Below the usual running band (50–75 % of RLA): normal at mild outdoor temperature or low load; if the space is not cooling, look at charge and airflow rather than the compressor.");
  } else if (pct <= 100) {
    interp.push("Normal running band. RLA is a nameplate design figure (RLA = MCC / 1.56 by UL definition), not a maximum — amps rise with condensing temperature and low line voltage.");
  } else if (pct <= 115) {
    interp.push("Above RLA: high head pressure (dirty condenser, condenser fan, overcharge, non-condensables), low or imbalanced line voltage, or a weak run capacitor (single-phase). Fix the cause; the overload will trip if it keeps climbing.");
  } else {
    interp.push("Well above RLA (> 115 %): stop and find the cause — dirty condenser/failed fan, weak run capacitor, low voltage, high voltage imbalance, mechanical drag (liquid flood-back, bearing failure). Compare against MCC (max continuous current ≈ RLA × 1.56) — the overload should already be tripping near MCC. Amps near LRA that drop out quickly = locked rotor.");
  }
  return result("amps_vs_rla", { percentOfRla: round(pct, 1), mccEstimate: round(req.rla * 1.56, 1) }, interp, v.warnings);
}

function calcTempRiseCfm(req: Extract<ElectricalCalcRequest, { kind: "temp_rise_cfm" }>): ElectricalCalcResult {
  const v = validator();
  const ok = [
    v.check("inputBtuh", req.inputBtuh, { positive: true }),
    v.check("efficiencyPercent", req.efficiencyPercent, { positive: true }),
    v.check("riseF", req.riseF, { positive: true }),
  ].every(Boolean);
  if (!ok) return result("temp_rise_cfm", {}, ["Enter heater input BTU/h (gas: nameplate input; electric: kW × 3412), efficiency % (electric heat = 100), and the measured supply − return temperature rise."], v.warnings);
  if (req.efficiencyPercent > 100) v.warnings.push("efficiencyPercent above 100 was used as given; electric heat is 100 %, gas heat typically 80–81 % (or the nameplate/AFUE figure).");
  const output = req.inputBtuh * (req.efficiencyPercent / 100);
  const cfm = output / (1.08 * req.riseF);
  const interp: string[] = [
    `Output ${Math.round(output).toLocaleString("en-US")} BTU/h = input × ${req.efficiencyPercent} %. CFM = output / (1.08 × ΔT) = ${Math.round(cfm).toLocaleString("en-US")} CFM at ${req.riseF} °F rise.`,
    "The 1.08 factor is for standard air at sea level (0.075 lb/ft³); at high elevation use 1.08 × (local density ratio). For electric heat, BTUh = kW × 3412 at 100 %; measure kW from volts × amps (× √3 for 3-phase) rather than trusting the nameplate.",
    "Check the rise against the nameplate temperature-rise range (gas furnaces/RTUs typically 25–55 °F or 35–65 °F): rise above the range = low airflow (filters, coil, belt, static, blower speed); rise below = high airflow or under-firing. Measure the supply temperature out of the radiant line of sight of the heat exchanger.",
  ];
  return result("temp_rise_cfm", { outputBtuh: Math.round(output), cfm: Math.round(cfm) }, interp, v.warnings);
}

function calcOhmsLaw(req: Extract<ElectricalCalcRequest, { kind: "ohms_law" }>): ElectricalCalcResult {
  const v = validator();
  const given: Record<string, number> = {};
  for (const key of ["volts", "amps", "ohms", "watts"] as const) {
    const val = req[key];
    if (val === undefined || val === null) continue;
    if (v.check(key, val, { positive: true })) given[key] = val;
  }
  const keys = Object.keys(given);
  if (keys.length < 2) {
    v.warnings.push("Ohm's law needs any two of volts, amps, ohms, watts.");
    return result("ohms_law", given, ["Provide any two values (e.g., volts + amps, or volts + ohms) and the other two are computed: V = I × R, P = V × I."], v.warnings);
  }
  let V = given.volts;
  let I = given.amps;
  let R = given.ohms;
  let P = given.watts;
  if (V !== undefined && I !== undefined) {
    R = V / I;
    P = V * I;
  } else if (V !== undefined && R !== undefined) {
    I = V / R;
    P = V * I;
  } else if (V !== undefined && P !== undefined) {
    I = P / V;
    R = V / I;
  } else if (I !== undefined && R !== undefined) {
    V = I * R;
    P = V * I;
  } else if (I !== undefined && P !== undefined) {
    V = P / I;
    R = V / I;
  } else if (R !== undefined && P !== undefined) {
    I = Math.sqrt(P / R);
    V = I * R;
  }
  if (keys.length > 2) v.warnings.push("More than two values given — the first pair in the order volts, amps, ohms, watts was used; the rest were recomputed.");
  const values = { volts: round(V!, 3), amps: round(I!, 3), ohms: round(R!, 3), watts: round(P!, 3) };
  return result(
    "ohms_law",
    values,
    [
      `V = ${values.volts} V, I = ${values.amps} A, R = ${values.ohms} Ω, P = ${values.watts} W (V = I·R, P = V·I).`,
      "Resistive loads only (electric heat, crankcase heaters, contactor coils approximately). For motors and transformers the ohms reading is the DC winding resistance — it does not predict running amps because of inductive reactance and back-EMF.",
    ],
    v.warnings,
  );
}

function calcElectricHeatKw(req: Extract<ElectricalCalcRequest, { kind: "electric_heat_kw" }>): ElectricalCalcResult {
  const v = validator();
  const ok = [v.check("volts", req.volts, { positive: true }), v.check("amps", req.amps, { nonNegative: true })].every(Boolean);
  if (req.phase !== 1 && req.phase !== 3) v.warnings.push(`phase must be 1 or 3 (got ${String(req.phase)}); assumed single-phase.`);
  v.check("nameplateKw", req.nameplateKw, { positive: true, optional: true });
  if (!ok) return result("electric_heat_kw", {}, ["Enter line voltage, total heater amps (one leg, all stages energized) and phase."], v.warnings);
  const factor = req.phase === 3 ? Math.sqrt(3) : 1;
  const kw = (req.volts * req.amps * factor) / 1000;
  const btuh = kw * 3412;
  const values: Record<string, number> = { kw: round(kw, 2), btuh: Math.round(btuh) };
  const interp: string[] = [
    `kW = V × A${req.phase === 3 ? " × √3" : ""} / 1000 = ${round(kw, 2)} kW ≈ ${Math.round(btuh).toLocaleString("en-US")} BTU/h (100 % efficient).`,
  ];
  if (req.nameplateKw !== undefined && isNum(req.nameplateKw) && req.nameplateKw > 0) {
    const pct = (100 * kw) / req.nameplateKw;
    values.percentOfNameplate = round(pct, 1);
    values.pass = Math.abs(pct - 100) <= 10 ? 1 : 0;
    if (Math.abs(pct - 100) <= 10) {
      interp.push(`${round(pct, 0)} % of the ${req.nameplateKw} kW nameplate — within ±10 %, all elements appear to be drawing. Remember nameplate kW is at the nameplate voltage; at 208 V a 240 V heater delivers ≈ 75 % (kW scales with V²).`);
    } else if (pct < 90) {
      interp.push(`${round(pct, 0)} % of the ${req.nameplateKw} kW nameplate — low. Likely an open element, a fusible link or limit open on one stage, a stage not being called (sequencer/relay/staging), an open element fuse, or the heater rated at a higher voltage than supplied (V² effect). Check amps on each element circuit individually.`);
    } else {
      interp.push(`${round(pct, 0)} % of the ${req.nameplateKw} kW nameplate — high. Check the voltage used (measure under load), that fan/other loads are not included in the clamp, and for a shorted element or grounded element.`);
    }
  }
  interp.push("Measure with all stages energized and airflow proven; never hold a heater on without airflow. Elements are resistive: one leg's amps on a balanced 3-phase heater tells the whole story; on single-phase heaters each element pair can be clamped separately.");
  return result("electric_heat_kw", values, interp, v.warnings);
}

function calcPsychrometrics(req: Extract<ElectricalCalcRequest, { kind: "psychrometrics" }>): ElectricalCalcResult {
  const v = validator();
  const ok = [v.check("dbF", req.dbF), v.check("wbF", req.wbF)].every(Boolean);
  v.check("elevationFt", req.elevationFt, { optional: true });
  if (!ok) return result("psychrometrics", {}, ["Enter dry-bulb and wet-bulb temperatures (°F); elevation in feet is optional (sea level assumed)."], v.warnings);
  if (req.wbF > req.dbF) {
    v.warnings.push(`Wet bulb (${req.wbF} °F) cannot exceed dry bulb (${req.dbF} °F); wet bulb was clamped to dry bulb. Re-check the readings (wick wet? probe out of the sun?).`);
  }
  if (req.dbF < -40 || req.dbF > 200) v.warnings.push("Dry bulb outside −40…200 °F — results are outside the range of the ASHRAE correlations.");
  const wb = Math.min(req.wbF, req.dbF);
  const elev = isNum(req.elevationFt) ? req.elevationFt : 0;
  const s = psychrometrics(req.dbF, wb, elev);
  const values: Record<string, number> = {
    rhPercent: round(s.rhPercent, 1),
    dewPointF: round(s.dewPointF, 1),
    enthalpyBtuPerLb: round(s.enthalpyBtuPerLb, 2),
    grainsPerLb: round(s.grainsPerLb, 1),
    humidityRatio: round(s.humidityRatio, 5),
    specificVolumeFt3PerLb: round(s.specificVolumeFt3PerLb, 3),
    pressurePsia: round(s.pressurePsia, 3),
    wbDepressionF: round(req.dbF - wb, 1),
  };
  const interp: string[] = [
    `${req.dbF} °F DB / ${wb} °F WB at ${round(s.pressurePsia, 2)} psia (${Math.round(elev)} ft): RH ${round(s.rhPercent, 0)} %, dew point ${round(s.dewPointF, 1)} °F, enthalpy ${round(s.enthalpyBtuPerLb, 1)} Btu/lb, ${round(s.grainsPerLb, 0)} grains/lb.`,
    "ASHRAE Fundamentals formulas: Hyland–Wexler saturation pressure, humidity ratio from the wet-bulb relation, h = 0.240·T + W·(1061 + 0.444·T) Btu/lb dry air.",
  ];
  if (s.rhPercent >= 99) interp.push("Air is saturated (WB ≈ DB) — check that the wet-bulb reading is real and not a dry wick or a coil-side reading.");
  interp.push("Uses: enthalpy of return vs supply gives total (sensible + latent) capacity: BTU/h ≈ 4.5 × CFM × Δh; supply dew point vs coil temperature checks latent performance; dew point above the coil/duct surface temperature means sweating.");
  if (elev > 2000) interp.push("Elevation lowers the total pressure, which raises the humidity ratio and specific volume for the same DB/WB — always enter elevation above ~2,000 ft.");
  return result("psychrometrics", values, interp, v.warnings);
}

const OPEN_OHMS = 1e6; // ≥ 1 MΩ on a winding reads as open (meter OL)
const SHORT_OHMS = 0.05;

function calcWindingCheck(req: Extract<ElectricalCalcRequest, { kind: "winding_check" }>): ElectricalCalcResult {
  const v = validator();
  const ok = [v.check("r1", req.r1, { nonNegative: true }), v.check("r2", req.r2, { nonNegative: true }), v.check("r3", req.r3, { nonNegative: true })].every(Boolean);
  if (req.phase !== 1 && req.phase !== 3) v.warnings.push(`phase must be 1 or 3 (got ${String(req.phase)}); assumed single-phase.`);
  const interp: string[] = [];
  if (!ok) {
    interp.push("Single-phase: enter C-S, C-R and S-R ohms. Three-phase: enter T1-T2, T2-T3 and T3-T1 ohms. Power off, disconnect the leads at the compressor terminals, use a low-ohms meter (readings are typically 0.3–5 Ω).");
    return result("winding_check", {}, interp, v.warnings);
  }
  const r = [req.r1, req.r2, req.r3];
  const opens = r.map((x) => x >= OPEN_OHMS);
  const shorts = r.map((x) => x <= SHORT_OHMS);
  const values: Record<string, number> = { r1: req.r1, r2: req.r2, r3: req.r3, openCount: opens.filter(Boolean).length, shortCount: shorts.filter(Boolean).length };
  let pass = 1;
  if (req.phase === 3) {
    const legs = ["T1-T2", "T2-T3", "T3-T1"];
    const avg = (req.r1 + req.r2 + req.r3) / 3;
    const maxDev = Math.max(...r.map((x) => Math.abs(x - avg)));
    const pct = avg > 0 ? (100 * maxDev) / avg : 0;
    values.average = round(avg, 3);
    values.deviationPercent = round(pct, 1);
    for (let i = 0; i < 3; i++) {
      if (opens[i]) {
        pass = 0;
        interp.push(`${legs[i]} reads open (${r[i]} Ω ≥ 1 MΩ / OL): an open winding or open internal line-break overload. If all three read open on a hot compressor, let it cool 1–2 h and re-test before condemning; check the terminal block/fusite for a burned pin.`);
      } else if (shorts[i]) {
        pass = 0;
        interp.push(`${legs[i]} reads ≈ 0 Ω (${r[i]} Ω): shorted turns or a shorted terminal — condemn after confirming with a good meter and clean terminals. Also check each terminal to ground.`);
      }
    }
    if (pass) {
      if (pct <= 5) {
        interp.push(`Three-phase legs within ±5 % (max deviation ${round(pct, 1)} % of the ${round(avg, 3)} Ω average) — windings balanced; PASS. Continue with a megohm test to ground and a check for reversed rotation if a scroll.`);
      } else {
        pass = 0;
        interp.push(`Legs differ by ${round(pct, 1)} % (> 5 %): shorted turns in one winding or a poor connection at a terminal. Clean the terminals, re-measure with a 4-wire/low-ohms meter, then condemn if it persists.`);
      }
    }
  } else {
    // r1 = C-S, r2 = C-R, r3 = S-R
    const cs = req.r1;
    const cr = req.r2;
    const sr = req.r3;
    if (opens[0] && opens[1] && !opens[2]) {
      pass = 0;
      interp.push("C-S and C-R open with S-R intact = the internal overload is open (common pin). The compressor is hot or the overload failed: cool it 1–2 hours (fan across the shell helps) and re-test before condemning. If it never closes after cooling, the overload/winding is open — replace.");
    } else {
      for (const [label, val, isOpen, isShort] of [
        ["C-S", cs, opens[0], shorts[0]],
        ["C-R", cr, opens[1], shorts[1]],
        ["S-R", sr, opens[2], shorts[2]],
      ] as [string, number, boolean, boolean][]) {
        if (isOpen) {
          pass = 0;
          interp.push(`${label} reads open (${val} Ω): an open ${label === "C-R" ? "run" : label === "C-S" ? "start" : "start-plus-run"} winding path or a burned terminal. Confirm at the compressor pins with the leads removed.`);
        } else if (isShort) {
          pass = 0;
          interp.push(`${label} reads ≈ 0 Ω (${val} Ω): shorted winding — condemn after confirming with clean pins and a good meter.`);
        }
      }
    }
    if (pass) {
      const sum = cs + cr;
      const err = sr > 0 ? (100 * Math.abs(sum - sr)) / sr : 100;
      values.csPlusCr = round(sum, 3);
      values.sumErrorPercent = round(err, 1);
      const ordering = cr < cs && cs < sr;
      if (err <= 10 && ordering) {
        interp.push(`C-S (${cs} Ω) + C-R (${cr} Ω) = ${round(sum, 3)} Ω ≈ S-R (${sr} Ω), within ${round(err, 1)} %; C-R is the lowest and S-R the highest — the single-phase winding pattern checks out; PASS. Follow with a megohm test to ground.`);
      } else if (err <= 10) {
        interp.push(`Sum checks (${round(err, 1)} % error) but the ordering is unusual (expect C-R lowest, C-S in the middle, S-R highest). Verify which pins are C, S and R (the compressor label or the terminal cover) — leads may be swapped.`);
        pass = 0;
      } else {
        pass = 0;
        interp.push(`C-S + C-R = ${round(sum, 3)} Ω vs S-R = ${sr} Ω: ${round(err, 1)} % mismatch (> ~10 %). Suspect shorted turns or a mis-identified terminal; re-measure at clean pins with the leads removed.`);
      }
    }
  }
  values.pass = pass;
  interp.push("Also check every terminal to the shell/ground with a megohmmeter (500 VDC): > 100 MΩ good, 20–100 MΩ investigate, < 20 MΩ suspect, < 1 MΩ condemn (general field guidance; confirm the manufacturer's minimum). Never megger under vacuum or with a VFD connected.");
  return result("winding_check", values, interp, v.warnings);
}

function calcMegohm(req: Extract<ElectricalCalcRequest, { kind: "megohm" }>): ElectricalCalcResult {
  const v = validator();
  const ok = v.check("megohms", req.megohms, { nonNegative: true });
  v.check("testVolts", req.testVolts, { positive: true, optional: true });
  const interp: string[] = [];
  if (!ok) return result("megohm", {}, ["Enter the winding-to-ground insulation resistance in MΩ (each terminal to the shell) and the test voltage (500 VDC for compressors)."], v.warnings);
  const m = req.megohms;
  let band: number;
  if (m > 100) {
    band = 0;
    interp.push(`${m} MΩ to ground: > 100 MΩ — good insulation.`);
  } else if (m >= 20) {
    band = 1;
    interp.push(`${m} MΩ to ground: 20–100 MΩ — investigate. Often moisture, acid or contaminated oil in the system; check the oil/acid test, drier condition and refrigerant moisture indicator; re-test after run time.`);
  } else if (m >= 1) {
    band = 2;
    interp.push(`${m} MΩ to ground: < 20 MΩ — suspect winding insulation breakdown or heavy contamination. Verify with clean, dry terminals and a good meter; plan for compressor replacement and a suction-line drier/burnout cleanup if it worsens.`);
  } else {
    band = 3;
    interp.push(`${m} MΩ to ground: < 1 MΩ — condemn. The winding is grounded (or nearly); do not attempt to run it. If a compressor has burned out, treat the system as contaminated (acid test, suction filter-drier, flush).`);
  }
  if (req.testVolts !== undefined && isNum(req.testVolts)) {
    if (req.testVolts > 500) v.warnings.push(`Test voltage ${req.testVolts} V exceeds the 500 VDC customary for hermetic compressors (general field practice; follow the compressor manufacturer's bulletin); higher voltages can damage insulation.`);
    else if (req.testVolts < 250) interp.push("Test voltages below 250 VDC understate problems; compressors are normally tested at 500 VDC.");
  }
  interp.push("Bands are general field guidance (IEEE 43-style insulation-resistance practice, as taught in HVAC/R training), not a specific Copeland limit — Copeland AE bulletins advise comparing against the compressor's own history and the manufacturer's minimum; readings are pressure-, temperature- and refrigerant-sensitive (they drop with refrigerant dissolved in the oil and rise as the compressor warms). Readings well below 100 MΩ on a compressor holding refrigerant are not by themselves a failure — compare to previous readings and to the other terminals.");
  interp.push("Never megger a compressor under vacuum (the motor can arc over to the shell through the thin gas) and never with a VFD or any electronic control connected to the output — disconnect and isolate the motor leads first. Discharge windings after the test.");
  return result("megohm", { megohms: m, band, condemn: band === 3 ? 1 : 0 }, interp, v.warnings);
}

export function calcElectrical(req: ElectricalCalcRequest): ElectricalCalcResult {
  if (!req || typeof req !== "object" || typeof (req as { kind?: unknown }).kind !== "string") {
    return { kind: "ohms_law", values: {}, interpretation: [], warnings: ["Request must be an object with a `kind`."] };
  }
  switch (req.kind) {
    case "voltage_imbalance":
      return calcVoltageImbalance(req);
    case "current_imbalance":
      return calcCurrentImbalance(req);
    case "capacitor_under_load":
      return calcCapacitorUnderLoad(req);
    case "amps_vs_rla":
      return calcAmpsVsRla(req);
    case "temp_rise_cfm":
      return calcTempRiseCfm(req);
    case "ohms_law":
      return calcOhmsLaw(req);
    case "electric_heat_kw":
      return calcElectricHeatKw(req);
    case "psychrometrics":
      return calcPsychrometrics(req);
    case "winding_check":
      return calcWindingCheck(req);
    case "megohm":
      return calcMegohm(req);
    default: {
      const kind = (req as { kind: string }).kind;
      return { kind: kind as ElectricalCalcRequest["kind"], values: {}, interpretation: [], warnings: [`Unknown calculator kind "${kind}".`] };
    }
  }
}

// ---------------------------------------------------------------------------
// Fuzzy lookup
// ---------------------------------------------------------------------------

/** Query-token → canonical token(s). Multi-token expansions are space-separated. */
const SYNONYMS: Record<string, string> = {
  cap: "capacitor",
  caps: "capacitor",
  capacitors: "capacitor",
  xfmr: "transformer",
  xformer: "transformer",
  tran: "transformer",
  trans: "transformer",
  comp: "compressor",
  compr: "compressor",
  hum: "hum",
  hums: "hum",
  humming: "hum",
  hummed: "hum",
  buzzing: "hum",
  buzz: "hum",
  trip: "trip",
  trips: "trip",
  tripping: "trip",
  tripped: "trip",
  dead: "dead",
  "no-power": "dead",
  nothing: "dead",
  cooling: "cooling",
  cool: "cooling",
  cools: "cooling",
  ac: "cooling",
  heat: "heat",
  heating: "heat",
  furnace: "heat gas",
  stat: "thermostat",
  tstat: "thermostat",
  "t-stat": "thermostat",
  breaker: "breaker",
  breakers: "breaker",
  fuse: "fuse",
  fuses: "fuse",
  blown: "fuse blowing",
  blows: "blowing",
  cond: "condenser",
  ofm: "condenser fan",
  ifm: "blower",
  blower: "blower",
  ifc: "blower",
  ofc: "condenser fan",
  fan: "fan",
  fans: "fan",
  drive: "vfd",
  vsd: "vfd",
  inverter: "vfd",
  econ: "economizer",
  economiser: "economizer",
  econo: "economizer",
  contactor: "contactor",
  contacter: "contactor",
  relay: "relay",
  relays: "relay",
  xfrmr: "transformer",
  overload: "overload",
  ol: "overload",
  hps: "high pressure switch",
  lps: "low pressure switch",
  loc: "loss charge switch",
  rds: "rds a2l refrigerant detection",
  a2l: "a2l rds refrigerant detection",
  r454b: "a2l",
  r32: "a2l",
  ignitor: "igniter",
  ignition: "igniter",
  flame: "flame sense",
  rollout: "rollout limit",
  limit: "limit",
  freezestat: "freeze stat",
  freeze: "freeze",
  megger: "megohm",
  megohms: "megohm",
  insulation: "megohm",
  imbalance: "imbalance",
  unbalance: "imbalance",
  unbalanced: "imbalance",
  rotation: "rotation",
  reversed: "rotation reversed",
  backwards: "rotation reversed",
  phasing: "phase",
  phases: "phase",
  "3ph": "three phase",
  "3-phase": "three phase",
  "1ph": "single phase",
  "1-phase": "single phase",
  "24v": "24v control",
  "24vac": "24v control",
  lockout: "lockout",
  locked: "lockout",
  short: "short",
  shorting: "short",
  cycling: "cycling",
  cycles: "cycling",
  cycle: "cycling",
  start: "start",
  starts: "start",
  starting: "start",
  wont: "wont",
  cant: "wont",
  doesnt: "wont",
  isnt: "wont",
  not: "wont",
  running: "run",
  runs: "run",
  run: "run",
  constantly: "constant",
  continuously: "constant",
  always: "constant",
  bas: "bas override",
  ddc: "bas",
  jace: "bas",
  override: "override",
  schedule: "override schedule",
  motor: "motor",
  motors: "motor",
  ecm: "ecm",
  x13: "ecm",
  amps: "amp",
  amperage: "amp",
  current: "amp",
  volts: "volt",
  voltage: "volt",
  sensor: "sensor",
  sensors: "sensor",
  switch: "switch",
  switches: "switch",
  heater: "heater",
  heaters: "heater",
  call: "call",
  calling: "call",
  demand: "call demand",
  idle: "idle",
  nameplate: "nameplate",
  plate: "nameplate",
  rla: "nameplate rla",
  fla: "nameplate fla",
  lra: "nameplate lra",
  mca: "nameplate",
  mop: "nameplate",
  loto: "safety lockout tagout",
  safety: "safety",
  ppe: "safety",
  diagram: "ladder diagram",
  schematic: "ladder diagram",
  wiring: "wire",
  wires: "wire",
  wire: "wire",
  color: "wire color",
  colors: "wire color",
  colour: "wire color",
  drop: "drop",
  ladder: "ladder diagram",
  intermittent: "intermittent",
  solenoid: "solenoid",
  reversing: "reversing valve solenoid",
  rv: "reversing valve",
  defrost: "defrost",
  crankcase: "crankcase heater",
  cch: "crankcase heater",
  timer: "timer",
  ascm: "anti short cycle timer",
  motormaster: "low ambient head pressure",
  "low-ambient": "low ambient",
  ambient: "ambient",
  head: "head",
  winding: "winding",
  windings: "winding",
  ohm: "ohms",
  ohms: "ohms",
  resistance: "ohms",
  pressure: "pressure",
  ramp: "ramp",
  fault: "fault",
  faults: "fault",
  faulted: "fault",
  code: "fault code",
  disconnect: "disconnect",
  mitigation: "mitigation",
  leak: "leak",
  ptc: "start relay",
  potential: "potential relay",
  "hard-start": "start capacitor",
  hardstart: "start capacitor",
};

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "it", "its", "of", "on", "in", "to", "and", "or", "with", "for", "at", "by", "my", "this", "that",
  "but", "be", "has", "have", "i", "we", "you", "there", "when", "what", "how", "do", "does", "check", "test", "please",
  "from", "into", "as", "than", "then", "will", "just", "still", "keeps", "keep", "getting", "get", "got", "up", "down", "out",
]);

function normalizeToken(raw: string): string {
  let t = raw.toLowerCase();
  t = t.replace(/['’]/g, "");
  t = t.replace(/[^a-z0-9-]/g, "");
  return t;
}

/** Split text into normalized tokens; applies synonym expansion and light plural stemming. */
export function tokenize(text: string, opts: { synonyms?: boolean } = {}): string[] {
  const useSyn = opts.synonyms ?? true;
  const out: string[] = [];
  const parts = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[\s_/\\,.;:()\[\]{}"“”!?+=|<>]+/)
    .map(normalizeToken)
    .filter((t) => t.length > 0);
  for (const p of parts) {
    if (useSyn && SYNONYMS[p] !== undefined) {
      out.push(...SYNONYMS[p]!.split(" "));
      continue;
    }
    // "hums-won't-start" style hyphens: expand into parts too
    const hyphen = p.includes("-") ? p.split("-").filter(Boolean) : [];
    if (hyphen.length > 1) {
      for (const h of hyphen) {
        if (useSyn && SYNONYMS[h] !== undefined) out.push(...SYNONYMS[h]!.split(" "));
        else out.push(stem(h));
      }
      continue;
    }
    out.push(stem(p));
  }
  return out.filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 4 && t.endsWith("es") && !t.endsWith("ses")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

interface Field {
  text: string;
  weight: number;
}

/** Score = sum over distinct query tokens of the best field weight where the token occurs, plus a phrase bonus. */
function scoreEntry(queryTokens: string[], queryPhrase: string, fields: Field[]): number {
  if (queryTokens.length === 0) return 0;
  const indexed = fields.map((f) => ({ tokens: new Set(tokenize(f.text)), text: f.text.toLowerCase(), weight: f.weight }));
  let score = 0;
  let matched = 0;
  for (const qt of new Set(queryTokens)) {
    let best = 0;
    for (const f of indexed) {
      if (f.tokens.has(qt) && f.weight > best) best = f.weight;
    }
    if (best > 0) matched++;
    score += best;
  }
  if (matched === 0) return 0;
  // phrase bonus: a multi-word query appears verbatim in a high-weight field
  if (queryPhrase.length >= 3 && queryPhrase.includes(" ")) {
    for (const f of indexed) {
      if (f.weight >= 2 && f.text.includes(queryPhrase)) {
        score += 2;
        break;
      }
    }
  }
  // coverage bonus: prefer entries matching more of the query
  score += matched / queryTokens.length;
  return score;
}

/** Exact (case-insensitive) match of the whole query against an id/alias/name earns a decisive bonus. */
function exactBonus(phrase: string, exacts: string[]): number {
  if (!phrase) return 0;
  const norm = (s: string) => s.toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
  const p = norm(phrase);
  return exacts.some((e) => norm(e) === p) ? 3 : 0;
}

function rank<T>(items: T[], query: string, fieldsOf: (item: T) => Field[], exactOf: (item: T) => string[], limit = 5): T[] {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  const qTokens = tokenize(query);
  if (qTokens.length === 0 && phrase.length === 0) return [];
  const scored = items
    .map((item, index) => {
      const base = scoreEntry(qTokens, phrase, fieldsOf(item));
      return { item, index, score: base > 0 ? base + exactBonus(phrase, exactOf(item)) : 0 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.item);
}

const LIMIT = 5;

/** Fuzzy lookup by component id/name/alias (also function text and failure modes at low weight). Best ≤ 5. */
export function findComponent(kb: KnowledgeBase, query: string): ElectricalComponent[] {
  const comps = entries(kb?.electrical?.components);
  if (typeof query !== "string") return [];
  return rank(
    comps,
    query,
    (c) => [
      { text: strOf(c.id), weight: 3.5 },
      { text: strOf(c.name), weight: 3 },
      { text: joinStrings(c.aliases), weight: 2.5 },
      { text: strOf(c.function), weight: 1 },
      { text: joinStrings(c.failureModes), weight: 0.75 },
      { text: entries(c.tests).map((t) => strOf(t.name)).join(" "), weight: 0.75 },
      { text: joinStrings(c.notes), weight: 0.4 },
    ],
    (c) => [strOf(c.id), strOf(c.name), ...strings(c.aliases)],
    LIMIT,
  );
}

/** Fuzzy lookup by symptom text (id, symptom, aliases, appliesTo, common causes). Best ≤ 5. */
export function findProcedure(kb: KnowledgeBase, query: string): ElectricalProcedure[] {
  const procs = entries(kb?.electrical?.procedures);
  if (typeof query !== "string") return [];
  return rank(
    procs,
    query,
    (p) => [
      { text: strOf(p.id), weight: 3.5 },
      { text: strOf(p.symptom), weight: 3 },
      { text: joinStrings(p.aliases), weight: 2.5 },
      { text: joinStrings(p.appliesTo), weight: 1 },
      { text: joinStrings(p.commonCauses), weight: 0.6 },
      { text: entries(p.steps).map((s) => strOf(s.step)).join(" "), weight: 0.3 },
    ],
    (p) => [strOf(p.id), strOf(p.symptom), ...strings(p.aliases)],
    LIMIT,
  );
}

/** Reference topics (voltage imbalance, motor nameplates, rotation...). Best ≤ 5. */
export function findReference(kb: KnowledgeBase, query: string): { topic: string; content: string[] }[] {
  const refs = entries(kb?.electrical?.reference);
  if (typeof query !== "string") return [];
  return rank(
    refs,
    query,
    (r) => [
      { text: strOf(r.topic), weight: 3 },
      { text: joinStrings(r.content), weight: 0.5 },
    ],
    (r) => [strOf(r.topic)],
    LIMIT,
  );
}

// Defensive accessors: a non-strict load can hand us entries missing arrays or with the wrong types,
// and DESIGN says lookups never throw.
function entries<T>(v: T[] | undefined | null): T[] {
  return Array.isArray(v) ? v.filter((x): x is T => x !== null && typeof x === "object") : [];
}
function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}
function joinStrings(v: unknown): string {
  return strings(v).join(" ");
}

export type ElectricalLookupKind = "component" | "procedure" | "reference" | "any";

export interface ElectricalLookupResult {
  components: ElectricalComponent[];
  procedures: ElectricalProcedure[];
  reference: { topic: string; content: string[] }[];
}

/** Convenience for the `electrical_reference` tool / route: one query across all three collections. */
export function lookupElectrical(kb: KnowledgeBase, query: string, kind: ElectricalLookupKind = "any"): ElectricalLookupResult {
  return {
    components: kind === "component" || kind === "any" ? findComponent(kb, query) : [],
    procedures: kind === "procedure" || kind === "any" ? findProcedure(kb, query) : [],
    reference: kind === "reference" || kind === "any" ? findReference(kb, query) : [],
  };
}
