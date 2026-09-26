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
  notes?: string[];
}

export interface SerialExample {
  serial: string;
  expect: { year?: number; month?: number; week?: number; dayOfYear?: number };
}

export type SerialDateRule =
  | {
      method: "twoDigitYear"; // YY -> year using pivot (default pivot: 70 => 1970..2069)
      yearGroup: number;
      pivot?: number;
      weekGroup?: number;
      monthGroup?: number;
      dayOfYearGroup?: number;
    }
  | {
      method: "oneDigitYear"; // single digit + decadeBase (e.g. Trane 2002-2009: "7" -> 2007)
      yearGroup: number;
      decadeBase: number;
      weekGroup?: number;
      monthGroup?: number;
    }
  | {
      method: "letterYear"; // letter -> year via map
      yearGroup: number;
      map: Record<string, number>;
      weekGroup?: number;
      monthGroup?: number;
      monthLetterMap?: Record<string, number>; // letter -> 1..12
    }
  | {
      method: "fourDigitYear";
      yearGroup: number;
      weekGroup?: number;
      monthGroup?: number;
      monthLetterMap?: Record<string, number>;
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
  /** Transform applied when attribute is tonnage: "mbh_to_tons" (036 -> 3), "tons_x10" (090 -> 9? no: 30 -> 3.0), "raw" */
  transform?: "mbh_to_tons" | "tons_x10" | "kbtuh" | "raw";
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
  examples?: ModelExample[];
  notes?: string[];
  confidence: Confidence;
}

export interface FaultCode {
  code: string; // as displayed, e.g. "A140", "E3", "LED 3 flashes"
  meaning: string;
  likelyCauses?: string[];
  checks?: string[];
  severity?: "info" | "warning" | "lockout" | "shutdown";
  notes?: string;
}

export interface ControlPlatform {
  id: string; // e.g. "comfortlink"
  name: string; // e.g. "Carrier ComfortLink"
  description?: string;
  appliesTo?: string[]; // family names / regexes (informational)
  faultCodes: FaultCode[];
  ledPatterns?: { pattern: string; meaning: string; checks?: string[] }[];
  diagnosticTips?: string[];
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
}

export interface CommonIssue {
  symptom: string;
  likelyCauses: string[];
  checks: string[];
  appliesTo?: string; // family regex or label; omitted = whole manufacturer
  confidence?: Confidence;
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
  notes?: string[];
  confidence: Confidence;
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
  summary: string; // one-paragraph plain-text summary for the assistant/UI
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
  glideF?: number; // temperature glide at typical evaporator conditions
  lubricant?: string; // "POE", "MO/AB", "PVE"
  applications: string[];
  serviceNotes: string[];
  replacementFor?: string[];
  criticalTempF?: number;
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
  psig?: number;
  bubbleTempF?: number; // sat liquid temp at psig
  dewTempF?: number; // sat vapor temp at psig
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
  indoorDbF?: number; // return air dry bulb
  indoorWbF?: number; // return air wet bulb
  supplyDbF?: number;
  suctionPsig?: number;
  suctionLineTempF?: number; // at outdoor unit service valve / compressor inlet
  liquidPsig?: number; // liquid line pressure (or discharge pressure if noted)
  dischargePsig?: number; // compressor discharge pressure
  liquidLineTempF?: number;
  dischargeLineTempF?: number; // 6 in. from compressor
  compressorAmps?: number;
  compressorRla?: number;
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
  compressionRatio?: number;
  dischargeSuperheatF?: number;
  ampsPercentRla?: number;
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
  findings: DxFinding[]; // ranked by severity then confidence
  missing: string[]; // measurements that would sharpen the diagnosis
  summary: string;
}

export type MetricKey =
  | keyof DxDerived
  | keyof DxMeasurements
  | "superheatDelta" // superheat - target
  | "subcoolingDelta"; // subcooling - target

export interface DxRule {
  id: string;
  condition: string;
  severity: DxFinding["severity"];
  confidence: Confidence;
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
  };
  rules: DxRule[];
  notes?: string[];
}

export interface ChargingTargets {
  version: string;
  /** Fixed-orifice target superheat table: rows = indoor wet bulb °F, cols = outdoor dry bulb °F */
  fixedOrificeSuperheat: { indoorWbF: number[]; outdoorDbF: number[]; targetF: (number | null)[][] };
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
  | { kind: "ohms_law"; volts?: number; amps?: number; ohms?: number; watts?: number };

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
  model: string;
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
  tags: string | null;
  created_at: string;
}

export interface SearchHit {
  kind: "message" | "finding";
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

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown; label: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary: string }
  | { type: "notice"; text: string }
  | { type: "done"; conversationId: string; messageIds: string[]; usage?: { input: number; output: number } }
  | { type: "error"; message: string };

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
  knowledgeDir: string;
  webDir: string;
}
