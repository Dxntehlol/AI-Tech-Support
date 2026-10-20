import type Anthropic from "@anthropic-ai/sdk";
import { REFRIGERANT_EVENT_TYPES, type Repos, type UnitInput } from "../db/repos.ts";
import type {
  ChillerMeasurements,
  ControlPlatform,
  CorrectionRow,
  DecodeResult,
  DxMeasurements,
  ElectricalCalcRequest,
  FindingRow,
  KnowledgeBase,
  ReadingRow,
  UnitRow,
} from "../types.ts";
import { decodeUnit } from "../knowledge/decoder.ts";
import { diagnose } from "../knowledge/diagnostics.ts";
import { CALC_KINDS, calcElectrical, lookupElectrical } from "../knowledge/electrical.ts";
import { lookupFaultCode } from "../knowledge/faults.ts";
import { getManualLibrary } from "../knowledge/library.ts";
import { complianceRefrigerantLookup, ptLookup, resolveRefrigerant, superheatSubcooling } from "../knowledge/refrigerants.ts";
import { DX_MEASUREMENT_ENUM_CODED_KEYS, DX_MEASUREMENT_NUMERIC_KEYS } from "../knowledge/loader.ts";
import { toTrendReading, trendFromReadings } from "../knowledge/trend.ts";
import { storeChillerReading, storeReading } from "../readingsStore.ts";
import { CHILLER_CONDENSER_TYPES, CHILLER_NUMERIC_KEYS, evaluateChiller } from "../knowledge/chiller.ts";
import { APPLIANCE_TYPES } from "../knowledge/refrigerantCompliance.ts";
import { refrigerantEventView, unitCompliance } from "../complianceStore.ts";
import { PM_TEMPLATE_IDS, findTemplate, suggestPmTemplate, templateSummary } from "../knowledge/pm.ts";
import { unitLastPm } from "../pmStore.ts";

export interface ToolContext {
  kb: KnowledgeBase;
  repos: Repos;
  conversationId: string;
  unitId: string | null;
  now?: Date;
}

export interface ToolOutcome {
  /** Text returned to the model as the tool_result content (compact JSON, ≤ 8 kB). */
  content: string;
  isError?: boolean;
  /** Short human label for the UI chip, e.g. "PT: R-410A 118 psig → 40 °F". */
  summary: string;
  /** Side effects the loop should apply. */
  attachUnitId?: string;
  setTitle?: string;
  setSummary?: string;
}

/** Hard cap on the tool_result text sent back to the model. */
export const TOOL_RESULT_MAX_CHARS = 8192;

// ---------------------------------------------------------------------------
// Schema DSL (hand-written validator + JSON schema generator)
// ---------------------------------------------------------------------------

type PropType = "string" | "number" | "integer" | "boolean" | "string_array" | "json";

interface Prop {
  type: PropType;
  description: string;
  required?: boolean;
  enum?: readonly string[];
  min?: number;
  max?: number;
  maxLength?: number;
}

interface ToolSpec {
  name: string;
  description: string;
  props: Record<string, Prop>;
}

type Validated = Record<string, unknown>;

function req(type: PropType, description: string, extra: Partial<Prop> = {}): Prop {
  return { type, description, required: true, ...extra };
}
function opt(type: PropType, description: string, extra: Partial<Prop> = {}): Prop {
  return { type, description, required: false, ...extra };
}

/**
 * Human-readable range for a numeric prop, appended to its description. Strict tool schemas do not
 * support `minimum`/`maximum` (nor `multipleOf`, `minLength`, `maxLength`), so the range travels in
 * the description and is enforced by validateInput.
 */
function rangeSentence(prop: Prop): string | undefined {
  if (prop.min !== undefined && prop.max !== undefined) return `Must be between ${prop.min} and ${prop.max}.`;
  if (prop.min !== undefined) return `Must be >= ${prop.min}.`;
  if (prop.max !== undefined) return `Must be <= ${prop.max}.`;
  return undefined;
}

/** JSON-schema keywords the API rejects in strict schemas; never emitted (see rangeSentence). */
export const STRICT_UNSUPPORTED_KEYWORDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format"] as const;

/**
 * The API caps union-typed parameters (type arrays, anyOf) at 16 across every tool in a request; a strict
 * schema has to list every property as required, so each optional field becomes a union and the 13 tools
 * together blow past the cap (400 "Schemas contains too many parameters with union types"). Optional fields
 * are therefore plain single-typed properties left out of `required`, and only a tool whose every input is
 * required keeps `strict: true`. validateInput still drops nulls and enforces enums and ranges client-side.
 */
export const UNION_PARAMETER_LIMIT = 16;

function jsonSchemaFor(prop: Prop): Record<string, unknown> {
  const out: Record<string, unknown> = { description: prop.description };
  switch (prop.type) {
    case "string":
    case "json":
      out.type = "string";
      if (prop.enum) out.enum = [...prop.enum];
      break;
    case "number":
    case "integer": {
      out.type = prop.type;
      const range = rangeSentence(prop);
      if (range) out.description = `${prop.description.trimEnd()} ${range}`;
      break;
    }
    case "boolean":
      out.type = "boolean";
      break;
    case "string_array":
      out.type = "array";
      out.items = { type: "string" };
      break;
  }
  return out;
}

function toBetaTool(spec: ToolSpec): Anthropic.Beta.BetaTool {
  const properties: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(spec.props)) properties[key] = jsonSchemaFor(prop);
  const required = Object.entries(spec.props)
    .filter(([, prop]) => prop.required)
    .map(([key]) => key);
  return {
    name: spec.name,
    description: spec.description,
    strict: required.length === Object.keys(spec.props).length,
    input_schema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function coerceNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function coerceBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1 || v === "1") return true;
  if (v === "false" || v === 0 || v === "0") return false;
  return undefined;
}

/**
 * Validate raw model input against a tool spec. Returns the cleaned values (nulls dropped,
 * numeric strings coerced, enums canonicalized) or a list of problems.
 */
function validateInput(spec: ToolSpec, input: unknown): { ok: true; value: Validated } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, problems: ["input must be a JSON object"] };
  }
  const src = input as Record<string, unknown>;
  const value: Validated = {};
  for (const [key, prop] of Object.entries(spec.props)) {
    const raw = src[key];
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "" && prop.type !== "json")) {
      if (prop.required) problems.push(`${key} is required (${prop.description.split(".")[0]})`);
      continue;
    }
    switch (prop.type) {
      case "string": {
        if (typeof raw !== "string" && typeof raw !== "number") {
          problems.push(`${key} must be a string`);
          break;
        }
        let s = String(raw).trim();
        if (prop.maxLength !== undefined && s.length > prop.maxLength) s = s.slice(0, prop.maxLength);
        if (prop.enum) {
          const canon = prop.enum.find((e) => e.toLowerCase() === s.toLowerCase());
          if (!canon) {
            problems.push(`${key} must be one of ${prop.enum.join(", ")} (got "${s}")`);
            break;
          }
          s = canon;
        }
        value[key] = s;
        break;
      }
      case "number":
      case "integer": {
        const n = coerceNumber(raw);
        if (n === undefined) {
          problems.push(`${key} must be a number`);
          break;
        }
        if (prop.type === "integer" && !Number.isInteger(n)) {
          problems.push(`${key} must be an integer`);
          break;
        }
        if (prop.min !== undefined && n < prop.min) {
          problems.push(`${key} must be >= ${prop.min} (got ${n})`);
          break;
        }
        if (prop.max !== undefined && n > prop.max) {
          problems.push(`${key} must be <= ${prop.max} (got ${n})`);
          break;
        }
        value[key] = n;
        break;
      }
      case "boolean": {
        const b = coerceBoolean(raw);
        if (b === undefined) {
          problems.push(`${key} must be true or false`);
          break;
        }
        value[key] = b;
        break;
      }
      case "string_array": {
        let arr: unknown[];
        if (Array.isArray(raw)) arr = raw;
        else if (typeof raw === "string") arr = raw.split(/[,;\n]/);
        else {
          problems.push(`${key} must be an array of strings`);
          break;
        }
        const strings = arr.map((x) => (typeof x === "string" ? x.trim() : typeof x === "number" ? String(x) : "")).filter((x) => x !== "");
        if (arr.some((x) => typeof x !== "string" && typeof x !== "number")) {
          problems.push(`${key} must contain only strings`);
          break;
        }
        value[key] = strings;
        break;
      }
      case "json": {
        if (typeof raw === "string") {
          const s = raw.trim();
          if (s === "") break;
          value[key] = s;
        } else if (typeof raw === "object") {
          value[key] = JSON.stringify(raw);
        } else if (typeof raw === "number" || typeof raw === "boolean") {
          value[key] = String(raw);
        } else {
          problems.push(`${key} must be a JSON string or object`);
        }
        break;
      }
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, value };
}

// ---------------------------------------------------------------------------
// Tool specs
// ---------------------------------------------------------------------------

const METERING = ["txv", "fixed", "eev", "unknown"] as const;
const MODES = ["ac_cooling", "heat_pump_cooling", "heat_pump_heating", "refrigeration"] as const;
const DX_ENUMS: Record<(typeof DX_MEASUREMENT_ENUM_CODED_KEYS)[number], readonly string[] | "boolean"> = {
  economizerPosition: ["closed", "minimum", "open", "unknown"],
  compressorType: ["recip", "scroll", "tandem_scroll", "digital_scroll", "variable_speed", "screw", "unknown"],
  stageCommanded: ["1", "2", "full", "part"],
  headPressureControl: ["none", "fan_cycling", "fan_vfd", "flooding_valve", "unknown"],
  dehumidReheatActive: "boolean",
  defrostActive: "boolean",
  sightGlass: ["clear", "bubbles", "flashing", "none"],
  moistureIndicator: ["dry", "caution", "wet"],
  suctionMeasuredAt: ["compressor_suction", "vapor_service_valve", "evap_outlet", "unknown"],
  highSideMeasuredAt: ["liquid_service_valve", "discharge_line", "vapor_service_valve", "unknown"],
  efficiencyTier: ["standard", "high"],
  hotGasBypass: "boolean",
};

const TEMP = { min: -100, max: 500 };
const PSIG = { min: -30, max: 1500 };
const AMPS = { min: 0, max: 2000 };

const DX_DESCRIPTIONS: Partial<Record<keyof DxMeasurements, string>> = {
  outdoorDbF: "Outdoor (condenser entering) air dry bulb, °F. Needed for condenser split and the fixed-orifice superheat chart.",
  indoorDbF: "Evaporator entering-air dry bulb, °F (return air when there is no economizer).",
  indoorWbF: "Evaporator entering-air wet bulb, °F. Needed for the fixed-orifice target superheat chart.",
  mixedAirDbF: "Mixed-air dry bulb entering the evaporator, °F, when an economizer/outside air is present (overrides indoor_db_f).",
  mixedAirWbF: "Mixed-air wet bulb entering the evaporator, °F.",
  supplyDbF: "Supply air dry bulb at the unit, °F, for delta-T.",
  suctionPsig: "Suction pressure, psig (field gauge reading).",
  suctionLineTempF: "Suction line temperature at the outdoor unit service valve / compressor inlet, °F.",
  liquidPsig: "Liquid line pressure, psig (use discharge_psig instead when measured at the discharge line).",
  dischargePsig: "Compressor discharge pressure, psig, when the liquid port is not available.",
  liquidLineTempF: "Liquid line temperature at the liquid service valve, °F.",
  dischargeLineTempF: "Discharge line temperature 6 inches from the compressor, °F.",
  compressorAmps: "Compressor amps on L1 (or single-phase run amps).",
  compressorAmpsL2: "Compressor amps on L2 (3-phase).",
  compressorAmpsL3: "Compressor amps on L3 (3-phase).",
  compressorRla: "Compressor RLA from the nameplate, amps.",
  capacityPercent: "Commanded capacity 0–100 % for digital, variable-speed or staged compressors.",
  runtimeMinutes: "Minutes the compressor has run at this stage before the readings were taken (readings need 10+).",
  drierInletTempF: "Filter-drier inlet temperature, °F (restriction check).",
  drierOutletTempF: "Filter-drier outlet temperature, °F (restriction check).",
  externalStaticInWc: "Total external static pressure, inches w.c.",
  compressorCount: "Number of compressors on this circuit (tandem/trio).",
  activeCompressors: "Number of compressors running on this circuit.",
  standingPsig: "Standing pressure with the unit off and equalized 30+ minutes, psig (non-condensables test).",
  equalizedAmbientF: "Ambient temperature at the equalized unit, °F (non-condensables test).",
  returnRhPercent: "Return air relative humidity, %, as an alternative to indoor_wb_f.",
  nameplateSubcoolingF: "Manufacturer target subcooling from the nameplate/charging chart, °F (TXV systems).",
  nameplateSuperheatF: "Manufacturer target superheat from the nameplate/charging chart, °F, if given.",
  elevationFt: "Site elevation, feet, for gauge pressure correction.",
};

function camelToSnake(key: string): string {
  return key.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`);
}

function dxRange(key: string): { min: number; max: number } {
  if (/Psig$/.test(key)) return PSIG;
  if (/TempF$|DbF$|WbF$|AmbientF$|SubcoolingF$|SuperheatF$/.test(key)) return TEMP;
  if (/Amps|Rla$/.test(key)) return AMPS;
  if (/Percent$/.test(key)) return { min: 0, max: 100 };
  if (key === "runtimeMinutes") return { min: 0, max: 100000 };
  if (key === "externalStaticInWc") return { min: 0, max: 10 };
  if (key === "compressorCount" || key === "activeCompressors") return { min: 0, max: 12 };
  if (key === "elevationFt") return { min: -1500, max: 30000 };
  return { min: -100000, max: 100000 };
}

function buildDiagnoseProps(): Record<string, Prop> {
  const props: Record<string, Prop> = {
    refrigerant: req("string", "Refrigerant on the nameplate or retrofit sticker, e.g. R-410A, R-22, R-454B, R-32."),
    metering_device: req("string", "Metering device: txv, fixed (orifice/piston), eev, or unknown. Charging method depends on it.", { enum: METERING }),
    mode: req("string", "Operating mode during the readings: ac_cooling, heat_pump_cooling, heat_pump_heating, or refrigeration.", { enum: MODES }),
  };
  for (const key of DX_MEASUREMENT_NUMERIC_KEYS) {
    const range = dxRange(key);
    const integer = key === "compressorCount" || key === "activeCompressors";
    props[camelToSnake(key)] = opt(integer ? "integer" : "number", DX_DESCRIPTIONS[key] ?? `${key} (numeric).`, range);
  }
  const enumDescriptions: Record<string, string> = {
    economizerPosition: "Economizer damper position during the readings (open invalidates charge checks).",
    compressorType: "Compressor type.",
    stageCommanded: "Compressor stage commanded: 1, 2, full or part.",
    headPressureControl: "Low-ambient head-pressure control confirmed on the unit: none, fan_cycling, fan_vfd, flooding_valve, unknown.",
    dehumidReheatActive: "true when hot-gas reheat / dehumidification mode is active (readings not valid for charge).",
    defrostActive: "true when the unit is in defrost (heat pump heating).",
    sightGlass: "Sight glass appearance: clear, bubbles, flashing, or none (no sight glass).",
    moistureIndicator: "Moisture indicator color: dry, caution, wet.",
    suctionMeasuredAt: "Where suction pressure/temperature were taken.",
    highSideMeasuredAt: "Where the high-side pressure was taken.",
    efficiencyTier: "Condenser coil efficiency tier: standard (split 25–30 °F) or high (high-efficiency/microchannel, split 10–20 °F).",
    hotGasBypass: "true when a hot gas bypass valve is fitted and may be holding suction pressure.",
  };
  for (const key of DX_MEASUREMENT_ENUM_CODED_KEYS) {
    const e = DX_ENUMS[key];
    props[camelToSnake(key)] = e === "boolean" ? opt("boolean", enumDescriptions[key] ?? key) : opt("string", enumDescriptions[key] ?? key, { enum: e });
  }
  props.circuit = opt("string", "Circuit identifier on multi-circuit units: 1, 2, A, B.", { maxLength: 20 });
  props.notes = opt("string", "Anything else about conditions (dirty coil seen, fan not running, recent work).", { maxLength: 500 });
  return props;
}

const CHILLER_DESCRIPTIONS: Record<(typeof CHILLER_NUMERIC_KEYS)[number], string> = {
  chwSupplyF: "Leaving (supply) chilled-water temperature, °F.",
  chwReturnF: "Entering (return) chilled-water temperature, °F.",
  chwFlowGpm: "Chilled-water flow, gpm (tons = 500 × gpm × ΔT ÷ 12000).",
  evapSatF: "Evaporator saturated refrigerant temperature from the controller, °F (or give evap_pressure_psig + refrigerant).",
  evapPressurePsig: "Evaporator (suction) pressure, psig; needs refrigerant.",
  condSatF: "Condenser saturated refrigerant temperature, °F (or give cond_pressure_psig + refrigerant).",
  condPressurePsig: "Condenser pressure, psig; needs refrigerant.",
  condWaterInF: "Entering condenser water temperature, °F (water-cooled).",
  condWaterOutF: "Leaving condenser water temperature, °F (water-cooled; condenser approach).",
  outdoorDbF: "Entering air / outdoor dry bulb, °F (air-cooled; condenser approach).",
  oilPressurePsig: "Oil pressure (net) as the controller shows it, psig.",
  oilTempF: "Oil temperature, °F.",
  compressorAmps: "Compressor amps (one leg or the controller's reading).",
  rla: "Compressor RLA from the nameplate, amps.",
  percentLoad: "Controller-reported load, 0–100 %.",
  elevationFt: "Site elevation, feet, for gauge correction.",
};

function buildChillerProps(): Record<string, Prop> {
  const props: Record<string, Prop> = {
    refrigerant: opt("string", "Refrigerant on the chiller nameplate (R-134a, R-513A, R-123, R-1233zd(E), R-410A, R-32…). Required when pressures are given; defaults to the attached unit's refrigerant.", { maxLength: 40 }),
    condenser_type: opt("string", "water_cooled or air_cooled; inferred from which condenser readings are given when omitted.", { enum: CHILLER_CONDENSER_TYPES }),
  };
  for (const key of CHILLER_NUMERIC_KEYS) {
    const range = /Psig$/.test(key) ? PSIG : /F$/.test(key) ? TEMP : key === "percentLoad" ? { min: 0, max: 100 } : key === "elevationFt" ? { min: -1500, max: 30000 } : { min: 0, max: 100000 };
    props[camelToSnake(key)] = opt("number", CHILLER_DESCRIPTIONS[key], range);
  }
  props.circuit = opt("string", "Circuit / compressor identifier on multi-circuit chillers.", { maxLength: 20 });
  props.notes = opt("string", "Anything else observed (purge counts, alarms, tower condition).", { maxLength: 500 });
  return props;
}

const SPECS: ToolSpec[] = [
  {
    name: "decode_unit",
    description:
      "Decode a model number (and serial) against the manufacturer nomenclature packs: family, product type, tonnage, voltage/phase, refrigerant, heat type, control platform, manufacture date and age, typical electrical designators, common issues, support/literature links. Call it whenever a model or serial appears. Set save=true to create or update the unit record in job memory and attach it to this conversation (a unit with the same model+serial is updated automatically). Results carry confidence and warnings; relay them.",
    props: {
      model: req("string", "Model number as printed on the nameplate.", { maxLength: 80 }),
      serial: opt("string", "Serial number as printed on the nameplate (for manufacture date).", { maxLength: 80 }),
      manufacturer: opt("string", "Manufacturer or brand hint when the tech named it (Carrier, Bryant, Trane, Lennox, York, Daikin, Goodman, Rheem, AAON, Copeland...).", { maxLength: 60 }),
      save: opt("boolean", "true to save/update the unit in job memory and attach it to the conversation."),
      site: opt("string", "Site or building name to store with the unit (when saving).", { maxLength: 120 }),
      unit_tag: opt("string", "Unit tag such as RTU-7 or AHU-2 (when saving).", { maxLength: 40 }),
      nickname: opt("string", "Nickname the tech uses for the unit (when saving).", { maxLength: 60 }),
    },
  },
  {
    name: "find_unit",
    description:
      "Search job memory for a saved unit by tag, site, customer, nickname, model or serial (e.g. \"RTU-7 pharmacy\"). Returns the best matches with the date of their last finding. A single match is attached to the conversation automatically; with several matches pass attach=true to attach the top one, or call again with a narrower query.",
    props: {
      query: req("string", "Words identifying the unit: tag, site, customer, nickname, model or serial fragment.", { maxLength: 120 }),
      site: opt("string", "Restrict to this site (exact name, case-insensitive).", { maxLength: 120 }),
      limit: opt("integer", "Maximum matches to return (1–20, default 5).", { min: 1, max: 20 }),
      attach: opt("boolean", "true to attach the top match to this conversation even when several units match; false to never attach."),
    },
  },
  {
    name: "refrigerant_pt",
    description:
      "Pressure–temperature lookup for a refrigerant: saturation temperatures (bubble and dew) at a gauge pressure, or saturation pressures at a temperature, with glide, ASHRAE 34 safety class, lubricant, retrofit and handling notes. Superheat uses the dew point, subcooling the bubble point. Pass elevation_ft when known (gauges read low at altitude). Provide psig or temp_f (or both). Never quote PT values from memory; call this.",
    props: {
      refrigerant: req("string", "Refrigerant designation or trade name: R-410A, R-22, R-454B, R-32, R-134a, R-407C, R-404A, Puron, Freon...", { maxLength: 40 }),
      psig: opt("number", "Gauge pressure in psig (negative for vacuum) to convert to saturation temperature.", PSIG),
      temp_f: opt("number", "Temperature in °F to convert to saturation pressure.", TEMP),
      elevation_ft: opt("number", "Site elevation in feet; gauge readings are corrected to sea-level basis.", { min: -1500, max: 30000 }),
    },
  },
  {
    name: "calc_superheat_subcooling",
    description:
      "Quick superheat and subcooling from gauge readings when fewer than four readings exist: suction psig + suction line temp → superheat (dew basis); liquid (or discharge) psig + liquid line temp → subcooling (bubble basis). For a full diagnosis with air temperatures, amps and validity checks use diagnose_refrigeration instead.",
    props: {
      refrigerant: req("string", "Refrigerant designation, e.g. R-410A.", { maxLength: 40 }),
      suction_psig: opt("number", "Suction pressure, psig.", PSIG),
      suction_line_temp_f: opt("number", "Suction line temperature at the service valve / compressor inlet, °F.", TEMP),
      liquid_psig: opt("number", "Liquid line pressure, psig.", PSIG),
      liquid_line_temp_f: opt("number", "Liquid line temperature, °F.", TEMP),
      discharge_psig: opt("number", "Discharge pressure, psig, when the liquid port is not available.", PSIG),
      elevation_ft: opt("number", "Site elevation in feet for gauge correction.", { min: -1500, max: 30000 }),
    },
  },
  {
    name: "diagnose_refrigeration",
    description:
      "Run the refrigeration-cycle rule engine on a set of readings (pressures, line and air temperatures, amps, conditions). Returns derived metrics (saturation temps, superheat, subcooling, targets, condenser split, evaporator TD, delta-T, compression ratio, % RLA), a validity gate for charge determination (low ambient, economizer open, part load, short runtime, reheat, defrost, heating mode), ranked findings with next checks and safety notes, the measurements that would sharpen the result, and a plain summary. Prefer it whenever four or more readings exist. Pass everything known; omit unknown fields. Units: psig, °F, amps, %, feet.",
    props: buildDiagnoseProps(),
  },
  {
    name: "electrical_reference",
    description:
      "Look up electrical knowledge: component tests (capacitors, contactors, transformers, compressors, motors, VFDs, safeties, economizer controls, RDS...), troubleshooting procedures by symptom (unit dead, compressor won't start, breaker trips, no heat...), and reference topics (voltage imbalance, nameplate reading, 24 V trace, rotation, safety). Returns steps, expected values and tolerances with safety notes.",
    props: {
      query: req("string", "Component name, symptom or topic, e.g. \"run capacitor\", \"compressor hums won't start\", \"voltage imbalance\".", { maxLength: 160 }),
      kind: opt("string", "Restrict to component, procedure or reference; any (default) searches all three.", { enum: ["component", "procedure", "reference", "any"] }),
    },
  },
  {
    name: "calc_electrical",
    description:
      "Field calculators. Pick a kind and pass its inputs: voltage_imbalance (vab, vbc, vca → %, NEMA derate); current_imbalance (ia, ib, ic); capacitor_under_load (amps on the capacitor lead, volts, rated_uf); amps_vs_rla (amps, rla); temp_rise_cfm (input_btuh, efficiency_percent, rise_f); ohms_law (any two of volts, amps, ohms, watts); electric_heat_kw (volts, amps, phase, nameplate_kw); psychrometrics (db_f, wb_f, elevation_ft); winding_check (phase, r1, r2, r3); megohm (megohms, test_volts); leak_rate (added_lbs, full_charge_lbs, days_since_last_add, appliance_type → EPA annualized leak rate vs threshold); gas_meter_clock (dial_cuft, seconds_per_rev, revolutions, heating_value_btu_per_cuft, nameplate_input_btuh → CFH, BTU/h, ±5 %); combustion_co (co_ppm, o2_pct, ambient_co_ppm → CO air-free, 100/400 ppm flags, stop-work); sensible_cfm (btuh, delta_t_f, tons → CFM, CFM/ton); static_pressure (supply_in_wc, return_in_wc, rated_max_in_wc or blower_type psc|ecm → TESP, over-max); fan_laws (rpm1, rpm2, cfm1, sp1, bhp1); belt_drive (motor_rpm, motor_sheave_in, fan_sheave_in, center_distance_in → fan rpm, belt length, deflection); voltage_drop (volts, amps, one_way_ft, awg or circular_mils, material cu|al, phase); motor_fla (hp, volts, phase → NEC 430.248/430.250 FLA, 125 % conductor); capacitor_replacement (rated_uf, rated_v, replacement_uf, replacement_v); motor_replacement (hp, rpm, volts, phase, frame, rotation_from_shaft_end, shaft_dia_in, enclosure → what must match).",
    props: {
      kind: req("string", "Calculator to run.", { enum: CALC_KINDS }),
      vab: opt("number", "Line voltage A-B, volts (voltage_imbalance).", { min: 0, max: 1000 }),
      vbc: opt("number", "Line voltage B-C, volts (voltage_imbalance).", { min: 0, max: 1000 }),
      vca: opt("number", "Line voltage C-A, volts (voltage_imbalance).", { min: 0, max: 1000 }),
      ia: opt("number", "Current on leg A / L1, amps (current_imbalance).", AMPS),
      ib: opt("number", "Current on leg B / L2, amps (current_imbalance).", AMPS),
      ic: opt("number", "Current on leg C / L3, amps (current_imbalance).", AMPS),
      amps: opt("number", "Measured amps (capacitor_under_load: on the capacitor lead, never compressor common; amps_vs_rla; ohms_law; electric_heat_kw).", AMPS),
      volts: opt("number", "Measured volts (capacitor_under_load: across the capacitor terminals; ohms_law; electric_heat_kw).", { min: 0, max: 1000 }),
      rated_uf: opt("number", "Capacitor rating printed on the can, µF (capacitor_under_load).", { min: 0, max: 2000 }),
      rla: opt("number", "Nameplate RLA, amps (amps_vs_rla).", AMPS),
      input_btuh: opt("number", "Heat input, BTU/h (temp_rise_cfm). For electric heat use kW × 3412.", { min: 0, max: 50_000_000 }),
      efficiency_percent: opt("number", "Combustion efficiency %, 100 for electric heat (temp_rise_cfm).", { min: 1, max: 100 }),
      rise_f: opt("number", "Measured temperature rise, °F (temp_rise_cfm).", { min: 0.1, max: 200 }),
      ohms: opt("number", "Resistance, ohms (ohms_law).", { min: 0, max: 1e9 }),
      watts: opt("number", "Power, watts (ohms_law).", { min: 0, max: 1e9 }),
      phase: opt("integer", "1 or 3 (electric_heat_kw, winding_check).", { min: 1, max: 3 }),
      nameplate_kw: opt("number", "Nameplate heater kW to compare against (electric_heat_kw).", { min: 0, max: 5000 }),
      db_f: opt("number", "Dry bulb, °F (psychrometrics).", TEMP),
      wb_f: opt("number", "Wet bulb, °F (psychrometrics).", TEMP),
      elevation_ft: opt("number", "Elevation, feet (psychrometrics).", { min: -1500, max: 30000 }),
      r1: opt("number", "Winding resistance 1, ohms (winding_check: 1-ph C-S; 3-ph T1-T2).", { min: 0, max: 1e6 }),
      r2: opt("number", "Winding resistance 2, ohms (winding_check: 1-ph C-R; 3-ph T2-T3).", { min: 0, max: 1e6 }),
      r3: opt("number", "Winding resistance 3, ohms (winding_check: 1-ph S-R; 3-ph T3-T1).", { min: 0, max: 1e6 }),
      megohms: opt("number", "Insulation resistance reading, MΩ (megohm).", { min: 0, max: 1e6 }),
      test_volts: opt("number", "Megger test voltage, VDC (megohm), typically 500.", { min: 0, max: 5000 }),
      added_lbs: opt("number", "Refrigerant added, lb (leak_rate).", { min: 0, max: 100000 }),
      full_charge_lbs: opt("number", "Appliance full charge, lb (leak_rate).", { min: 0, max: 100000 }),
      days_since_last_add: opt("number", "Days since the previous add (leak_rate; < 1 counts as 1, more than 365 counts as 365).", { min: 0, max: 36500 }),
      refrigerant: opt("string", "Refrigerant (leak_rate applicability: HFC with GWP > 53 from 15 lb, ODS such as R-22 from 50 lb, GWP ≤ 53 not covered).", { maxLength: 40 }),
      appliance_type: opt("string", "EPA appliance category (leak_rate): comfort_cooling 10 %, commercial_refrigeration 20 %, industrial_process 30 %, other 10 %.", { enum: APPLIANCE_TYPES }),
      dial_cuft: opt("number", "Meter test dial size, ft³ per revolution: 0.5, 1, 2, 5 (gas_meter_clock).", { min: 0, max: 100 }),
      seconds_per_rev: opt("number", "Seconds for the revolutions timed (gas_meter_clock).", { min: 0, max: 36000 }),
      revolutions: opt("number", "Revolutions timed, default 1 (gas_meter_clock).", { min: 0, max: 100 }),
      heating_value_btu_per_cuft: opt("number", "Gas heating value, BTU/ft³, default 1000 (gas_meter_clock).", { min: 0, max: 5000 }),
      nameplate_input_btuh: opt("number", "Rated input from the plate, BTU/h, to compare ±5 % (gas_meter_clock).", { min: 0, max: 50_000_000 }),
      co_ppm: opt("number", "Flue CO as measured, ppm (combustion_co).", { min: 0, max: 100000 }),
      o2_pct: opt("number", "Flue O2, % (combustion_co).", { min: 0, max: 21 }),
      ambient_co_ppm: opt("number", "CO in the room/space, ppm (combustion_co; > 20 = stop work).", { min: 0, max: 100000 }),
      btuh: opt("number", "Sensible heat, BTU/h (sensible_cfm).", { min: 0, max: 50_000_000 }),
      delta_t_f: opt("number", "Temperature change across the coil/heater, °F (sensible_cfm).", { min: 0, max: 200 }),
      tons: opt("number", "Nominal tons for CFM/ton (sensible_cfm).", { min: 0, max: 10000 }),
      supply_in_wc: opt("number", "Supply static, in. wc (static_pressure).", { min: -10, max: 10 }),
      return_in_wc: opt("number", "Return static, in. wc; negative or magnitude (static_pressure).", { min: -10, max: 10 }),
      rated_max_in_wc: opt("number", "Nameplate maximum external static, in. wc (static_pressure).", { min: 0, max: 10 }),
      blower_type: opt("string", "psc (default max 0.5 in. wc) or ecm (0.8) when no rated maximum is given (static_pressure).", { enum: ["psc", "ecm"] }),
      rpm1: opt("number", "Current fan RPM (fan_laws).", { min: 0, max: 100000 }),
      rpm2: opt("number", "New fan RPM (fan_laws).", { min: 0, max: 100000 }),
      cfm1: opt("number", "Current CFM (fan_laws).", { min: 0, max: 10_000_000 }),
      sp1: opt("number", "Current static pressure, in. wc (fan_laws).", { min: 0, max: 50 }),
      bhp1: opt("number", "Current brake horsepower (fan_laws).", { min: 0, max: 10000 }),
      motor_rpm: opt("number", "Motor RPM (belt_drive).", { min: 0, max: 100000 }),
      motor_sheave_in: opt("number", "Motor sheave pitch diameter, in. (belt_drive).", { min: 0, max: 100 }),
      fan_sheave_in: opt("number", "Fan sheave pitch diameter, in. (belt_drive).", { min: 0, max: 100 }),
      center_distance_in: opt("number", "Shaft center distance, in. (belt_drive: belt length and deflection).", { min: 0, max: 1000 }),
      one_way_ft: opt("number", "One-way conductor run, feet (voltage_drop).", { min: 0, max: 100000 }),
      awg: opt("string", "Conductor size: 14…4/0 AWG or 250…500 kcmil (voltage_drop).", { maxLength: 20 }),
      circular_mils: opt("number", "Conductor area in circular mils when the size is not a standard AWG (voltage_drop).", { min: 0, max: 10_000_000 }),
      material: opt("string", "Conductor material: cu (default) or al (voltage_drop).", { enum: ["cu", "al"] }),
      hp: opt("number", "Motor horsepower (motor_fla, motor_replacement).", { min: 0, max: 10000 }),
      rated_v: opt("number", "Original capacitor voltage rating (capacitor_replacement).", { min: 0, max: 1000 }),
      replacement_uf: opt("number", "Replacement capacitor µF (capacitor_replacement).", { min: 0, max: 2000 }),
      replacement_v: opt("number", "Replacement capacitor voltage rating (capacitor_replacement).", { min: 0, max: 1000 }),
      rpm: opt("number", "Motor nameplate RPM (motor_replacement).", { min: 0, max: 100000 }),
      frame: opt("string", "NEMA frame, e.g. 48Y, 56, 143T (motor_replacement).", { maxLength: 40 }),
      rotation_from_shaft_end: opt("string", "Rotation seen from the shaft end: cw or ccw (motor_replacement).", { enum: ["cw", "ccw"] }),
      shaft_dia_in: opt("number", "Shaft diameter, in. (motor_replacement).", { min: 0, max: 10 }),
      enclosure: opt("string", "Enclosure: ODP, TEFC, TEAO, weatherproof… (motor_replacement).", { maxLength: 40 }),
    },
  },
  {
    name: "diagnose_chiller",
    description:
      "Chiller readings mode: evaluate chilled-water supply/return (ΔT, tons with gpm), evaporator approach (CHW supply − evap saturated temp), condenser approach (cond saturated temp − leaving condenser water, or − entering air on air-cooled), amps as % RLA and oil pressure/temperature bands. Pressures convert through the PT tables when a refrigerant is given. Returns derived values, ranked findings (fouled tubes / low flow / dirty coil / overload / oil) and a summary; never judges charge from gauges. With a unit attached the readings are stored (mode chiller) for trending.",
    props: buildChillerProps(),
  },
  {
    name: "log_refrigerant",
    description:
      "Log a refrigerant event on the attached unit: add (pounds added; the EPA annualized leak rate is computed from the unit's full charge and the previous add and compared with the 10/20/30 % threshold), recover, leak_check (leak_found), verification_initial / verification_followup (passed), repair, or retrofit_plan. An add that exceeds the threshold opens a follow-up finding (repair within 30 days and verify). Returns the event with its leak rate and the unit's compliance status and open obligations — relay an exceedance and the 30-day repair clock to the tech. Requires an attached unit with full_charge_lbs set (update_unit) for a leak rate.",
    props: {
      event_type: req("string", "add, recover, leak_check, verification_initial, verification_followup, repair or retrofit_plan.", { enum: REFRIGERANT_EVENT_TYPES }),
      refrigerant: opt("string", "Refrigerant handled; defaults to the unit's.", { maxLength: 40 }),
      amount_lbs: opt("number", "Pounds added or recovered (decimal lb; 8 oz = 0.5). Required for add and recover.", { min: 0, max: 100000 }),
      circuit: opt("integer", "Circuit number the event applies to on multi-circuit units (1, 2, …).", { min: 1, max: 64 }),
      cylinder_id: opt("string", "Cylinder / tank id the refrigerant came from or went into.", { maxLength: 120 }),
      tech_name: opt("string", "Technician name.", { maxLength: 120 }),
      tech_cert: opt("string", "Technician EPA 608 certification number.", { maxLength: 120 }),
      leak_found: opt("boolean", "leak_check: whether a leak was found."),
      passed: opt("boolean", "verification_initial / verification_followup: whether the test passed."),
      note: opt("string", "Where the leak was, what was repaired, test pressure / method, anything for the owner record.", { maxLength: 2000 }),
      date: opt("string", "Event date YYYY-MM-DD when logging a past event; defaults to today.", { maxLength: 10 }),
    },
  },
  {
    name: "get_pm_checklist",
    description:
      "Get the preventive-maintenance checklist template for an equipment type (sections and items with pass/fail, numeric as-found/as-left fields and nameplate comparisons: volts ±10 %, amps vs RLA, capacitor ±6 %), plus the attached unit's last PM visit summary. Omit equipment_type to let the decoded unit pick it (packaged rooftop with gas heat → rtu_gas, etc.). Use it to walk the tech through a PM or to interpret a saved visit.",
    props: {
      equipment_type: opt("string", "Template id: rtu_gas, rtu_electric_or_cooling_only, split_ac, heat_pump, chiller_air_cooled, chiller_water_cooled, walk_in_cooler, walk_in_freezer, ice_machine, mau_exhaust, boiler.", { enum: PM_TEMPLATE_IDS }),
    },
  },
  {
    name: "lookup_fault_code",
    description:
      "Look up a fault/alarm code or LED flash pattern (e.g. \"A140\", \"E3\", \"IGC 3 flashes\", \"T051\") in the manufacturer control-platform tables. Returns the verbatim meaning, likely causes, checks, severity, the platform's table coverage (complete or partial) and the source document for each entry. Narrow with manufacturer and/or platform when known. No hit means \"no verified entry for this code on this platform\" — never guess a meaning.",
    props: {
      code: req("string", "Code or LED pattern as displayed.", { maxLength: 80 }),
      manufacturer: opt("string", "Manufacturer or brand to scope the search.", { maxLength: 60 }),
      platform: opt("string", "Control platform name or id (ComfortLink, SystemVu, IGC, RTU-Open, Prodigy, Simplicity...).", { maxLength: 60 }),
    },
  },
  {
    name: "search_manuals",
    description:
      "Search the manufacturer manual library: full text of the installation/operation/service manuals, controller manuals and alarm guides held for STULZ, Liebert/Vertiv, Trane/American Standard, Carrier/Bryant/Payne/ICP, Goodman/Amana/Daikin, Lennox, York/JCI, Rheem/Ruud, Data Aire, Uniflair, APC InRow and Rittal, plus curated notes (alarm tables, model-number keys, troubleshooting). Use it for sequences of operation, setpoints and factory defaults, menu paths and published passwords, alarm reset procedures, terminal and wiring designations, charging and pressure-switch settings, component data, and alarm text that lookup_fault_code has no entry for. Query with the words the manual would print (alarm text, component or menu names, model family) and pass the manufacturer. Returns passages with document title, doc number, page and public URL; quote them and cite title + page. No passages means the library has nothing on it, not that the answer does not exist.",
    props: {
      query: req("string", "Words to find, as the manual would print them: e.g. \"LOW PRESSURE 1 reset\", \"dehumidification reheat sequence\", \"E2 password service level\", \"high pressure switch setting R410A\".", { maxLength: 200 }),
      manufacturer: opt("string", "Manufacturer or brand to restrict the search (STULZ, Liebert, Vertiv, Trane, Carrier, Bryant, Goodman, Daikin, Lennox, York, Rheem, Data Aire, Uniflair, APC, Rittal...).", { maxLength: 60 }),
      max_results: opt("integer", "Passages to return (default 4).", { min: 1, max: 6 }),
    },
  },
  {
    name: "search_history",
    description:
      "Full-text search across past conversations, findings and units in job memory (\"have we seen code A140 before\", \"compressor replacement at the pharmacy\"). Returns up to 10 hits with snippets. Set unit_only=true to search only the attached unit; filter by site or since (ISO date).",
    props: {
      query: req("string", "Search words (plain words work best; codes and model fragments are fine).", { maxLength: 160 }),
      unit_only: opt("boolean", "true to restrict to the unit attached to this conversation."),
      site: opt("string", "Restrict to this site name.", { maxLength: 120 }),
      since: opt("string", "Only hits on or after this ISO date (YYYY-MM-DD).", { maxLength: 30 }),
    },
  },
  {
    name: "get_unit_history",
    description:
      "Full job memory for a unit: record, nameplate data, decoded attributes, technician decode corrections (trust these over the decoder), open follow-ups first, every finding (open/monitor first, hypotheses marked), the last 3 saved readings with the trend since the previous comparable visit, and past conversations with summaries. Defaults to the unit attached to this conversation; pass unit_id to read another unit (ids come from find_unit / search_history).",
    props: {
      unit_id: opt("string", "Unit id (16 hex chars). Omit for the attached unit.", { maxLength: 32 }),
    },
  },
  {
    name: "save_finding",
    description:
      "Record a finding on the attached unit: symptom → cause → resolution, with measurements, parts, tags, circuit, status and refrigerant handling. Saved with origin=assistant. Set confirmed=true ONLY after the tech explicitly confirmed the cause and fix; otherwise it is stored as an unconfirmed hypothesis (say so). Call set_conversation afterwards.",
    props: {
      symptom: req("string", "What the unit was doing, in the tech's words.", { maxLength: 400 }),
      cause: opt("string", "Root cause found.", { maxLength: 400 }),
      resolution: opt("string", "What was done to fix it (or the plan).", { maxLength: 600 }),
      measurements: opt("json", "Key readings as a JSON object string, e.g. {\"suction_psig\":118,\"superheat_f\":12,\"subcooling_f\":10} or free text."),
      parts: opt("string_array", "Parts replaced or needed, one per entry (with part numbers when known)."),
      tags: opt("string_array", "Short lowercase tags: undercharge, txv, contactor, economizer..."),
      circuit: opt("string", "Circuit identifier for multi-circuit units.", { maxLength: 20 }),
      status: opt("string", "open (still broken / parts on order), resolved (fixed and verified), monitor (watch on the next visit). Default open unless confirmed.", { enum: ["open", "resolved", "monitor"] }),
      refrigerant: opt("string", "Refrigerant involved, e.g. R-410A.", { maxLength: 40 }),
      refrigerant_added_lbs: opt("number", "Refrigerant added, pounds (decimal).", { min: 0, max: 100000 }),
      refrigerant_recovered_lbs: opt("number", "Refrigerant recovered, pounds (decimal).", { min: 0, max: 100000 }),
      follow_up: opt("string", "The one action for the next visit, as a short checklist line (under 120 characters, e.g. \"Re-check fan amps and subcooling after cap swap\"). Details and target numbers go in resolution/notes, not here.", { maxLength: 400 }),
      follow_up_due: opt("string", "When the follow-up is due, YYYY-MM-DD (only with follow_up).", { maxLength: 10 }),
      service_date: opt("string", "Service date YYYY-MM-DD; defaults to today.", { maxLength: 30 }),
      confirmed: opt("boolean", "true only when the tech explicitly confirmed the cause and fix."),
    },
  },
  {
    name: "update_unit",
    description:
      "Update the unit attached to this conversation with nameplate data the decoder cannot infer: tag, nickname, site, customer, location note, refrigerant, tonnage, voltage, phase, number of circuits, factory charge per circuit, nameplate electrical data (MCA/MOP/RLA/LRA/fan FLA/heat kW or MBH), control platform, heat type, metering device, install year, elevation, notes, and the EPA compliance fields (full_charge_lbs, appliance_type, circuits_count). Pass only the fields to change. Requires an attached unit (decode_unit with save=true or find_unit first).",
    props: {
      nickname: opt("string", "Nickname for the unit.", { maxLength: 60 }),
      unit_tag: opt("string", "Unit tag such as RTU-7.", { maxLength: 40 }),
      site: opt("string", "Site / building name.", { maxLength: 120 }),
      customer: opt("string", "Customer name.", { maxLength: 120 }),
      location_note: opt("string", "Where the unit is (roof NE corner, mech room 2...).", { maxLength: 200 }),
      refrigerant: opt("string", "Refrigerant on the nameplate or retrofit sticker.", { maxLength: 40 }),
      tonnage: opt("number", "Nominal cooling tons.", { min: 0, max: 10000 }),
      voltage: opt("string", "Supply voltage string as on the nameplate, e.g. 208-230/3/60 or 460/3/60.", { maxLength: 40 }),
      phase: opt("string", "1 or 3.", { enum: ["1", "3"] }),
      circuits: opt("integer", "Number of refrigerant circuits.", { min: 0, max: 64 }),
      charge: opt("json", "Factory charge per circuit as a JSON object string, e.g. {\"1\":\"12 lb 4 oz\",\"2\":\"11 lb 8 oz\"}."),
      nameplate: opt("json", "Nameplate electrical data as a JSON object string, e.g. {\"mca\":38,\"mop\":50,\"rla_1\":14.2,\"lra_1\":91,\"fan_fla\":2.1,\"heat_mbh\":115,\"test_pressure_high\":650}."),
      control_platform: opt("string", "Control platform fitted (ComfortLink, SystemVu, RTU-Open, Prodigy...).", { maxLength: 60 }),
      heat_type: opt("string", "Heat type: gas, electric, heat pump, none, hydronic.", { maxLength: 60 }),
      metering_device: opt("string", "txv, fixed, eev or unknown.", { enum: METERING }),
      install_year: opt("integer", "Year installed (not the manufacture year).", { min: 1900, max: 2100 }),
      elevation_ft: opt("integer", "Site elevation in feet.", { min: -1500, max: 30000 }),
      notes: opt("string", "Free-form notes about the unit (access, quirks, history).", { maxLength: 1000 }),
      full_charge_lbs: opt("number", "Total nameplate refrigerant charge of the appliance, lb (enables EPA leak-rate calculation).", { min: 0, max: 100000 }),
      appliance_type: opt("string", "EPA category for the leak-rate threshold: comfort_cooling (10 %), commercial_refrigeration (20 %), industrial_process (30 %), other (10 %).", { enum: APPLIANCE_TYPES }),
      circuits_count: opt("integer", "Independent refrigerant circuits sharing full_charge_lbs equally (each circuit is its own EPA appliance).", { min: 1, max: 64 }),
    },
  },
  {
    name: "set_conversation",
    description:
      "Set this conversation's title (short: unit tag plus the problem, e.g. \"RTU-7 low charge ckt 2\") and/or a 1–2 sentence summary of what was found and done. Call it when a diagnosis is reached or a finding is saved so job memory stays searchable.",
    props: {
      title: opt("string", "New title, ≤ 80 characters.", { maxLength: 80 }),
      summary: opt("string", "1–2 sentence summary of the outcome.", { maxLength: 600 }),
    },
  },
];

const SPEC_BY_NAME = new Map(SPECS.map((s) => [s.name, s]));

/** Tool definitions sent to the API (custom tools only; server tools are added by the loop). */
export function toolDefinitions(): Anthropic.Beta.BetaTool[] {
  return SPECS.map(toBetaTool);
}

/** Names of every custom tool, in definition order. */
export function toolNames(): string[] {
  return SPECS.map((s) => s.name);
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function clip(text: unknown, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

/** Find the largest array anywhere in the value (path + length) so truncation hits the bulkiest data first. */
function largestArray(value: unknown, path: (string | number)[] = []): { path: (string | number)[]; length: number } | null {
  let best: { path: (string | number)[]; length: number } | null = null;
  const visit = (v: unknown, p: (string | number)[]): void => {
    if (Array.isArray(v)) {
      const size = JSON.stringify(v)?.length ?? 0;
      if (v.length > 1 && (!best || size > best.length)) best = { path: p, length: size };
      v.forEach((item, i) => visit(item, [...p, i]));
    } else if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) visit(child, [...p, k]);
    }
  };
  visit(value, path);
  return best;
}

function getAtPath(root: unknown, path: (string | number)[]): unknown {
  let cur = root;
  for (const key of path) cur = (cur as Record<string | number, unknown>)?.[key];
  return cur;
}

function setAtPath(root: unknown, path: (string | number)[], value: unknown): void {
  if (path.length === 0) return;
  const parent = getAtPath(root, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path[path.length - 1]!] = value;
}

/** Clip every string longer than `max` anywhere in the value (in place). Returns how many were clipped. */
function clipLongStrings(value: unknown, max: number): number {
  let count = 0;
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.length > max) {
        count++;
        return `${v.slice(0, max - 1)}…`;
      }
      return v;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = visit(v[i]);
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) o[k] = visit(o[k]);
    }
    return v;
  };
  visit(value);
  return count;
}

/** Compact JSON no longer than TOOL_RESULT_MAX_CHARS; arrays are shortened (and say so) when needed. */
export function compactJson(value: unknown, limit = TOOL_RESULT_MAX_CHARS): string {
  const root = stripUndefined(structuredClone(value)) as Record<string, unknown>;
  let text = JSON.stringify(root);
  if (text.length <= limit) return text;
  const notes: string[] = [];
  const setNote = (): void => {
    const shown = notes.length > 6 ? `${notes.slice(0, 6).join("; ")}; …` : notes.join("; ");
    root.truncated = `Result truncated to fit ${limit} chars (${shown}). Narrow the query for more.`;
  };
  // Stage 1: halve the bulkiest array until everything fits (or no array with 2+ items remains).
  for (let guard = 0; guard < 400 && text.length > limit; guard++) {
    const target = largestArray(root);
    if (!target) break;
    const arr = getAtPath(root, target.path) as unknown[];
    const keep = Math.max(1, Math.floor(arr.length / 2));
    setAtPath(root, target.path, arr.slice(0, keep));
    notes.push(`${target.path.join(".") || "root"}: ${arr.length}→${keep} items`);
    setNote();
    text = JSON.stringify(root);
  }
  // Stage 2: clip long strings.
  for (const max of [600, 300, 150, 80]) {
    if (text.length <= limit) break;
    const n = clipLongStrings(root, max);
    if (n > 0) {
      notes.push(`${n} string${n === 1 ? "" : "s"} clipped to ${max} chars`);
      setNote();
      text = JSON.stringify(root);
    }
  }
  if (text.length > limit) {
    // Last resort: keep the summary and a hard-cut preview so the JSON stays valid. The preview is
    // a JSON string embedded in JSON, so every quote/backslash in it costs an extra escape character:
    // size it on the serialized length, not on the raw slice.
    const summary = typeof root.summary === "string" ? clip(root.summary, 400) : undefined;
    const wrap = (n: number): string => JSON.stringify({ summary, truncated: "Result too large; preview only.", preview: text.slice(0, n) });
    // Serialized length grows monotonically with the preview length: binary-search the largest fit.
    let lo = 0;
    let hi = Math.min(text.length, Math.max(0, limit - wrap(0).length));
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (wrap(mid).length <= limit) lo = mid;
      else hi = mid - 1;
    }
    return wrap(lo);
  }
  return text;
}

function ok(value: unknown, summary: string, extra: Partial<ToolOutcome> = {}): ToolOutcome {
  return { content: compactJson(value), summary: clip(summary, 160), ...extra };
}

function fail(message: string, summary?: string): ToolOutcome {
  return { content: JSON.stringify({ error: message }), isError: true, summary: clip(summary ?? message, 160) };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function fmt(n: number | undefined, digits = 1): string {
  return n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(digits).replace(/\.0$/, "");
}

// ---------------------------------------------------------------------------
// describeToolCall
// ---------------------------------------------------------------------------

/** Human-readable label for a tool call before it runs (used by the UI). */
export function describeToolCall(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s = (k: string, max = 40): string => clip(i[k] ?? "", max);
  switch (name) {
    case "decode_unit":
      return `Decode ${s("model") || "nameplate"}${i.serial ? ` / S/N ${s("serial")}` : ""}`;
    case "find_unit":
      return `Find unit "${s("query")}"`;
    case "refrigerant_pt": {
      const r = s("refrigerant") || "refrigerant";
      if (typeof i.psig === "number") return `PT: ${r} ${i.psig} psig`;
      if (typeof i.temp_f === "number") return `PT: ${r} ${i.temp_f} °F`;
      return `PT: ${r}`;
    }
    case "calc_superheat_subcooling":
      return `SH/SC ${s("refrigerant") || ""}`.trim();
    case "diagnose_refrigeration":
      return `Diagnose ${[s("refrigerant"), s("mode").replace(/_/g, " "), i.circuit ? `ckt ${s("circuit")}` : ""].filter(Boolean).join(" · ")}`.trim();
    case "electrical_reference":
      return `Electrical: ${s("query", 60)}`;
    case "calc_electrical":
      return `Calc ${s("kind").replace(/_/g, " ")}`;
    case "lookup_fault_code":
      return `Fault code ${s("code")}${i.manufacturer ? ` (${s("manufacturer")})` : ""}`;
    case "search_manuals":
      return `Manuals: "${s("query", 60)}"${i.manufacturer ? ` (${s("manufacturer")})` : ""}`;
    case "search_history":
      return `Search history "${s("query", 60)}"`;
    case "get_unit_history":
      return i.unit_id ? `Unit history (${s("unit_id")})` : "Unit history";
    case "save_finding":
      return `Save finding${i.confirmed === true ? "" : " (unconfirmed)"}: ${s("symptom", 60)}`;
    case "update_unit": {
      const keys = Object.keys(i).filter((k) => i[k] !== null && i[k] !== undefined);
      return `Update unit${keys.length ? ` (${keys.slice(0, 4).join(", ")}${keys.length > 4 ? "…" : ""})` : ""}`;
    }
    case "set_conversation": {
      const parts = [];
      if (i.title) parts.push("title");
      if (i.summary) parts.push("summary");
      return `Set conversation ${parts.join(" + ") || "metadata"}`;
    }
    case "diagnose_chiller":
      return `Chiller readings${i.circuit ? ` ckt ${s("circuit")}` : ""}`;
    case "log_refrigerant": {
      const amt = typeof i.amount_lbs === "number" ? ` ${i.amount_lbs} lb` : "";
      return `Log refrigerant ${s("event_type").replace(/_/g, " ")}${amt}${i.refrigerant ? ` ${s("refrigerant")}` : ""}`;
    }
    case "get_pm_checklist":
      return `PM checklist${i.equipment_type ? ` ${s("equipment_type").replace(/_/g, " ")}` : ""}`;
    case "web_search":
      return `Web search: ${s("query", 60)}`;
    default:
      return name;
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function trimControl(c: ControlPlatform): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    coverage: c.coverage ?? "partial",
    confidence: c.confidence,
    faultCodeCount: Array.isArray(c.faultCodes) ? c.faultCodes.length : 0,
    diagnosticTips: (c.diagnosticTips ?? []).slice(0, 4),
    sourceDocs: (c.sourceDocs ?? []).slice(0, 3).map((d) => d.title),
  };
}

function trimDecode(r: DecodeResult): Record<string, unknown> {
  return {
    summary: r.summary,
    evidenceSummary: r.evidenceSummary,
    warnings: r.warnings,
    manufacturerCandidates: r.manufacturerCandidates.slice(0, 4),
    model: r.model.slice(0, 3).map((m) => ({
      manufacturerId: m.manufacturerId,
      family: m.family,
      productType: m.productType,
      attributes: m.attributes,
      segments: m.segments.slice(0, 16),
      refrigerant: m.refrigerant,
      controlPlatformIds: m.controlPlatformIds,
      equivalentFamilies: m.equivalentFamilies,
      confidence: m.confidence,
      evidence: m.evidence,
      sources: (m.sources ?? []).slice(0, 3),
      notes: (m.notes ?? []).slice(0, 4),
    })),
    serial: r.serial.slice(0, 3).map((s) => ({
      manufacturerId: s.manufacturerId,
      description: s.description,
      year: s.year,
      month: s.month,
      week: s.week,
      manufactureDate: s.manufactureDate,
      ageYears: s.ageYears,
      plant: s.plant,
      confidence: s.confidence,
      ambiguous: s.ambiguous,
      candidateYears: s.candidateYears,
      evidence: s.evidence,
      sources: (s.sources ?? []).slice(0, 3),
      notes: (s.notes ?? []).slice(0, 4),
    })),
    controls: r.controls.slice(0, 4).map(trimControl),
    electrical: r.electrical.slice(0, 1).map((e) => ({
      familyLabel: e.familyLabel,
      controlVoltage: e.controlVoltage,
      components: e.components.slice(0, 24).map((c) => `${c.designator}: ${c.name}`),
      safetyDevices: (e.safetyDevices ?? []).slice(0, 10),
      terminalLabels: e.terminalLabels,
      sequenceOfOperation: (e.sequenceOfOperation ?? []).slice(0, 8).map((s) => clip(s, 160)),
      notes: (e.notes ?? []).slice(0, 4).map((s) => clip(s, 160)),
      confidence: e.confidence,
      evidence: e.evidence,
    })),
    commonIssues: r.commonIssues.slice(0, 5).map((c) => ({
      symptom: clip(c.symptom, 120),
      likelyCauses: c.likelyCauses.slice(0, 4).map((s) => clip(s, 120)),
      checks: c.checks.slice(0, 4).map((s) => clip(s, 140)),
      confidence: c.confidence,
      evidence: c.evidence,
    })),
    support: r.support
      ? {
          phone: r.support.phone,
          literatureUrl: r.support.literatureUrl ?? r.support.url,
          literatureSearchHint: r.support.literatureSearchHint ? clip(r.support.literatureSearchHint, 200) : undefined,
          notes: r.support.notes ? clip(r.support.notes, 200) : undefined,
        }
      : undefined,
    hint: "Call get_unit_history after attaching; call lookup_fault_code for codes; electrical designators/sequence are from the pack's wiring-diagram legend (confirm on the unit's diagram).",
  };
}

function phaseFromVoltage(voltage: string | undefined): string | undefined {
  if (!voltage) return undefined;
  const m = /[-/](1|3)[-/]\s*(50|60)/.exec(voltage) ?? /[-/](1|3)\s*(ph|phase|$)/i.exec(voltage);
  return m ? m[1] : undefined;
}

function parseTonnage(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function unitSummaryRecord(u: UnitRow): Record<string, unknown> {
  return {
    id: u.id,
    manufacturer: u.manufacturer,
    brand: u.brand,
    model: u.model,
    serial: u.serial,
    unit_tag: u.unit_tag,
    nickname: u.nickname,
    site: u.site,
    customer: u.customer,
    location_note: u.location_note,
    refrigerant: u.refrigerant,
    tonnage: u.tonnage,
    voltage: u.voltage,
    phase: u.phase,
    circuits: u.circuits,
    charge: safeParse(u.charge_json),
    nameplate: safeParse(u.nameplate_json),
    control_platform: u.control_platform,
    heat_type: u.heat_type,
    metering_device: u.metering_device,
    install_year: u.install_year,
    elevation_ft: u.elevation_ft,
    last_service_at: u.last_service_at,
    archived: u.archived_at ? true : undefined,
    notes: u.notes,
  };
}

function safeParse(text: string | null | undefined): unknown {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function unitLabel(u: UnitRow): string {
  return [u.unit_tag, u.nickname, u.model, u.site].filter((x): x is string => !!x).slice(0, 3).join(" · ") || u.id;
}

function findingDate(f: FindingRow): string {
  return f.service_date ?? f.created_at;
}

function trimFinding(f: FindingRow): Record<string, unknown> {
  return {
    id: f.id,
    date: findingDate(f).slice(0, 10),
    status: f.status,
    circuit: f.circuit,
    symptom: clip(f.symptom, 240),
    cause: f.cause ? clip(f.cause, 240) : undefined,
    resolution: f.resolution ? clip(f.resolution, 300) : undefined,
    measurements: safeParse(f.measurements_json),
    parts: safeParse(f.parts_json),
    tags: f.tags,
    refrigerant: f.refrigerant,
    refrigerant_added_lbs: f.refrigerant_added_lbs,
    refrigerant_recovered_lbs: f.refrigerant_recovered_lbs,
    follow_up: f.follow_up,
    follow_up_due: f.follow_up ? (f.follow_up_due ?? undefined) : undefined,
    follow_up_done: f.follow_up ? f.follow_up_done === 1 : undefined,
    origin: f.origin,
    confirmed: f.confirmed === 1,
    hypothesis: f.origin === "assistant" && f.confirmed !== 1 ? true : undefined,
  };
}

/** Compact readings row for tool results: date, mode, source and the headline numbers only. */
function trimReading(row: ReadingRow): Record<string, unknown> {
  const t = toTrendReading(row);
  const d = t.derived ?? {};
  const m = t.measurements ?? {};
  const pick = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : undefined);
  return {
    id: row.id,
    date: row.created_at.slice(0, 10),
    mode: row.mode,
    source: row.source,
    refrigerant: row.refrigerant,
    outdoorDbF: pick(m.outdoorDbF),
    suctionPsig: pick(m.suctionPsig),
    liquidPsig: pick(m.liquidPsig),
    superheatF: pick(d.superheatF),
    subcoolingF: pick(d.subcoolingF),
    evapSatF: pick(d.evapSatF),
    condSatF: pick(d.condSatF),
    deltaTF: pick(d.deltaTF),
    ampsPercentRla: pick(d.ampsPercentRla),
    validForCharge: (() => {
      const v = safeParse(row.validity_json);
      return v && typeof v === "object" ? (v as { ok?: unknown }).ok !== false : undefined;
    })(),
    note: row.note ?? undefined,
  };
}

function toolDecodeUnit(v: Validated, ctx: ToolContext): ToolOutcome {
  const model = str(v.model)!;
  const serial = str(v.serial);
  const manufacturer = str(v.manufacturer);
  const result = decodeUnit(ctx.kb, { model, serial, manufacturer, now: ctx.now });
  const out: Record<string, unknown> = trimDecode(result);
  const best = result.model[0];
  const bestSerial = result.serial[0];
  const packId = best?.manufacturerId ?? result.manufacturerCandidates[0]?.id;
  const pack = packId ? ctx.kb.manufacturers.find((p) => p.id === packId) : undefined;

  let attachUnitId: string | undefined;
  const existing = ctx.repos.units.findByModelSerial(model, serial ?? null);
  if (v.save === true || existing) {
    const patch: UnitInput = { model, decoded_json: JSON.stringify(result) };
    if (serial) patch.serial = serial;
    const mfrName = pack?.manufacturer ?? result.manufacturerCandidates[0]?.manufacturer;
    if (mfrName) patch.manufacturer = mfrName;
    if (manufacturer) patch.brand = manufacturer;
    else if (mfrName) patch.brand = mfrName;
    const refrigerant = best?.refrigerant ?? best?.attributes.refrigerant;
    if (refrigerant) patch.refrigerant = refrigerant;
    const tonnage = parseTonnage(best?.attributes.tonnage);
    if (tonnage !== undefined) patch.tonnage = tonnage;
    if (best?.attributes.voltage) {
      patch.voltage = best.attributes.voltage;
      const phase = phaseFromVoltage(best.attributes.voltage);
      if (phase) patch.phase = phase;
    }
    if (best?.attributes.heat_type) patch.heat_type = best.attributes.heat_type;
    const platformId = best?.controlPlatformIds?.[0];
    const platform = platformId ? result.controls.find((c) => c.id === platformId) ?? result.controls[0] : result.controls[0];
    if (platform) patch.control_platform = platform.name;
    if (str(v.site)) patch.site = str(v.site);
    if (str(v.unit_tag)) patch.unit_tag = str(v.unit_tag);
    if (str(v.nickname)) patch.nickname = str(v.nickname);
    let unit: UnitRow | undefined;
    if (existing) {
      unit = ctx.repos.units.update(existing.id, patch) ?? existing;
      out.unit = { ...unitSummaryRecord(unit), action: "updated" };
    } else {
      unit = ctx.repos.units.create(patch);
      out.unit = { ...unitSummaryRecord(unit), action: "created" };
    }
    attachUnitId = unit.id;
    out.attachedUnitId = unit.id;
  } else {
    out.saveHint = "Not saved. Call again with save=true (plus site/unit_tag/nickname) once the nameplate is confirmed to store the unit and attach it.";
  }

  const bits: string[] = [];
  if (pack?.manufacturer) bits.push(pack.manufacturer);
  if (best?.family) bits.push(clip(best.family, 40));
  if (best?.attributes.tonnage) bits.push(`${best.attributes.tonnage} ton`);
  if (bestSerial?.manufactureDate) bits.push(bestSerial.ambiguous ? `mfd ${bestSerial.candidateYears?.join("/") ?? bestSerial.manufactureDate}?` : `mfd ${bestSerial.manufactureDate}`);
  const conf = best?.confidence ?? bestSerial?.confidence;
  if (conf) bits.push(`${conf} confidence`);
  const summary = bits.length ? `Decoded ${model}: ${bits.join(", ")}${attachUnitId ? " — unit saved" : ""}` : `No manufacturer match for ${model}`;
  return ok(out, summary, attachUnitId ? { attachUnitId } : {});
}

function toolFindUnit(v: Validated, ctx: ToolContext): ToolOutcome {
  const query = str(v.query)!;
  const site = str(v.site);
  const limit = num(v.limit) ?? 5;
  const seen = new Map<string, UnitRow>();
  const add = (u: UnitRow | undefined): void => {
    if (u && !u.archived_at && !seen.has(u.id)) seen.set(u.id, u);
  };
  for (const hit of ctx.repos.search(query, { site, limit: 40 })) {
    if (hit.kind === "unit") add(ctx.repos.units.get(hit.id));
  }
  for (const u of ctx.repos.units.list({ q: query, site, limit: 40 })) add(u);
  if (seen.size === 0) {
    // token-wise LIKE fallback ("RTU-7 pharmacy" → any unit matching each token)
    const tokens = query.split(/\s+/).filter((t) => t.length >= 2);
    for (const tok of tokens) for (const u of ctx.repos.units.list({ q: tok, site, limit: 40 })) add(u);
  }
  const units = [...seen.values()].slice(0, limit);
  const matches = units.map((u) => {
    const findings = ctx.repos.findings.list({ unitId: u.id, limit: 200 });
    const lastFinding = findings.map(findingDate).sort().at(-1);
    const openCount = findings.filter((f) => f.status === "open" || f.status === "monitor").length;
    return { ...unitSummaryRecord(u), findingCount: findings.length, openFindings: openCount, lastFindingDate: lastFinding?.slice(0, 10) };
  });
  let attachUnitId: string | undefined;
  const attach = bool(v.attach);
  const top = units[0];
  if (top && units.length === 1 && attach !== false) attachUnitId = top.id;
  else if (top && units.length > 1 && attach === true) attachUnitId = top.id;
  const out: Record<string, unknown> = { query, matches, attachedUnitId: attachUnitId };
  if (units.length === 0) out.hint = "No saved unit matched. Ask for the nameplate and call decode_unit with save=true.";
  else if (units.length > 1 && !attachUnitId) out.hint = "Several units matched; ask the tech which one, then call find_unit again with attach=true or a narrower query.";
  const summary = !top
    ? `No unit found for "${query}"`
    : units.length === 1
      ? `Found ${unitLabel(top)}${attachUnitId ? " — attached" : ""}`
      : `${units.length} units match "${query}"${attachUnitId ? ` — ${unitLabel(top)} attached` : ""}`;
  return ok(out, summary, attachUnitId ? { attachUnitId } : {});
}

function toolRefrigerantPt(v: Validated, ctx: ToolContext): ToolOutcome {
  const refrigerant = str(v.refrigerant)!;
  const psig = num(v.psig);
  const tempF = num(v.temp_f);
  if (psig === undefined && tempF === undefined) return fail("Provide psig or temp_f (or both).", "PT lookup: missing psig/temp_f");
  const result = ptLookup(ctx.kb, refrigerant, { psig, tempF, elevationFt: num(v.elevation_ft) });
  const meta = resolveRefrigerant(ctx.kb, refrigerant);
  const hasTable = result.bubbleTempF !== undefined || result.dewTempF !== undefined || result.bubblePsig !== undefined || result.dewPsig !== undefined;
  const out: Record<string, unknown> = {
    ...result,
    type: meta?.type,
    blendType: meta?.blendType,
    composition: meta?.composition,
    lubricant: meta?.lubricant,
    gwp: meta?.gwp,
    replacementFor: meta?.replacementFor,
    aliases: meta?.aliases?.slice(0, 6),
    applications: meta?.applications?.slice(0, 5),
    serviceNotes: meta?.serviceNotes?.slice(0, 8),
    tableSource: meta?.tableSource,
    tableVerified: meta?.tableVerified,
  };
  if (!meta && !hasTable) return fail(`Unknown refrigerant "${refrigerant}". ${result.notes.join(" ")}`, `PT: unknown refrigerant ${refrigerant}`);
  const id = result.refrigerant;
  let summary: string;
  if (psig !== undefined && result.dewTempF !== undefined) {
    summary =
      result.glideF !== undefined && result.glideF >= 0.5
        ? `PT: ${id} ${psig} psig → dew ${fmt(result.dewTempF)} °F / bubble ${fmt(result.bubbleTempF)} °F`
        : `PT: ${id} ${psig} psig → ${fmt(result.dewTempF)} °F`;
  } else if (tempF !== undefined && result.dewPsig !== undefined) {
    summary =
      result.glideF !== undefined && result.glideF >= 0.5
        ? `PT: ${id} ${tempF} °F → bubble ${fmt(result.bubblePsig)} / dew ${fmt(result.dewPsig)} psig`
        : `PT: ${id} ${tempF} °F → ${fmt(result.dewPsig)} psig`;
  } else {
    summary = `PT: ${id} — ${clip(result.notes.find((n) => /outside|critical|No PT/.test(n)) ?? result.notes[0] ?? "no result", 100)}`;
  }
  return ok(out, summary);
}

function toolCalcSuperheatSubcooling(v: Validated, ctx: ToolContext): ToolOutcome {
  const refrigerant = str(v.refrigerant)!;
  const inputs = {
    refrigerant,
    suctionPsig: num(v.suction_psig),
    suctionLineTempF: num(v.suction_line_temp_f),
    liquidPsig: num(v.liquid_psig),
    liquidLineTempF: num(v.liquid_line_temp_f),
    dischargePsig: num(v.discharge_psig),
    elevationFt: num(v.elevation_ft),
  };
  const canSh = inputs.suctionPsig !== undefined && inputs.suctionLineTempF !== undefined;
  const canSc = (inputs.liquidPsig !== undefined || inputs.dischargePsig !== undefined) && inputs.liquidLineTempF !== undefined;
  if (!canSh && !canSc) {
    return fail(
      "Need suction_psig + suction_line_temp_f for superheat and/or liquid_psig (or discharge_psig) + liquid_line_temp_f for subcooling.",
      "SH/SC: not enough readings",
    );
  }
  const r = superheatSubcooling(ctx.kb, inputs);
  if (!resolveRefrigerant(ctx.kb, refrigerant) && r.evapSatF === undefined && r.condSatF === undefined) {
    return fail(`Unknown refrigerant "${refrigerant}". ${r.notes.join(" ")}`, `SH/SC: unknown refrigerant ${refrigerant}`);
  }
  const parts: string[] = [];
  if (r.superheatF !== undefined) parts.push(`SH ${fmt(r.superheatF)} °F`);
  if (r.subcoolingF !== undefined) parts.push(`SC ${fmt(r.subcoolingF)} °F`);
  if (parts.length === 0 && r.evapSatF !== undefined) parts.push(`evap sat ${fmt(r.evapSatF)} °F`);
  if (parts.length === 0 && r.condSatF !== undefined) parts.push(`cond sat ${fmt(r.condSatF)} °F`);
  const summary = `${r.refrigerant}: ${parts.join(" / ") || clip(r.notes[0] ?? "no result", 80)}`;
  return ok({ ...r, inputs, summary }, summary);
}

function toolDiagnose(v: Validated, ctx: ToolContext): ToolOutcome {
  const m: Record<string, unknown> = {
    refrigerant: str(v.refrigerant)!,
    meteringDevice: str(v.metering_device)!,
    mode: str(v.mode)!,
  };
  for (const key of DX_MEASUREMENT_NUMERIC_KEYS) {
    const n = num(v[camelToSnake(key)]);
    if (n !== undefined) m[key] = n;
  }
  for (const key of DX_MEASUREMENT_ENUM_CODED_KEYS) {
    const raw = v[camelToSnake(key)];
    if (raw !== undefined) m[key] = raw;
  }
  if (str(v.circuit)) m.circuit = str(v.circuit);
  if (str(v.notes)) m.notes = str(v.notes);
  const measurements = m as unknown as DxMeasurements;
  if (!resolveRefrigerant(ctx.kb, measurements.refrigerant)) {
    return fail(`Unknown refrigerant "${measurements.refrigerant}". Check the nameplate/retrofit sticker or call refrigerant_pt to list known refrigerants.`, "Diagnose: unknown refrigerant");
  }
  const r = diagnose(ctx.kb, measurements);
  // Readings history: with a unit attached the diagnosis is stored on it (source "chat") and the trend
  // against the previous comparable visit comes back with the result.
  let readingId: string | undefined;
  let trendLines: string[] | undefined;
  if (ctx.unitId && ctx.repos.units.get(ctx.unitId)) {
    try {
      readingId = storeReading(ctx.repos, { unitId: ctx.unitId, conversationId: ctx.conversationId, result: r, source: "chat" }).id;
      const trend = trendFromReadings(ctx.repos.readings.list({ unitId: ctx.unitId, limit: 20 }));
      if (trend) trendLines = trend.lines;
    } catch {
      readingId = undefined; // never fail the diagnosis over history bookkeeping
    }
  }
  const out = {
    refrigerant: r.measurements.refrigerant,
    meteringDevice: r.measurements.meteringDevice,
    mode: r.measurements.mode,
    derived: r.derived,
    validity: r.validity,
    findings: r.findings.slice(0, 6),
    moreFindings: r.findings.length > 6 ? r.findings.length - 6 : undefined,
    missing: r.missing,
    summary: r.summary,
    readingId,
    trendSinceLastVisit: trendLines,
  };
  const top = r.findings[0];
  const flags: string[] = [];
  if (r.derived.superheatF !== undefined) flags.push(`SH ${fmt(r.derived.superheatF)}`);
  if (r.derived.subcoolingF !== undefined) flags.push(`SC ${fmt(r.derived.subcoolingF)}`);
  const head = top ? `${top.severity}: ${clip(top.condition, 70)}` : "no findings";
  const summary = `${r.validity.ok ? "" : "[readings not valid for charge] "}${head}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  return ok(out, summary);
}

function toolElectricalReference(v: Validated, ctx: ToolContext): ToolOutcome {
  const query = str(v.query)!;
  const kind = (str(v.kind) ?? "any") as "component" | "procedure" | "reference" | "any";
  const r = lookupElectrical(ctx.kb, query, kind);
  const out = {
    query,
    kind,
    components: r.components.slice(0, 3),
    procedures: r.procedures.slice(0, 3),
    reference: r.reference.slice(0, 3),
    moreComponents: r.components.length > 3 ? r.components.length - 3 : undefined,
    moreProcedures: r.procedures.length > 3 ? r.procedures.length - 3 : undefined,
    hint: r.components.length + r.procedures.length + r.reference.length === 0 ? "No match. Try a component name (run capacitor, contactor), a symptom (unit dead, breaker trips) or a topic (voltage imbalance)." : undefined,
  };
  const names = [...r.components.slice(0, 2).map((c) => c.name), ...r.procedures.slice(0, 2).map((p) => clip(p.symptom, 40)), ...r.reference.slice(0, 1).map((t) => t.topic)];
  const summary = names.length ? `Electrical: ${names.join("; ")}` : `Electrical: no match for "${query}"`;
  return ok(out, summary);
}

const CALC_REQUIRED: Record<(typeof CALC_KINDS)[number], string[]> = {
  voltage_imbalance: ["vab", "vbc", "vca"],
  current_imbalance: ["ia", "ib", "ic"],
  capacitor_under_load: ["amps", "volts"],
  amps_vs_rla: ["amps", "rla"],
  temp_rise_cfm: ["input_btuh", "efficiency_percent", "rise_f"],
  ohms_law: [],
  electric_heat_kw: ["volts", "amps", "phase"],
  psychrometrics: ["db_f", "wb_f"],
  winding_check: ["phase", "r1", "r2", "r3"],
  megohm: ["megohms"],
  leak_rate: ["added_lbs", "full_charge_lbs", "days_since_last_add"],
  gas_meter_clock: ["dial_cuft", "seconds_per_rev"],
  combustion_co: ["co_ppm", "o2_pct"],
  sensible_cfm: ["btuh", "delta_t_f"],
  static_pressure: ["supply_in_wc", "return_in_wc"],
  fan_laws: ["rpm1", "rpm2"],
  belt_drive: ["motor_rpm", "motor_sheave_in", "fan_sheave_in"],
  voltage_drop: ["volts", "amps", "one_way_ft"],
  motor_fla: ["hp", "volts", "phase"],
  capacitor_replacement: ["rated_uf", "rated_v", "replacement_uf", "replacement_v"],
  motor_replacement: [],
};

function toolCalcElectrical(v: Validated, ctx: ToolContext): ToolOutcome {
  const kind = str(v.kind) as (typeof CALC_KINDS)[number];
  const missing = CALC_REQUIRED[kind].filter((k) => v[k] === undefined);
  if (missing.length) return fail(`${kind} needs ${CALC_REQUIRED[kind].join(", ")}; missing: ${missing.join(", ")}.`, `Calc ${kind}: missing inputs`);
  if (kind === "ohms_law") {
    const given = ["volts", "amps", "ohms", "watts"].filter((k) => v[k] !== undefined);
    if (given.length < 2) return fail("ohms_law needs any two of volts, amps, ohms, watts.", "Calc ohms law: need two values");
  }
  const phase = num(v.phase);
  if ((kind === "electric_heat_kw" || kind === "winding_check" || kind === "motor_fla") && phase !== 1 && phase !== 3) {
    return fail("phase must be 1 or 3.", `Calc ${kind}: phase must be 1 or 3`);
  }
  if ((kind === "voltage_drop" || kind === "motor_replacement") && phase !== undefined && phase !== 1 && phase !== 3) {
    return fail("phase must be 1 or 3.", `Calc ${kind}: phase must be 1 or 3`);
  }
  if (kind === "voltage_drop" && str(v.awg) === undefined && num(v.circular_mils) === undefined) {
    return fail("voltage_drop needs awg (14…4/0, 250…500 kcmil) or circular_mils.", "Calc voltage drop: conductor size missing");
  }
  let request: ElectricalCalcRequest;
  switch (kind) {
    case "voltage_imbalance":
      request = { kind, vab: num(v.vab)!, vbc: num(v.vbc)!, vca: num(v.vca)! };
      break;
    case "current_imbalance":
      request = { kind, ia: num(v.ia)!, ib: num(v.ib)!, ic: num(v.ic)! };
      break;
    case "capacitor_under_load":
      request = { kind, amps: num(v.amps)!, volts: num(v.volts)!, ratedUf: num(v.rated_uf) };
      break;
    case "amps_vs_rla":
      request = { kind, amps: num(v.amps)!, rla: num(v.rla)! };
      break;
    case "temp_rise_cfm":
      request = { kind, inputBtuh: num(v.input_btuh)!, efficiencyPercent: num(v.efficiency_percent)!, riseF: num(v.rise_f)! };
      break;
    case "ohms_law":
      request = { kind, volts: num(v.volts), amps: num(v.amps), ohms: num(v.ohms), watts: num(v.watts) };
      break;
    case "electric_heat_kw":
      request = { kind, volts: num(v.volts)!, amps: num(v.amps)!, phase: phase as 1 | 3, nameplateKw: num(v.nameplate_kw) };
      break;
    case "psychrometrics":
      request = { kind, dbF: num(v.db_f)!, wbF: num(v.wb_f)!, elevationFt: num(v.elevation_ft) };
      break;
    case "winding_check":
      request = { kind, phase: phase as 1 | 3, r1: num(v.r1)!, r2: num(v.r2)!, r3: num(v.r3)! };
      break;
    case "megohm":
      request = { kind, megohms: num(v.megohms)!, testVolts: num(v.test_volts) };
      break;
    case "leak_rate":
      request = { kind, addedLbs: num(v.added_lbs)!, fullChargeLbs: num(v.full_charge_lbs)!, daysSinceLastAdd: num(v.days_since_last_add)!, applianceType: str(v.appliance_type) as ElectricalCalcRequest extends { applianceType?: infer T } ? T : never, refrigerant: str(v.refrigerant) };
      break;
    case "gas_meter_clock":
      request = { kind, dialCuft: num(v.dial_cuft)!, secondsPerRev: num(v.seconds_per_rev)!, heatingValueBtuPerCuft: num(v.heating_value_btu_per_cuft), revolutions: num(v.revolutions), nameplateInputBtuh: num(v.nameplate_input_btuh) };
      break;
    case "combustion_co":
      request = { kind, coPpm: num(v.co_ppm)!, o2Pct: num(v.o2_pct)!, ambientCoPpm: num(v.ambient_co_ppm) };
      break;
    case "sensible_cfm":
      request = { kind, btuh: num(v.btuh)!, deltaTF: num(v.delta_t_f)!, tons: num(v.tons) };
      break;
    case "static_pressure":
      request = { kind, supplyInWc: num(v.supply_in_wc)!, returnInWc: num(v.return_in_wc)!, ratedMaxInWc: num(v.rated_max_in_wc), blowerType: str(v.blower_type) as "psc" | "ecm" | undefined };
      break;
    case "fan_laws":
      request = { kind, rpm1: num(v.rpm1)!, rpm2: num(v.rpm2)!, cfm1: num(v.cfm1), sp1: num(v.sp1), bhp1: num(v.bhp1) };
      break;
    case "belt_drive":
      request = { kind, motorRpm: num(v.motor_rpm)!, motorSheaveIn: num(v.motor_sheave_in)!, fanSheaveIn: num(v.fan_sheave_in)!, centerDistanceIn: num(v.center_distance_in) };
      break;
    case "voltage_drop":
      request = { kind, volts: num(v.volts)!, amps: num(v.amps)!, oneWayFt: num(v.one_way_ft)!, awg: str(v.awg), circularMils: num(v.circular_mils), material: str(v.material) as "cu" | "al" | undefined, phase: phase as 1 | 3 | undefined };
      break;
    case "motor_fla":
      request = { kind, hp: num(v.hp)!, volts: num(v.volts)!, phase: phase as 1 | 3 };
      break;
    case "capacitor_replacement":
      request = { kind, ratedUf: num(v.rated_uf)!, ratedV: num(v.rated_v)!, replacementUf: num(v.replacement_uf)!, replacementV: num(v.replacement_v)! };
      break;
    case "motor_replacement":
      request = { kind, hp: num(v.hp), rpm: num(v.rpm), volts: num(v.volts), phase: phase as 1 | 3 | undefined, frame: str(v.frame), rotationFromShaftEnd: str(v.rotation_from_shaft_end) as "cw" | "ccw" | undefined, shaftDiaIn: num(v.shaft_dia_in), enclosure: str(v.enclosure) };
      break;
  }
  const r = calcElectrical(request, { refrigerantLookup: complianceRefrigerantLookup(ctx.kb) });
  const summary = `${kind.replace(/_/g, " ")}: ${clip(r.interpretation[0] ?? r.warnings[0] ?? Object.entries(r.values).map(([k, n]) => `${k}=${fmt(n, 2)}`).join(", "), 120)}`;
  return ok({ ...r, request }, summary);
}

/** Characters of passage text per hit, sized so the default 4 hits plus citations fit TOOL_RESULT_MAX_CHARS. */
const MANUAL_PASSAGE_CHARS = 1500;

function toolSearchManuals(v: Validated): ToolOutcome {
  const query = str(v.query)!.trim();
  const manufacturer = str(v.manufacturer)?.trim() || undefined;
  const limit = num(v.max_results) ?? 4;
  const lib = getManualLibrary();
  const missing = lib ? lib.unavailable() : "no manual library configured on this server";
  if (!lib || missing) {
    return ok(
      { query, manufacturer, available: false, reason: missing, guidance: "The manual library is not installed on this server. Answer from the knowledge tools, say the manual was not searched, and point the tech to the IOM / controller manual on the unit or the manufacturer's literature site." },
      "Manuals: library not installed",
    );
  }
  const r = lib.search(query, { manufacturer, limit });
  const perHit = Math.max(500, Math.floor((MANUAL_PASSAGE_CHARS * 4) / Math.max(r.hits.length, 4)));
  const passages = r.hits.map((h) => ({
    document: h.title,
    docNo: h.docNo ?? undefined,
    manufacturer: h.manufacturerLabel,
    type: h.kind === "manual" ? "manufacturer manual" : "research notes (compiled from manufacturer manuals; check the cited source)",
    location: h.location,
    url: h.url ?? undefined,
    text: h.text.length > perHit ? `${h.text.slice(0, perHit).trimEnd()} …` : h.text,
  }));
  const out = {
    query,
    manufacturerFilter: r.manufacturerFilter ?? undefined,
    match: r.match === "any" ? "partial: no passage had every word; these share some of them, so check relevance" : r.match === "all" ? "all words" : "no match",
    passages,
    note:
      passages.length === 0
        ? "No passages found. Try the exact display text, a component name, or drop the manufacturer filter. Do not guess the content of a manual."
        : "Quote the passage and cite document + location. Manual text was extracted from PDFs: table columns are separated by ' | ' and may be misaligned; confirm numbers on the unit's own literature when they matter.",
  };
  const where = r.hits[0] ? `${clip(r.hits[0].title, 50)} ${r.hits[0].location}` : "no passages";
  return ok(out, `Manuals "${clip(query, 40)}": ${r.hits.length} passage${r.hits.length === 1 ? "" : "s"} (${where})`);
}

function toolLookupFaultCode(v: Validated, ctx: ToolContext): ToolOutcome {
  const code = str(v.code)!;
  const manufacturer = str(v.manufacturer);
  const platform = str(v.platform);
  const hits = lookupFaultCode(ctx.kb, code, { manufacturer, platform });
  const entries = hits.slice(0, 8).map((h) => ({
    manufacturer: h.manufacturer,
    platform: { id: h.platform.id, name: h.platform.name, coverage: h.platform.coverage ?? "partial", confidence: h.platform.confidence },
    code: h.fault.code,
    meaning: h.fault.meaning,
    likelyCauses: (h.fault.likelyCauses ?? []).slice(0, 6),
    checks: (h.fault.checks ?? []).slice(0, 6),
    severity: h.fault.severity,
    notes: h.fault.notes,
    source: h.fault.source ?? "source not recorded — confirm in the controller manual",
    evidence: h.fault.evidence,
    coverageNote:
      (h.platform.coverage ?? "partial") === "complete"
        ? `The ${h.platform.name} table is complete in the pack.`
        : `The ${h.platform.name} table is PARTIAL in the pack — a missing code is not evidence the code does not exist.`,
  }));
  const platforms = [...new Set(hits.map((h) => `${h.manufacturer} ${h.platform.name}`))];
  const out = {
    query: { code, manufacturer, platform },
    hitCount: hits.length,
    entries,
    moreHits: hits.length > 8 ? hits.length - 8 : undefined,
    message:
      hits.length === 0
        ? `No verified entry for "${code}"${manufacturer ? ` on ${manufacturer}` : ""}${platform ? ` / ${platform}` : ""} in the manufacturer packs. Say so, and offer to look it up in the controller manual (web search when enabled).`
        : `${hits.length} verified entr${hits.length === 1 ? "y" : "ies"} across ${platforms.length} platform${platforms.length === 1 ? "" : "s"}: ${platforms.slice(0, 4).join("; ")}. Each entry lists its source and the platform's table coverage.`,
  };
  const top = entries[0];
  const summary = top
    ? `${top.code} (${top.platform.name}, ${top.platform.coverage}): ${clip(top.meaning, 80)}${entries.length > 1 ? ` +${entries.length - 1} more` : ""}`
    : `No verified entry for ${code}`;
  return ok(out, summary);
}

function toolSearchHistory(v: Validated, ctx: ToolContext): ToolOutcome {
  const query = str(v.query)!;
  const unitOnly = bool(v.unit_only) === true;
  if (unitOnly && !ctx.unitId) return fail("unit_only=true but no unit is attached to this conversation. Attach one (decode_unit save=true / find_unit) or search without unit_only.", "Search history: no unit attached");
  const since = str(v.since);
  if (since !== undefined && !Number.isFinite(Date.parse(since))) return fail(`since must be an ISO date (YYYY-MM-DD); got "${since}".`, "Search history: bad since date");
  const hits = ctx.repos.search(query, { unitId: unitOnly ? ctx.unitId ?? undefined : undefined, site: str(v.site), since, limit: 10 });
  const results = hits.map((h) => ({
    kind: h.kind,
    id: h.id,
    conversationId: h.conversationId,
    conversationTitle: h.conversationTitle,
    unitId: h.unitId,
    date: h.createdAt.slice(0, 10),
    snippet: clip(h.snippet, 300),
  }));
  const out = {
    query,
    filters: { unit_only: unitOnly, unitId: unitOnly ? ctx.unitId : undefined, site: str(v.site), since },
    hitCount: results.length,
    hits: results,
    hint: results.length === 0 ? "No hits. Try fewer or different words; codes and model fragments match as whole tokens." : undefined,
  };
  return ok(out, results.length ? `${results.length} hit${results.length === 1 ? "" : "s"} for "${query}"` : `No history for "${query}"`);
}

function trimCorrection(c: CorrectionRow): Record<string, unknown> {
  return {
    date: c.created_at.slice(0, 10),
    field: c.field,
    appValue: c.app_value ?? undefined,
    actualValue: clip(c.actual_value, 200),
    note: c.note ? clip(c.note, 300) : undefined,
    appliedToUnit: c.applied === 1 ? true : undefined,
  };
}

function toolGetUnitHistory(v: Validated, ctx: ToolContext): ToolOutcome {
  const unitId = str(v.unit_id) ?? ctx.unitId;
  if (!unitId) return fail("No unit attached to this conversation and no unit_id given. Call decode_unit with save=true or find_unit first.", "Unit history: no unit attached");
  const unit = ctx.repos.units.get(unitId);
  if (!unit) return fail(`Unit ${unitId} not found.`, "Unit history: unit not found");
  const findings = ctx.repos.findings.list({ unitId, limit: 100 });
  const conversations = ctx.repos.conversations.list({ unitId, limit: 20 });
  const corrections = ctx.repos.corrections.list({ unitId, limit: 100 });
  const readingRows = ctx.repos.readings.list({ unitId, limit: 20 });
  const trend = trendFromReadings(readingRows);
  const openFollowUps = findings.filter((f) => f.follow_up && f.follow_up_done !== 1);
  const decoded = safeParse(unit.decoded_json) as Partial<DecodeResult> | undefined;
  const out = {
    unit: unitSummaryRecord(unit),
    openFollowUps: openFollowUps.length
      ? openFollowUps.map((f) => ({ findingId: f.id, due: f.follow_up_due ?? undefined, text: clip(f.follow_up ?? "", 240), symptom: clip(f.symptom, 120), status: f.status }))
      : undefined,
    decoded:
      decoded && typeof decoded === "object"
        ? { summary: decoded.summary, warnings: decoded.warnings, bestModel: decoded.model?.[0]?.attributes, family: decoded.model?.[0]?.family, serial: decoded.serial?.[0] }
        : undefined,
    technicianCorrections: corrections.length
      ? {
          note: "Technician corrections - trust these over the decoder. Each says what the app showed (appValue) and what the nameplate/tech found (actualValue).",
          items: corrections.slice(0, 20).map(trimCorrection),
          more: corrections.length > 20 ? corrections.length - 20 : undefined,
        }
      : undefined,
    findingCount: findings.length,
    findings: findings.slice(0, 20).map(trimFinding),
    moreFindings: findings.length > 20 ? findings.length - 20 : undefined,
    readingCount: readingRows.length,
    readings: readingRows.length ? readingRows.slice(0, 3).map(trimReading) : undefined,
    trendSinceLastVisit: trend ? { since: trend.since, lines: trend.lines } : undefined,
    conversations: conversations.slice(0, 10).map((c) => ({
      id: c.id,
      title: c.title,
      summary: c.summary ? clip(c.summary, 300) : undefined,
      updated: c.updated_at.slice(0, 10),
      current: c.id === ctx.conversationId ? true : undefined,
    })),
  };
  const open = findings.filter((f) => f.status === "open" || f.status === "monitor").length;
  const corr = corrections.length ? `, ${corrections.length} correction${corrections.length === 1 ? "" : "s"}` : "";
  const fu = openFollowUps.length ? `, ${openFollowUps.length} open follow-up${openFollowUps.length === 1 ? "" : "s"}` : "";
  const rd = readingRows.length ? `, ${readingRows.length} reading${readingRows.length === 1 ? "" : "s"}${trend ? " (trend)" : ""}` : "";
  return ok(out, `${unitLabel(unit)}: ${findings.length} finding${findings.length === 1 ? "" : "s"} (${open} open/monitor)${fu}${rd}, ${conversations.length} conversation${conversations.length === 1 ? "" : "s"}${corr}`);
}

function toolSaveFinding(v: Validated, ctx: ToolContext): ToolOutcome {
  const confirmed = v.confirmed === true;
  const now = ctx.now ?? new Date();
  const serviceDate = str(v.service_date) ?? now.toISOString().slice(0, 10);
  if (!Number.isFinite(Date.parse(serviceDate))) return fail(`service_date must be an ISO date; got "${serviceDate}".`, "Save finding: bad date");
  const followUpDue = str(v.follow_up_due) ?? null;
  if (followUpDue !== null && !/^\d{4}-\d{2}-\d{2}$/.test(followUpDue)) return fail(`follow_up_due must be YYYY-MM-DD; got "${followUpDue}".`, "Save finding: bad follow-up date");
  const row = ctx.repos.findings.create({
    unit_id: ctx.unitId,
    conversation_id: ctx.conversationId,
    symptom: str(v.symptom)!,
    cause: str(v.cause) ?? null,
    resolution: str(v.resolution) ?? null,
    measurements_json: str(v.measurements) ?? null,
    parts_json: Array.isArray(v.parts) && v.parts.length ? JSON.stringify(v.parts) : null,
    tags: Array.isArray(v.tags) && v.tags.length ? (v.tags as string[]).join(",") : null,
    circuit: str(v.circuit) ?? null,
    status: (str(v.status) as FindingRow["status"] | undefined) ?? (confirmed ? "resolved" : "open"),
    service_date: serviceDate,
    refrigerant: str(v.refrigerant) ?? null,
    refrigerant_added_lbs: num(v.refrigerant_added_lbs) ?? null,
    refrigerant_recovered_lbs: num(v.refrigerant_recovered_lbs) ?? null,
    follow_up: str(v.follow_up) ?? null,
    follow_up_due: str(v.follow_up) ? followUpDue : null,
    origin: "assistant",
    confirmed: confirmed ? 1 : 0,
  });
  const out = {
    saved: true,
    finding: trimFinding(row),
    unitAttached: ctx.unitId !== null,
    note: ctx.unitId
      ? confirmed
        ? "Saved as confirmed by the tech."
        : "Saved as an UNCONFIRMED hypothesis (confirmed=false). Tell the tech; re-save with confirmed=true once they confirm the cause and fix."
      : "No unit is attached: the finding is linked to this conversation only. Attach the unit (decode_unit save=true) so it shows in the unit's history.",
  };
  return ok(out, `Finding saved${confirmed ? "" : " (unconfirmed)"}: ${clip(row.symptom, 60)}`);
}

const UPDATE_UNIT_FIELDS = [
  "nickname",
  "unit_tag",
  "site",
  "customer",
  "location_note",
  "refrigerant",
  "tonnage",
  "voltage",
  "phase",
  "circuits",
  "control_platform",
  "heat_type",
  "metering_device",
  "install_year",
  "elevation_ft",
  "notes",
  "full_charge_lbs",
  "appliance_type",
  "circuits_count",
] as const;

// ---------------------------------------------------------------------------
// Wave 2 tools: chiller readings, refrigerant log, PM checklist
// ---------------------------------------------------------------------------

function toolDiagnoseChiller(v: Validated, ctx: ToolContext): ToolOutcome {
  const m: Record<string, unknown> = {};
  for (const key of CHILLER_NUMERIC_KEYS) {
    const n = num(v[camelToSnake(key)]);
    if (n !== undefined) m[key] = n;
  }
  if (str(v.refrigerant)) m.refrigerant = str(v.refrigerant);
  if (str(v.condenser_type)) m.condenserType = str(v.condenser_type);
  if (str(v.circuit)) m.circuit = str(v.circuit);
  if (str(v.notes)) m.notes = str(v.notes);
  const unit = ctx.unitId ? ctx.repos.units.get(ctx.unitId) : undefined;
  if (!m.refrigerant && unit?.refrigerant) m.refrigerant = unit.refrigerant;
  if (Object.keys(m).every((k) => ["refrigerant", "condenserType", "circuit", "notes"].includes(k))) {
    return fail("No chiller readings given. Pass chw_supply_f / chw_return_f and evap_sat_f (or evap_pressure_psig + refrigerant), cond_sat_f (or cond_pressure_psig) with cond_water_out_f or outdoor_db_f.", "Chiller: no readings");
  }
  if (typeof m.refrigerant === "string" && !resolveRefrigerant(ctx.kb, m.refrigerant)) {
    return fail(`Unknown refrigerant "${m.refrigerant}". Check the chiller nameplate or call refrigerant_pt to list known refrigerants.`, "Chiller: unknown refrigerant");
  }
  const r = evaluateChiller(ctx.kb, m as ChillerMeasurements);
  let readingId: string | undefined;
  if (unit) {
    try {
      readingId = storeChillerReading(ctx.repos, { unitId: unit.id, conversationId: ctx.conversationId, result: r, source: "chat" }).id;
    } catch {
      readingId = undefined;
    }
  }
  const out = {
    condenserType: r.condenserType,
    derived: r.derived,
    validity: r.validity,
    findings: r.findings.slice(0, 6),
    moreFindings: r.findings.length > 6 ? r.findings.length - 6 : undefined,
    missing: r.missing,
    summary: r.summary,
    readingId,
    scope: "Chiller charge is by weight / manufacturer procedure; approaches and ΔT judge heat-exchanger health and load. Log any refrigerant added with log_refrigerant.",
  };
  const top = r.findings.find((f) => f.severity !== "info");
  const bits: string[] = [];
  if (r.derived.evapApproachF !== undefined) bits.push(`evap approach ${fmt(r.derived.evapApproachF)}`);
  if (r.derived.condApproachF !== undefined) bits.push(`cond approach ${fmt(r.derived.condApproachF)}`);
  if (r.derived.chwDeltaTF !== undefined) bits.push(`ΔT ${fmt(r.derived.chwDeltaTF)}`);
  return ok(out, `${top ? `${top.severity}: ${clip(top.condition, 70)}` : "chiller readings within band"}${bits.length ? ` (${bits.join(", ")})` : ""}`);
}

function toolLogRefrigerant(v: Validated, ctx: ToolContext): ToolOutcome {
  if (!ctx.unitId) return fail("No unit is attached to this conversation. Call decode_unit with save=true or find_unit first, then log_refrigerant.", "Log refrigerant: no unit attached");
  const unit = ctx.repos.units.get(ctx.unitId);
  if (!unit) return fail(`Attached unit ${ctx.unitId} no longer exists.`, "Log refrigerant: unit missing");
  const eventType = str(v.event_type)!;
  const amount = num(v.amount_lbs);
  if ((eventType === "add" || eventType === "recover") && !(amount !== undefined && amount > 0)) return fail(`amount_lbs (> 0) is required for ${eventType}.`, `Log refrigerant: amount missing`);
  const date = str(v.date);
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(`date must be YYYY-MM-DD; got "${date}".`, "Log refrigerant: bad date");
  const row = ctx.repos.refrigerantEvents.create({
    unit_id: unit.id,
    conversation_id: ctx.conversationId,
    event_type: eventType,
    refrigerant: str(v.refrigerant) ?? null,
    amount_lbs: amount ?? null,
    circuit: num(v.circuit) ?? null,
    cylinder_id: str(v.cylinder_id) ?? null,
    tech_name: str(v.tech_name) ?? null,
    tech_cert: str(v.tech_cert) ?? null,
    leak_found: bool(v.leak_found) ?? null,
    passed: bool(v.passed) ?? null,
    note: str(v.note) ?? null,
    date: date ?? null,
  });
  const today = (ctx.now ?? new Date()).toISOString().slice(0, 10);
  const compliance = unitCompliance(ctx.repos, unit, today, undefined, complianceRefrigerantLookup(ctx.kb));
  const event = refrigerantEventView(row);
  const finding = row.finding_id ? ctx.repos.findings.get(row.finding_id) : undefined;
  const notes: string[] = [];
  if (eventType === "add") {
    if (row.leak_rate_pct === null) notes.push(`Leak rate not computed: ${compliance.fullChargeLbs === null ? "the unit has no full_charge_lbs — ask for the nameplate charge and call update_unit" : "no previous add or install year on record; the next add will be annualized from this one"}.`);
    else if (row.exceeded === 1) notes.push(`EXCEEDANCE: ${row.leak_rate_pct} % per year exceeds the ${row.threshold_pct} % threshold. Tell the tech: repair within 30 days of ${event.date} (120 if a shutdown is needed), initial verification test before adding refrigerant again, follow-up verification within 10 days, records kept 3 years. A follow-up finding was opened${finding ? ` (due ${finding.follow_up_due})` : ""}.`);
    else notes.push(`${row.leak_rate_pct} % per year is below the ${row.threshold_pct} % threshold.`);
  }
  const oe = compliance.openExceedance;
  if (oe && oe.id !== row.id) notes.push(`The ${oe.date} exceedance (${oe.leakRatePct ?? "?"} %/yr) is still open: it closes only with a passed follow-up verification test or a retrofit/retirement plan, not with a top-off.`);
  if (!compliance.applies && compliance.fullChargeLbs !== null && (eventType === "add" || oe)) {
    notes.push(compliance.regime === "not_covered" ? `The EPA leak-repair obligations do not apply to this unit's refrigerant (GWP ≤ 53, not an HFC or ODS); the rate is for the record.` : `The EPA leak-repair obligations do not apply: the full charge is below the ${compliance.applicabilityLbs} lb applicability${compliance.regime === "ods" ? " for an ODS (40 CFR 82.157)" : " (40 CFR 84.106)"}.`);
  }
  const out = { event, finding: finding ? trimFinding(finding) : undefined, compliance, notes: notes.length ? notes : undefined, formula: compliance.formula };
  const label = eventType.replace(/_/g, " ");
  const summary =
    eventType === "add"
      ? `Logged add ${amount} lb${row.refrigerant ? ` ${row.refrigerant}` : ""}: ${row.leak_rate_pct === null ? "leak rate n/a" : `${row.leak_rate_pct} %/yr${row.exceeded === 1 ? ` EXCEEDS ${row.threshold_pct} %` : ` (limit ${row.threshold_pct} %)`}`}`
      : `Logged ${label}${amount !== undefined ? ` ${amount} lb` : ""}${compliance.obligations.length ? ` — ${compliance.obligations.length} open obligation${compliance.obligations.length === 1 ? "" : "s"}` : ""}`;
  return ok(out, summary);
}

function toolGetPmChecklist(v: Validated, ctx: ToolContext): ToolOutcome {
  const pm = ctx.kb.pm;
  if (!pm) return fail("No PM checklist templates are loaded on this server.", "PM checklist: none loaded");
  const unit = ctx.unitId ? ctx.repos.units.get(ctx.unitId) : undefined;
  let templateId = str(v.equipment_type);
  let suggestion: { templateId: string | null; reason: string } | undefined;
  if (!templateId) {
    if (!unit) return fail(`No unit attached and no equipment_type given. Pass one of: ${pm.templates.map((t) => t.id).join(", ")}.`, "PM checklist: equipment type needed");
    suggestion = suggestPmTemplate(unit);
    if (!suggestion.templateId) return fail(`Could not pick a template for the attached unit (${suggestion.reason}). Pass equipment_type: ${pm.templates.map((t) => t.id).join(", ")}.`, "PM checklist: equipment type needed");
    templateId = suggestion.templateId;
  }
  const template = findTemplate(pm, templateId);
  if (!template) return fail(`Unknown template "${templateId}". Known: ${pm.templates.map((t) => t.id).join(", ")}.`, "PM checklist: unknown template");
  const lastPm = unit ? unitLastPm(ctx.repos, unit.id, ctx.kb) : null;
  const out = {
    template: {
      id: template.id,
      name: template.name,
      appliesTo: template.appliesTo,
      sections: template.sections.map((s) => ({
        title: s.title,
        items: s.items.map((i) => ({ id: i.id, label: i.label, kind: i.kind, unit: i.unit, nameplateCompare: i.nameplateCompare, asFoundAsLeft: i.asFoundAsLeft, safety: i.safety, hint: i.hint })),
      })),
    },
    suggestedFrom: suggestion ? suggestion.reason : undefined,
    availableTemplates: pm.templates.map((t) => t.id),
    lastPm: lastPm
      ? {
          date: lastPm.date,
          status: lastPm.status,
          templateId: lastPm.template_id,
          templateName: lastPm.template_name,
          techName: lastPm.tech_name,
          total: lastPm.summary?.total,
          pass: lastPm.summary?.pass,
          fail: lastPm.summary?.fail,
          na: lastPm.summary?.na,
          fails: lastPm.summary?.items.filter((i) => i.status === "fail").map((i) => `${i.label}${i.note ? ` — ${clip(i.note, 120)}` : ""}`),
          flagged: lastPm.summary?.items.filter((i) => i.flagged).map((i) => `${i.label}: ${i.value ?? i.asLeft ?? i.asFound} vs ${i.reference}`),
          note: lastPm.note ?? undefined,
        }
      : undefined,
    hint: "Walk the tech through the sections; the app's PM sheet stores results per item (value / checked / as-found / as-left) and evaluates nameplate deviations.",
  };
  const n = templateSummary(template).itemCount;
  return ok(out, `PM checklist ${template.name} (${n} items)${suggestion ? " — picked from the unit" : ""}${lastPm ? `; last PM ${lastPm.date}: ${lastPm.summary?.fail ?? 0} fail` : ""}`);
}

function toolUpdateUnit(v: Validated, ctx: ToolContext): ToolOutcome {
  if (!ctx.unitId) return fail("No unit is attached to this conversation. Call decode_unit with save=true or find_unit first, then update_unit.", "Update unit: no unit attached");
  const unit = ctx.repos.units.get(ctx.unitId);
  if (!unit) return fail(`Attached unit ${ctx.unitId} no longer exists.`, "Update unit: unit missing");
  const patch: Record<string, unknown> = {};
  for (const k of UPDATE_UNIT_FIELDS) if (v[k] !== undefined) patch[k] = v[k];
  if (v.charge !== undefined) patch.charge_json = v.charge;
  if (v.nameplate !== undefined) patch.nameplate_json = v.nameplate;
  const keys = Object.keys(patch);
  if (keys.length === 0) return fail("Nothing to update: pass at least one field.", "Update unit: no fields");
  const updated = ctx.repos.units.update(unit.id, patch as UnitInput);
  if (!updated) return fail("Unit update failed.", "Update unit: failed");
  return ok({ updated: keys, unit: unitSummaryRecord(updated) }, `Unit ${unitLabel(updated)} updated: ${keys.join(", ")}`);
}

function toolSetConversation(v: Validated): ToolOutcome {
  const title = str(v.title);
  const summary = str(v.summary);
  if (!title && !summary) return fail("Provide a title and/or a summary.", "Set conversation: nothing to set");
  const extra: Partial<ToolOutcome> = {};
  if (title) extra.setTitle = title;
  if (summary) extra.setSummary = summary;
  const parts = [title ? `title "${clip(title, 50)}"` : "", summary ? "summary" : ""].filter(Boolean);
  return ok({ ok: true, title, summary }, `Conversation ${parts.join(" and ")} set`, extra);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Validate input against the tool's schema and execute. Never throws; errors become isError results. */
export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) return fail(`Unknown tool "${name}". Available: ${toolNames().join(", ")}.`, `Unknown tool ${name}`);
  const validated = validateInput(spec, input);
  if (!validated.ok) {
    return fail(`Invalid input for ${name}: ${validated.problems.join("; ")}.`, `${name}: invalid input (${validated.problems.length} problem${validated.problems.length === 1 ? "" : "s"})`);
  }
  const v = validated.value;
  try {
    switch (name) {
      case "decode_unit":
        return toolDecodeUnit(v, ctx);
      case "find_unit":
        return toolFindUnit(v, ctx);
      case "refrigerant_pt":
        return toolRefrigerantPt(v, ctx);
      case "calc_superheat_subcooling":
        return toolCalcSuperheatSubcooling(v, ctx);
      case "diagnose_refrigeration":
        return toolDiagnose(v, ctx);
      case "electrical_reference":
        return toolElectricalReference(v, ctx);
      case "calc_electrical":
        return toolCalcElectrical(v, ctx);
      case "lookup_fault_code":
        return toolLookupFaultCode(v, ctx);
      case "search_manuals":
        return toolSearchManuals(v);
      case "search_history":
        return toolSearchHistory(v, ctx);
      case "get_unit_history":
        return toolGetUnitHistory(v, ctx);
      case "save_finding":
        return toolSaveFinding(v, ctx);
      case "update_unit":
        return toolUpdateUnit(v, ctx);
      case "set_conversation":
        return toolSetConversation(v);
      case "diagnose_chiller":
        return toolDiagnoseChiller(v, ctx);
      case "log_refrigerant":
        return toolLogRefrigerant(v, ctx);
      case "get_pm_checklist":
        return toolGetPmChecklist(v, ctx);
      default:
        return fail(`Tool "${name}" has no implementation.`, `Unknown tool ${name}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return fail(`${name} failed: ${message}`, `${name} failed: ${clip(message, 80)}`);
  }
}
