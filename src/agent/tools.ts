import type Anthropic from "@anthropic-ai/sdk";
import type { Repos, UnitInput } from "../db/repos.ts";
import type {
  ControlPlatform,
  DecodeResult,
  DxMeasurements,
  ElectricalCalcRequest,
  FindingRow,
  KnowledgeBase,
  UnitRow,
} from "../types.ts";
import { decodeUnit } from "../knowledge/decoder.ts";
import { diagnose } from "../knowledge/diagnostics.ts";
import { calcElectrical, lookupElectrical } from "../knowledge/electrical.ts";
import { lookupFaultCode } from "../knowledge/faults.ts";
import { ptLookup, resolveRefrigerant, superheatSubcooling } from "../knowledge/refrigerants.ts";
import { DX_MEASUREMENT_ENUM_CODED_KEYS, DX_MEASUREMENT_NUMERIC_KEYS } from "../knowledge/loader.ts";

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
// Schema DSL (hand-written validator + strict JSON schema generator)
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

function jsonSchemaFor(prop: Prop): Record<string, unknown> {
  const nullable = !prop.required;
  const withNull = (t: string): string | string[] => (nullable ? [t, "null"] : t);
  const out: Record<string, unknown> = { description: prop.description };
  switch (prop.type) {
    case "string":
    case "json":
      out.type = withNull("string");
      if (prop.enum) out.enum = nullable ? [...prop.enum, null] : [...prop.enum];
      break;
    case "number":
    case "integer":
      out.type = withNull(prop.type);
      if (prop.min !== undefined) out.minimum = prop.min;
      if (prop.max !== undefined) out.maximum = prop.max;
      break;
    case "boolean":
      out.type = withNull("boolean");
      break;
    case "string_array":
      out.type = withNull("array");
      out.items = { type: "string" };
      break;
  }
  return out;
}

function toBetaTool(spec: ToolSpec): Anthropic.Beta.BetaTool {
  const properties: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(spec.props)) properties[key] = jsonSchemaFor(prop);
  return {
    name: spec.name,
    description: spec.description,
    strict: true,
    input_schema: {
      type: "object",
      properties,
      required: Object.keys(spec.props),
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
    hotGasBypass: "true when a hot gas bypass valve is fitted and may be holding suction pressure.",
  };
  for (const key of DX_MEASUREMENT_ENUM_CODED_KEYS) {
    const e = DX_ENUMS[key];
    props[camelToSnake(key)] = e === "boolean" ? opt("boolean", enumDescriptions[key] ?? key) : opt("string", enumDescriptions[key] ?? key, { enum: e });
  }
  props.circuit = opt("string", "Circuit identifier on multi-circuit units: 1, 2, A, B.", { maxLength: 20 });
  props.efficiency_tier = opt("string", "Condenser coil efficiency tier: standard (split 25–30 °F) or high (high-efficiency/microchannel, split 10–20 °F).", { enum: ["standard", "high"] });
  props.notes = opt("string", "Anything else about conditions (dirty coil seen, fan not running, recent work).", { maxLength: 500 });
  return props;
}

const CALC_KINDS = [
  "voltage_imbalance",
  "current_imbalance",
  "capacitor_under_load",
  "amps_vs_rla",
  "temp_rise_cfm",
  "ohms_law",
  "electric_heat_kw",
  "psychrometrics",
  "winding_check",
  "megohm",
] as const;

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
      "Electrical calculators. Pick a kind and pass its inputs: voltage_imbalance (vab, vbc, vca in volts → %, NEMA derate); current_imbalance (ia, ib, ic amps); capacitor_under_load (amps on the capacitor lead, volts across it, rated_uf → measured µF and pass/fail); amps_vs_rla (amps, rla); temp_rise_cfm (input_btuh, efficiency_percent, rise_f → CFM); ohms_law (any two of volts, amps, ohms, watts); electric_heat_kw (volts, amps, phase 1|3, nameplate_kw); psychrometrics (db_f, wb_f, elevation_ft → RH, dew point, enthalpy, grains); winding_check (phase, r1, r2, r3 ohms: 1-ph r1=C-S r2=C-R r3=S-R; 3-ph T1-T2, T2-T3, T3-T1); megohm (megohms, test_volts).",
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
      "Full job memory for a unit: record, nameplate data, decoded attributes, every finding (open/monitor first, hypotheses marked) and past conversations with summaries. Defaults to the unit attached to this conversation; pass unit_id to read another unit (ids come from find_unit / search_history).",
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
      follow_up: opt("string", "What to do on the next visit.", { maxLength: 400 }),
      service_date: opt("string", "Service date YYYY-MM-DD; defaults to today.", { maxLength: 30 }),
      confirmed: opt("boolean", "true only when the tech explicitly confirmed the cause and fix."),
    },
  },
  {
    name: "update_unit",
    description:
      "Update the unit attached to this conversation with nameplate data the decoder cannot infer: tag, nickname, site, customer, location note, refrigerant, tonnage, voltage, phase, number of circuits, factory charge per circuit, nameplate electrical data (MCA/MOP/RLA/LRA/fan FLA/heat kW or MBH), control platform, heat type, metering device, install year, elevation, notes. Pass only the fields to change. Requires an attached unit (decode_unit with save=true or find_unit first).",
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
    // Last resort: keep the summary and a hard-cut preview so the JSON stays valid.
    const summary = typeof root.summary === "string" ? clip(root.summary, 400) : undefined;
    const overhead = JSON.stringify({ summary, truncated: "Result too large; preview only.", preview: "" }).length + 64;
    const preview = text.slice(0, Math.max(0, limit - overhead));
    return JSON.stringify({ summary, truncated: "Result too large; preview only.", preview });
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
    origin: f.origin,
    confirmed: f.confirmed === 1,
    hypothesis: f.origin === "assistant" && f.confirmed !== 1 ? true : undefined,
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
  if (str(v.efficiency_tier)) m.efficiencyTier = str(v.efficiency_tier);
  if (str(v.notes)) m.notes = str(v.notes);
  const measurements = m as unknown as DxMeasurements;
  if (!resolveRefrigerant(ctx.kb, measurements.refrigerant)) {
    return fail(`Unknown refrigerant "${measurements.refrigerant}". Check the nameplate/retrofit sticker or call refrigerant_pt to list known refrigerants.`, "Diagnose: unknown refrigerant");
  }
  const r = diagnose(ctx.kb, measurements);
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
};

function toolCalcElectrical(v: Validated): ToolOutcome {
  const kind = str(v.kind) as (typeof CALC_KINDS)[number];
  const missing = CALC_REQUIRED[kind].filter((k) => v[k] === undefined);
  if (missing.length) return fail(`${kind} needs ${CALC_REQUIRED[kind].join(", ")}; missing: ${missing.join(", ")}.`, `Calc ${kind}: missing inputs`);
  if (kind === "ohms_law") {
    const given = ["volts", "amps", "ohms", "watts"].filter((k) => v[k] !== undefined);
    if (given.length < 2) return fail("ohms_law needs any two of volts, amps, ohms, watts.", "Calc ohms law: need two values");
  }
  const phase = num(v.phase);
  if ((kind === "electric_heat_kw" || kind === "winding_check") && phase !== 1 && phase !== 3) {
    return fail("phase must be 1 or 3.", `Calc ${kind}: phase must be 1 or 3`);
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
  }
  const r = calcElectrical(request);
  const summary = `${kind.replace(/_/g, " ")}: ${clip(r.interpretation[0] ?? r.warnings[0] ?? Object.entries(r.values).map(([k, n]) => `${k}=${fmt(n, 2)}`).join(", "), 120)}`;
  return ok({ ...r, request }, summary);
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

function toolGetUnitHistory(v: Validated, ctx: ToolContext): ToolOutcome {
  const unitId = str(v.unit_id) ?? ctx.unitId;
  if (!unitId) return fail("No unit attached to this conversation and no unit_id given. Call decode_unit with save=true or find_unit first.", "Unit history: no unit attached");
  const unit = ctx.repos.units.get(unitId);
  if (!unit) return fail(`Unit ${unitId} not found.`, "Unit history: unit not found");
  const findings = ctx.repos.findings.list({ unitId, limit: 100 });
  const conversations = ctx.repos.conversations.list({ unitId, limit: 20 });
  const decoded = safeParse(unit.decoded_json) as Partial<DecodeResult> | undefined;
  const out = {
    unit: unitSummaryRecord(unit),
    decoded:
      decoded && typeof decoded === "object"
        ? { summary: decoded.summary, warnings: decoded.warnings, bestModel: decoded.model?.[0]?.attributes, family: decoded.model?.[0]?.family, serial: decoded.serial?.[0] }
        : undefined,
    findingCount: findings.length,
    findings: findings.slice(0, 20).map(trimFinding),
    moreFindings: findings.length > 20 ? findings.length - 20 : undefined,
    conversations: conversations.slice(0, 10).map((c) => ({
      id: c.id,
      title: c.title,
      summary: c.summary ? clip(c.summary, 300) : undefined,
      updated: c.updated_at.slice(0, 10),
      current: c.id === ctx.conversationId ? true : undefined,
    })),
  };
  const open = findings.filter((f) => f.status === "open" || f.status === "monitor").length;
  return ok(out, `${unitLabel(unit)}: ${findings.length} finding${findings.length === 1 ? "" : "s"} (${open} open/monitor), ${conversations.length} conversation${conversations.length === 1 ? "" : "s"}`);
}

function toolSaveFinding(v: Validated, ctx: ToolContext): ToolOutcome {
  const confirmed = v.confirmed === true;
  const now = ctx.now ?? new Date();
  const serviceDate = str(v.service_date) ?? now.toISOString().slice(0, 10);
  if (!Number.isFinite(Date.parse(serviceDate))) return fail(`service_date must be an ISO date; got "${serviceDate}".`, "Save finding: bad date");
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
] as const;

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
        return toolCalcElectrical(v);
      case "lookup_fault_code":
        return toolLookupFaultCode(v, ctx);
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
      default:
        return fail(`Tool "${name}" has no implementation.`, `Unknown tool ${name}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return fail(`${name} failed: ${message}`, `${name} failed: ${clip(message, 80)}`);
  }
}
