/**
 * Service reports (pure builders, no I/O).
 *
 * `buildConversationReport` / `buildUnitReport` turn stored rows into one structured object (the `json`
 * format); `renderReportMarkdown` and `renderReportHtml` render that object. The HTML page is
 * self-contained (inline CSS, no external assets, a print stylesheet and a "Print / Save as PDF" button).
 * Everything that came from the database or the model is escaped; the assistant summary is the only
 * markdown-rendered block, through `marked` with a renderer that never emits raw HTML, images or
 * non-http(s) links.
 */
import { Marked } from "marked";
import type { ConversationRow, CorrectionRow, DecodeResult, DxDerived, DxFinding, FindingRow, MessageRow, PmVisitRow, RefrigerantEventRow, UnitRow } from "./types.ts";
import { camelize, safeParseJson } from "./routes/util.ts";
import type { ComplianceSummary } from "./knowledge/refrigerantCompliance.ts";
import { parseSummary } from "./knowledge/pm.ts";

export type ReportFormat = "md" | "html" | "json";
export const REPORT_FORMATS: readonly ReportFormat[] = ["md", "html", "json"];
export const COMPLAINT_MAX_CHARS = 400;
export const UNIT_REPORT_CONVERSATIONS = 5;

/** Tools whose calls are listed under "Readings". */
export const READINGS_TOOLS: ReadonlySet<string> = new Set(["diagnose_refrigeration", "calc_superheat_subcooling"]);

// ---------------------------------------------------------------------------
// Report data shapes (the `json` format)
// ---------------------------------------------------------------------------

export interface ReportUnit {
  id: string;
  tag: string | null;
  nickname: string | null;
  site: string | null;
  customer: string | null;
  locationNote: string | null;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  family: string | null;
  tonnage: number | null;
  refrigerant: string | null;
  voltage: string | null;
  phase: string | null;
  controlPlatform: string | null;
  heatType: string | null;
  meteringDevice: string | null;
  manufactureDate: string | null;
  ageYears: number | null;
  installYear: number | null;
  elevationFt: number | null;
  circuits: number | null;
  charge: string | null;
  notes: string | null;
  decodeWarnings: string[];
}

export interface ReportValue {
  key: string;
  label: string;
  value: string;
}

export interface ReportReadings {
  at: string;
  tool: string;
  label: string;
  ok: boolean;
  circuit: string | null;
  measurements: ReportValue[];
  derived: ReportValue[];
  validity: { ok: boolean; issues: string[] } | null;
  findings: { severity: string; condition: string }[];
  summary: string | null;
  /** Free-text readings entered on the Readings sheet and sent to chat (no tool call). */
  text: string | null;
}

export interface ReportFinding {
  id: string;
  date: string | null;
  status: FindingRow["status"];
  confirmed: boolean;
  origin: FindingRow["origin"];
  circuit: string | null;
  symptom: string;
  cause: string | null;
  resolution: string | null;
  parts: string[];
  measurements: Record<string, unknown> | null;
  refrigerant: string | null;
  refrigerantAddedLbs: number | null;
  refrigerantRecoveredLbs: number | null;
  followUp: string | null;
  tags: string[];
  conversationId: string | null;
}

export interface ReportCorrection {
  date: string;
  field: string;
  appValue: string | null;
  actualValue: string;
  note: string | null;
  applied: boolean;
}

export interface ReportConversationRef {
  id: string;
  title: string;
  date: string;
  summary: string | null;
}

/** One refrigerant log line for the owner documentation block. */
export interface ReportRefrigerantEvent {
  date: string;
  type: string;
  refrigerant: string | null;
  amountLbs: number | null;
  circuit: number | null;
  cylinderId: string | null;
  techName: string | null;
  techCert: string | null;
  leakFound: boolean | null;
  passed: boolean | null;
  leakRatePct: number | null;
  thresholdPct: number | null;
  exceeded: boolean | null;
  note: string | null;
}

/** "Owner documentation" (EPA 40 CFR 84.106 record the tech hands the owner): events, formula, obligations. */
export interface ReportOwnerDocumentation {
  fullChargeLbs: number | null;
  applianceType: string | null;
  thresholdPct: number;
  applies: boolean;
  circuitsCount: number;
  formula: string;
  source: string;
  lastLeakRatePct: number | null;
  exceeded: boolean;
  events: ReportRefrigerantEvent[];
  obligations: { kind: string; dueDate: string | null; text: string; overdue: boolean }[];
  notes: string[];
}

/** Last PM visit summary for a report. */
export interface ReportPm {
  date: string;
  templateId: string;
  templateName: string;
  status: string;
  techName: string | null;
  total: number;
  pass: number;
  fail: number;
  na: number;
  fails: string[];
  flagged: string[];
  safetyFails: string[];
  note: string | null;
}

export interface ReportJob {
  startedAt: string | null;
  endedAt: string | null;
  minutesOnSite: number | null;
}

export interface ReportSignature {
  signedBy: string | null;
  signedAt: string | null;
  note: string | null;
  /** PNG data URL; embedded in the HTML report, noted in Markdown. */
  png: string | null;
}

export interface ConversationReport {
  kind: "conversation";
  generatedAt: string;
  appVersion: string;
  conversation: { id: string; title: string; createdAt: string; updatedAt: string; summary: string | null };
  unit: ReportUnit | null;
  complaint: string | null;
  readings: ReportReadings[];
  findings: ReportFinding[];
  openItems: string[];
  assistantSummary: string | null;
  job: ReportJob;
  signature: ReportSignature | null;
  ownerDocumentation: ReportOwnerDocumentation | null;
  pm: ReportPm | null;
}

export interface UnitReport {
  kind: "unit";
  generatedAt: string;
  appVersion: string;
  unit: ReportUnit;
  findingsByDate: { date: string; findings: ReportFinding[] }[];
  corrections: ReportCorrection[];
  conversations: ReportConversationRef[];
  totals: { findings: number; open: number; conversations: number };
  ownerDocumentation: ReportOwnerDocumentation | null;
  pm: ReportPm | null;
}

export type Report = ConversationReport | UnitReport;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Whitespace-collapsed text cut at `max` characters with an ellipsis (never mid-surrogate). */
export function truncateText(text: string, max: number): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, Math.max(0, max - 1)).replace(/\s+\S*$/, "");
  return `${cut || s.slice(0, max - 1)}…`;
}

function dateOnly(iso: string | null | undefined): string {
  if (!iso) return "";
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso;
}

function dateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

function fmtNum(n: unknown, digits = 1): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n ?? "");
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  return String(r);
}

/** A safe, short filename stem: lowercase ASCII words joined by "-", at most 40 chars. */
export function slugify(s: string, max = 40): string {
  const slug = String(s ?? "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug;
}

const EXT: Record<ReportFormat, string> = { md: "md", html: "html", json: "json" };
export const REPORT_CONTENT_TYPES: Record<ReportFormat, string> = {
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
};

/** `hvac-report-<unit>-<date>.<ext>` for a conversation, `hvac-unit-<unit>-<date>.<ext>` for a unit. */
export function reportFilename(report: Report, format: ReportFormat): string {
  const unitStem = report.unit ? slugify(report.unit.tag || report.unit.nickname || report.unit.model || report.unit.id) : "";
  const stem = report.kind === "conversation" ? slugify(unitStem || report.conversation.title || report.conversation.id) : unitStem || "unit";
  const date = dateOnly(report.generatedAt) || "report";
  return `hvac-${report.kind === "conversation" ? "report" : "unit"}-${stem || "untitled"}-${date}.${EXT[format]}`;
}

function parseJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  const v = safeParseJson(text);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function decodedOf(unit: UnitRow): DecodeResult | null {
  const d = parseJsonObject(unit.decoded_json);
  return d ? (d as unknown as DecodeResult) : null;
}

export function reportUnit(unit: UnitRow): ReportUnit {
  const d = decodedOf(unit);
  const bestModel = d?.model?.[0];
  const bestSerial = d?.serial?.[0];
  let charge: string | null = null;
  if (unit.charge_json) {
    const c = safeParseJson(unit.charge_json);
    charge = c && typeof c === "object" ? Object.entries(c as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`).join(", ") : unit.charge_json;
  }
  return {
    id: unit.id,
    tag: unit.unit_tag,
    nickname: unit.nickname,
    site: unit.site,
    customer: unit.customer,
    locationNote: unit.location_note,
    manufacturer: unit.manufacturer ?? unit.brand,
    model: unit.model,
    serial: unit.serial,
    family: bestModel?.family ?? null,
    tonnage: unit.tonnage,
    refrigerant: unit.refrigerant,
    voltage: unit.voltage,
    phase: unit.phase,
    controlPlatform: unit.control_platform ? String(unit.control_platform).split(" — ")[0] ?? null : null,
    heatType: unit.heat_type,
    meteringDevice: unit.metering_device,
    manufactureDate: bestSerial?.manufactureDate ?? null,
    ageYears: typeof bestSerial?.ageYears === "number" ? bestSerial.ageYears : null,
    installYear: unit.install_year,
    elevationFt: unit.elevation_ft,
    circuits: unit.circuits,
    charge,
    notes: unit.notes,
    decodeWarnings: Array.isArray(d?.warnings) ? d.warnings.filter((w): w is string => typeof w === "string").slice(0, 6) : [],
  };
}

function parseStringList(text: string | null): string[] {
  if (!text) return [];
  const v = safeParseJson(text);
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? JSON.stringify(x) : String(x))).filter(Boolean);
  if (typeof v === "string") return [v];
  return [text];
}

export function reportFinding(f: FindingRow): ReportFinding {
  return {
    id: f.id,
    date: f.service_date ?? dateOnly(f.created_at) ?? null,
    status: f.status,
    confirmed: Number(f.confirmed) === 1,
    origin: f.origin,
    circuit: f.circuit,
    symptom: f.symptom,
    cause: f.cause,
    resolution: f.resolution,
    parts: parseStringList(f.parts_json),
    measurements: parseJsonObject(f.measurements_json),
    refrigerant: f.refrigerant,
    refrigerantAddedLbs: f.refrigerant_added_lbs,
    refrigerantRecoveredLbs: f.refrigerant_recovered_lbs,
    followUp: f.follow_up,
    tags: f.tags ? f.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    conversationId: f.conversation_id,
  };
}

// ---------------------------------------------------------------------------
// Readings extraction from stored message blocks
// ---------------------------------------------------------------------------

type Block = Record<string, unknown> & { type?: unknown };

function isBlock(v: unknown): v is Block {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function blocksOf(row: MessageRow): Block[] {
  const parsed = safeParseJson(row.content_json);
  return Array.isArray(parsed) ? parsed.filter(isBlock) : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(isBlock).map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
  return "";
}

/** Human labels for DxMeasurements / DxDerived keys (camelCase); unknown keys are humanized. */
const MEASUREMENT_LABELS: Record<string, string> = {
  refrigerant: "Refrigerant",
  meteringDevice: "Metering device",
  mode: "Mode",
  circuit: "Circuit",
  suctionPsig: "Suction pressure (psig)",
  suctionLineTempF: "Suction line temp (°F)",
  liquidPsig: "Liquid pressure (psig)",
  liquidLineTempF: "Liquid line temp (°F)",
  dischargePsig: "Discharge pressure (psig)",
  dischargeLineTempF: "Discharge line temp (°F)",
  outdoorDbF: "Outdoor DB (°F)",
  indoorDbF: "Entering DB (°F)",
  indoorWbF: "Entering WB (°F)",
  mixedAirDbF: "Mixed air DB (°F)",
  mixedAirWbF: "Mixed air WB (°F)",
  supplyDbF: "Supply DB (°F)",
  returnRhPercent: "Return RH (%)",
  compressorAmps: "Compressor amps L1 (A)",
  compressorAmpsL2: "Compressor amps L2 (A)",
  compressorAmpsL3: "Compressor amps L3 (A)",
  compressorRla: "Nameplate RLA (A)",
  externalStaticInWc: "External static (in. wc)",
  capacityPercent: "Capacity (%)",
  economizerPosition: "Economizer",
  elevationFt: "Elevation (ft)",
  runtimeMinutes: "Runtime (min)",
  headPressureControl: "Head-pressure control",
  sightGlass: "Sight glass",
  moistureIndicator: "Moisture indicator",
  drierInletTempF: "Drier inlet temp (°F)",
  drierOutletTempF: "Drier outlet temp (°F)",
  standingPsig: "Standing pressure (psig)",
  equalizedAmbientF: "Equalized ambient (°F)",
  nameplateSubcoolingF: "Nameplate subcooling (°F)",
  nameplateSuperheatF: "Nameplate superheat (°F)",
  notes: "Notes",
};

const DERIVED_LABELS: Record<keyof DxDerived | string, string> = {
  evapSatF: "Evaporator saturation (°F)",
  condSatF: "Condenser saturation (°F)",
  superheatF: "Superheat (°F)",
  subcoolingF: "Subcooling (°F)",
  targetSuperheatF: "Target superheat (°F)",
  targetSubcoolingF: "Target subcooling (°F)",
  condenserSplitF: "Condenser split (°F)",
  evapTdF: "Evaporator TD (°F)",
  deltaTF: "Delta-T (°F)",
  targetDeltaTF: "Target delta-T (°F)",
  indoorCoilTdF: "Indoor coil TD (°F)",
  compressionRatio: "Compression ratio",
  patmPsia: "Atmospheric pressure (psia)",
  dischargeSuperheatF: "Discharge superheat (°F)",
  ampsPercentRla: "Amps (% RLA)",
  currentImbalancePercent: "Current imbalance (%)",
  drierTempDropF: "Drier temperature drop (°F)",
  standingExcessPsi: "Standing excess pressure (psi)",
};

function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function valueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return fmtNum(v, 2);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v;
  if (isBlock(v) && typeof v.min === "number" && typeof v.max === "number") return `${fmtNum(v.min)}–${fmtNum(v.max)}`;
  return JSON.stringify(v);
}

function valuesOf(obj: Record<string, unknown>, labels: Record<string, string>, skip: ReadonlySet<string> = new Set()): ReportValue[] {
  const out: ReportValue[] = [];
  for (const [rawKey, v] of Object.entries(obj)) {
    const key = camelize(rawKey);
    if (skip.has(key) || v === null || v === undefined || v === "") continue;
    const text = valueText(v);
    if (!text) continue;
    out.push({ key, label: labels[key] ?? humanize(key), value: text });
  }
  return out;
}

function toolLabel(name: string, input: Record<string, unknown>): string {
  const s = (k: string): string => (typeof input[k] === "string" ? (input[k] as string) : typeof input[k] === "number" ? String(input[k]) : "");
  if (name === "diagnose_refrigeration") {
    return `Diagnosis${[s("refrigerant"), s("mode").replace(/_/g, " "), s("circuit") ? `circuit ${s("circuit")}` : ""].filter(Boolean).map((x) => ` · ${x}`).join("")}`;
  }
  if (name === "calc_superheat_subcooling") return `Superheat / subcooling${s("refrigerant") ? ` · ${s("refrigerant")}` : ""}`;
  return humanize(name);
}

const SKIP_MEASUREMENT_KEYS: ReadonlySet<string> = new Set(["refrigerant", "meteringDevice", "mode", "circuit"]);

/** Readings-sheet messages the client composes ("Readings (circuit 1, R-410A, TXV, AC cooling): …"). */
const READINGS_TEXT_RE = /^Readings \([^)]*\): /;

/**
 * Every readings/diagnose tool call in the conversation (tool_use block + the matching tool_result in the
 * following tool_result row) plus readings-sheet messages, in conversation order.
 */
export function extractReadings(rows: MessageRow[]): ReportReadings[] {
  const out: ReportReadings[] = [];
  let pending: { entry: ReportReadings; id: string; name: string }[] = [];
  for (const row of rows) {
    const blocks = blocksOf(row);
    if (row.role === "user" && row.kind === "tool_result") {
      for (const b of blocks) {
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const p = pending.find((x) => x.id === b.tool_use_id);
        if (!p) continue;
        const ok = b.is_error !== true;
        p.entry.ok = ok;
        const result = parseJsonObject(resultText(b.content));
        if (!ok || !result) {
          if (!ok) p.entry.summary = truncateText(resultText(b.content) || "Tool failed.", 200);
          continue;
        }
        if (typeof result.summary === "string") p.entry.summary = result.summary;
        if (p.name === "diagnose_refrigeration") {
          if (isBlock(result.derived)) p.entry.derived = valuesOf(result.derived, DERIVED_LABELS);
          if (isBlock(result.validity)) {
            p.entry.validity = { ok: result.validity.ok === true, issues: Array.isArray(result.validity.issues) ? result.validity.issues.map(String) : [] };
          }
          if (Array.isArray(result.findings)) {
            p.entry.findings = result.findings
              .filter(isBlock)
              .map((f) => ({ severity: String((f as Partial<DxFinding>).severity ?? ""), condition: String((f as Partial<DxFinding>).condition ?? "") }))
              .filter((f) => f.condition);
          }
        } else {
          const derived: Record<string, unknown> = {};
          for (const k of ["evapSatF", "condSatF", "superheatF", "subcoolingF", "patmPsia"]) if (result[k] !== undefined) derived[k] = result[k];
          p.entry.derived = valuesOf(derived, DERIVED_LABELS);
          if (Array.isArray(result.notes) && !p.entry.summary) p.entry.summary = result.notes.map(String).join(" ");
        }
      }
      continue;
    }
    pending = [];
    if (row.role === "user") {
      const text = row.text || "";
      if (READINGS_TEXT_RE.test(text)) {
        out.push({ at: row.created_at, tool: "readings_sheet", label: "Readings sheet", ok: true, circuit: null, measurements: [], derived: [], validity: null, findings: [], summary: null, text: truncateText(text, 1200) });
      }
      continue;
    }
    for (const b of blocks) {
      if (b.type !== "tool_use" || typeof b.id !== "string" || typeof b.name !== "string" || !READINGS_TOOLS.has(b.name)) continue;
      const input = isBlock(b.input) ? b.input : {};
      const entry: ReportReadings = {
        at: row.created_at,
        tool: b.name,
        label: toolLabel(b.name, input),
        ok: false,
        circuit: typeof input.circuit === "string" ? input.circuit : null,
        measurements: valuesOf(input, MEASUREMENT_LABELS, SKIP_MEASUREMENT_KEYS),
        derived: [],
        validity: null,
        findings: [],
        summary: "No result recorded (tool interrupted).",
        text: null,
      };
      out.push(entry);
      pending.push({ entry, id: b.id, name: b.name });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export interface ConversationReportInput {
  conversation: ConversationRow;
  unit: UnitRow | null;
  messages: MessageRow[];
  findings: FindingRow[];
  now: Date;
  appVersion: string;
  /** Refrigerant events logged in this conversation (conversation report) or on the unit (unit report). */
  refrigerantEvents?: RefrigerantEventRow[];
  compliance?: ComplianceSummary | null;
  /** PM visits, newest first; the newest is reported. */
  pmVisits?: PmVisitRow[];
  signaturePng?: string | null;
}

function flag(v: 0 | 1 | null | undefined): boolean | null {
  return v === null || v === undefined ? null : v === 1;
}

export function reportRefrigerantEvent(e: RefrigerantEventRow): ReportRefrigerantEvent {
  return {
    date: dateOnly(e.created_at),
    type: e.event_type,
    refrigerant: e.refrigerant,
    amountLbs: e.amount_lbs,
    circuit: e.circuit,
    cylinderId: e.cylinder_id,
    techName: e.tech_name,
    techCert: e.tech_cert,
    leakFound: flag(e.leak_found),
    passed: flag(e.passed),
    leakRatePct: e.leak_rate_pct,
    thresholdPct: e.threshold_pct,
    exceeded: flag(e.exceeded),
    note: e.note,
  };
}

/** Owner documentation block from the unit's compliance summary and the events; null when there is nothing to document. */
export function ownerDocumentationOf(compliance: ComplianceSummary | null | undefined, events: RefrigerantEventRow[] | undefined): ReportOwnerDocumentation | null {
  const rows = [...(events ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (!compliance) return null;
  if (rows.length === 0 && compliance.fullChargeLbs === null && compliance.obligations.length === 0) return null;
  return {
    fullChargeLbs: compliance.fullChargeLbs,
    applianceType: compliance.applianceType,
    thresholdPct: compliance.thresholdPct,
    applies: compliance.applies,
    circuitsCount: compliance.circuitsCount,
    formula: compliance.formula,
    source: compliance.source,
    lastLeakRatePct: compliance.lastLeakRatePct,
    exceeded: compliance.exceeded,
    events: rows.map(reportRefrigerantEvent),
    obligations: compliance.obligations.map((o) => ({ kind: o.kind, dueDate: o.dueDate, text: o.text, overdue: o.overdue })),
    notes: compliance.notes,
  };
}

/** The newest PM visit as a report block, or null. */
export function reportPmOf(visits: PmVisitRow[] | undefined): ReportPm | null {
  const rows = [...(visits ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const v = rows[0];
  if (!v) return null;
  const s = parseSummary(v.summary_json);
  const label = (i: { label: string; note?: string; value?: unknown; asLeft?: number; asFound?: number; reference?: string }): string => i.label;
  return {
    date: dateOnly(v.created_at),
    templateId: v.template_id,
    templateName: s?.templateName ?? v.template_id,
    status: v.status,
    techName: v.tech_name,
    total: s?.total ?? 0,
    pass: s?.pass ?? 0,
    fail: s?.fail ?? 0,
    na: s?.na ?? 0,
    fails: s ? s.items.filter((i) => i.status === "fail").map((i) => `${label(i)}${i.note ? ` — ${i.note}` : ""}`) : [],
    flagged: s ? s.items.filter((i) => i.flagged).map((i) => `${i.label}: ${String(i.asLeft ?? i.asFound ?? i.value ?? "")} vs ${i.reference ?? "nameplate"}`) : [],
    safetyFails: s ? s.items.filter((i) => i.status === "fail" && i.safety).map(label) : [],
    note: v.note,
  };
}

function minutesBetween(startedAt: string | null | undefined, endedAt: string | null | undefined): number | null {
  if (!startedAt || !endedAt) return null;
  const a = Date.parse(startedAt);
  const b = Date.parse(endedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 60_000);
}

/** "2 h 05 min" / "45 min". */
export function formatMinutes(min: number | null): string {
  if (min === null) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

export function openItemsOf(findings: ReportFinding[]): string[] {
  const items: string[] = [];
  for (const f of findings) {
    if (f.status === "open" || f.status === "monitor") {
      items.push(`${f.status === "monitor" ? "Monitor" : "Open"}: ${f.symptom}${f.followUp ? ` — ${f.followUp}` : ""}`);
    } else if (f.followUp) items.push(`Follow-up: ${f.followUp}`);
  }
  return items;
}

export function buildConversationReport(input: ConversationReportInput): ConversationReport {
  const { conversation, messages } = input;
  const firstUser = messages.find((m) => m.role === "user" && m.kind === "chat" && m.text.trim() !== "");
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.text.trim() !== "");
  const findings = input.findings.map(reportFinding);
  const signed = !!conversation.signed_at || !!input.signaturePng;
  return {
    kind: "conversation",
    generatedAt: input.now.toISOString(),
    appVersion: input.appVersion,
    conversation: { id: conversation.id, title: conversation.title, createdAt: conversation.created_at, updatedAt: conversation.updated_at, summary: conversation.summary },
    unit: input.unit ? reportUnit(input.unit) : null,
    complaint: firstUser ? truncateText(firstUser.text, COMPLAINT_MAX_CHARS) : null,
    readings: extractReadings(messages),
    findings,
    openItems: openItemsOf(findings),
    assistantSummary: lastAssistant ? lastAssistant.text : null,
    job: { startedAt: conversation.job_started_at ?? null, endedAt: conversation.job_ended_at ?? null, minutesOnSite: minutesBetween(conversation.job_started_at, conversation.job_ended_at) },
    signature: signed ? { signedBy: conversation.signed_by ?? null, signedAt: conversation.signed_at ?? null, note: conversation.signature_note ?? null, png: input.signaturePng ?? null } : null,
    ownerDocumentation: ownerDocumentationOf(input.compliance, input.refrigerantEvents),
    pm: reportPmOf(input.pmVisits),
  };
}

export interface UnitReportInput {
  unit: UnitRow;
  findings: FindingRow[];
  corrections: CorrectionRow[];
  conversations: ConversationRow[];
  now: Date;
  appVersion: string;
  refrigerantEvents?: RefrigerantEventRow[];
  compliance?: ComplianceSummary | null;
  pmVisits?: PmVisitRow[];
}

export function buildUnitReport(input: UnitReportInput): UnitReport {
  const findings = input.findings.map(reportFinding);
  const byDate = new Map<string, ReportFinding[]>();
  for (const f of findings) {
    const key = f.date || "Undated";
    const list = byDate.get(key) ?? [];
    list.push(f);
    byDate.set(key, list);
  }
  const findingsByDate = [...byDate.entries()]
    .sort((a, b) => (a[0] === "Undated" ? 1 : b[0] === "Undated" ? -1 : b[0].localeCompare(a[0])))
    .map(([date, list]) => ({ date, findings: list }));
  const conversations = [...input.conversations]
    .sort((a, b) => (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at))
    .slice(0, UNIT_REPORT_CONVERSATIONS)
    .map((c) => ({ id: c.id, title: c.title, date: c.updated_at || c.created_at, summary: c.summary }));
  return {
    kind: "unit",
    generatedAt: input.now.toISOString(),
    appVersion: input.appVersion,
    unit: reportUnit(input.unit),
    findingsByDate,
    corrections: [...input.corrections]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((c) => ({ date: c.created_at, field: c.field, appValue: c.app_value, actualValue: c.actual_value, note: c.note, applied: Number(c.applied) === 1 })),
    conversations,
    totals: { findings: findings.length, open: findings.filter((f) => f.status === "open" || f.status === "monitor").length, conversations: input.conversations.length },
    ownerDocumentation: ownerDocumentationOf(input.compliance, input.refrigerantEvents),
    pm: reportPmOf(input.pmVisits),
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function unitTitle(u: ReportUnit | null): string {
  if (!u) return "No unit attached";
  return [u.tag, u.nickname].filter(Boolean).join(" · ") || u.model || "Unit";
}

function unitLines(u: ReportUnit): [string, string][] {
  const lines: [string, string | null | undefined][] = [
    ["Site", [u.site, u.customer, u.locationNote].filter(Boolean).join(" · ")],
    ["Unit tag", [u.tag, u.nickname].filter(Boolean).join(" · ")],
    ["Manufacturer", u.manufacturer],
    ["Model", u.model],
    ["Serial", u.serial],
    ["Family", u.family],
    ["Tonnage", u.tonnage !== null && u.tonnage !== undefined ? `${u.tonnage} ton` : null],
    ["Refrigerant", u.refrigerant],
    ["Voltage", [u.voltage, u.phase ? `${u.phase}-phase` : ""].filter(Boolean).join(" · ")],
    ["Controls", u.controlPlatform],
    ["Heat", u.heatType],
    ["Metering device", u.meteringDevice],
    ["Manufactured", u.manufactureDate ? `${u.manufactureDate}${u.ageYears !== null ? ` (${fmtNum(u.ageYears)} yr)` : ""}` : u.installYear ? `installed ${u.installYear}` : null],
    ["Circuits", u.circuits !== null ? String(u.circuits) : null],
    ["Nameplate charge", u.charge],
    ["Elevation", u.elevationFt !== null && u.elevationFt !== undefined ? `${u.elevationFt} ft` : null],
    ["Notes", u.notes],
  ];
  return lines.filter((l): l is [string, string] => typeof l[1] === "string" && l[1] !== "");
}

/** Plain text, safe inside a markdown table cell / list line. */
function mdCell(s: unknown): string {
  return String(s ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function findingLineMd(f: ReportFinding): string {
  const flags = [f.confirmed ? "confirmed" : f.origin === "assistant" ? "hypothesis — unconfirmed" : "unconfirmed", f.status];
  const chain = [f.symptom, f.cause, f.resolution].filter(Boolean).map(mdCell).join(" → ");
  const extras: string[] = [];
  if (f.circuit) extras.push(`circuit ${mdCell(f.circuit)}`);
  if (f.parts.length) extras.push(`parts: ${f.parts.map(mdCell).join(", ")}`);
  if (f.refrigerantAddedLbs) extras.push(`refrigerant added: ${f.refrigerantAddedLbs} lb${f.refrigerant ? ` ${mdCell(f.refrigerant)}` : ""}`);
  if (f.refrigerantRecoveredLbs) extras.push(`recovered: ${f.refrigerantRecoveredLbs} lb`);
  if (f.followUp) extras.push(`follow-up: ${mdCell(f.followUp)}`);
  return `- **${chain}** _(${flags.join(", ")}${f.date ? `, ${f.date}` : ""})_${extras.length ? ` — ${extras.join("; ")}` : ""}`;
}

function readingsMd(r: ReportReadings): string[] {
  const lines: string[] = [`### ${mdCell(r.label)} — ${dateTime(r.at)}`];
  if (r.text) {
    lines.push("", mdCell(r.text));
    return lines;
  }
  if (!r.ok) lines.push("", `_${mdCell(r.summary || "Tool failed.")}_`);
  if (r.measurements.length) {
    lines.push("", "| Measurement | Value |", "| --- | --- |");
    for (const m of r.measurements) lines.push(`| ${mdCell(m.label)} | ${mdCell(m.value)} |`);
  }
  if (r.derived.length) {
    lines.push("", "| Derived | Value |", "| --- | --- |");
    for (const d of r.derived) lines.push(`| ${mdCell(d.label)} | ${mdCell(d.value)} |`);
  }
  if (r.validity) lines.push("", `Validity: ${r.validity.ok ? "readings valid for charge determination" : `not valid for charge determination (${r.validity.issues.map(mdCell).join("; ") || "see summary"})`}`);
  if (r.findings.length) lines.push("", `Findings: ${r.findings.map((f) => `${mdCell(f.severity)} — ${mdCell(f.condition)}`).join("; ")}`);
  if (r.ok && r.summary) lines.push("", mdCell(r.summary));
  return lines;
}

function eventLineMd(e: ReportRefrigerantEvent): string {
  const bits: string[] = [`**${mdCell(e.type.replace(/_/g, " "))}**`];
  if (e.amountLbs !== null) bits.push(`${e.amountLbs} lb${e.refrigerant ? ` ${mdCell(e.refrigerant)}` : ""}`);
  else if (e.refrigerant) bits.push(mdCell(e.refrigerant));
  if (e.circuit !== null) bits.push(`circuit ${e.circuit}`);
  if (e.leakFound !== null) bits.push(e.leakFound ? "leak found" : "no leak found");
  if (e.passed !== null) bits.push(e.passed ? "passed" : "failed");
  if (e.leakRatePct !== null) bits.push(`leak rate ${e.leakRatePct} %/yr${e.thresholdPct !== null ? ` vs ${e.thresholdPct} % threshold` : ""}${e.exceeded ? " — EXCEEDED" : ""}`);
  if (e.cylinderId) bits.push(`cylinder ${mdCell(e.cylinderId)}`);
  if (e.techName || e.techCert) bits.push(`tech ${[e.techName, e.techCert ? `cert ${e.techCert}` : null].filter(Boolean).map(mdCell).join(" ")}`);
  if (e.note) bits.push(mdCell(e.note));
  return `- ${e.date} · ${bits.join(" · ")}`;
}

function ownerDocMd(doc: ReportOwnerDocumentation | null): string[] {
  const out: string[] = ["## Owner documentation (refrigerant / EPA leak-repair record)", ""];
  if (!doc) {
    out.push("_No refrigerant events or full charge recorded._", "");
    return out;
  }
  out.push(`- **Full charge:** ${doc.fullChargeLbs !== null ? `${doc.fullChargeLbs} lb${doc.circuitsCount > 1 ? ` (${doc.circuitsCount} circuits)` : ""}` : "not recorded"}`);
  out.push(`- **Appliance type / threshold:** ${doc.applianceType ? mdCell(doc.applianceType.replace(/_/g, " ")) : "not set (comfort cooling assumed)"} · ${doc.thresholdPct} % per year${doc.applies ? "" : " · rule applicability: below 15 lb"}`);
  out.push(`- **Last leak rate:** ${doc.lastLeakRatePct !== null ? `${doc.lastLeakRatePct} %/yr${doc.exceeded ? " — EXCEEDS the threshold" : ""}` : "none computed"}`);
  out.push(`- **Formula:** ${mdCell(doc.formula)} (${mdCell(doc.source)})`);
  out.push("", "### Refrigerant events", "");
  if (doc.events.length) for (const e of doc.events) out.push(eventLineMd(e));
  else out.push("_None logged._");
  out.push("", "### Open obligations", "");
  if (doc.obligations.length) for (const o of doc.obligations) out.push(`- ${o.overdue ? "**OVERDUE** " : ""}${mdCell(o.text)}${o.dueDate ? ` _(due ${o.dueDate})_` : ""}`);
  else out.push("_None._");
  if (doc.notes.length) out.push("", ...doc.notes.map((n) => `_${mdCell(n)}_`));
  out.push("");
  return out;
}

function pmMd(pm: ReportPm | null): string[] {
  const out: string[] = ["## Preventive maintenance", ""];
  if (!pm) {
    out.push("_No PM visit recorded._", "");
    return out;
  }
  out.push(`- **Last PM:** ${pm.date} · ${mdCell(pm.templateName)} · ${mdCell(pm.status.replace(/_/g, " "))}${pm.techName ? ` · ${mdCell(pm.techName)}` : ""}`);
  out.push(`- **Result:** ${pm.pass} pass / ${pm.fail} fail / ${pm.na} n/a of ${pm.total} items`);
  if (pm.safetyFails.length) out.push(`- **Safety items failed:** ${pm.safetyFails.map(mdCell).join("; ")}`);
  if (pm.fails.length) out.push(`- **Failed items:** ${pm.fails.map(mdCell).join("; ")}`);
  if (pm.flagged.length) out.push(`- **Nameplate deviations:** ${pm.flagged.map(mdCell).join("; ")}`);
  if (pm.note) out.push(`- **Note:** ${mdCell(pm.note)}`);
  out.push("");
  return out;
}

export function renderReportMarkdown(report: Report): string {
  const out: string[] = [];
  const stamp = `Generated ${dateTime(report.generatedAt)} · HVAC Field Assistant v${report.appVersion}`;
  if (report.kind === "conversation") {
    out.push(`# Service report — ${mdCell(report.conversation.title)}`, "", stamp, "");
    out.push("## Unit", "");
    if (report.unit) for (const [k, v] of unitLines(report.unit)) out.push(`- **${k}:** ${mdCell(v)}`);
    else out.push("- No unit attached to this conversation.");
    out.push(`- **Date:** ${dateTime(report.conversation.createdAt)}${report.conversation.updatedAt !== report.conversation.createdAt ? ` (last activity ${dateTime(report.conversation.updatedAt)})` : ""}`);
    if (report.job.startedAt) out.push(`- **Time on site:** ${report.job.minutesOnSite !== null ? formatMinutes(report.job.minutesOnSite) : "clock running"} (${dateTime(report.job.startedAt)}${report.job.endedAt ? ` → ${dateTime(report.job.endedAt)}` : " → …"})`);
    out.push("- **Technician:** ______________________", "");
    out.push("## Complaint", "", report.complaint ? mdCell(report.complaint) : "_No complaint recorded._", "");
    out.push("## Readings", "");
    if (report.readings.length) for (const r of report.readings) out.push(...readingsMd(r), "");
    else out.push("_No readings or diagnoses in this conversation._", "");
    out.push("## Findings", "");
    if (report.findings.length) for (const f of report.findings) out.push(findingLineMd(f));
    else out.push("_No findings saved from this conversation._");
    out.push("", "## Open items / follow-up", "");
    if (report.openItems.length) for (const i of report.openItems) out.push(`- ${mdCell(i)}`);
    else out.push("_None._");
    out.push("", ...ownerDocMd(report.ownerDocumentation));
    out.push(...pmMd(report.pm));
    out.push("## Assistant summary", "");
    out.push(report.assistantSummary ? report.assistantSummary.trim() : "_No assistant reply yet._", "");
    out.push("## Customer signature", "");
    if (report.signature) out.push(`Signed by ${mdCell(report.signature.signedBy ?? "customer")}${report.signature.signedAt ? ` on ${dateTime(report.signature.signedAt)}` : ""}${report.signature.note ? ` — ${mdCell(report.signature.note)}` : ""} (signature image in the printable report).`, "");
    else out.push("_Not signed._", "");
    return out.join("\n");
  }
  const u = report.unit;
  out.push(`# Unit report — ${mdCell(unitTitle(u))}`, "", stamp, "", "## Nameplate", "");
  for (const [k, v] of unitLines(u)) out.push(`- **${k}:** ${mdCell(v)}`);
  if (u.decodeWarnings.length) out.push(`- **Decoder warnings:** ${u.decodeWarnings.map(mdCell).join("; ")}`);
  out.push("", `## Findings (${report.totals.findings}${report.totals.open ? `, ${report.totals.open} open` : ""})`, "");
  if (report.findingsByDate.length) {
    for (const g of report.findingsByDate) {
      out.push(`### ${g.date}`, "");
      for (const f of g.findings) out.push(findingLineMd(f));
      out.push("");
    }
  } else out.push("_No findings on this unit yet._", "");
  out.push("## Corrections", "");
  if (report.corrections.length) for (const c of report.corrections) out.push(`- ${dateOnly(c.date)} · **${mdCell(c.field)}**: app said ${mdCell(c.appValue ?? "—")} → actually ${mdCell(c.actualValue)}${c.applied ? " (unit updated)" : ""}${c.note ? ` — ${mdCell(c.note)}` : ""}`);
  else out.push("_None._");
  out.push("", ...ownerDocMd(report.ownerDocumentation));
  out.push(...pmMd(report.pm));
  out.push(`## Recent conversations (${Math.min(report.totals.conversations, UNIT_REPORT_CONVERSATIONS)} of ${report.totals.conversations})`, "");
  if (report.conversations.length) for (const c of report.conversations) out.push(`- ${dateOnly(c.date)} — ${mdCell(c.title)}${c.summary ? ` — ${mdCell(c.summary)}` : ""}`);
  else out.push("_None._");
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** Markdown → HTML for the assistant summary: no raw HTML, no images, http(s)/mailto links only. */
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    image({ text, href }) {
      return escapeHtml(text || href || "");
    },
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens);
      return /^(https?:|mailto:)/i.test(href) ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${inner}</a>` : inner;
    },
  },
});

export function renderMarkdownSafe(text: string): string {
  const out = md.parse(text ?? "", { async: false });
  return typeof out === "string" ? out : "";
}

const PAGE_CSS = `
:root { color-scheme: light; --ink: #14181d; --muted: #5a6470; --line: #d5dae0; --accent: #b86200; --soft: #f4f6f8; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: #fff; }
.page { max-width: 820px; margin: 0 auto; padding: 24px 20px 48px; }
header.top { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; border-bottom: 3px solid var(--accent); padding-bottom: 12px; margin-bottom: 20px; }
h1 { font-size: 24px; margin: 0 0 4px; line-height: 1.2; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 26px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
h3 { font-size: 15px; margin: 14px 0 6px; }
.meta { color: var(--muted); font-size: 13px; }
.btn { font: inherit; font-weight: 600; padding: 10px 14px; border-radius: 10px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; white-space: nowrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px 16px; }
.kv { border-bottom: 1px dotted var(--line); padding: 4px 0; }
.kv b { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
table { border-collapse: collapse; width: 100%; margin: 6px 0 10px; font-size: 14px; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: var(--soft); font-weight: 600; }
td:last-child, th:last-child { font-variant-numeric: tabular-nums; }
ul { padding-left: 20px; } li { margin: 4px 0; }
.chip { display: inline-block; font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px; background: var(--soft); color: var(--muted); margin-right: 4px; vertical-align: middle; }
.chip.ok { background: #e3f4ea; color: #0b6631; } .chip.warn { background: #fff1d6; color: #7a4f00; } .chip.bad { background: #fde3e1; color: #a01f18; }
.finding { padding: 8px 0; border-bottom: 1px solid var(--line); }
.finding .chain { font-weight: 600; }
.finding .extra { color: var(--muted); font-size: 13px; margin-top: 2px; }
.readings { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin: 10px 0; break-inside: avoid; }
.summary { border-left: 3px solid var(--accent); padding: 4px 14px; background: var(--soft); border-radius: 0 8px 8px 0; overflow-wrap: anywhere; }
.summary table { font-size: 13px; } .summary pre { white-space: pre-wrap; word-break: break-word; background: #fff; padding: 8px; border-radius: 6px; }
.summary a { color: var(--accent); }
.muted { color: var(--muted); }
.sign { margin-top: 32px; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.sign div { border-top: 1px solid var(--ink); padding-top: 6px; font-size: 12px; color: var(--muted); }
.sign img { display: block; max-width: 100%; max-height: 120px; margin-bottom: 6px; }
.sign .who { color: var(--ink); font-size: 13px; }
.events li { margin: 6px 0; }
.events .ex { color: #a01f18; font-weight: 700; }
footer { margin-top: 28px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 8px; }
@media print {
  .page { max-width: none; padding: 0; }
  .btn, .no-print { display: none !important; }
  body { font-size: 12.5px; }
  h2 { break-after: avoid; }
  a { color: inherit; text-decoration: none; }
}
@page { margin: 16mm 14mm; }
`;

function kvHtml(u: ReportUnit): string {
  return `<div class="grid">${unitLines(u)
    .map(([k, v]) => `<div class="kv"><b>${escapeHtml(k)}</b>${escapeHtml(v)}</div>`)
    .join("")}</div>`;
}

function findingHtml(f: ReportFinding): string {
  const statusCls = f.status === "resolved" ? "ok" : f.status === "monitor" ? "warn" : "bad";
  const chips = [
    `<span class="chip ${statusCls}">${escapeHtml(f.status)}</span>`,
    f.confirmed ? '<span class="chip ok">confirmed</span>' : `<span class="chip">${f.origin === "assistant" ? "hypothesis — unconfirmed" : "unconfirmed"}</span>`,
    f.circuit ? `<span class="chip">circuit ${escapeHtml(f.circuit)}</span>` : "",
    f.date ? `<span class="muted">${escapeHtml(f.date)}</span>` : "",
  ].join("");
  const chain = [f.symptom, f.cause, f.resolution].filter(Boolean).map(escapeHtml).join(" &rarr; ");
  const extras: string[] = [];
  if (f.parts.length) extras.push(`Parts: ${f.parts.map(escapeHtml).join(", ")}`);
  if (f.refrigerantAddedLbs) extras.push(`Refrigerant added: ${escapeHtml(f.refrigerantAddedLbs)} lb${f.refrigerant ? ` ${escapeHtml(f.refrigerant)}` : ""}`);
  if (f.refrigerantRecoveredLbs) extras.push(`Recovered: ${escapeHtml(f.refrigerantRecoveredLbs)} lb`);
  if (f.followUp) extras.push(`Follow-up: ${escapeHtml(f.followUp)}`);
  return `<div class="finding"><div>${chips}</div><div class="chain">${chain}</div>${extras.length ? `<div class="extra">${extras.join(" · ")}</div>` : ""}</div>`;
}

function tableHtml(head: string, rows: ReportValue[]): string {
  if (!rows.length) return "";
  return `<table><thead><tr><th>${escapeHtml(head)}</th><th>Value</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.value)}</td></tr>`).join("")}</tbody></table>`;
}

function readingsHtml(r: ReportReadings): string {
  const parts: string[] = [`<h3>${escapeHtml(r.label)} <span class="meta">${escapeHtml(dateTime(r.at))}</span></h3>`];
  if (r.text) parts.push(`<p>${escapeHtml(r.text)}</p>`);
  else {
    if (!r.ok) parts.push(`<p class="muted"><em>${escapeHtml(r.summary || "Tool failed.")}</em></p>`);
    parts.push(tableHtml("Measurement", r.measurements), tableHtml("Derived", r.derived));
    if (r.validity) {
      parts.push(
        `<p><span class="chip ${r.validity.ok ? "ok" : "warn"}">${r.validity.ok ? "valid for charge determination" : "not valid for charge determination"}</span>${r.validity.issues.length ? ` <span class="muted">${r.validity.issues.map(escapeHtml).join("; ")}</span>` : ""}</p>`,
      );
    }
    if (r.findings.length) parts.push(`<ul>${r.findings.map((f) => `<li><span class="chip ${f.severity === "critical" || f.severity === "warning" ? "bad" : f.severity === "advisory" ? "warn" : ""}">${escapeHtml(f.severity)}</span>${escapeHtml(f.condition)}</li>`).join("")}</ul>`);
    if (r.ok && r.summary) parts.push(`<p>${escapeHtml(r.summary)}</p>`);
  }
  return `<div class="readings">${parts.join("")}</div>`;
}

function eventHtml(e: ReportRefrigerantEvent): string {
  const bits: string[] = [`<b>${escapeHtml(e.type.replace(/_/g, " "))}</b>`];
  if (e.amountLbs !== null) bits.push(`${escapeHtml(e.amountLbs)} lb${e.refrigerant ? ` ${escapeHtml(e.refrigerant)}` : ""}`);
  else if (e.refrigerant) bits.push(escapeHtml(e.refrigerant));
  if (e.circuit !== null) bits.push(`circuit ${escapeHtml(e.circuit)}`);
  if (e.leakFound !== null) bits.push(e.leakFound ? "leak found" : "no leak found");
  if (e.passed !== null) bits.push(e.passed ? "passed" : "failed");
  if (e.leakRatePct !== null) bits.push(`leak rate ${escapeHtml(e.leakRatePct)} %/yr${e.thresholdPct !== null ? ` vs ${escapeHtml(e.thresholdPct)} %` : ""}${e.exceeded ? ' <span class="ex">EXCEEDED</span>' : ""}`);
  if (e.cylinderId) bits.push(`cylinder ${escapeHtml(e.cylinderId)}`);
  if (e.techName || e.techCert) bits.push(`tech ${escapeHtml([e.techName, e.techCert ? `cert ${e.techCert}` : null].filter(Boolean).join(" "))}`);
  if (e.note) bits.push(escapeHtml(e.note));
  return `<li>${escapeHtml(e.date)} · ${bits.join(" · ")}</li>`;
}

function ownerDocHtml(doc: ReportOwnerDocumentation | null): string {
  const parts = ["<h2>Owner documentation (refrigerant / EPA leak-repair record)</h2>"];
  if (!doc) {
    parts.push('<p class="muted">No refrigerant events or full charge recorded.</p>');
    return parts.join("\n");
  }
  parts.push(
    `<div class="grid"><div class="kv"><b>Full charge</b>${doc.fullChargeLbs !== null ? `${escapeHtml(doc.fullChargeLbs)} lb${doc.circuitsCount > 1 ? ` (${doc.circuitsCount} circuits)` : ""}` : "not recorded"}</div>` +
      `<div class="kv"><b>Appliance type</b>${doc.applianceType ? escapeHtml(doc.applianceType.replace(/_/g, " ")) : "not set (comfort cooling assumed)"}</div>` +
      `<div class="kv"><b>Threshold</b>${escapeHtml(doc.thresholdPct)} % per year${doc.applies ? "" : " · below 15 lb applicability"}</div>` +
      `<div class="kv"><b>Last leak rate</b>${doc.lastLeakRatePct !== null ? `${escapeHtml(doc.lastLeakRatePct)} %/yr${doc.exceeded ? ' <span class="chip bad">exceeds threshold</span>' : ' <span class="chip ok">within threshold</span>'}` : "none computed"}</div></div>`,
  );
  parts.push(`<p class="muted">Formula: ${escapeHtml(doc.formula)} — ${escapeHtml(doc.source)}.</p>`);
  parts.push("<h3>Refrigerant events</h3>", doc.events.length ? `<ul class="events">${doc.events.map(eventHtml).join("")}</ul>` : '<p class="muted">None logged.</p>');
  parts.push("<h3>Open obligations</h3>", doc.obligations.length ? `<ul>${doc.obligations.map((o) => `<li>${o.overdue ? '<span class="chip bad">overdue</span>' : ""}${escapeHtml(o.text)}${o.dueDate ? ` <span class="muted">(due ${escapeHtml(o.dueDate)})</span>` : ""}</li>`).join("")}</ul>` : '<p class="muted">None.</p>');
  if (doc.notes.length) parts.push(`<p class="muted">${doc.notes.map(escapeHtml).join(" ")}</p>`);
  return parts.join("\n");
}

function pmHtml(pm: ReportPm | null): string {
  const parts = ["<h2>Preventive maintenance</h2>"];
  if (!pm) {
    parts.push('<p class="muted">No PM visit recorded.</p>');
    return parts.join("\n");
  }
  parts.push(
    `<div class="grid"><div class="kv"><b>Last PM</b>${escapeHtml(pm.date)} · ${escapeHtml(pm.templateName)}</div><div class="kv"><b>Status</b>${escapeHtml(pm.status.replace(/_/g, " "))}${pm.techName ? ` · ${escapeHtml(pm.techName)}` : ""}</div><div class="kv"><b>Result</b><span class="chip ok">${pm.pass} pass</span><span class="chip ${pm.fail ? "bad" : ""}">${pm.fail} fail</span><span class="chip">${pm.na} n/a</span> of ${pm.total}</div></div>`,
  );
  if (pm.safetyFails.length) parts.push(`<p><span class="chip bad">safety</span> ${pm.safetyFails.map(escapeHtml).join("; ")}</p>`);
  if (pm.fails.length) parts.push(`<p><b>Failed items:</b> ${pm.fails.map(escapeHtml).join("; ")}</p>`);
  if (pm.flagged.length) parts.push(`<p><b>Nameplate deviations:</b> ${pm.flagged.map(escapeHtml).join("; ")}</p>`);
  if (pm.note) parts.push(`<p class="muted">${escapeHtml(pm.note)}</p>`);
  return parts.join("\n");
}

function signatureHtml(sig: ReportSignature | null): string {
  const customer = sig
    ? `${sig.png && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig.png) ? `<img src="${sig.png}" alt="Customer signature">` : ""}<div class="who">${escapeHtml(sig.signedBy ?? "Customer")}${sig.signedAt ? ` · ${escapeHtml(dateTime(sig.signedAt))}` : ""}${sig.note ? ` · ${escapeHtml(sig.note)}` : ""}</div>Customer signature`
    : "Customer signature";
  return `<div class="sign"><div>Technician signature</div><div>${customer}</div></div>`;
}

function pageHtml(title: string, bodyHtml: string, report: Report): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="page">
<header class="top">
<div><h1>${escapeHtml(title)}</h1><div class="meta">Generated ${escapeHtml(dateTime(report.generatedAt))} · HVAC Field Assistant v${escapeHtml(report.appVersion)}</div></div>
<button class="btn" type="button" id="print">Print / Save as PDF</button>
</header>
${bodyHtml}
<footer>Decoded nameplate data carries a confidence level; anything not marked high confidence should be confirmed on the nameplate or IOM. Charge decisions require valid readings and a leak check.</footer>
</div>
<script>document.getElementById("print").addEventListener("click", function () { window.print(); });</script>
</body>
</html>
`;
}

export function renderReportHtml(report: Report): string {
  if (report.kind === "conversation") {
    const body: string[] = [];
    body.push("<h2>Unit</h2>");
    body.push(report.unit ? kvHtml(report.unit) : '<p class="muted">No unit attached to this conversation.</p>');
    body.push(
      `<div class="grid" style="margin-top:8px"><div class="kv"><b>Date</b>${escapeHtml(dateTime(report.conversation.createdAt))}</div><div class="kv"><b>Last activity</b>${escapeHtml(dateTime(report.conversation.updatedAt))}</div>${report.job.startedAt ? `<div class="kv"><b>Time on site</b>${report.job.minutesOnSite !== null ? escapeHtml(formatMinutes(report.job.minutesOnSite)) : "clock running"} <span class="muted">(${escapeHtml(dateTime(report.job.startedAt))}${report.job.endedAt ? ` → ${escapeHtml(dateTime(report.job.endedAt))}` : " → …"})</span></div>` : ""}<div class="kv"><b>Technician</b>&nbsp;</div></div>`,
    );
    body.push("<h2>Complaint</h2>", report.complaint ? `<p>${escapeHtml(report.complaint)}</p>` : '<p class="muted">No complaint recorded.</p>');
    body.push("<h2>Readings</h2>", report.readings.length ? report.readings.map(readingsHtml).join("") : '<p class="muted">No readings or diagnoses in this conversation.</p>');
    body.push("<h2>Findings</h2>", report.findings.length ? report.findings.map(findingHtml).join("") : '<p class="muted">No findings saved from this conversation.</p>');
    body.push("<h2>Open items / follow-up</h2>", report.openItems.length ? `<ul>${report.openItems.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : '<p class="muted">None.</p>');
    body.push(ownerDocHtml(report.ownerDocumentation));
    body.push(pmHtml(report.pm));
    body.push("<h2>Assistant summary</h2>", report.assistantSummary ? `<div class="summary">${renderMarkdownSafe(report.assistantSummary)}</div>` : '<p class="muted">No assistant reply yet.</p>');
    body.push(signatureHtml(report.signature));
    return pageHtml(`Service report — ${report.conversation.title}`, body.join("\n"), report);
  }
  const u = report.unit;
  const body: string[] = ["<h2>Nameplate</h2>", kvHtml(u)];
  if (u.decodeWarnings.length) body.push(`<p class="muted">Decoder warnings: ${u.decodeWarnings.map(escapeHtml).join("; ")}</p>`);
  body.push(`<h2>Findings (${report.totals.findings}${report.totals.open ? `, ${report.totals.open} open` : ""})</h2>`);
  if (report.findingsByDate.length) for (const g of report.findingsByDate) body.push(`<h3>${escapeHtml(g.date)}</h3>`, g.findings.map(findingHtml).join(""));
  else body.push('<p class="muted">No findings on this unit yet.</p>');
  body.push("<h2>Corrections</h2>");
  body.push(
    report.corrections.length
      ? `<ul>${report.corrections
          .map((c) => `<li>${escapeHtml(dateOnly(c.date))} · <b>${escapeHtml(c.field)}</b>: app said ${escapeHtml(c.appValue ?? "—")} &rarr; actually ${escapeHtml(c.actualValue)}${c.applied ? " (unit updated)" : ""}${c.note ? ` — ${escapeHtml(c.note)}` : ""}</li>`)
          .join("")}</ul>`
      : '<p class="muted">None.</p>',
  );
  body.push(ownerDocHtml(report.ownerDocumentation));
  body.push(pmHtml(report.pm));
  body.push(`<h2>Recent conversations (${Math.min(report.totals.conversations, UNIT_REPORT_CONVERSATIONS)} of ${report.totals.conversations})</h2>`);
  body.push(report.conversations.length ? `<ul>${report.conversations.map((c) => `<li>${escapeHtml(dateOnly(c.date))} — ${escapeHtml(c.title)}${c.summary ? ` <span class="muted">— ${escapeHtml(c.summary)}</span>` : ""}</li>`).join("")}</ul>` : '<p class="muted">None.</p>');
  return pageHtml(`Unit report — ${unitTitle(u)}`, body.join("\n"), report);
}

/** Body + content type for a format. */
export function renderReport(report: Report, format: ReportFormat): { body: string; contentType: string; filename: string } {
  const filename = reportFilename(report, format);
  if (format === "json") return { body: JSON.stringify(report, null, 2), contentType: REPORT_CONTENT_TYPES.json, filename };
  if (format === "html") return { body: renderReportHtml(report), contentType: REPORT_CONTENT_TYPES.html, filename };
  return { body: renderReportMarkdown(report), contentType: REPORT_CONTENT_TYPES.md, filename };
}
