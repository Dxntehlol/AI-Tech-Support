/**
 * Readings history storage helpers shared by POST /api/calc/diagnose, GET /api/units/:id[/readings] and the
 * assistant's diagnose_refrigeration tool. Kept outside routes/ so agent/tools.ts can import it without a
 * routes/util.ts ↔ agent/tools.ts import cycle.
 */
import type { Repos } from "./db/repos.ts";
import { trendFromReadings, type TrendResult } from "./knowledge/trend.ts";
import type { ChillerResult, DxResult, ReadingRow, ReadingSource } from "./types.ts";

function safeParseJson(text: string | null | undefined): unknown {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Reading as the API returns it: the JSON columns parsed into objects. */
export interface ReadingView {
  id: string;
  unit_id: string;
  conversation_id: string | null;
  created_at: string;
  mode: ReadingRow["mode"];
  refrigerant: string;
  metering_device: ReadingRow["metering_device"];
  measurements: Record<string, unknown>;
  derived: Record<string, unknown>;
  validity: { ok: boolean; issues: string[] };
  findings: { ruleId: string; severity: string }[];
  note: string | null;
  source: ReadingSource;
}

function obj(text: string | null | undefined): Record<string, unknown> {
  const v = safeParseJson(text);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function readingView(row: ReadingRow): ReadingView {
  const validity = obj(row.validity_json);
  const findingsRaw = safeParseJson(row.findings_json);
  const findings = Array.isArray(findingsRaw)
    ? findingsRaw
        .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
        .map((f) => ({ ruleId: String(f.ruleId ?? ""), severity: String(f.severity ?? "info") }))
    : [];
  return {
    id: row.id,
    unit_id: row.unit_id,
    conversation_id: row.conversation_id,
    created_at: row.created_at,
    mode: row.mode,
    refrigerant: row.refrigerant,
    metering_device: row.metering_device,
    measurements: obj(row.measurements_json),
    derived: obj(row.derived_json),
    validity: { ok: validity.ok !== false, issues: Array.isArray(validity.issues) ? validity.issues.map(String) : [] },
    findings,
    note: row.note,
    source: row.source,
  };
}

/**
 * Persist a diagnosis as a readings row: measurements as entered, derived metrics, the validity verdict and the
 * findings reduced to ruleId + severity. Shared by POST /api/calc/diagnose (unit_id) and the diagnose tool.
 */
export function storeReading(
  repos: Repos,
  opts: { unitId: string; conversationId?: string | null; result: DxResult; note?: string | null; source: ReadingSource },
): ReadingRow {
  const r = opts.result;
  return repos.readings.create({
    unit_id: opts.unitId,
    conversation_id: opts.conversationId ?? null,
    mode: r.measurements.mode,
    refrigerant: r.measurements.refrigerant,
    metering_device: r.measurements.meteringDevice,
    measurements_json: r.measurements,
    derived_json: r.derived,
    validity_json: r.validity,
    findings_json: r.findings.map((f) => ({ ruleId: f.ruleId, severity: f.severity })),
    note: opts.note ?? null,
    source: opts.source,
  });
}

/**
 * Persist a chiller evaluation as a readings row (mode "chiller", metering "unknown"): measurements as entered,
 * derived approach/ΔT/tons, the validity verdict and findings reduced to ruleId + severity.
 */
export function storeChillerReading(
  repos: Repos,
  opts: { unitId: string; conversationId?: string | null; result: ChillerResult; note?: string | null; source: ReadingSource },
): ReadingRow {
  const r = opts.result;
  return repos.readings.create({
    unit_id: opts.unitId,
    conversation_id: opts.conversationId ?? null,
    mode: "chiller",
    refrigerant: r.measurements.refrigerant ?? "unknown",
    metering_device: "unknown",
    measurements_json: { ...r.measurements, condenserType: r.condenserType },
    derived_json: r.derived,
    validity_json: r.validity,
    findings_json: r.findings.map((f) => ({ ruleId: f.ruleId, severity: f.severity })),
    note: opts.note ?? null,
    source: opts.source,
  });
}

/** Rows considered when computing a unit's trend (newest first). */
export const TREND_WINDOW = 20;

/** The newest reading (view) and the trend for GET /api/units/:id. */
export function unitReadingsSummary(repos: Repos, unitId: string): { lastReading: ReadingView | null; trend: TrendResult | null } {
  const rows = repos.readings.list({ unitId, limit: TREND_WINDOW });
  return { lastReading: rows[0] ? readingView(rows[0]) : null, trend: trendFromReadings(rows) };
}
