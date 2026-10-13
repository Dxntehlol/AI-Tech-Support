/**
 * PM checklists (pure): evaluate a visit's results against a template (pass / fail / n/a per item, nameplate
 * comparisons), derive the unit's nameplate references, and suggest a template from the unit record.
 */
import type { DecodeResult, PmChecklists, PmItem, PmNameplateCompare, PmTemplate, UnitRow } from "../types.ts";

/** Tolerances for nameplate comparisons: volts ±10 %, amps up to 110 % of RLA/FLA, capacitors ±6 % of rating. */
export const PM_TOLERANCES: Record<PmNameplateCompare, number> = { volts: 10, amps: 10, capacitor_uf: 6 };

export const PM_TEMPLATE_IDS = [
  "rtu_gas",
  "rtu_electric_or_cooling_only",
  "split_ac",
  "heat_pump",
  "chiller_air_cooled",
  "chiller_water_cooled",
  "walk_in_cooler",
  "walk_in_freezer",
  "ice_machine",
  "mau_exhaust",
  "boiler",
] as const;
export type PmTemplateId = (typeof PM_TEMPLATE_IDS)[number];

/** One item's recorded result. Numbers may be strings from a form; `rated` is the printed rating for capacitor items. */
export interface PmItemResult {
  value?: number | string | null;
  checked?: boolean | null;
  asFound?: number | null;
  asLeft?: number | null;
  /** Explicit verdict; wins over the derived one. null = not decided. */
  pass?: boolean | null;
  note?: string | null;
  rated?: number | null;
}

export type PmResults = Record<string, PmItemResult>;

export interface PmNameplate {
  /** Nameplate voltage range (208-230 → 208…230; 460 → 460…460). */
  voltageMinV?: number;
  voltageMaxV?: number;
  /** Compressor RLA (the reference for compressor amps items only). */
  rlaA?: number;
  /** Indoor blower motor FLA (`nameplate_json` blower_fla / blower_motor_fla / ifm_fla); items with nameplateKey "blower_fla". */
  blowerFlaA?: number;
  /** Fan motor FLA (`nameplate_json` fan_fla / fan_motor_fla / ofm_fla / exhaust_fan_fla); items with nameplateKey "fan_fla". */
  fanFlaA?: number;
  capacitorUf?: number;
}

export type PmItemStatus = "pass" | "fail" | "na";

export interface PmItemEvaluation {
  id: string;
  label: string;
  section: string;
  kind: PmItem["kind"];
  status: PmItemStatus;
  value?: number | string;
  asFound?: number;
  asLeft?: number;
  /** What the value was compared with, e.g. "nameplate 208–230 V ±10 %". */
  reference?: string;
  deviationPct?: number;
  flagged: boolean;
  safety: boolean;
  note?: string;
}

export interface PmSummary {
  templateId: string;
  templateName: string;
  total: number;
  pass: number;
  fail: number;
  na: number;
  /** Item ids whose number deviates from the nameplate reference beyond tolerance. */
  flagged: string[];
  /** Item ids that failed (explicit fail, unchecked safety item, or nameplate deviation). */
  fails: string[];
  /** Failed items with the safety flag (call these out first). */
  safetyFails: string[];
  items: PmItemEvaluation[];
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim().replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** All items of a template, with their section title. */
export function templateItems(template: PmTemplate): { item: PmItem; section: string }[] {
  const out: { item: PmItem; section: string }[] = [];
  for (const s of template.sections ?? []) for (const item of s.items ?? []) out.push({ item, section: s.title });
  return out;
}

export function templateItemCount(template: PmTemplate): number {
  return templateItems(template).length;
}

/** Compact template listing for GET /api/pm/templates. */
export function templateSummary(template: PmTemplate): { id: string; name: string; appliesTo: string; itemCount: number; sections: { title: string; itemCount: number }[] } {
  return {
    id: template.id,
    name: template.name,
    appliesTo: template.appliesTo,
    itemCount: templateItemCount(template),
    sections: (template.sections ?? []).map((s) => ({ title: s.title, itemCount: (s.items ?? []).length })),
  };
}

export function findTemplate(pm: PmChecklists | undefined, id: string | null | undefined): PmTemplate | undefined {
  if (!pm || typeof id !== "string") return undefined;
  const key = id.trim().toLowerCase();
  return pm.templates.find((t) => t.id === key);
}

// ---------------------------------------------------------------------------
// Nameplate references from the unit record
// ---------------------------------------------------------------------------

function safeParse(text: string | null | undefined): Record<string, unknown> | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * "208-230/3/60" and "208/230-3-60" and "208/230/3/60" → [208, 230]; "460/3/60" → [460, 460]; "575" → [575, 575];
 * unknown → undefined. Every number in 100–700 is a voltage; phase (1/3) and frequency (50/60 Hz) fall outside
 * that band, so the separators ("/" or "-") do not matter.
 */
export function parseVoltageRange(voltage: string | null | undefined): { min: number; max: number } | undefined {
  if (typeof voltage !== "string") return undefined;
  const nums = voltage.match(/\d+(?:\.\d+)?/g)?.map(Number).filter((n) => n >= 100 && n <= 700) ?? [];
  if (nums.length === 0) return undefined;
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

/**
 * Nameplate references for comparisons: voltage from `units.voltage`; compressor RLA (rla, rla_1, compressor_rla…),
 * blower FLA (blower_fla, blower_motor_fla, ifm_fla), fan FLA (fan_fla, fan_motor_fla, ofm_fla, exhaust_fan_fla)
 * and run capacitor µF from `nameplate_json`.
 */
export function nameplateOf(unit: Pick<UnitRow, "voltage" | "nameplate_json">): PmNameplate {
  const out: PmNameplate = {};
  const v = parseVoltageRange(unit.voltage);
  if (v) {
    out.voltageMinV = v.min;
    out.voltageMaxV = v.max;
  }
  const np = safeParse(unit.nameplate_json);
  if (np) {
    for (const [k, val] of Object.entries(np)) {
      const key = k.toLowerCase().replace(/[\s-]/g, "_");
      const n = num(val);
      if (n === undefined || n <= 0) continue;
      if (out.rlaA === undefined && /^(rla|rla_?1|compressor_?rla|comp_?rla)$/.test(key)) out.rlaA = n;
      if (out.capacitorUf === undefined && /^(run_?cap(acitor)?_?uf|capacitor_?uf|cap_?uf)$/.test(key)) out.capacitorUf = n;
      if (out.blowerFlaA === undefined && /^(blower_?(motor_?)?fla|ifm_?fla|indoor_?fan_?fla)$/.test(key)) out.blowerFlaA = n;
      if (out.fanFlaA === undefined && /^(fan_?(motor_?)?fla|ofm_?fla|condenser_?fan_?fla|exhaust_?fan_?fla)$/.test(key)) out.fanFlaA = n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Compressor amps items ("comp_amps", "Compressor running amps vs RLA") are the only ones compared with the compressor RLA. */
function isCompressorItem(item: Pick<PmItem, "id" | "label">): boolean {
  return /comp/i.test(item.id) || /compressor/i.test(item.label);
}

function compare(kind: PmNameplateCompare, value: number, nameplate: PmNameplate, rated: number | undefined, item: PmItem): { status: PmItemStatus; reference: string; deviationPct?: number } | undefined {
  switch (kind) {
    case "volts": {
      const min = nameplate.voltageMinV;
      const max = nameplate.voltageMaxV;
      if (min === undefined || max === undefined) return undefined;
      const lo = min * (1 - PM_TOLERANCES.volts / 100);
      const hi = max * (1 + PM_TOLERANCES.volts / 100);
      const nominal = value < min ? min : value > max ? max : value;
      const deviationPct = round1(((value - nominal) / nominal) * 100);
      const label = min === max ? `${min} V` : `${min}–${max} V`;
      return { status: value >= lo && value <= hi ? "pass" : "fail", reference: `nameplate ${label} ±${PM_TOLERANCES.volts} %`, deviationPct };
    }
    case "amps": {
      // Fan / blower motors are judged against their own FLA (per-item `rated` or the item's nameplateKey), never
      // the compressor RLA; without a reference the item is n/a and asks for the motor FLA.
      const compressor = isCompressorItem(item);
      const fromKey = item.nameplateKey === "blower_fla" ? nameplate.blowerFlaA : item.nameplateKey === "fan_fla" ? nameplate.fanFlaA : undefined;
      const rla = rated ?? fromKey ?? (compressor ? nameplate.rlaA : undefined);
      if (rla === undefined) return compressor ? undefined : { status: "na", reference: "enter motor FLA (rated) to compare" };
      const pct = round1((value / rla) * 100);
      return { status: value <= rla * (1 + PM_TOLERANCES.amps / 100) ? "pass" : "fail", reference: `RLA/FLA ${rla} A (fail above ${100 + PM_TOLERANCES.amps} %)`, deviationPct: round1(pct - 100) };
    }
    case "capacitor_uf": {
      const r = rated ?? nameplate.capacitorUf;
      if (r === undefined) return undefined;
      const deviationPct = round1(((value - r) / r) * 100);
      return { status: Math.abs(deviationPct) <= PM_TOLERANCES.capacitor_uf ? "pass" : "fail", reference: `rated ${r} µF ±${PM_TOLERANCES.capacitor_uf} %`, deviationPct };
    }
  }
}

/**
 * Evaluate one visit. Per item: an explicit `pass` wins; a check item passes when checked (an unchecked
 * safety item with any other data recorded fails; otherwise n/a); a number item is compared with the
 * nameplate reference when it has one (the as-left value, else as-found, else value) and flagged when it
 * deviates; a text or plain number item passes when something was recorded. Items with nothing recorded are n/a.
 */
export function evaluate(template: PmTemplate, results: PmResults | null | undefined, nameplate: PmNameplate = {}): PmSummary {
  const res = results && typeof results === "object" ? results : {};
  const items: PmItemEvaluation[] = [];
  for (const { item, section } of templateItems(template)) {
    const r = (res[item.id] ?? {}) as PmItemResult;
    const ev: PmItemEvaluation = { id: item.id, label: item.label, section, kind: item.kind, status: "na", flagged: false, safety: item.safety === true };
    const note = typeof r.note === "string" && r.note.trim() !== "" ? r.note.trim() : undefined;
    if (note) ev.note = note;
    const asFound = num(r.asFound);
    const asLeft = num(r.asLeft);
    const value = item.kind === "number" ? num(r.value) : typeof r.value === "string" && r.value.trim() !== "" ? r.value.trim() : num(r.value);
    if (asFound !== undefined) ev.asFound = asFound;
    if (asLeft !== undefined) ev.asLeft = asLeft;
    if (value !== undefined) ev.value = value;
    const measured = asLeft ?? asFound ?? (typeof value === "number" ? value : undefined);
    const anything = measured !== undefined || value !== undefined || r.checked === true || r.checked === false || note !== undefined;

    let status: PmItemStatus = "na";
    if (item.kind === "check") {
      if (r.checked === true) status = "pass";
      else if (r.checked === false) status = item.safety || note !== undefined ? "fail" : "na";
    } else if (item.kind === "number") {
      if (measured !== undefined) {
        status = "pass";
        if (item.nameplateCompare) {
          const c = compare(item.nameplateCompare, measured, nameplate, num(r.rated), item);
          if (c) {
            status = c.status;
            ev.reference = c.reference;
            if (c.deviationPct !== undefined) ev.deviationPct = c.deviationPct;
            if (c.status === "fail") ev.flagged = true;
          }
        }
      }
    } else if (value !== undefined) status = "pass";

    if (r.pass === true) status = "pass";
    else if (r.pass === false) status = "fail";
    else if (status === "na" && anything && r.checked !== false && note !== undefined && item.kind !== "check") status = "pass";
    ev.status = status;
    items.push(ev);
  }
  const fails = items.filter((i) => i.status === "fail");
  return {
    templateId: template.id,
    templateName: template.name,
    total: items.length,
    pass: items.filter((i) => i.status === "pass").length,
    fail: fails.length,
    na: items.filter((i) => i.status === "na").length,
    flagged: items.filter((i) => i.flagged).map((i) => i.id),
    fails: fails.map((i) => i.id),
    safetyFails: fails.filter((i) => i.safety).map((i) => i.id),
    items,
  };
}

/** The stored summary (summary_json) parsed back, or null. */
export function parseSummary(text: string | null | undefined): PmSummary | null {
  const v = safeParse(text);
  if (!v || typeof v.total !== "number") return null;
  return v as unknown as PmSummary;
}

// ---------------------------------------------------------------------------
// Template suggestion from the unit record / decode
// ---------------------------------------------------------------------------

export interface PmSuggestion {
  templateId: PmTemplateId | null;
  reason: string;
}

/**
 * Pick a template from the decoded product type and heat type: packaged RTU with gas heat → rtu_gas, other
 * packaged/air handler → rtu_electric_or_cooling_only, split condensing unit → split_ac, heat pumps →
 * heat_pump, chillers → water- or air-cooled by family wording, refrigeration condensing units → walk-in
 * cooler, furnaces → rtu_gas (combustion items apply). Null when nothing is known.
 */
export function suggestPmTemplate(unit: Pick<UnitRow, "heat_type" | "decoded_json" | "model" | "manufacturer">, decoded?: DecodeResult | null): PmSuggestion {
  const d = decoded ?? (safeParse(unit.decoded_json) as unknown as DecodeResult | null);
  const best = d?.model?.[0];
  const productType = best?.productType;
  const family = `${best?.family ?? ""} ${unit.model ?? ""}`.toLowerCase();
  const heat = `${unit.heat_type ?? best?.attributes?.heat_type ?? ""}`.toLowerCase();
  const gas = /gas|propane|lp\b|natural/.test(heat);
  const heatPumpHeat = /heat ?pump/.test(heat);
  switch (productType) {
    case "packaged_rtu":
      if (heatPumpHeat) return { templateId: "heat_pump", reason: "packaged rooftop with heat-pump heat" };
      return gas ? { templateId: "rtu_gas", reason: "packaged rooftop with gas heat" } : { templateId: "rtu_electric_or_cooling_only", reason: `packaged rooftop${heat ? ` with ${heat} heat` : ""}` };
    case "air_handler":
      return { templateId: "rtu_electric_or_cooling_only", reason: "air handler (airside items)" };
    case "split_condensing_unit":
      return { templateId: "split_ac", reason: "split condensing unit" };
    case "split_heat_pump":
    case "water_source_hp":
      return { templateId: "heat_pump", reason: productType === "water_source_hp" ? "water-source heat pump (skip outdoor-coil items)" : "split heat pump" };
    case "chiller":
      return /water[- ]cooled|centrifugal|cvh|19xr|23xr|rthd|yk\b|wme/.test(family)
        ? { templateId: "chiller_water_cooled", reason: "chiller (water-cooled family)" }
        : { templateId: "chiller_air_cooled", reason: "chiller (air-cooled unless the family says otherwise)" };
    case "refrigeration_condensing_unit":
      return /freez|low[- ]temp/.test(family) ? { templateId: "walk_in_freezer", reason: "refrigeration condensing unit (low temp)" } : { templateId: "walk_in_cooler", reason: "refrigeration condensing unit (medium temp assumed)" };
    case "furnace":
      return { templateId: "rtu_gas", reason: "furnace: gas heat / combustion items apply" };
    default:
      break;
  }
  if (heatPumpHeat) return { templateId: "heat_pump", reason: "heat-pump heat type on the record" };
  if (gas) return { templateId: "rtu_gas", reason: "gas heat type on the record" };
  if (/chiller|cgam|rtac|30ra|30rb|ylaa|yvaa/.test(family)) return { templateId: "chiller_air_cooled", reason: "model looks like an air-cooled chiller" };
  if (/boiler/.test(family)) return { templateId: "boiler", reason: "model looks like a boiler" };
  if (/ice|cuber|flaker|manitowoc|hoshizaki|scotsman/.test(family) || /manitowoc|hoshizaki|scotsman/.test((unit.manufacturer ?? "").toLowerCase())) return { templateId: "ice_machine", reason: "ice machine manufacturer/model" };
  return { templateId: null, reason: "no product type decoded; pick the equipment type" };
}
