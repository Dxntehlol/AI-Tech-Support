import type {
  ChargingTargets,
  DxDerived,
  DxFinding,
  DxMeasurements,
  DxResult,
  DxRule,
  DxRuleSet,
  KnowledgeBase,
  MetricKey,
  SystemMode,
} from "../types.ts";
import { patmPsia, resolveRefrigerant, getTable, satPressuresAtTemp, seaLevelToFieldPsig, superheatSubcooling } from "./refrigerants.ts";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const COOLING_MODES: SystemMode[] = ["ac_cooling", "heat_pump_cooling"];
const VALID_MODES: SystemMode[] = ["ac_cooling", "heat_pump_cooling", "heat_pump_heating", "refrigeration"];
const VALID_METERING = ["txv", "fixed", "eev", "unknown"] as const;

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Finite number from a number or numeric string; undefined otherwise (never throws). */
function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const NUMERIC_KEYS = [
  "outdoorDbF", "indoorDbF", "indoorWbF", "mixedAirDbF", "mixedAirWbF", "supplyDbF", "suctionPsig", "suctionLineTempF",
  "liquidPsig", "dischargePsig", "liquidLineTempF", "dischargeLineTempF", "compressorAmps", "compressorAmpsL2", "compressorAmpsL3",
  "compressorRla", "capacityPercent", "runtimeMinutes", "drierInletTempF", "drierOutletTempF", "externalStaticInWc", "compressorCount",
  "activeCompressors", "standingPsig", "equalizedAmbientF", "returnRhPercent", "nameplateSubcoolingF", "nameplateSuperheatF", "elevationFt",
] as const;

/** Defensive copy: numeric fields coerced/dropped, enums defaulted. Never throws. */
function sanitize(input: DxMeasurements | undefined | null): DxMeasurements {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  for (const k of NUMERIC_KEYS) {
    const v = num(raw[k]);
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  out.refrigerant = typeof raw.refrigerant === "string" ? raw.refrigerant.trim() : "";
  out.mode = VALID_MODES.includes(raw.mode as SystemMode) ? raw.mode : "ac_cooling";
  out.meteringDevice = (VALID_METERING as readonly string[]).includes(raw.meteringDevice as string) ? raw.meteringDevice : "unknown";
  for (const b of ["dehumidReheatActive", "defrostActive", "hotGasBypass"]) {
    const v = raw[b];
    if (v === undefined || v === null) delete out[b];
    else out[b] = v === true || v === 1 || v === "true" || v === "1" || v === "yes";
  }
  return out as unknown as DxMeasurements;
}

/**
 * Wet bulb from dry bulb and relative humidity — Stull (2011) empirical fit, valid for RH 5–99 % and
 * about −4…122 °F at sea level; accuracy ≈ ±1 °F, fine for picking a chart column.
 */
export function wetBulbFromRh(dbF: number, rhPercent: number): number | undefined {
  if (!Number.isFinite(dbF) || !Number.isFinite(rhPercent)) return undefined;
  const rh = Math.min(99, Math.max(5, rhPercent));
  const t = ((dbF - 32) * 5) / 9;
  const tw =
    t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(t + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035;
  return round1((tw * 9) / 5 + 32);
}

/**
 * Bilinear interpolation on a grid with null cells. Values within one grid step outside the edge are
 * clamped to the edge; further out → undefined. When one of the four surrounding cells is null the
 * nearest grid cell to the point is returned instead (a null edge must not swallow the whole 2 F x 5 F
 * box next to it); only a null nearest cell → undefined.
 */
function bilinear(rows: number[], cols: number[], grid: (number | null)[][], r: number, c: number): number | undefined {
  if (rows.length === 0 || cols.length === 0) return undefined;
  const rStep = rows.length > 1 ? Math.abs(rows[1]! - rows[0]!) : 0;
  const cStep = cols.length > 1 ? Math.abs(cols[1]! - cols[0]!) : 0;
  const rMin = rows[0]!;
  const rMax = rows[rows.length - 1]!;
  const cMin = cols[0]!;
  const cMax = cols[cols.length - 1]!;
  if (r < rMin - rStep || r > rMax + rStep || c < cMin - cStep || c > cMax + cStep) return undefined;
  const rr = Math.min(rMax, Math.max(rMin, r));
  const cc = Math.min(cMax, Math.max(cMin, c));
  const seg = (xs: number[], x: number): [number, number, number] => {
    let i = 0;
    while (i < xs.length - 1 && xs[i + 1]! <= x) i++;
    if (i >= xs.length - 1) return [xs.length - 1, xs.length - 1, 0];
    const x0 = xs[i]!;
    const x1 = xs[i + 1]!;
    if (x === x0) return [i, i, 0];
    return [i, i + 1, (x - x0) / (x1 - x0)];
  };
  const [i0, i1, fr] = seg(rows, rr);
  const [j0, j1, fc] = seg(cols, cc);
  const cell = (i: number, j: number): number | null => grid[i]?.[j] ?? null;
  const a = cell(i0, j0);
  const b = cell(i0, j1);
  const c0 = cell(i1, j0);
  const d = cell(i1, j1);
  if (a === null || b === null || c0 === null || d === null) {
    const nearest = cell(fr < 0.5 ? i0 : i1, fc < 0.5 ? j0 : j1);
    return nearest === null ? undefined : nearest;
  }
  const top = a + (b - a) * fc;
  const bottom = c0 + (d - c0) * fc;
  return top + (bottom - top) * fr;
}

/** Target superheat for fixed-orifice systems from indoor WB / outdoor DB (interpolated). */
export function targetSuperheatFixedOrifice(kb: KnowledgeBase, indoorWbF: number, outdoorDbF: number): number | undefined {
  const chart = kb.diagnostics?.charging?.fixedOrificeSuperheat;
  if (!chart || !Number.isFinite(indoorWbF) || !Number.isFinite(outdoorDbF)) return undefined;
  if (outdoorDbF < 55) return undefined; // charging not recommended below the chart
  const v = bilinear(chart.indoorWbF, chart.outdoorDbF, chart.targetF, indoorWbF, outdoorDbF);
  return v === undefined ? undefined : round1(v);
}

/** Field tolerance on a delta-T reading (Carrier / Proctor CheckMe: within 3 °F of the chart target is acceptable). */
export const DELTA_T_TOLERANCE_F = 3;

/** Expected evaporator temperature drop from the charging-targets table (±3 °F band around the chart point), if the table covers the point. */
export function targetDeltaTFromTable(kb: KnowledgeBase, enteringDbF: number, enteringWbF: number): { min: number; max: number } | undefined {
  const t = kb.diagnostics?.charging?.targetDeltaT;
  if (!t || !Number.isFinite(enteringDbF) || !Number.isFinite(enteringWbF)) return undefined;
  const v = bilinear(t.indoorDbF, t.indoorWbF, t.targetF, enteringDbF, enteringWbF);
  if (v === undefined) return undefined;
  return { min: Math.round(v - DELTA_T_TOLERANCE_F), max: Math.round(v + DELTA_T_TOLERANCE_F) };
}

type Defaults = Omit<DxRuleSet["defaults"], "byMode">;

/** Rule-set defaults merged with the byMode override for the mode. */
export function modeDefaults(rules: DxRuleSet, mode: SystemMode): Defaults {
  const base: Defaults = {
    targetSubcoolingTxvF: 10,
    condenserSplitNormalF: { min: 15, max: 30 },
    evapTdNormalF: { min: 30, max: 40 },
    deltaTNormalF: { min: 16, max: 22 },
    dischargeTempWarnF: 225,
    dischargeTempCriticalF: 250,
    compressionRatioWarn: 4.5,
    compressionRatioAdvisory: 3.5,
    lowAmbientMinOutdoorDbF: 65,
  };
  const d = rules?.defaults ?? ({} as DxRuleSet["defaults"]);
  const { byMode, ...rest } = d;
  const override = byMode?.[mode] ?? {};
  return { ...base, ...rest, ...override };
}

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

/** Entering-air conditions with mixed-air precedence and WB fallback from RH. */
function enteringAir(m: DxMeasurements): { dbF?: number; wbF?: number; wbFromRh: boolean } {
  const dbF = m.mixedAirDbF ?? m.indoorDbF;
  let wbF = m.mixedAirWbF ?? m.indoorWbF;
  let wbFromRh = false;
  if (wbF === undefined && dbF !== undefined && m.returnRhPercent !== undefined) {
    wbF = wetBulbFromRh(dbF, m.returnRhPercent);
    wbFromRh = wbF !== undefined;
  }
  return { dbF, wbF, wbFromRh };
}

/** Compute all derived metrics the rules can reference. Never throws; unknown refrigerant → only non-PT metrics. */
export function deriveMetrics(kb: KnowledgeBase, input: DxMeasurements): DxDerived {
  const m = sanitize(input);
  const d: DxDerived = {};
  const mode = m.mode;
  const cooling = COOLING_MODES.includes(mode);
  const heating = mode === "heat_pump_heating";
  const defaults = modeDefaults(kb.diagnostics?.rules, mode);
  d.patmPsia = round2(patmPsia(m.elevationFt));

  const air = enteringAir(m);
  const highSide = m.liquidPsig ?? m.dischargePsig;
  const swapped = m.suctionPsig !== undefined && highSide !== undefined && m.suctionPsig >= highSide;
  // In heating the vapor service valve carries hot gas: a "suction" reading there is head pressure, so
  // everything derived from the suction side is left undefined (the high side and SC are still real).
  const badSuction = swapped || (heating && m.suctionMeasuredAt === "vapor_service_valve");

  // Saturation temps, SH, SC (elevation-corrected inside superheatSubcooling)
  const table = m.refrigerant ? getTable(kb, m.refrigerant) : undefined;
  if (table && !swapped) {
    const sh = superheatSubcooling(kb, m);
    if (sh.evapSatF !== undefined && !badSuction) d.evapSatF = sh.evapSatF;
    if (sh.condSatF !== undefined) d.condSatF = sh.condSatF;
    if (sh.superheatF !== undefined && !badSuction) d.superheatF = sh.superheatF;
    if (sh.subcoolingF !== undefined) d.subcoolingF = sh.subcoolingF;
  }

  // Targets (cooling and refrigeration only; heating charges by chart/weigh-in)
  if (!heating) {
    if (m.nameplateSuperheatF !== undefined) d.targetSuperheatF = m.nameplateSuperheatF;
    else if (m.meteringDevice === "fixed" && cooling && air.wbF !== undefined && m.outdoorDbF !== undefined) {
      const t = targetSuperheatFixedOrifice(kb, air.wbF, m.outdoorDbF);
      if (t !== undefined) d.targetSuperheatF = t;
    }
    if (m.nameplateSubcoolingF !== undefined) d.targetSubcoolingF = m.nameplateSubcoolingF;
    else if (m.meteringDevice === "txv" || m.meteringDevice === "eev") d.targetSubcoolingF = defaults.targetSubcoolingTxvF;
  }

  // Coil temperature differences and delta-T
  if (heating) {
    if (d.condSatF !== undefined && air.dbF !== undefined) d.indoorCoilTdF = round1(d.condSatF - air.dbF);
    if (d.evapSatF !== undefined && m.outdoorDbF !== undefined) d.evapTdF = round1(m.outdoorDbF - d.evapSatF);
    if (m.supplyDbF !== undefined && air.dbF !== undefined) d.deltaTF = round1(m.supplyDbF - air.dbF); // temperature rise
    // condenserSplitF intentionally undefined: the indoor coil is the condenser
  } else {
    if (d.condSatF !== undefined && m.outdoorDbF !== undefined) d.condenserSplitF = round1(d.condSatF - m.outdoorDbF);
    if (d.evapSatF !== undefined && air.dbF !== undefined) d.evapTdF = round1(air.dbF - d.evapSatF);
    if (m.supplyDbF !== undefined && air.dbF !== undefined) d.deltaTF = round1(air.dbF - m.supplyDbF);
    if (cooling) {
      const fromTable = air.dbF !== undefined && air.wbF !== undefined ? targetDeltaTFromTable(kb, air.dbF, air.wbF) : undefined;
      d.targetDeltaTF = fromTable ?? { ...defaults.deltaTNormalF };
    }
  }

  // Compression ratio on absolute pressures
  if (m.suctionPsig !== undefined && highSide !== undefined && !badSuction) {
    const patm = d.patmPsia;
    const lo = m.suctionPsig + patm;
    const hi = highSide + patm;
    if (lo > 0 && hi > 0) d.compressionRatio = round2(hi / lo);
  }

  if (d.condSatF !== undefined && m.dischargeLineTempF !== undefined) d.dischargeSuperheatF = round1(m.dischargeLineTempF - d.condSatF);

  // Amps: highest leg vs RLA (conservative for over-RLA; all legs low when the max is low)
  const legs = [m.compressorAmps, m.compressorAmpsL2, m.compressorAmpsL3].filter((x): x is number => x !== undefined);
  if (legs.length > 0 && m.compressorRla !== undefined && m.compressorRla > 0) {
    d.ampsPercentRla = round1((Math.max(...legs) / m.compressorRla) * 100);
  }
  if (legs.length === 3) {
    const avg = (legs[0]! + legs[1]! + legs[2]!) / 3;
    if (avg > 0) d.currentImbalancePercent = round1((Math.max(...legs.map((x) => Math.abs(x - avg))) / avg) * 100);
  }

  if (m.drierInletTempF !== undefined && m.drierOutletTempF !== undefined) d.drierTempDropF = round1(m.drierInletTempF - m.drierOutletTempF);

  // Standing pressure vs saturation at ambient (field gauge basis at elevation)
  if (table && m.standingPsig !== undefined && m.equalizedAmbientF !== undefined) {
    const p = satPressuresAtTemp(table, m.equalizedAmbientF);
    if (p) {
      const satField = seaLevelToFieldPsig(p.bubblePsig, m.elevationFt);
      d.standingExcessPsi = round1(m.standingPsig - satField);
    }
  }
  return d;
}

// ---------------------------------------------------------------------------
// Metric resolution for rules
// ---------------------------------------------------------------------------

const ENUM_CODES: Partial<Record<keyof DxMeasurements, Record<string, number>>> = {
  sightGlass: { clear: 0, bubbles: 1, flashing: 2 },
  economizerPosition: { closed: 0, minimum: 1, open: 2 },
  headPressureControl: { none: 0, unknown: 0, fan_cycling: 1, fan_vfd: 2, flooding_valve: 3 },
  suctionMeasuredAt: { compressor_suction: 0, vapor_service_valve: 1, evap_outlet: 2 },
  highSideMeasuredAt: { liquid_service_valve: 0, discharge_line: 1, vapor_service_valve: 2 },
  moistureIndicator: { dry: 0, caution: 1, wet: 2 },
  stageCommanded: { part: 0, "1": 1, "2": 2, full: 3 },
  compressorType: { recip: 0, scroll: 1, tandem_scroll: 2, digital_scroll: 3, variable_speed: 4, screw: 5 },
  meteringDevice: { fixed: 0, txv: 1, eev: 2 },
  efficiencyTier: { standard: 0, high: 1 },
};
const BOOL_KEYS: (keyof DxMeasurements)[] = ["dehumidReheatActive", "defrostActive", "hotGasBypass"];
/** Absent → 0: unconfirmed head-pressure control, false booleans, and efficiencyTier (not given = standard). */
const DEFAULT_ZERO: (keyof DxMeasurements)[] = ["headPressureControl", "efficiencyTier", ...BOOL_KEYS];

/**
 * Value of a metric for rule evaluation. Numbers come back as-is; categorical measurements are mapped
 * to the codes documented in refrigeration-cycle.json notes; strings resolve to NaN (present, not numeric).
 */
function metricValue(metric: MetricKey, m: DxMeasurements, d: DxDerived): number | undefined {
  if (metric === "superheatDelta") {
    return d.superheatF !== undefined && d.targetSuperheatF !== undefined ? round1(d.superheatF - d.targetSuperheatF) : undefined;
  }
  if (metric === "subcoolingDelta") {
    return d.subcoolingF !== undefined && d.targetSubcoolingF !== undefined ? round1(d.subcoolingF - d.targetSubcoolingF) : undefined;
  }
  if (metric === "deltaTDelta") {
    return d.deltaTF !== undefined && d.targetDeltaTF ? round1(d.deltaTF - (d.targetDeltaTF.min + d.targetDeltaTF.max) / 2) : undefined;
  }
  if (metric === "targetDeltaTF") return d.targetDeltaTF ? (d.targetDeltaTF.min + d.targetDeltaTF.max) / 2 : undefined;
  if (metric in d) {
    const v = (d as Record<string, unknown>)[metric];
    if (typeof v === "number") return v;
  }
  const mv = (m as unknown as Record<string, unknown>)[metric];
  if (mv === undefined || mv === null) {
    return DEFAULT_ZERO.includes(metric as keyof DxMeasurements) ? 0 : undefined;
  }
  if (typeof mv === "number") return Number.isFinite(mv) ? mv : undefined;
  if (typeof mv === "boolean") return mv ? 1 : 0;
  if (typeof mv === "string") {
    const codes = ENUM_CODES[metric as keyof DxMeasurements];
    if (codes) return codes[mv]; // unknown values → undefined (absent)
    return mv.trim() === "" ? undefined : Number.NaN; // present, not numeric
  }
  return undefined;
}

/** Which measurements feed a metric (for missing[]). */
function metricSources(metric: MetricKey, mode: SystemMode): (keyof DxMeasurements)[] {
  const heating = mode === "heat_pump_heating";
  switch (metric) {
    case "evapSatF": return ["suctionPsig"];
    case "condSatF": return ["liquidPsig"];
    case "superheatF": return ["suctionPsig", "suctionLineTempF"];
    case "subcoolingF": return ["liquidPsig", "liquidLineTempF"];
    case "targetSuperheatF": return ["indoorWbF", "outdoorDbF"];
    case "targetSubcoolingF": return ["nameplateSubcoolingF"];
    case "superheatDelta": return ["suctionPsig", "suctionLineTempF", "indoorWbF", "outdoorDbF"];
    case "subcoolingDelta": return ["liquidPsig", "liquidLineTempF"];
    case "condenserSplitF": return ["liquidPsig", "outdoorDbF"];
    case "evapTdF": return heating ? ["suctionPsig", "outdoorDbF"] : ["suctionPsig", "indoorDbF"];
    case "deltaTF": return ["indoorDbF", "supplyDbF"];
    case "targetDeltaTF": return ["indoorDbF", "indoorWbF"];
    case "deltaTDelta": return ["indoorDbF", "supplyDbF", "indoorWbF"];
    case "indoorCoilTdF": return ["liquidPsig", "indoorDbF"];
    case "compressionRatio": return ["suctionPsig", "liquidPsig"];
    case "patmPsia": return ["elevationFt"];
    case "dischargeSuperheatF": return ["dischargeLineTempF", "liquidPsig"];
    case "ampsPercentRla": return ["compressorAmps", "compressorRla"];
    case "currentImbalancePercent": return ["compressorAmps", "compressorAmpsL2", "compressorAmpsL3"];
    case "drierTempDropF": return ["drierInletTempF", "drierOutletTempF"];
    case "standingExcessPsi": return ["standingPsig", "equalizedAmbientF"];
    default: return [metric as keyof DxMeasurements];
  }
}

const HUMAN_NAMES: Partial<Record<keyof DxMeasurements, string>> = {
  suctionPsig: "suction pressure (psig) at the suction service valve",
  suctionLineTempF: "suction line temperature (°F) about 6 in. from the suction service valve / compressor",
  liquidPsig: "liquid line pressure (psig) at the liquid service valve",
  liquidLineTempF: "liquid line temperature (°F) at the liquid service valve",
  dischargePsig: "compressor discharge pressure (psig)",
  dischargeLineTempF: "discharge line temperature (°F) 6 in. from the compressor",
  outdoorDbF: "outdoor dry bulb (°F) at the condenser air inlet",
  indoorDbF: "evaporator entering air dry bulb (°F) (return or mixed air)",
  indoorWbF: "evaporator entering air wet bulb (°F) (or return RH %)",
  supplyDbF: "supply air dry bulb (°F)",
  compressorAmps: "compressor running amps",
  compressorAmpsL2: "compressor amps on L2",
  compressorAmpsL3: "compressor amps on L3",
  compressorRla: "nameplate compressor RLA",
  nameplateSubcoolingF: "nameplate subcooling target (°F)",
  nameplateSuperheatF: "nameplate superheat target (°F)",
  drierInletTempF: "filter drier inlet temperature (°F)",
  drierOutletTempF: "filter drier outlet temperature (°F)",
  standingPsig: "standing pressure with the unit off 30+ min (psig)",
  equalizedAmbientF: "ambient temperature at the equalized unit (°F)",
  headPressureControl: "head-pressure control type (fan cycling / fan VFD / flooding valve / none)",
  externalStaticInWc: "external static pressure (in. wc)",
  runtimeMinutes: "minutes of run time at this stage",
  capacityPercent: "commanded compressor capacity (%)",
  economizerPosition: "economizer damper position",
  sightGlass: "sight glass condition",
  moistureIndicator: "moisture indicator color",
  elevationFt: "site elevation (ft)",
  mixedAirDbF: "mixed-air dry bulb (°F)",
  mixedAirWbF: "mixed-air wet bulb (°F)",
  returnRhPercent: "return air relative humidity (%)",
  compressorCount: "number of compressors on the circuit",
  stageCommanded: "commanded stage",
  suctionMeasuredAt: "where the suction pressure was read",
  hotGasBypass: "whether hot-gas bypass is active",
  defrostActive: "whether defrost is active",
};

const MISSING_ORDER: (keyof DxMeasurements)[] = [
  "suctionPsig", "liquidPsig", "suctionLineTempF", "liquidLineTempF", "outdoorDbF", "indoorDbF", "indoorWbF", "supplyDbF",
  "compressorAmps", "compressorRla", "dischargeLineTempF", "headPressureControl", "compressorAmpsL2", "compressorAmpsL3",
  "nameplateSubcoolingF", "nameplateSuperheatF", "drierInletTempF", "drierOutletTempF", "standingPsig", "equalizedAmbientF",
  "externalStaticInWc", "sightGlass", "runtimeMinutes", "capacityPercent", "elevationFt",
];

/** Measurements whose absence always weakens the diagnosis in this mode. */
function coreMeasurements(m: DxMeasurements): (keyof DxMeasurements)[] {
  switch (m.mode) {
    case "heat_pump_heating":
      return ["outdoorDbF", "indoorDbF", "suctionPsig", "suctionLineTempF", "liquidPsig", "dischargeLineTempF", "supplyDbF"];
    case "refrigeration":
      return ["suctionPsig", "suctionLineTempF", "liquidPsig", "liquidLineTempF", "outdoorDbF", "indoorDbF", "compressorAmps", "compressorRla", "dischargeLineTempF"];
    default: {
      const core: (keyof DxMeasurements)[] = ["suctionPsig", "suctionLineTempF", "liquidPsig", "liquidLineTempF", "outdoorDbF", "indoorDbF"];
      if (m.meteringDevice === "fixed") core.push("indoorWbF");
      core.push("supplyDbF", "compressorAmps", "compressorRla");
      return core;
    }
  }
}

function isMeasurementMissing(m: DxMeasurements, key: keyof DxMeasurements): boolean {
  const v = (m as unknown as Record<string, unknown>)[key];
  if (v !== undefined && v !== null && v !== "") return false;
  // equivalents
  if (key === "indoorDbF") return m.mixedAirDbF === undefined;
  if (key === "indoorWbF") return m.mixedAirWbF === undefined && m.returnRhPercent === undefined;
  if (key === "liquidPsig") return m.dischargePsig === undefined;
  return true;
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<DxFinding["severity"], number> = { critical: 4, warning: 3, advisory: 2, info: 1 };
const CONFIDENCE_RANK: Record<DxFinding["confidence"], number> = { high: 3, medium: 2, low: 1 };

/** Metrics that mean nothing when the gauges are swapped / unit off. */
const PRESSURE_METRICS: Set<MetricKey> = new Set([
  "evapSatF", "condSatF", "superheatF", "subcoolingF", "superheatDelta", "subcoolingDelta", "condenserSplitF", "evapTdF",
  "indoorCoilTdF", "compressionRatio", "dischargeSuperheatF", "standingExcessPsi",
]);
/**
 * Metrics derived from the suction reading: meaningless when the low-side gauge sits on the heating-mode
 * vapor service valve (hot gas). Discharge superheat is included because its diagnoses (wet compression,
 * reversing-valve leak-by) are suction-side conclusions that need a trusted suction reading.
 */
const SUCTION_METRICS: Set<MetricKey> = new Set(["evapSatF", "superheatF", "superheatDelta", "evapTdF", "compressionRatio", "dischargeSuperheatF"]);

function ruleApplies(rule: DxRule, m: DxMeasurements): boolean {
  const a = rule.appliesTo;
  if (!a) return true;
  if (a.mode && a.mode.length > 0 && !a.mode.includes(m.mode)) return false;
  if (a.meteringDevice && a.meteringDevice.length > 0 && !a.meteringDevice.includes(m.meteringDevice)) return false;
  return true;
}

interface RuleEval {
  fires: boolean;
  /** all defined clauses passed but ≥1 numeric clause had an undefined metric */
  blocked: boolean;
  missingMetrics: MetricKey[];
}

function evaluateRule(rule: DxRule, m: DxMeasurements, d: DxDerived): RuleEval {
  let allDefinedPass = true;
  let definedPassCount = 0;
  const missingMetrics: MetricKey[] = [];
  if (!Array.isArray(rule.when) || rule.when.length === 0) return { fires: false, blocked: false, missingMetrics };
  for (const c of rule.when) {
    if (!c || typeof c.metric !== "string") return { fires: false, blocked: false, missingMetrics: [] };
    const v = metricValue(c.metric, m, d);
    const present = v !== undefined;
    if (c.op === "present") {
      if (!present) allDefinedPass = false;
      else definedPassCount++;
      continue;
    }
    if (c.op === "absent") {
      if (present) allDefinedPass = false;
      else definedPassCount++;
      continue;
    }
    if (v === undefined || Number.isNaN(v)) {
      if (v === undefined) missingMetrics.push(c.metric);
      else allDefinedPass = false; // non-numeric string with a numeric op never fires
      continue;
    }
    const a = typeof c.value === "number" ? c.value : Number.NaN;
    let pass: boolean;
    switch (c.op) {
      case ">": pass = v > a; break;
      case ">=": pass = v >= a; break;
      case "<": pass = v < a; break;
      case "<=": pass = v <= a; break;
      case "between": {
        const b = typeof c.value2 === "number" ? c.value2 : Number.NaN;
        pass = v >= Math.min(a, b) && v <= Math.max(a, b);
        break;
      }
      default: pass = false;
    }
    if (Number.isNaN(a)) pass = false;
    if (!pass) allDefinedPass = false;
    else definedPassCount++;
  }
  const fires = allDefinedPass && missingMetrics.length === 0;
  // "blocked" = the readings we do have point at this rule and only missing data keeps it from firing
  const blocked = allDefinedPass && missingMetrics.length > 0 && definedPassCount > 0;
  return { fires, blocked, missingMetrics };
}

function rankFindings(findings: { f: DxFinding; priority: number; order: number }[]): DxFinding[] {
  findings.sort((x, y) => {
    const s = SEVERITY_RANK[y.f.severity] - SEVERITY_RANK[x.f.severity];
    if (s !== 0) return s;
    const c = CONFIDENCE_RANK[y.f.confidence] - CONFIDENCE_RANK[x.f.confidence];
    if (c !== 0) return c;
    if (y.priority !== x.priority) return y.priority - x.priority;
    return x.order - y.order;
  });
  const seen = new Set<string>();
  const out: DxFinding[] = [];
  for (const { f } of findings) {
    if (seen.has(f.ruleId)) continue;
    seen.add(f.ruleId);
    out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validity gate
// ---------------------------------------------------------------------------

function validityIssues(m: DxMeasurements, d: DxDerived, defaults: Defaults): string[] {
  const issues: string[] = [];
  const cooling = COOLING_MODES.includes(m.mode);
  if (m.mode === "heat_pump_heating") {
    issues.push("heating mode: cooling superheat/subcooling charging charts do not apply — charge by the manufacturer heating check chart or weigh-in");
  }
  if (cooling || m.mode === "refrigeration") {
    const headOk = m.headPressureControl === "fan_cycling" || m.headPressureControl === "fan_vfd" || m.headPressureControl === "flooding_valve";
    const base = defaults.lowAmbientMinOutdoorDbF ?? 65;
    const min = m.meteringDevice === "fixed" && d.targetSuperheatF !== undefined ? Math.min(base, 60) : base;
    if (m.outdoorDbF === undefined) {
      issues.push(`outdoor dry bulb not given — cannot confirm ambient is at least ${base} °F (or that head-pressure control is holding)`);
    } else if (m.outdoorDbF < min && !headOk) {
      issues.push(`outdoor ${m.outdoorDbF} °F is below ${min} °F without confirmed head-pressure control`);
    }
  }
  if (cooling && m.meteringDevice === "fixed" && m.nameplateSuperheatF === undefined && d.targetSuperheatF === undefined) {
    const air = enteringAir(m);
    if (air.wbF !== undefined && m.outdoorDbF !== undefined) {
      issues.push(`fixed-orifice chart gives no target at indoor WB ${air.wbF} °F / outdoor DB ${m.outdoorDbF} °F (charging not recommended)`);
    }
  }
  if (m.economizerPosition === "open") issues.push("economizer open — entering air is mixed air, load is off-chart");
  if (m.capacityPercent !== undefined && m.capacityPercent < 100) issues.push(`compressor at ${m.capacityPercent} % capacity (part load)`);
  if (m.stageCommanded === "part") issues.push("part stage commanded");
  else if (m.stageCommanded === "1" && (m.compressorCount ?? 1) > 1) issues.push("only stage 1 running on a multi-compressor circuit");
  if (m.compressorCount !== undefined && m.activeCompressors !== undefined && m.activeCompressors < m.compressorCount) {
    issues.push(`${m.activeCompressors} of ${m.compressorCount} compressors running`);
  }
  if ((m.compressorType === "digital_scroll" || m.compressorType === "variable_speed") && m.capacityPercent === undefined) {
    issues.push(`${m.compressorType.replace("_", " ")} compressor with unknown capacity — confirm 100 % before judging charge`);
  }
  if (m.runtimeMinutes !== undefined && m.runtimeMinutes < 10) issues.push(`only ${m.runtimeMinutes} min of run time (need 10-15)`);
  if (m.dehumidReheatActive) issues.push("dehumidification / hot-gas reheat active");
  if (m.defrostActive) issues.push("defrost active");
  return issues;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const MODE_LABEL: Record<SystemMode, string> = {
  ac_cooling: "AC cooling",
  heat_pump_cooling: "heat pump cooling",
  heat_pump_heating: "heat pump heating",
  refrigeration: "refrigeration",
};
const METERING_LABEL: Record<DxMeasurements["meteringDevice"], string> = { txv: "TXV", fixed: "fixed orifice", eev: "EEV", unknown: "unknown metering" };

function readingsSentence(id: string, m: DxMeasurements, d: DxDerived): string {
  const parts: string[] = [];
  if (m.suctionPsig !== undefined) {
    let s = `suction ${m.suctionPsig} psig`;
    if (d.evapSatF !== undefined) s += ` (evap sat ${d.evapSatF} °F)`;
    if (d.superheatF !== undefined) s += `, SH ${d.superheatF} °F` + (d.targetSuperheatF !== undefined ? ` vs target ${d.targetSuperheatF} °F` : "");
    parts.push(s);
  }
  const high = m.liquidPsig ?? m.dischargePsig;
  if (high !== undefined) {
    let s = `${m.liquidPsig !== undefined ? "liquid" : "discharge"} ${high} psig`;
    if (d.condSatF !== undefined) s += ` (cond sat ${d.condSatF} °F)`;
    if (d.subcoolingF !== undefined) s += `, SC ${d.subcoolingF} °F` + (d.targetSubcoolingF !== undefined ? ` vs target ${d.targetSubcoolingF} °F` : "");
    parts.push(s);
  }
  if (d.condenserSplitF !== undefined) parts.push(`split ${d.condenserSplitF} °F`);
  if (d.indoorCoilTdF !== undefined) parts.push(`indoor coil TD ${d.indoorCoilTdF} °F`);
  if (d.evapTdF !== undefined) parts.push(`${m.mode === "heat_pump_heating" ? "outdoor coil" : "evap"} TD ${d.evapTdF} °F`);
  if (d.deltaTF !== undefined) {
    parts.push(`${m.mode === "heat_pump_heating" ? "rise" : "delta-T"} ${d.deltaTF} °F` + (d.targetDeltaTF ? ` (expect ${d.targetDeltaTF.min}-${d.targetDeltaTF.max})` : ""));
  }
  if (d.compressionRatio !== undefined) parts.push(`CR ${d.compressionRatio}`);
  if (d.ampsPercentRla !== undefined) parts.push(`amps ${d.ampsPercentRla} % RLA`);
  if (d.dischargeSuperheatF !== undefined) parts.push(`discharge SH ${d.dischargeSuperheatF} °F`);
  const head = `${id || "unknown refrigerant"} ${METERING_LABEL[m.meteringDevice]}, ${MODE_LABEL[m.mode]}`;
  return parts.length ? `${head}: ${parts.join("; ")}.` : `${head}: no gauge readings given.`;
}

// ---------------------------------------------------------------------------
// Diagnose
// ---------------------------------------------------------------------------

/** Full diagnosis: derived metrics + ranked rule findings + missing measurements + summary. Never throws. */
export function diagnose(kb: KnowledgeBase, input: DxMeasurements): DxResult {
  const m = sanitize(input);
  try {
    return diagnoseInner(kb, m);
  } catch (e) {
    return {
      measurements: m,
      derived: {},
      validity: { ok: false, issues: ["internal error while evaluating readings"] },
      findings: [
        {
          ruleId: "engine_error",
          condition: "Diagnosis could not be completed",
          severity: "info",
          confidence: "low",
          explanation: `The rule engine hit an internal error (${(e as Error)?.message ?? "unknown"}). Re-check the inputs and try again.`,
          nextChecks: ["Re-enter the readings with numeric values and a known refrigerant."],
        },
      ],
      missing: [],
      summary: "The diagnosis could not be completed because of an internal error. Re-check the readings and try again.",
    };
  }
}

function diagnoseInner(kb: KnowledgeBase, m: DxMeasurements): DxResult {
  const ruleSet: DxRuleSet = kb.diagnostics?.rules ?? { version: "0", defaults: modeDefaults({ version: "0", defaults: {} as DxRuleSet["defaults"], rules: [] }, m.mode), rules: [] };
  const rules = Array.isArray(ruleSet.rules) ? ruleSet.rules : [];
  const byId = new Map<string, DxRule>();
  for (const r of rules) if (r && typeof r.id === "string") byId.set(r.id, r);
  const defaults = modeDefaults(ruleSet, m.mode);
  const meta = m.refrigerant ? resolveRefrigerant(kb, m.refrigerant) : undefined;
  const table = m.refrigerant ? getTable(kb, m.refrigerant) : undefined;
  const refId = meta?.id ?? (m.refrigerant || "");
  const heating = m.mode === "heat_pump_heating";
  const cooling = COOLING_MODES.includes(m.mode);

  const ranked: { f: DxFinding; priority: number; order: number }[] = [];
  let order = 0;
  const push = (f: DxFinding, priority = 0): void => {
    ranked.push({ f, priority, order: order++ });
  };
  const findingFromRule = (rule: DxRule): DxFinding => {
    const f: DxFinding = {
      ruleId: rule.id,
      condition: rule.condition,
      severity: rule.severity,
      confidence: rule.confidence,
      explanation: rule.explanation,
      nextChecks: Array.isArray(rule.nextChecks) ? [...rule.nextChecks] : [],
    };
    if (rule.safety && rule.safety.length) f.safety = [...rule.safety];
    return f;
  };

  // ---- 1. Sanity gate
  const highSide = m.liquidPsig ?? m.dischargePsig;
  const swapped = m.suctionPsig !== undefined && highSide !== undefined && m.suctionPsig >= highSide;
  const badSuction = swapped || (heating && m.suctionMeasuredAt === "vapor_service_valve");
  if (swapped) {
    push(
      {
        ruleId: "readings_swapped_or_off",
        condition: "Readings look swapped or unit off (suction ≥ liquid pressure)",
        severity: "warning",
        confidence: "high",
        explanation: `Suction ${m.suctionPsig} psig is not below the high side ${highSide} psig. A running compressor always holds suction well below head; either the hoses/gauges are swapped, the readings were taken with the compressor off (pressures equalize), the pressure was read at the wrong port (heating-mode vapor valve), or the compressor is not pumping at all. Charge rules are skipped until this is sorted. Follows the basic gauge sanity check in every manufacturer charging procedure.`,
        nextChecks: [
          "Confirm the compressor is running (amps on the compressor leads); expect 60-90 % of RLA.",
          "Confirm the low-side hose is on the suction service valve and the high-side hose on the liquid valve; expect suction well below liquid within a minute of start.",
          "If both pressures really are equal with the compressor energized and drawing amps: suspect a compressor that is not pumping (broken valves/scroll, reversed rotation) or a stuck-open reversing/hot-gas valve.",
        ],
        safety: ["Never add refrigerant on readings you cannot explain."],
      },
      100,
    );
  }
  if (m.refrigerant && !table) {
    push({
      ruleId: "unknown_refrigerant",
      condition: `No PT data for refrigerant "${m.refrigerant}"`,
      severity: "info",
      confidence: "high",
      explanation: `The refrigerant "${m.refrigerant}" is not in the PT tables, so saturation temperatures, superheat, subcooling and the charge rules cannot be computed. Check the nameplate/retrofit sticker for the exact designation (e.g. R-410A, R-22, R-407C, R-454B) and re-run. Follows the assistant's provenance rule: no PT values from memory.`,
      nextChecks: ["Read the refrigerant designation off the unit nameplate or retrofit sticker and re-run with that id; expect one of the tabulated refrigerants."],
      safety: ["Never mix refrigerants; if the charge is unknown, use a refrigerant identifier before recovery."],
    });
  } else if (!m.refrigerant) {
    push({
      ruleId: "unknown_refrigerant",
      condition: "Refrigerant not given",
      severity: "info",
      confidence: "high",
      explanation: "No refrigerant was specified, so pressures cannot be converted to saturation temperatures and no superheat/subcooling rule can run. Follows the assistant's provenance rule: no PT values from memory.",
      nextChecks: ["Read the refrigerant off the nameplate or retrofit sticker (R-410A, R-22, R-454B ...) and re-run."],
    });
  }

  // ---- 2. Derived metrics
  const d = deriveMetrics(kb, m);
  const air = enteringAir(m);

  // A saturation temperature above the PT table top came from the extrapolated tail: usable for the
  // airflow / non-condensable rules but approximate, so say so.
  if (table && !swapped && superheatSubcooling(kb, m).extrapolated) {
    push(
      {
        ruleId: "pt_extrapolated",
        condition: `Pressure above the ${refId} PT table — saturation temperature extrapolated (approximate)`,
        severity: "info",
        confidence: "medium",
        explanation: `A reading is above the ${refId} table top (160 °F), so the saturation temperature was extrapolated from the table tail with a Clausius–Clapeyron fit; it is close but approximate. Do not make charge decisions from it. A head pressure this high is itself the finding.`,
        nextChecks: [
          "Verify the gauge on a known reference and confirm the refrigerant on the nameplate.",
          "Check the high-pressure switch setting and why it has not tripped; check condenser airflow, coil cleanliness and non-condensables.",
        ],
      },
      5,
    );
  }

  // Implausible saturation temps for the stated refrigerant (sanity gate, continued)
  if (table && !swapped) {
    const reasons: string[] = [];
    if (heating) {
      if (!badSuction && d.evapSatF !== undefined && m.outdoorDbF !== undefined && d.evapSatF > m.outdoorDbF + 2) reasons.push(`evaporating sat ${d.evapSatF} °F is above outdoor air ${m.outdoorDbF} °F`);
      if (d.condSatF !== undefined && air.dbF !== undefined && d.condSatF < air.dbF - 2) reasons.push(`condensing sat ${d.condSatF} °F is below indoor entering air ${air.dbF} °F`);
    } else {
      if (d.evapSatF !== undefined && air.dbF !== undefined && d.evapSatF > air.dbF + 2) reasons.push(`evaporating sat ${d.evapSatF} °F is above entering air ${air.dbF} °F`);
      if (d.condSatF !== undefined && m.outdoorDbF !== undefined && d.condSatF < m.outdoorDbF - 2) reasons.push(`condensing sat ${d.condSatF} °F is below outdoor air ${m.outdoorDbF} °F`);
    }
    if (reasons.length) {
      const base = byId.get("wrong_refrigerant");
      const f: DxFinding = base
        ? findingFromRule(base)
        : {
            ruleId: "wrong_refrigerant",
            condition: "Saturation temperatures impossible for the stated refrigerant — verify refrigerant and gauges",
            severity: "advisory",
            confidence: "low",
            explanation: "Follows the PT-chart sanity check in the Carrier/RSES troubleshooting guidance.",
            nextChecks: ["Verify the refrigerant on the nameplate/retrofit sticker and check gauge calibration."],
          };
      f.explanation = `${reasons.join("; ")} — impossible while running on ${refId}. ${f.explanation}`;
      push(f, base?.priority ?? 65);
    }
  }

  // Fixed orifice with a null chart cell: no superheat target at these conditions (charging not recommended)
  if (cooling && !swapped && m.meteringDevice === "fixed" && m.nameplateSuperheatF === undefined && d.targetSuperheatF === undefined && air.wbF !== undefined && m.outdoorDbF !== undefined) {
    push(
      {
        ruleId: "fixed_chart_no_target",
        condition: `Fixed-orifice chart has no superheat target at indoor WB ${air.wbF} °F / outdoor DB ${m.outdoorDbF} °F`,
        severity: "advisory",
        confidence: "high",
        explanation: `The fixed-orifice superheat chart has no target at this indoor wet bulb / outdoor dry bulb (the published chart leaves the cell blank where the required superheat would be under 5 °F or the outdoor air is below 55 °F): charging by superheat is not recommended here. Raise the indoor load (close doors/windows, run the blower with the space warm, wait for a higher return wet bulb) or use the manufacturer charging chart / weigh-in to the nameplate charge instead. Follows the published fixed-orifice superheat charging chart (Carrier / Goodman / Trane; ACCA Manual T).`,
        nextChecks: [
          "Re-measure entering wet bulb and outdoor dry bulb after the space has warmed (or the sun is off the condenser); expect a chart cell with a target once WB rises about 4 °F.",
          "If the load cannot be raised: recover, evacuate and weigh in the nameplate charge (plus line-set allowance), then confirm superheat later at valid conditions.",
        ],
        safety: ["Never add refrigerant without a leak check and a valid superheat target; a null chart cell is not a license to guess."],
      },
      58,
    );
  }

  // ---- 3. Validity gate
  const issues = validityIssues(m, d, defaults);
  if (swapped) issues.unshift("suction pressure is not below the high-side pressure — gauges swapped or unit off");
  const validity = { ok: issues.length === 0, issues };

  // ---- 4. Rules
  const blockedSources = new Set<keyof DxMeasurements>();
  for (const rule of rules) {
    if (!rule || typeof rule.id !== "string" || !Array.isArray(rule.when)) continue;
    if (!ruleApplies(rule, m)) continue;
    if (swapped && (rule.chargeRelated || rule.when.some((c) => PRESSURE_METRICS.has(c.metric)))) continue;
    if (badSuction && rule.when.some((c) => SUCTION_METRICS.has(c.metric))) continue;
    if (!table && rule.when.some((c) => PRESSURE_METRICS.has(c.metric))) continue;
    const ev = evaluateRule(rule, m, d);
    if (ev.fires) {
      const f = findingFromRule(rule);
      if (rule.chargeRelated && !validity.ok) {
        f.severity = "info";
        f.condition = `readings not valid for charge determination: ${f.condition}`;
        f.explanation = `readings not valid for charge determination (${issues.join("; ")}) — do not add or remove refrigerant on these readings. Pattern seen: ${f.explanation}`;
      }
      push(f, rule.priority ?? 0);
    } else if (ev.blocked) {
      for (const metric of ev.missingMetrics) {
        for (const src of metricSources(metric, m.mode)) if (isMeasurementMissing(m, src)) blockedSources.add(src);
      }
    }
  }

  // Scope advisory from free-text notes (VRF / mini-split / chiller)
  if (m.notes && /\b(vrf|vrv|mini[\s-]?split|ductless|chiller)\b/i.test(m.notes)) {
    const base = byId.get("vrf_chiller_scope");
    if (base) push(findingFromRule(base), base.priority ?? 25);
  }

  const findings = rankFindings(ranked);

  // ---- 5. Missing measurements (prioritized, human names)
  const missingKeys = new Set<keyof DxMeasurements>();
  if (heating && m.outdoorDbF === undefined) missingKeys.add("outdoorDbF");
  for (const k of coreMeasurements(m)) if (isMeasurementMissing(m, k)) missingKeys.add(k);
  for (const k of blockedSources) missingKeys.add(k);
  if ((cooling || m.mode === "refrigeration") && m.outdoorDbF !== undefined && m.outdoorDbF < (defaults.lowAmbientMinOutdoorDbF ?? 65) && (m.headPressureControl === undefined || m.headPressureControl === "unknown")) {
    missingKeys.add("headPressureControl");
  }
  const orderIdx = (k: keyof DxMeasurements): number => {
    const i = MISSING_ORDER.indexOf(k);
    return i < 0 ? 999 : i;
  };
  const missingSorted = [...missingKeys].sort((a, b) => orderIdx(a) - orderIdx(b));
  if (heating) {
    const i = missingSorted.indexOf("outdoorDbF");
    if (i > 0) {
      missingSorted.splice(i, 1);
      missingSorted.unshift("outdoorDbF");
    }
  }
  const missing = missingSorted.slice(0, 8).map((k) => HUMAN_NAMES[k] ?? String(k));

  // ---- 6. Summary (2–4 sentences)
  const sentences: string[] = [readingsSentence(refId, m, d)];
  const top = findings[0];
  if (top) {
    const sevWord = top.severity === "info" ? "note" : top.severity;
    sentences.push(`Top finding (${sevWord}, ${top.confidence} confidence): ${top.condition}.`);
  } else {
    sentences.push("No abnormal pattern found in the readings given.");
  }
  if (validity.ok) {
    sentences.push(heating ? "Readings usable for heating checks." : "Readings are valid for charge determination (ambient, stage, run time and airflow conditions met).");
  } else {
    sentences.push(`Not valid for charge determination: ${issues.join("; ")}.`);
  }
  if (missing.length && sentences.length < 4) {
    sentences.push(`Would sharpen the diagnosis: ${missing.slice(0, 3).join(", ")}.`);
  }

  return { measurements: m, derived: d, validity, findings, missing, summary: sentences.join(" ") };
}
