/**
 * Shared contracts for the HVAC Field Assistant.
 *
 * FROZEN: parallel builders code against these types. Add optional fields only;
 * do not rename or remove anything without updating DESIGN.md.
 */

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export type Confidence = "high" | "medium" | "low";

/**
 * Provenance of a manufacturer-specific claim:
 *  manufacturer_doc  = manufacturer nomenclature sheet / IOM / service manual (cite doc id or title)
 *  multi_secondary   = two or more independent third-party sources agree
 *  single_secondary  = one third-party source
 *  inferred          = pattern inference / memory (must be confidence "low")
 */
export type EvidenceLevel = "manufacturer_doc" | "multi_secondary" | "single_secondary" | "inferred";

export type ProductType =
  | "packaged_rtu"
  | "split_condensing_unit"
  | "split_heat_pump"
  | "air_handler"
  | "furnace"
  | "chiller"
  | "vrf_outdoor"
  | "vrf_indoor"
  | "mini_split"
  | "water_source_hp"
  | "compressor"
  | "refrigeration_condensing_unit"
  | "other";

export type MeteringDevice = "txv" | "fixed" | "eev" | "unknown";

export type SystemMode =
  | "ac_cooling"
  | "heat_pump_cooling"
  | "heat_pump_heating"
  | "refrigeration";

// ---------------------------------------------------------------------------
// Manufacturer packs  (knowledge/manufacturers/<id>.json)
// ---------------------------------------------------------------------------

export interface ManufacturerPack {
  id: string; // e.g. "carrier"
  manufacturer: string; // e.g. "Carrier"
  brands: string[]; // brands whose nameplates use these formats
  aliases?: string[]; // extra spellings for matching user input
  serialFormats: SerialFormat[];
  modelFormats: ModelFormat[];
  controls: ControlPlatform[];
  electrical?: FamilyElectrical[];
  commonIssues: CommonIssue[];
  support?: SupportInfo;
  notes?: string[];
  sources?: string[];
  confidence: Confidence;
  lastReviewed?: string; // ISO date
}

export interface SerialFormat {
  id: string;
  description: string;
  eraStart?: number; // first model year this format applies to
  eraEnd?: number; // last model year
  regex: string; // anchored (^...$), matched case-insensitively against the trimmed serial
  date: SerialDateRule;
  plant?: { group: number; map?: Record<string, string> };
  examples?: SerialExample[];
  confidence: Confidence;
  evidence?: EvidenceLevel;
  sources?: string[];
  lastVerified?: string;
  notes?: string[]; // include how to disambiguate ambiguous year digits (nameplate style, refrigerant, compressor date)
}

export interface SerialExample {
  serial: string;
  expect: { year?: number; month?: number; week?: number; dayOfYear?: number };
}

/**
 * Serial date rules. Month may be numeric (monthGroup) or a letter (monthGroup + monthLetterMap).
 * The engine rejects a match whose month ∉ 1..12, week ∉ 1..53, dayOfYear ∉ 1..366 or year ∉ 1965..now+1,
 * and falls through to the next format. Era (eraStart/eraEnd on the format) further filters candidates.
 */
export type SerialDateRule =
  | {
      method: "twoDigitYear"; // YY -> year using pivot (default 70: yy >= 70 → 19yy, else 20yy), or yearMap
      yearGroup: number;
      pivot?: number;
      yearMap?: Record<string, number>; // non-linear mappings ("00" -> 2000 ...)
      weekGroup?: number;
      monthGroup?: number;
      monthLetterMap?: Record<string, number>;
      dayOfYearGroup?: number;
    }
  | {
      method: "oneDigitYear"; // single digit + decadeBase (e.g. Trane 2002-2009: "7" -> 2007)
      yearGroup: number;
      decadeBase: number;
      weekGroup?: number;
      monthGroup?: number;
      monthLetterMap?: Record<string, number>;
      dayOfYearGroup?: number;
    }
  | {
      method: "decadeDigitYear"; // decade digit + year digit (e.g. York style); year = decadeMap[d] (default 2000+10*d) + y
      decadeGroup: number;
      yearGroup: number;
      decadeMap?: Record<string, number>;
      weekGroup?: number;
      monthGroup?: number;
      monthLetterMap?: Record<string, number>;
    }
  | {
      method: "letterYear"; // letter -> year via map
      yearGroup: number;
      map: Record<string, number>;
      weekGroup?: number;
      monthGroup?: number;
      monthLetterMap?: Record<string, number>; // letter -> 1..12
      dayOfYearGroup?: number;
    }
  | {
      method: "fourDigitYear";
      yearGroup: number;
      weekGroup?: number;
      monthGroup?: number;
      monthLetterMap?: Record<string, number>;
      dayOfYearGroup?: number;
    }
  | {
      method: "manual"; // engine cannot compute; note explains how to read it
      note: string;
    };

export type ModelAttribute =
  | "unit_type"
  | "series"
  | "tonnage"
  | "refrigerant"
  | "voltage"
  | "heat_type"
  | "heat_capacity"
  | "efficiency"
  | "controls"
  | "revision"
  | "compressor_type"
  | "stages"
  | "airflow"
  | "cabinet"
  | "options"
  | "other";

export interface ModelSegment {
  group: number; // regex capture group index (1-based)
  name: string; // human label, e.g. "Nominal cooling capacity"
  attribute?: ModelAttribute;
  map?: Record<string, string>; // code -> meaning
  /**
   * Numeric transforms (applied when `map` has no entry for the code):
   *  - "mbh_to_tons": code is nominal cooling in MBH (kBTU/h) → tons = n/12, formatted with up to one
   *     decimal and no trailing ".0" ("036"→"3", "090"→"7.5", "150"→"12.5", "180"→"15").
   *  - "tons_x10": code/10 ("030"→"3").
   *  - "kbtuh": heat capacity in kBTU/h kept as the number string ("115"→"115").
   *  - "raw": code unchanged (e.g. chillers where the code is already tons: CGAM060 = 60 tons).
   *  - "map_tons": the `map` value is already tons (Carrier 48TC size codes 04=3, 05=4, 06=5, 07=6, 08=7.5, 09=8.5, 12=10, 14=12.5, 16=15).
   * Attribute value = map[code] if present, else transformed value, else the raw code.
   * `attributes.tonnage` is always a numeric string in tons; `attributes.voltage` uses the form "208-230/3/60".
   */
  transform?: "mbh_to_tons" | "tons_x10" | "kbtuh" | "raw" | "map_tons";
  capacityBasis?: string; // e.g. compressors: "kBtuh at AHRI rating point"
  unit?: "tons" | "kbtuh" | "mbh";
  notes?: string;
}

export interface ModelExample {
  model: string;
  expect: Partial<Record<ModelAttribute, string>> & { family?: string };
}

export interface ModelFormat {
  id: string;
  family: string; // e.g. "48TC WeatherMaker packaged rooftop (gas heat/electric cooling)"
  description?: string;
  productType: ProductType;
  eraStart?: number;
  eraEnd?: number;
  regex: string; // anchored, case-insensitive, over the trimmed model number
  segments: ModelSegment[];
  refrigerant?: string; // default refrigerant if not encoded (e.g. "R-410A")
  controlPlatformIds?: string[]; // ids in ControlPlatform[] typically fitted to this family
  equivalentFamilies?: string[]; // e.g. Bryant 580J ≙ Carrier 48TC
  examples?: ModelExample[];
  notes?: string[];
  confidence: Confidence;
  evidence?: EvidenceLevel;
  sources?: string[];
  lastVerified?: string;
}

export interface FaultCode {
  code: string; // as displayed, e.g. "A140", "E3", "LED 3 flashes"
  meaning: string;
  likelyCauses?: string[];
  checks?: string[];
  severity?: "info" | "warning" | "lockout" | "shutdown";
  notes?: string;
  source?: string; // document title/id + section
  evidence?: EvidenceLevel;
}

export interface ControlPlatform {
  id: string; // e.g. "comfortlink"
  name: string; // e.g. "Carrier ComfortLink"
  description?: string;
  appliesTo?: string[]; // family names / regexes (informational)
  faultCodes: FaultCode[];
  ledPatterns?: { pattern: string; meaning: string; checks?: string[] }[];
  diagnosticTips?: string[];
  coverage?: "complete" | "partial"; // whether faultCodes covers the platform's full table
  sourceDocs?: { title: string; docId?: string; url?: string }[];
  confidence: Confidence;
  sources?: string[];
}

export interface FamilyElectrical {
  familyRegex?: string; // which model formats this applies to (matches ModelFormat.id or model regex)
  familyLabel: string;
  controlVoltage?: string; // e.g. "24 VAC from TRAN"
  components: { designator: string; name: string; notes?: string }[];
  safetyDevices?: string[];
  terminalLabels?: Record<string, string>;
  sequenceOfOperation?: string[];
  notes?: string[];
  confidence: Confidence;
  evidence?: EvidenceLevel;
  sources?: string[];
}

export interface CommonIssue {
  symptom: string;
  likelyCauses: string[];
  checks: string[];
  appliesTo?: string; // family regex or label; omitted = whole manufacturer
  confidence?: Confidence;
  evidence?: EvidenceLevel;
  sources?: string[];
}

export interface SupportInfo {
  phone?: string;
  url?: string;
  literatureUrl?: string; // where to find IOM / wiring diagrams
  literatureSearchHint?: string; // e.g. "search '<model> installation instructions' on docs.carrier.com"
  notes?: string;
}

// ---------------------------------------------------------------------------
// Decoder engine output
// ---------------------------------------------------------------------------

export interface DecodedSerial {
  formatId: string;
  manufacturerId: string;
  description: string;
  year?: number;
  month?: number; // 1..12
  week?: number; // 1..53
  dayOfYear?: number;
  manufactureDate?: string; // "YYYY-MM" or "YYYY-Www" or "YYYY"
  ageYears?: number; // relative to now
  plant?: string;
  confidence: Confidence;
  ambiguous?: boolean; // another format of the same pack yields a different year
  candidateYears?: number[];
  evidence?: EvidenceLevel;
  sources?: string[];
  notes?: string[];
}

export interface DecodedModel {
  formatId: string;
  manufacturerId: string;
  family: string;
  productType: ProductType;
  attributes: Partial<Record<ModelAttribute, string>>;
  segments: { name: string; code: string; meaning?: string }[];
  refrigerant?: string;
  controlPlatformIds?: string[];
  equivalentFamilies?: string[];
  notes?: string[];
  confidence: Confidence;
  evidence?: EvidenceLevel;
  sources?: string[];
}

export interface DecodeResult {
  input: { model: string; serial?: string; manufacturer?: string };
  manufacturerCandidates: { id: string; manufacturer: string; score: number; reason: string }[];
  model: DecodedModel[]; // ranked, best first
  serial: DecodedSerial[]; // ranked, best first
  controls: ControlPlatform[]; // platforms relevant to best model match
  electrical: FamilyElectrical[];
  commonIssues: CommonIssue[];
  support?: SupportInfo;
  summary: string; // one-paragraph plain-text summary; opens with the confidence level
  evidenceSummary?: string; // e.g. "Nomenclature: Carrier 48TC product data (manufacturer doc); serial rule: two secondary sources"
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Refrigerants
// ---------------------------------------------------------------------------

export interface RefrigerantMeta {
  id: string; // canonical, e.g. "R-410A"
  aliases: string[]; // "R410A", "410A", "Puron"
  type: "pure" | "azeotrope" | "zeotrope";
  composition?: { component: string; massPercent: number }[];
  safetyClass: string; // "A1", "A2L", "A3", "B2L"
  gwp?: { ar4?: number; ar5?: number };
  glideF?: number; // temperature glide at ~40 °F evaporating (dew − bubble at the bubble pressure)
  glideAtCondF?: number; // glide at ~110 °F condensing, if known
  blendType?: "near_azeotrope" | "high_glide";
  lubricant?: string; // "POE", "MO/AB", "PVE"
  applications: string[];
  serviceNotes: string[];
  replacementFor?: string[];
  criticalTempF?: number;
  criticalPsig?: number;
  tableSource?: "coolprop_predefined" | "coolprop_mixture" | "coolprop_mixture_approx";
  tableVerified?: { against: string; maxErrorPsi: number; pointsChecked: number };
  extrapolatedAboveF?: number; // table points above this temperature are extrapolated
  sourceNote?: string; // how the table was generated
}

export interface RefrigerantTable {
  id: string;
  tempF: number[];
  bubblePsig: number[]; // saturated liquid pressure, psig (sea level)
  dewPsig: number[]; // saturated vapor pressure, psig
}

export interface PtLookupResult {
  refrigerant: string;
  safetyClass?: string;
  elevationFt?: number; // when given, psig is treated as a field gauge reading at this elevation
  inHgVacuum?: number; // for sub-atmospheric pressures
  psig?: number;
  bubbleTempF?: number; // sat liquid temp at psig
  dewTempF?: number; // sat vapor temp at psig
  midpointTempF?: number; // (bubble + dew) / 2 at psig
  tempF?: number;
  bubblePsig?: number;
  dewPsig?: number;
  glideF?: number;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface DxMeasurements {
  refrigerant: string;
  meteringDevice: MeteringDevice;
  mode: SystemMode;
  outdoorDbF?: number;
  indoorDbF?: number; // evaporator entering-air dry bulb (return air if no economizer)
  indoorWbF?: number; // evaporator entering-air wet bulb
  mixedAirDbF?: number; // air entering the evaporator when OA/economizer is present (overrides indoorDbF)
  mixedAirWbF?: number;
  economizerPosition?: "closed" | "minimum" | "open" | "unknown";
  supplyDbF?: number;
  suctionPsig?: number;
  suctionLineTempF?: number; // at outdoor unit service valve / compressor inlet
  liquidPsig?: number; // liquid line pressure (or discharge pressure if noted)
  dischargePsig?: number; // compressor discharge pressure
  liquidLineTempF?: number;
  dischargeLineTempF?: number; // 6 in. from compressor
  compressorAmps?: number; // L1 (or single-phase run amps)
  compressorAmpsL2?: number;
  compressorAmpsL3?: number;
  compressorRla?: number;
  circuit?: string; // "1", "2", "A", "B" for multi-circuit units
  compressorType?: "recip" | "scroll" | "tandem_scroll" | "digital_scroll" | "variable_speed" | "screw" | "unknown";
  capacityPercent?: number; // commanded capacity 0–100 (digital/variable/staged)
  stageCommanded?: "1" | "2" | "full" | "part";
  runtimeMinutes?: number; // minutes since start at this stage
  headPressureControl?: "none" | "fan_cycling" | "fan_vfd" | "flooding_valve" | "unknown";
  dehumidReheatActive?: boolean;
  defrostActive?: boolean;
  drierInletTempF?: number;
  drierOutletTempF?: number;
  sightGlass?: "clear" | "bubbles" | "flashing" | "none";
  moistureIndicator?: "dry" | "caution" | "wet";
  externalStaticInWc?: number;
  suctionMeasuredAt?: "compressor_suction" | "vapor_service_valve" | "evap_outlet" | "unknown";
  highSideMeasuredAt?: "liquid_service_valve" | "discharge_line" | "vapor_service_valve" | "unknown";
  efficiencyTier?: "standard" | "high"; // picks the condenser-split normal range
  hotGasBypass?: boolean;
  compressorCount?: number;
  activeCompressors?: number;
  standingPsig?: number; // unit off, equalized 30+ min (non-condensables test)
  equalizedAmbientF?: number;
  returnRhPercent?: number; // alternative to indoorWbF
  nameplateSubcoolingF?: number; // manufacturer target for TXV systems
  nameplateSuperheatF?: number; // manufacturer target if given
  elevationFt?: number;
  notes?: string;
}

export interface DxDerived {
  evapSatF?: number; // dew point at suction pressure
  condSatF?: number; // bubble point at liquid/discharge pressure
  superheatF?: number;
  subcoolingF?: number;
  targetSuperheatF?: number;
  targetSubcoolingF?: number;
  condenserSplitF?: number; // condSat - outdoorDb
  evapTdF?: number; // indoorDb - evapSat
  deltaTF?: number; // return - supply
  targetDeltaTF?: { min: number; max: number };
  indoorCoilTdF?: number; // heating mode: condSat − indoorDb (indoor coil is the condenser)
  compressionRatio?: number; // absolute pressure ratio using Patm at elevation
  patmPsia?: number;
  dischargeSuperheatF?: number;
  ampsPercentRla?: number;
  currentImbalancePercent?: number; // 3-phase compressor legs
  drierTempDropF?: number; // drier inlet − outlet
  standingExcessPsi?: number; // standing pressure − saturation pressure at ambient
}

export interface DxFinding {
  ruleId: string;
  condition: string; // short label, e.g. "Undercharge (high SH, low SC)"
  severity: "info" | "advisory" | "warning" | "critical";
  confidence: Confidence;
  explanation: string;
  nextChecks: string[];
  safety?: string[];
}

export interface DxResult {
  measurements: DxMeasurements;
  derived: DxDerived;
  /**
   * Whether the readings are valid for charge determination. When !ok, charge-related findings
   * (undercharge/overcharge/restriction) are downgraded to "info" and prefixed with
   * "readings not valid for charge determination".
   */
  validity: { ok: boolean; issues: string[] };
  findings: DxFinding[]; // ranked by severity, then confidence, then rule priority/order
  missing: string[]; // measurements that would sharpen the diagnosis
  summary: string;
}

export type MetricKey =
  | keyof DxDerived
  | keyof DxMeasurements
  | "superheatDelta" // superheat - target
  | "subcoolingDelta"; // subcooling - target

/**
 * Rule semantics: `when` clauses are ANDed; `between` is inclusive [value, value2]; a numeric clause on an
 * undefined metric makes the rule not fire (and the metric's source measurements are reported in
 * DxResult.missing); "present"/"absent" test defined-ness. `chargeRelated` rules are downgraded when
 * validity is not ok.
 */
export interface DxRule {
  id: string;
  condition: string;
  severity: DxFinding["severity"];
  confidence: Confidence;
  priority?: number; // tie-breaker within a severity/confidence (higher first)
  chargeRelated?: boolean;
  appliesTo?: { meteringDevice?: MeteringDevice[]; mode?: SystemMode[] };
  when: { metric: MetricKey; op: ">" | ">=" | "<" | "<=" | "between" | "present" | "absent"; value?: number; value2?: number }[];
  explanation: string;
  nextChecks: string[];
  safety?: string[];
}

export interface DxRuleSet {
  version: string;
  defaults: {
    targetSubcoolingTxvF: number;
    condenserSplitNormalF: { min: number; max: number };
    evapTdNormalF: { min: number; max: number };
    deltaTNormalF: { min: number; max: number };
    dischargeTempWarnF: number;
    dischargeTempCriticalF: number;
    compressionRatioWarn: number;
    compressionRatioAdvisory?: number; // e.g. 3.5 for AC; byMode refrigeration 8 advisory / 12 warn
    lowAmbientMinOutdoorDbF?: number; // default 65: below this, charge checks need head-pressure control
    /** Per-mode overrides (e.g. refrigeration: compressionRatioWarn ~10, evapTdNormalF 8–12) */
    byMode?: Partial<Record<SystemMode, Partial<Omit<DxRuleSet["defaults"], "byMode">>>>;
  };
  rules: DxRule[];
  notes?: string[];
}

export interface ChargingTargets {
  version: string;
  /** Fixed-orifice target superheat table: rows = indoor wet bulb °F, cols = outdoor dry bulb °F */
  fixedOrificeSuperheat: { indoorWbF: number[]; outdoorDbF: number[]; targetF: (number | null)[][] };
  /** Optional evaporator target temperature drop by entering DB (rows) / WB (cols) */
  targetDeltaT?: { indoorDbF: number[]; indoorWbF: number[]; targetF: (number | null)[][] };
  heatPumpHeating?: { notes: string[] };
  notes: string[];
}

// ---------------------------------------------------------------------------
// Electrical
// ---------------------------------------------------------------------------

export interface ElectricalComponent {
  id: string; // "run_capacitor"
  name: string;
  aliases?: string[];
  function: string;
  tests: {
    name: string;
    energized: boolean;
    steps: string[];
    expected: string;
    tolerance?: string;
  }[];
  failureModes: string[];
  safety: string[];
  tools?: string[];
  notes?: string[];
}

export interface ElectricalProcedure {
  id: string; // "unit_dead"
  symptom: string;
  aliases?: string[];
  appliesTo?: string[];
  safety: string[];
  steps: { step: string; expect?: string; ifNot?: string }[];
  commonCauses: string[];
}

export interface ElectricalKnowledge {
  version: string;
  components: ElectricalComponent[];
  procedures: ElectricalProcedure[];
  reference: { topic: string; content: string[] }[]; // e.g. voltage imbalance, motor nameplate reading, 3-phase rotation
}

export type ElectricalCalcRequest =
  | { kind: "voltage_imbalance"; vab: number; vbc: number; vca: number }
  | { kind: "current_imbalance"; ia: number; ib: number; ic: number }
  | { kind: "capacitor_under_load"; amps: number; volts: number; ratedUf?: number }
  | { kind: "amps_vs_rla"; amps: number; rla: number }
  | { kind: "temp_rise_cfm"; inputBtuh: number; efficiencyPercent: number; riseF: number }
  | { kind: "ohms_law"; volts?: number; amps?: number; ohms?: number; watts?: number }
  | { kind: "electric_heat_kw"; volts: number; amps: number; phase: 1 | 3; nameplateKw?: number }
  | { kind: "psychrometrics"; dbF: number; wbF: number; elevationFt?: number }
  | { kind: "winding_check"; phase: 1 | 3; r1: number; r2: number; r3: number } // 1-phase: r1=C-S, r2=C-R, r3=S-R; 3-phase: T1-T2, T2-T3, T3-T1
  | { kind: "megohm"; megohms: number; testVolts?: number };

export interface ElectricalCalcResult {
  kind: ElectricalCalcRequest["kind"];
  values: Record<string, number>;
  interpretation: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Job memory (DB rows)
// ---------------------------------------------------------------------------

export interface UnitRow {
  id: string;
  manufacturer: string | null;
  brand: string | null;
  model: string | null; // null when the nameplate is unreadable (record keyed by site + unit_tag)
  serial: string | null;
  nickname: string | null;
  site: string | null;
  customer: string | null;
  location_note: string | null;
  refrigerant: string | null;
  tonnage: number | null;
  voltage: string | null;
  phase: string | null;
  decoded_json: string | null; // DecodeResult JSON
  notes: string | null;
  unit_tag: string | null; // e.g. "RTU-7"
  circuits: number | null;
  charge_json: string | null; // per-circuit nameplate charge, e.g. {"1":"12 lb 4 oz"}
  nameplate_json: string | null; // MCA, MOP, RLA/LRA per circuit, fan FLA, heat MBH/kW, test pressures
  control_platform: string | null;
  heat_type: string | null;
  metering_device: string | null;
  install_year: number | null;
  last_service_at: string | null;
  elevation_ft: number | null;
  archived_at: string | null; // soft delete
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  title: string;
  unit_id: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: "user" | "assistant";
  kind: "chat" | "tool_result"; // tool_result rows carry only tool_result blocks and text = ""
  content_json: string; // Anthropic content blocks array, verbatim
  text: string; // searchable plain text
  created_at: string;
}

export interface FindingRow {
  id: string;
  unit_id: string | null;
  conversation_id: string | null;
  symptom: string;
  cause: string | null;
  resolution: string | null;
  measurements_json: string | null;
  parts_json: string | null;
  tags: string | null; // comma-separated lowercase tokens
  circuit: string | null;
  status: "open" | "resolved" | "monitor";
  service_date: string | null;
  refrigerant: string | null;
  refrigerant_added_lbs: number | null;
  refrigerant_recovered_lbs: number | null;
  follow_up: string | null;
  origin: "tech" | "assistant";
  confirmed: 0 | 1; // 1 only after the tech explicitly confirmed the cause/fix
  created_at: string;
}

export interface SearchHit {
  kind: "message" | "finding" | "unit";
  id: string;
  conversationId?: string;
  conversationTitle?: string;
  unitId?: string;
  snippet: string;
  createdAt: string;
  rank: number;
}

// ---------------------------------------------------------------------------
// Knowledge base handle
// ---------------------------------------------------------------------------

export interface KnowledgeBase {
  manufacturers: ManufacturerPack[];
  refrigerants: { meta: RefrigerantMeta[]; tables: Map<string, RefrigerantTable> };
  diagnostics: { rules: DxRuleSet; charging: ChargingTargets };
  electrical: ElectricalKnowledge;
}

// ---------------------------------------------------------------------------
// Chat streaming events (server -> browser over SSE)
// ---------------------------------------------------------------------------

export type ChatErrorCode =
  | "busy"
  | "not_found"
  | "validation"
  | "api_error"
  | "auth"
  | "rate_limit"
  | "network"
  | "refusal"
  | "max_tokens"
  | "context_full"
  | "aborted"
  | "iteration_cap"
  | "internal";

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown; label: string } // id = tool_use id
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary: string }
  | { type: "notice"; text: string }
  | { type: "unit_attached"; unitId: string }
  | {
      type: "done";
      conversationId: string;
      messageIds: string[];
      model?: string;
      usage?: { input: number; output: number; cacheRead?: number };
    }
  | { type: "error"; code: ChatErrorCode; message: string };

/** Message as sent to the browser (GET /api/conversations/:id). Tool results are folded into the assistant message. */
export interface DisplayMessage {
  id: string;
  seq: number;
  role: "user" | "assistant";
  createdAt: string;
  text: string;
  images?: { media_type: string; data: string }[];
  tools?: { id: string; name: string; input: unknown; label: string; ok: boolean; summary: string }[];
}

/** JSON error envelope for every non-2xx API response. */
export interface ApiError {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// App config
// ---------------------------------------------------------------------------

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  appPassword: string | null;
  claudeModel: string;
  claudeEffort: "low" | "medium" | "high" | "xhigh" | "max";
  claudeFallbacks: "default" | "off";
  enableWebSearch: boolean;
  maxToolIterations: number;
  /** Images in user messages older than this many user turns are replaced by a text placeholder on replay (0 = never). */
  replayImageWindow: number;
  knowledgeDir: string;
  webDir: string;
  /** Origins allowed via CORS (native shells, e.g. capacitor://localhost); empty/absent = same-origin only. */
  allowOrigins?: string[];
}
