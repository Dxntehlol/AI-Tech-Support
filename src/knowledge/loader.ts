import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ChargingTargets,
  DxRuleSet,
  ElectricalComponent,
  ElectricalKnowledge,
  ElectricalProcedure,
  KnowledgeBase,
  ManufacturerPack,
  RefrigerantMeta,
  RefrigerantTable,
  SerialFormat,
} from "../types.ts";
import { analyzeRegex } from "./decoder.ts";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));
}

export interface LoadOptions {
  /** Throw if a pack fails validation (default true). */
  strict?: boolean;
}

export class KnowledgeValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Knowledge validation failed:\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Enumerations (mirrors src/types.ts — keep in sync)
// ---------------------------------------------------------------------------

export const CONFIDENCES = new Set(["high", "medium", "low"]);
export const EVIDENCE_LEVELS = new Set(["manufacturer_doc", "multi_secondary", "single_secondary", "inferred"]);
export const PRODUCT_TYPES = new Set([
  "packaged_rtu",
  "split_condensing_unit",
  "split_heat_pump",
  "air_handler",
  "furnace",
  "chiller",
  "vrf_outdoor",
  "vrf_indoor",
  "mini_split",
  "water_source_hp",
  "compressor",
  "refrigeration_condensing_unit",
  "other",
]);
export const MODEL_ATTRIBUTES = new Set([
  "unit_type",
  "series",
  "tonnage",
  "refrigerant",
  "voltage",
  "heat_type",
  "heat_capacity",
  "efficiency",
  "controls",
  "revision",
  "compressor_type",
  "stages",
  "airflow",
  "cabinet",
  "options",
  "other",
]);
export const TRANSFORMS = new Set(["mbh_to_tons", "tons_x10", "kbtuh", "raw", "map_tons"]);
export const DATE_METHODS = new Set(["twoDigitYear", "oneDigitYear", "decadeDigitYear", "letterYear", "fourDigitYear", "manual"]);
export const SAFETY_CLASSES = new Set(["A1", "A2L", "A2", "A3", "B1", "B2L", "B2", "B3"]);
export const METERING_DEVICES = new Set(["txv", "fixed", "eev", "unknown"]);
export const SYSTEM_MODES = new Set(["ac_cooling", "heat_pump_cooling", "heat_pump_heating", "refrigeration"]);
export const DX_SEVERITIES = new Set(["info", "advisory", "warning", "critical"]);
export const DX_OPS = new Set([">", ">=", "<", "<=", "between", "present", "absent"]);

/** Numeric DxDerived keys (all except targetDeltaTF, which is a {min,max} object). */
export const DX_DERIVED_NUMERIC_KEYS = [
  "evapSatF",
  "condSatF",
  "superheatF",
  "subcoolingF",
  "targetSuperheatF",
  "targetSubcoolingF",
  "condenserSplitF",
  "evapTdF",
  "deltaTF",
  "indoorCoilTdF",
  "compressionRatio",
  "patmPsia",
  "dischargeSuperheatF",
  "ampsPercentRla",
  "currentImbalancePercent",
  "drierTempDropF",
  "standingExcessPsi",
] as const;
export const DX_DERIVED_OBJECT_KEYS = ["targetDeltaTF"] as const;
export const DX_MEASUREMENT_NUMERIC_KEYS = [
  "outdoorDbF",
  "indoorDbF",
  "indoorWbF",
  "mixedAirDbF",
  "mixedAirWbF",
  "supplyDbF",
  "suctionPsig",
  "suctionLineTempF",
  "liquidPsig",
  "dischargePsig",
  "liquidLineTempF",
  "dischargeLineTempF",
  "compressorAmps",
  "compressorAmpsL2",
  "compressorAmpsL3",
  "compressorRla",
  "capacityPercent",
  "runtimeMinutes",
  "drierInletTempF",
  "drierOutletTempF",
  "externalStaticInWc",
  "compressorCount",
  "activeCompressors",
  "standingPsig",
  "equalizedAmbientF",
  "returnRhPercent",
  "nameplateSubcoolingF",
  "nameplateSuperheatF",
  "elevationFt",
] as const;
/**
 * Categorical / boolean measurements that the diagnostics engine exposes to `when[]` as numeric codes
 * (see refrigeration-cycle.json notes: sightGlass clear=0 bubbles=1 flashing=2, headPressureControl none=0 …,
 * efficiencyTier standard=0 high=1, booleans false=0 true=1). Numeric ops are therefore legal on them.
 */
export const DX_MEASUREMENT_ENUM_CODED_KEYS = [
  "economizerPosition",
  "compressorType",
  "stageCommanded",
  "headPressureControl",
  "dehumidReheatActive",
  "defrostActive",
  "sightGlass",
  "moistureIndicator",
  "suctionMeasuredAt",
  "highSideMeasuredAt",
  "hotGasBypass",
  "efficiencyTier",
] as const;
/** Free-text / identifier measurements: only present/absent make sense. */
export const DX_MEASUREMENT_STRING_KEYS = ["refrigerant", "meteringDevice", "mode", "circuit", "notes"] as const;
export const DX_DELTA_KEYS = ["superheatDelta", "subcoolingDelta", "deltaTDelta"] as const;

/** Every MetricKey (DxDerived keys + DxMeasurements keys + superheatDelta/subcoolingDelta/deltaTDelta). */
export const METRIC_KEYS = new Set<string>([
  ...DX_DERIVED_NUMERIC_KEYS,
  ...DX_DERIVED_OBJECT_KEYS,
  ...DX_MEASUREMENT_NUMERIC_KEYS,
  ...DX_MEASUREMENT_ENUM_CODED_KEYS,
  ...DX_MEASUREMENT_STRING_KEYS,
  ...DX_DELTA_KEYS,
]);
/** MetricKeys on which numeric comparison ops are allowed (numbers, enum-coded categoricals, deltas). */
export const NUMERIC_METRIC_KEYS = new Set<string>([
  ...DX_DERIVED_NUMERIC_KEYS,
  ...DX_MEASUREMENT_NUMERIC_KEYS,
  ...DX_MEASUREMENT_ENUM_CODED_KEYS,
  ...DX_DELTA_KEYS,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.trim().length > 0);
}

/** Validate a pack regex: compiles, anchored ^…$, ≤ 400 chars, no nested quantifiers. Returns the group count (or null when unusable). */
function checkRegex(where: string, regex: unknown, problems: string[]): number | null {
  const a = analyzeRegex(regex);
  if (!a.ok) {
    problems.push(`${where}: ${a.reason}`);
    return null;
  }
  if (!a.anchored) problems.push(`${where}: regex must be anchored ^...$`);
  return a.groups;
}

function checkGroupRef(where: string, label: string, idx: unknown, groups: number | null, problems: string[], required = false): void {
  if (idx === undefined || idx === null) {
    if (required) problems.push(`${where}: ${label} is required`);
    return;
  }
  if (!Number.isInteger(idx) || (idx as number) < 1) {
    problems.push(`${where}: ${label} must be a positive integer (got ${JSON.stringify(idx)})`);
    return;
  }
  if (groups !== null && (idx as number) > groups) problems.push(`${where}: ${label} = ${idx} exceeds the regex group count (${groups})`);
}

function checkNumberMap(where: string, label: string, map: unknown, min: number, max: number, problems: string[], required = false): void {
  if (map === undefined || map === null) {
    if (required) problems.push(`${where}: ${label} is required`);
    return;
  }
  if (typeof map !== "object" || Array.isArray(map)) {
    problems.push(`${where}: ${label} must be an object`);
    return;
  }
  const entries = Object.entries(map as Record<string, unknown>);
  if (required && entries.length === 0) problems.push(`${where}: ${label} is empty`);
  for (const [k, v] of entries) {
    if (!isNum(v) || v < min || v > max) problems.push(`${where}: ${label}["${k}"] = ${JSON.stringify(v)} outside ${min}..${max}`);
  }
}

function checkConfidence(where: string, confidence: unknown, problems: string[]): string {
  if (!CONFIDENCES.has(confidence as string)) {
    problems.push(`${where}: confidence must be high|medium|low (got ${JSON.stringify(confidence)})`);
    return "low";
  }
  return confidence as string;
}

function checkHighNeedsSources(where: string, confidence: string, sources: unknown, problems: string[]): void {
  if (confidence === "high" && !isNonEmptyStringArray(sources)) problems.push(`${where}: high confidence requires non-empty sources[]`);
}

function checkEvidence(where: string, evidence: unknown, problems: string[]): void {
  if (evidence !== undefined && !EVIDENCE_LEVELS.has(evidence as string)) problems.push(`${where}: unknown evidence level ${JSON.stringify(evidence)}`);
}

// ---------------------------------------------------------------------------
// Manufacturer packs
// ---------------------------------------------------------------------------

function validateSerialFormat(where: string, sf: SerialFormat, problems: string[]): void {
  const groups = checkRegex(where, sf.regex, problems);
  const confidence = checkConfidence(where, sf.confidence, problems);
  checkHighNeedsSources(where, confidence, sf.sources, problems);
  checkEvidence(where, sf.evidence, problems);
  if (!sf.description) problems.push(`${where}: description is required`);
  if (sf.eraStart !== undefined && !isNum(sf.eraStart)) problems.push(`${where}: eraStart must be a number`);
  if (sf.eraEnd !== undefined && !isNum(sf.eraEnd)) problems.push(`${where}: eraEnd must be a number`);
  if (isNum(sf.eraStart) && isNum(sf.eraEnd) && sf.eraEnd < sf.eraStart) problems.push(`${where}: eraEnd < eraStart`);

  const date = sf.date as Record<string, unknown> | undefined;
  if (!date || typeof date !== "object") {
    problems.push(`${where}: missing date rule`);
  } else if (!DATE_METHODS.has(date.method as string)) {
    problems.push(`${where}: unknown date method ${JSON.stringify(date.method)}`);
  } else if (date.method === "manual") {
    if (typeof date.note !== "string" || !date.note.trim()) problems.push(`${where}: manual date rule needs a note`);
  } else {
    checkGroupRef(where, "date.yearGroup", date.yearGroup, groups, problems, true);
    checkGroupRef(where, "date.monthGroup", date.monthGroup, groups, problems);
    checkGroupRef(where, "date.weekGroup", date.weekGroup, groups, problems);
    checkGroupRef(where, "date.dayOfYearGroup", date.dayOfYearGroup, groups, problems);
    if (date.method === "decadeDigitYear") {
      checkGroupRef(where, "date.decadeGroup", date.decadeGroup, groups, problems, true);
      checkNumberMap(where, "date.decadeMap", date.decadeMap, 1900, 2100, problems);
    }
    if (date.method === "letterYear") checkNumberMap(where, "date.map", date.map, 1965, 2100, problems, true);
    if (date.method === "twoDigitYear") {
      checkNumberMap(where, "date.yearMap", date.yearMap, 1965, 2100, problems);
      if (date.pivot !== undefined && (!isNum(date.pivot) || date.pivot < 0 || date.pivot > 99)) problems.push(`${where}: date.pivot must be 0..99`);
    }
    if (date.method === "oneDigitYear" && !isNum(date.decadeBase)) problems.push(`${where}: oneDigitYear needs a numeric decadeBase`);
    checkNumberMap(where, "date.monthLetterMap", date.monthLetterMap, 1, 12, problems);
  }

  if (sf.plant !== undefined) {
    if (!sf.plant || typeof sf.plant !== "object") problems.push(`${where}: plant must be an object`);
    else {
      checkGroupRef(where, "plant.group", sf.plant.group, groups, problems, true);
      if (sf.plant.map !== undefined && (typeof sf.plant.map !== "object" || sf.plant.map === null)) problems.push(`${where}: plant.map must be an object`);
    }
  }

  const examples = Array.isArray(sf.examples) ? sf.examples : [];
  if (confidence !== "low" && examples.length < 2) problems.push(`${where}: needs >= 2 serial examples for ${confidence} confidence (has ${examples.length})`);
  examples.forEach((ex, i) => {
    if (!ex || typeof ex !== "object" || typeof ex.serial !== "string" || !ex.serial.trim()) problems.push(`${where}: example[${i}] needs a serial`);
    else if (!ex.expect || typeof ex.expect !== "object") problems.push(`${where}: example[${i}] (${ex.serial}) needs an expect object`);
  });
}

/** Structural + depth validation of a manufacturer pack (DESIGN.md "Loader validation"). */
export function validateManufacturerPack(pack: ManufacturerPack, problems: string[]): void {
  const where = `manufacturers/${pack?.id ?? "?"}`;
  if (!pack || typeof pack !== "object") {
    problems.push(`${where}: pack is not an object`);
    return;
  }
  if (!pack.id || !pack.manufacturer) problems.push(`${where}: id and manufacturer are required`);
  if (!Array.isArray(pack.brands) || pack.brands.length === 0) problems.push(`${where}: brands[] required`);
  const packConfidence = checkConfidence(where, pack.confidence, problems);
  checkHighNeedsSources(where, packConfidence, pack.sources, problems);
  for (const key of ["serialFormats", "modelFormats", "controls", "commonIssues"] as const) {
    if (!Array.isArray(pack[key])) problems.push(`${where}: ${key}[] is required`);
  }

  const seenSerial = new Set<string>();
  for (const sf of Array.isArray(pack.serialFormats) ? pack.serialFormats : []) {
    const w = `${where}: serialFormat ${sf?.id ?? "?"}`;
    if (!sf || typeof sf !== "object" || !sf.id) {
      problems.push(`${w}: id is required`);
      continue;
    }
    if (seenSerial.has(sf.id)) problems.push(`${w}: duplicate id`);
    seenSerial.add(sf.id);
    validateSerialFormat(w, sf, problems);
  }

  const controlIds = new Set((Array.isArray(pack.controls) ? pack.controls : []).map((c) => c?.id).filter(Boolean));
  const seenModel = new Set<string>();
  for (const mf of Array.isArray(pack.modelFormats) ? pack.modelFormats : []) {
    const w = `${where}: modelFormat ${mf?.id ?? "?"}`;
    if (!mf || typeof mf !== "object" || !mf.id) {
      problems.push(`${w}: id is required`);
      continue;
    }
    if (seenModel.has(mf.id)) problems.push(`${w}: duplicate id`);
    seenModel.add(mf.id);
    const groups = checkRegex(w, mf.regex, problems);
    if (!mf.family) problems.push(`${w}: missing family`);
    if (!PRODUCT_TYPES.has(mf.productType as string)) problems.push(`${w}: unknown productType ${JSON.stringify(mf.productType)}`);
    const confidence = checkConfidence(w, mf.confidence, problems);
    checkHighNeedsSources(w, confidence, mf.sources, problems);
    checkEvidence(w, mf.evidence, problems);
    if (!Array.isArray(mf.segments)) problems.push(`${w}: segments[] required`);
    (Array.isArray(mf.segments) ? mf.segments : []).forEach((seg, i) => {
      const sw = `${w} segment[${i}]`;
      if (!seg || typeof seg !== "object") {
        problems.push(`${sw}: not an object`);
        return;
      }
      checkGroupRef(sw, "group", seg.group, groups, problems, true);
      if (!seg.name) problems.push(`${sw}: name is required`);
      if (seg.attribute !== undefined && !MODEL_ATTRIBUTES.has(seg.attribute)) problems.push(`${sw}: unknown attribute ${JSON.stringify(seg.attribute)}`);
      if (seg.transform !== undefined && !TRANSFORMS.has(seg.transform)) problems.push(`${sw}: unknown transform ${JSON.stringify(seg.transform)}`);
      if (seg.transform === "map_tons" && (!seg.map || typeof seg.map !== "object")) problems.push(`${sw}: map_tons requires a map`);
      if (seg.map !== undefined && (typeof seg.map !== "object" || seg.map === null || Array.isArray(seg.map))) problems.push(`${sw}: map must be an object`);
    });
    for (const id of Array.isArray(mf.controlPlatformIds) ? mf.controlPlatformIds : []) {
      if (!controlIds.has(id)) problems.push(`${w}: controlPlatformIds references unknown control platform "${id}"`);
    }
    const examples = Array.isArray(mf.examples) ? mf.examples : [];
    if (confidence !== "low" && examples.length < 1) problems.push(`${w}: needs >= 1 model example for ${confidence} confidence`);
    examples.forEach((ex, i) => {
      if (!ex || typeof ex !== "object" || typeof ex.model !== "string" || !ex.model.trim()) problems.push(`${w}: example[${i}] needs a model`);
      else if (!ex.expect || typeof ex.expect !== "object") problems.push(`${w}: example[${i}] (${ex.model}) needs an expect object`);
      else {
        for (const k of Object.keys(ex.expect)) {
          if (k !== "family" && !MODEL_ATTRIBUTES.has(k)) problems.push(`${w}: example[${i}] (${ex.model}) expects unknown attribute "${k}"`);
        }
      }
    });
  }

  const seenControl = new Set<string>();
  for (const c of Array.isArray(pack.controls) ? pack.controls : []) {
    const w = `${where}: control ${c?.id ?? "?"}`;
    if (!c || typeof c !== "object" || !c.id || !c.name) {
      problems.push(`${where}: control platform missing id/name`);
      continue;
    }
    if (seenControl.has(c.id)) problems.push(`${w}: duplicate id`);
    seenControl.add(c.id);
    const confidence = checkConfidence(w, c.confidence, problems);
    checkHighNeedsSources(w, confidence, c.sources, problems);
    if (c.coverage !== undefined && c.coverage !== "complete" && c.coverage !== "partial") problems.push(`${w}: coverage must be complete|partial`);
    const codes = Array.isArray(c.faultCodes) ? c.faultCodes : [];
    if (codes.length === 0) problems.push(`${w}: needs >= 1 fault code`);
    for (const fc of codes) {
      if (!fc || typeof fc !== "object" || !fc.code || !fc.meaning) problems.push(`${w}: has a fault code without code/meaning`);
      else checkEvidence(`${w} code ${fc.code}`, fc.evidence, problems);
    }
    for (const led of Array.isArray(c.ledPatterns) ? c.ledPatterns : []) {
      if (!led || typeof led !== "object" || !led.pattern || !led.meaning) problems.push(`${w}: has an LED pattern without pattern/meaning`);
    }
  }

  (Array.isArray(pack.electrical) ? pack.electrical : []).forEach((e, i) => {
    const w = `${where}: electrical[${i}]`;
    if (!e || typeof e !== "object") {
      problems.push(`${w}: not an object`);
      return;
    }
    if (!e.familyLabel) problems.push(`${w}: familyLabel is required`);
    if (e.familyRegex !== undefined) {
      try {
        new RegExp(e.familyRegex, "i");
      } catch (err) {
        problems.push(`${w}: familyRegex invalid: ${(err as Error).message}`);
      }
    }
    if (!Array.isArray(e.components)) problems.push(`${w}: components[] required`);
    else {
      e.components.forEach((comp, j) => {
        if (!comp || typeof comp !== "object" || !comp.designator || !comp.name) problems.push(`${w}: component[${j}] needs designator and name`);
      });
    }
    const confidence = checkConfidence(w, e.confidence, problems);
    checkHighNeedsSources(w, confidence, e.sources, problems);
    checkEvidence(w, e.evidence, problems);
  });

  (Array.isArray(pack.commonIssues) ? pack.commonIssues : []).forEach((ci, i) => {
    const w = `${where}: commonIssue[${i}]`;
    if (!ci || typeof ci !== "object") {
      problems.push(`${w}: not an object`);
      return;
    }
    if (!ci.symptom) problems.push(`${w}: symptom is required`);
    if (!isNonEmptyStringArray(ci.likelyCauses)) problems.push(`${w}: likelyCauses[] required`);
    if (!isNonEmptyStringArray(ci.checks)) problems.push(`${w}: checks[] required`);
    if (ci.appliesTo !== undefined) {
      try {
        new RegExp(ci.appliesTo, "i");
      } catch (err) {
        problems.push(`${w}: appliesTo regex invalid: ${(err as Error).message}`);
      }
    }
    if (ci.confidence !== undefined) {
      const confidence = checkConfidence(w, ci.confidence, problems);
      checkHighNeedsSources(w, confidence, ci.sources, problems);
    }
    checkEvidence(w, ci.evidence, problems);
  });
}

// ---------------------------------------------------------------------------
// Refrigerants
// ---------------------------------------------------------------------------

/**
 * Validate refrigerants/index.json against the loaded tables. `indexExists` false is itself a problem
 * in strict mode; the reverse check (every table has an entry) runs only when the index exists.
 */
export function validateRefrigerantIndex(
  meta: RefrigerantMeta[] | undefined,
  tables: Map<string, RefrigerantTable>,
  problems: string[],
  opts: { indexExists: boolean; strict: boolean },
): void {
  const where = "refrigerants/index.json";
  if (!opts.indexExists) {
    if (opts.strict) problems.push(`${where}: missing (required in strict mode)`);
    return;
  }
  if (!Array.isArray(meta)) {
    problems.push(`${where}: must be an array of RefrigerantMeta`);
    return;
  }
  const seen = new Set<string>();
  for (const m of meta) {
    const id = m?.id;
    if (!m || typeof m !== "object" || typeof id !== "string" || !id) {
      problems.push(`${where}: entry without id`);
      continue;
    }
    const key = id.toUpperCase();
    if (seen.has(key)) problems.push(`${where}: duplicate entry ${id}`);
    seen.add(key);
    if (!tables.has(key)) problems.push(`${where}: ${id} has no table file`);
    if (!SAFETY_CLASSES.has(m.safetyClass)) problems.push(`${where}: ${id} safetyClass ${JSON.stringify(m.safetyClass)} is not an ASHRAE 34 class`);
    if (!m.gwp || !isNum(m.gwp.ar4)) problems.push(`${where}: ${id} gwp.ar4 must be a number`);
    if (!Array.isArray(m.aliases)) problems.push(`${where}: ${id} aliases[] required`);
    if (m.type !== undefined && !["pure", "azeotrope", "zeotrope"].includes(m.type)) problems.push(`${where}: ${id} type must be pure|azeotrope|zeotrope`);
  }
  for (const key of tables.keys()) {
    if (!seen.has(key)) problems.push(`${where}: table ${tables.get(key)?.id ?? key} has no index entry`);
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export function validateRuleSet(rules: DxRuleSet, problems: string[]): void {
  const where = "diagnostics/refrigeration-cycle.json";
  if (!rules || typeof rules !== "object") {
    problems.push(`${where}: not an object`);
    return;
  }
  if (!rules.defaults || typeof rules.defaults !== "object") problems.push(`${where}: defaults required`);
  else {
    const d = rules.defaults;
    for (const k of ["targetSubcoolingTxvF", "dischargeTempWarnF", "dischargeTempCriticalF", "compressionRatioWarn"] as const) {
      if (!isNum(d[k])) problems.push(`${where}: defaults.${k} must be a number`);
    }
    for (const k of ["condenserSplitNormalF", "evapTdNormalF", "deltaTNormalF"] as const) {
      const r = d[k];
      if (!r || !isNum(r.min) || !isNum(r.max) || r.min > r.max) problems.push(`${where}: defaults.${k} must be {min <= max}`);
    }
    if (d.byMode !== undefined) {
      for (const mode of Object.keys(d.byMode)) if (!SYSTEM_MODES.has(mode)) problems.push(`${where}: defaults.byMode has unknown mode "${mode}"`);
    }
  }
  if (!Array.isArray(rules.rules)) {
    problems.push(`${where}: rules[] required`);
    return;
  }
  const seen = new Set<string>();
  rules.rules.forEach((r, i) => {
    const w = `${where}: rule ${r?.id ?? `#${i}`}`;
    if (!r || typeof r !== "object" || !r.id || !Array.isArray(r.when) || r.when.length === 0) {
      problems.push(`${w} malformed (id and non-empty when[] required)`);
      return;
    }
    if (seen.has(r.id)) problems.push(`${w}: duplicate id`);
    seen.add(r.id);
    if (!r.condition) problems.push(`${w}: condition label required`);
    if (!DX_SEVERITIES.has(r.severity)) problems.push(`${w}: unknown severity ${JSON.stringify(r.severity)}`);
    if (!CONFIDENCES.has(r.confidence)) problems.push(`${w}: unknown confidence ${JSON.stringify(r.confidence)}`);
    if (!r.explanation) problems.push(`${w}: explanation required`);
    if (!Array.isArray(r.nextChecks)) problems.push(`${w}: nextChecks[] required`);
    if (r.appliesTo !== undefined) {
      if (!r.appliesTo || typeof r.appliesTo !== "object") problems.push(`${w}: appliesTo must be an object`);
      else {
        for (const md of r.appliesTo.meteringDevice ?? []) if (!METERING_DEVICES.has(md)) problems.push(`${w}: appliesTo.meteringDevice has unknown "${md}"`);
        for (const mode of r.appliesTo.mode ?? []) if (!SYSTEM_MODES.has(mode)) problems.push(`${w}: appliesTo.mode has unknown "${mode}"`);
      }
    }
    r.when.forEach((c, j) => {
      const cw = `${w} when[${j}]`;
      if (!c || typeof c !== "object") {
        problems.push(`${cw}: not an object`);
        return;
      }
      if (!METRIC_KEYS.has(c.metric)) problems.push(`${cw}: unknown metric "${c.metric}"`);
      if (!DX_OPS.has(c.op)) {
        problems.push(`${cw}: unknown op "${c.op}"`);
        return;
      }
      if (c.op === "present" || c.op === "absent") return;
      if (METRIC_KEYS.has(c.metric) && !NUMERIC_METRIC_KEYS.has(c.metric)) problems.push(`${cw}: numeric op "${c.op}" on non-numeric metric "${c.metric}"`);
      if (!isNum(c.value)) problems.push(`${cw}: op "${c.op}" needs a numeric value`);
      if (c.op === "between") {
        if (!isNum(c.value2)) problems.push(`${cw}: between needs value2`);
        else if (isNum(c.value) && c.value2 < c.value) problems.push(`${cw}: between has value2 < value`);
      }
    });
  });
}

function checkGrid(where: string, rows: unknown, cols: unknown, grid: unknown, problems: string[]): void {
  if (!Array.isArray(rows) || !rows.every(isNum)) problems.push(`${where}: row axis must be a number[]`);
  if (!Array.isArray(cols) || !cols.every(isNum)) problems.push(`${where}: column axis must be a number[]`);
  if (!Array.isArray(grid)) {
    problems.push(`${where}: targetF must be a 2-D array`);
    return;
  }
  const nRows = Array.isArray(rows) ? rows.length : 0;
  const nCols = Array.isArray(cols) ? cols.length : 0;
  if (grid.length !== nRows) problems.push(`${where}: targetF has ${grid.length} rows, expected ${nRows}`);
  grid.forEach((row, i) => {
    if (!Array.isArray(row)) problems.push(`${where}: targetF[${i}] is not an array`);
    else {
      if (row.length !== nCols) problems.push(`${where}: targetF[${i}] has ${row.length} columns, expected ${nCols}`);
      row.forEach((cell, j) => {
        if (cell !== null && !isNum(cell)) problems.push(`${where}: targetF[${i}][${j}] must be a number or null`);
      });
    }
  });
}

export function validateChargingTargets(ct: ChargingTargets, problems: string[]): void {
  const where = "diagnostics/charging-targets.json";
  if (!ct || typeof ct !== "object") {
    problems.push(`${where}: not an object`);
    return;
  }
  if (!ct.fixedOrificeSuperheat || typeof ct.fixedOrificeSuperheat !== "object") problems.push(`${where}: fixedOrificeSuperheat required`);
  else checkGrid(`${where}: fixedOrificeSuperheat`, ct.fixedOrificeSuperheat.indoorWbF, ct.fixedOrificeSuperheat.outdoorDbF, ct.fixedOrificeSuperheat.targetF, problems);
  if (ct.targetDeltaT !== undefined) {
    if (!ct.targetDeltaT || typeof ct.targetDeltaT !== "object") problems.push(`${where}: targetDeltaT must be an object`);
    else checkGrid(`${where}: targetDeltaT`, ct.targetDeltaT.indoorDbF, ct.targetDeltaT.indoorWbF, ct.targetDeltaT.targetF, problems);
  }
  if (!Array.isArray(ct.notes)) problems.push(`${where}: notes[] required`);
}

// ---------------------------------------------------------------------------
// Electrical (components.json / procedures.json)
// ---------------------------------------------------------------------------

/** Spec minimums (DESIGN.md "Electrical"): enforced when the file is present. */
export const MIN_ELECTRICAL_COMPONENTS = 22;
export const MIN_ELECTRICAL_PROCEDURES = 16;

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function checkString(where: string, label: string, v: unknown, problems: string[]): void {
  if (typeof v !== "string" || v.trim().length === 0) problems.push(`${where}: ${label} must be a non-empty string`);
}

function checkStringArray(where: string, label: string, v: unknown, problems: string[], required = true): void {
  if (v === undefined && !required) return;
  if (!isStringArray(v)) problems.push(`${where}: ${label} must be a string array`);
}

/** Shape checks for ElectricalComponent[]: id/name/function strings; tests[] (name, energized, steps[], expected); failureModes[]; safety[]. */
export function validateElectricalComponents(components: unknown, problems: string[], where = "electrical/components.json"): void {
  if (!Array.isArray(components)) {
    problems.push(`${where}: components[] required`);
    return;
  }
  const seen = new Set<string>();
  components.forEach((c: Partial<ElectricalComponent> | null, i) => {
    const w = `${where}: components[${i}]`;
    if (!c || typeof c !== "object") {
      problems.push(`${w}: not an object`);
      return;
    }
    checkString(w, "id", c.id, problems);
    checkString(w, "name", c.name, problems);
    checkString(w, "function", c.function, problems);
    if (typeof c.id === "string") {
      if (seen.has(c.id)) problems.push(`${w}: duplicate component id ${c.id}`);
      seen.add(c.id);
    }
    checkStringArray(w, "aliases", c.aliases, problems, false);
    checkStringArray(w, "failureModes", c.failureModes, problems);
    checkStringArray(w, "safety", c.safety, problems);
    checkStringArray(w, "tools", c.tools, problems, false);
    checkStringArray(w, "notes", c.notes, problems, false);
    if (!Array.isArray(c.tests)) problems.push(`${w}: tests[] required`);
    else {
      c.tests.forEach((t: Partial<ElectricalComponent["tests"][number]> | null, j) => {
        const tw = `${w}.tests[${j}]`;
        if (!t || typeof t !== "object") {
          problems.push(`${tw}: not an object`);
          return;
        }
        checkString(tw, "name", t.name, problems);
        if (typeof t.energized !== "boolean") problems.push(`${tw}: energized must be a boolean`);
        checkStringArray(tw, "steps", t.steps, problems);
        checkString(tw, "expected", t.expected, problems);
        if (t.tolerance !== undefined && typeof t.tolerance !== "string") problems.push(`${tw}: tolerance must be a string`);
      });
    }
  });
}

/** Shape checks for ElectricalProcedure[]: id/symptom strings; safety[]; steps[] with step strings; commonCauses[]. */
export function validateElectricalProcedures(procedures: unknown, problems: string[], where = "electrical/procedures.json"): void {
  if (!Array.isArray(procedures)) {
    problems.push(`${where}: procedures[] required`);
    return;
  }
  const seen = new Set<string>();
  procedures.forEach((p: Partial<ElectricalProcedure> | null, i) => {
    const w = `${where}: procedures[${i}]`;
    if (!p || typeof p !== "object") {
      problems.push(`${w}: not an object`);
      return;
    }
    checkString(w, "id", p.id, problems);
    checkString(w, "symptom", p.symptom, problems);
    if (typeof p.id === "string") {
      if (seen.has(p.id)) problems.push(`${w}: duplicate procedure id ${p.id}`);
      seen.add(p.id);
    }
    checkStringArray(w, "aliases", p.aliases, problems, false);
    checkStringArray(w, "appliesTo", p.appliesTo, problems, false);
    checkStringArray(w, "safety", p.safety, problems);
    checkStringArray(w, "commonCauses", p.commonCauses, problems);
    if (!Array.isArray(p.steps)) problems.push(`${w}: steps[] required`);
    else {
      p.steps.forEach((s: Partial<ElectricalProcedure["steps"][number]> | null, j) => {
        const sw = `${w}.steps[${j}]`;
        if (!s || typeof s !== "object") {
          problems.push(`${sw}: not an object`);
          return;
        }
        checkString(sw, "step", s.step, problems);
        if (s.expect !== undefined && typeof s.expect !== "string") problems.push(`${sw}: expect must be a string`);
        if (s.ifNot !== undefined && typeof s.ifNot !== "string") problems.push(`${sw}: ifNot must be a string`);
      });
    }
  });
}

/** Shape checks for reference topics: { topic, content[] }. */
export function validateElectricalReference(reference: unknown, problems: string[], where = "electrical/components.json"): void {
  if (reference === undefined) return; // optional
  if (!Array.isArray(reference)) {
    problems.push(`${where}: reference must be an array`);
    return;
  }
  reference.forEach((r: Partial<ElectricalKnowledge["reference"][number]> | null, i) => {
    const w = `${where}: reference[${i}]`;
    if (!r || typeof r !== "object") {
      problems.push(`${w}: not an object`);
      return;
    }
    checkString(w, "topic", r.topic, problems);
    checkStringArray(w, "content", r.content, problems);
  });
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadKnowledge(dir: string, opts: LoadOptions = {}): KnowledgeBase {
  const strict = opts.strict ?? true;
  const problems: string[] = [];

  const manufacturers: ManufacturerPack[] = [];
  const seenPackIds = new Set<string>();
  for (const file of listJson(join(dir, "manufacturers"))) {
    try {
      const pack = readJson<ManufacturerPack>(file);
      validateManufacturerPack(pack, problems);
      if (pack?.id) {
        if (seenPackIds.has(pack.id)) problems.push(`${file}: duplicate pack id ${pack.id}`);
        seenPackIds.add(pack.id);
      }
      manufacturers.push(pack);
    } catch (e) {
      problems.push(`${file}: ${(e as Error).message}`);
    }
  }

  const refDir = join(dir, "refrigerants");
  const metaPath = join(refDir, "index.json");
  const indexExists = existsSync(metaPath);
  let meta: RefrigerantMeta[] = [];
  if (indexExists) {
    try {
      meta = readJson<RefrigerantMeta[]>(metaPath);
    } catch (e) {
      problems.push(`${metaPath}: ${(e as Error).message}`);
    }
  }
  const tables = new Map<string, RefrigerantTable>();
  for (const file of listJson(refDir)) {
    if (file.endsWith("index.json") || /[\/\\]_[^\/\\]*$/.test(file)) continue;
    try {
      const t = readJson<RefrigerantTable>(file);
      if (!t.id || !Array.isArray(t.tempF) || t.tempF.length !== t.bubblePsig?.length || t.tempF.length !== t.dewPsig?.length) {
        problems.push(`${file}: malformed refrigerant table`);
        continue;
      }
      tables.set(t.id.toUpperCase(), t);
    } catch (e) {
      problems.push(`${file}: ${(e as Error).message}`);
    }
  }
  validateRefrigerantIndex(meta, tables, problems, { indexExists, strict });
  if (!Array.isArray(meta)) meta = [];

  const rulesPath = join(dir, "diagnostics", "refrigeration-cycle.json");
  const chargingPath = join(dir, "diagnostics", "charging-targets.json");
  const defaultRules: DxRuleSet = {
    version: "0",
    defaults: {
      targetSubcoolingTxvF: 10,
      condenserSplitNormalF: { min: 15, max: 30 },
      evapTdNormalF: { min: 30, max: 40 },
      deltaTNormalF: { min: 16, max: 22 },
      dischargeTempWarnF: 225,
      dischargeTempCriticalF: 250,
      compressionRatioWarn: 4,
    },
    rules: [],
  };
  const defaultCharging: ChargingTargets = { version: "0", fixedOrificeSuperheat: { indoorWbF: [], outdoorDbF: [], targetF: [] }, notes: [] };
  let rules: DxRuleSet = defaultRules;
  let charging: ChargingTargets = defaultCharging;
  if (existsSync(rulesPath)) {
    try {
      rules = readJson<DxRuleSet>(rulesPath);
      validateRuleSet(rules, problems);
      if (!rules || typeof rules !== "object" || !Array.isArray(rules.rules)) rules = defaultRules;
    } catch (e) {
      problems.push(`${rulesPath}: ${(e as Error).message}`);
    }
  }
  if (existsSync(chargingPath)) {
    try {
      charging = readJson<ChargingTargets>(chargingPath);
      validateChargingTargets(charging, problems);
      if (!charging || typeof charging !== "object" || !charging.fixedOrificeSuperheat) charging = defaultCharging;
    } catch (e) {
      problems.push(`${chargingPath}: ${(e as Error).message}`);
    }
  }

  const elDir = join(dir, "electrical");
  const compPath = join(elDir, "components.json");
  const procPath = join(elDir, "procedures.json");
  const electrical: ElectricalKnowledge = { version: "0", components: [], procedures: [], reference: [] };
  if (existsSync(compPath)) {
    try {
      const raw = readJson<Partial<ElectricalKnowledge>>(compPath);
      if (!raw || typeof raw !== "object") throw new Error("not an object");
      electrical.version = raw.version ?? "0";
      electrical.components = Array.isArray(raw.components) ? raw.components : [];
      electrical.reference = Array.isArray(raw.reference) ? raw.reference : [];
      validateElectricalComponents(raw.components, problems, compPath);
      validateElectricalReference(raw.reference, problems, compPath);
      if (Array.isArray(raw.components) && raw.components.length < MIN_ELECTRICAL_COMPONENTS) {
        problems.push(`${compPath}: ${raw.components.length} components, spec minimum is ${MIN_ELECTRICAL_COMPONENTS}`);
      }
    } catch (e) {
      problems.push(`${compPath}: ${(e as Error).message}`);
    }
  }
  if (existsSync(procPath)) {
    try {
      const raw = readJson<Partial<ElectricalKnowledge>>(procPath);
      if (!raw || typeof raw !== "object") throw new Error("not an object");
      electrical.procedures = Array.isArray(raw.procedures) ? raw.procedures : [];
      validateElectricalProcedures(raw.procedures, problems, procPath);
      validateElectricalReference(raw.reference, problems, procPath);
      if (Array.isArray(raw.procedures) && raw.procedures.length < MIN_ELECTRICAL_PROCEDURES) {
        problems.push(`${procPath}: ${raw.procedures.length} procedures, spec minimum is ${MIN_ELECTRICAL_PROCEDURES}`);
      }
      if (Array.isArray(raw.reference) && raw.reference.length) electrical.reference = [...electrical.reference, ...raw.reference];
    } catch (e) {
      problems.push(`${procPath}: ${(e as Error).message}`);
    }
  }

  if (problems.length && strict) throw new KnowledgeValidationError(problems);
  if (problems.length) console.warn(`[knowledge] ${problems.length} problem(s):\n- ${problems.join("\n- ")}`);

  return { manufacturers, refrigerants: { meta, tables }, diagnostics: { rules, charging }, electrical };
}
