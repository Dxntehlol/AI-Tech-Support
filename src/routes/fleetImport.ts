import type { AppDeps } from "../app.ts";
import { mapRowObject, parseImportText, type ImportField, type ParsedImport } from "../importParse.ts";
import type { Confidence, DecodeResult, UnitRow } from "../types.ts";
import { prepareUnitCreate, parseUnitInput, type PreparedUnit } from "./units.ts";
import { HttpError, badRequest, describeError, optBoolean, type Body } from "./util.ts";

/** Most rows one import request may carry. */
export const IMPORT_MAX_ROWS = 200;
/** Largest `text` accepted (bytes, UTF-8); the JSON body limit is 1 MB as well. */
export const IMPORT_MAX_TEXT_BYTES = 1024 * 1024;

export type ImportRowStatus = "new" | "duplicate" | "error";

export interface ImportDecodedSummary {
  manufacturer: string | null;
  family: string | null;
  tonnage: number | null;
  refrigerant: string | null;
  voltage: string | null;
  manufactureDate: string | null;
  ageYears: number | null;
  /** Lowest confidence of the best model and serial matches; "none" when the decoder matched neither (or no model). */
  confidence: Confidence | "none";
  warnings: string[];
}

export interface ImportRowReport {
  index: number;
  /** 1-based source line for pasted text. */
  line?: number;
  input: Partial<Record<ImportField, string>>;
  status: ImportRowStatus;
  error?: string;
  /** duplicate of a saved unit */
  existingUnitId?: string;
  /** duplicate of an earlier row in this batch */
  duplicateOf?: number;
  /** set when dryRun is false and the row was created */
  unitId?: string;
  decoded: ImportDecodedSummary | null;
}

export interface ImportResponse {
  dryRun: boolean;
  source: "text" | "rows";
  delimiter?: ParsedImport["delimiter"];
  header?: boolean;
  ignoredColumns: string[];
  warnings: string[];
  summary: { total: number; new: number; duplicate: number; error: number; created: number };
  createdIds: string[];
  rows: ImportRowReport[];
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Report-sized view of a decode (the stored decoded_json is the full DecodeResult). */
export function summarizeDecode(columns: Record<string, unknown>, decoded: DecodeResult | null): ImportDecodedSummary {
  const bestModel = decoded?.model[0];
  const bestSerial = decoded?.serial[0];
  const levels = [bestModel?.confidence, bestSerial?.confidence].filter((c): c is Confidence => !!c);
  const confidence = levels.length ? levels.reduce((a, b) => (CONFIDENCE_RANK[b] < CONFIDENCE_RANK[a] ? b : a)) : "none";
  const warnings = [...(decoded?.warnings ?? [])];
  if (!decoded) warnings.push("No model number: decoder skipped.");
  else if (bestSerial?.ambiguous && bestSerial.candidateYears?.length) warnings.push(`Serial year ambiguous: ${bestSerial.candidateYears.join(" or ")}.`);
  return {
    manufacturer: str(columns.manufacturer),
    family: bestModel?.family ?? null,
    tonnage: typeof columns.tonnage === "number" ? columns.tonnage : null,
    refrigerant: str(columns.refrigerant),
    voltage: str(columns.voltage),
    manufactureDate: bestSerial?.manufactureDate ?? null,
    ageYears: typeof bestSerial?.ageYears === "number" ? bestSerial.ageYears : null,
    confidence,
    warnings: [...new Set(warnings)],
  };
}

/** Within-batch identity: model + serial when a serial is present, else model + site + tag; null = not comparable. */
function batchKey(p: PreparedUnit, values: Partial<Record<ImportField, string>>): string | null {
  if (p.serial) return p.model ? `ms|${p.model.toUpperCase()}|${p.serial.toUpperCase()}` : null;
  const tag = values.unit_tag?.trim().toLowerCase();
  if (!tag) return null;
  return `tag|${(p.model ?? "").toUpperCase()}|${(values.site ?? "").trim().toLowerCase()}|${tag}`;
}

interface SourceRow {
  line?: number;
  values: Partial<Record<ImportField, string>>;
  ignored?: string[];
}

function tooManyRows(count: string): HttpError {
  return badRequest(`Too many rows (${count}); import at most ${IMPORT_MAX_ROWS} units at a time.`);
}

function readSource(b: Body): { source: "text" | "rows"; rows: SourceRow[]; parsed?: ParsedImport; ignored: string[] } {
  const hasText = b.text !== undefined && b.text !== null && b.text !== "";
  const hasRows = b.rows !== undefined && b.rows !== null;
  if (hasText && hasRows) throw badRequest("Send either text or rows, not both.");
  if (hasText) {
    if (typeof b.text !== "string") throw badRequest("text must be a string.");
    if (Buffer.byteLength(b.text, "utf8") > IMPORT_MAX_TEXT_BYTES) throw new HttpError(413, "too_large", "Import text is larger than 1 MB.");
    // The parser stops after IMPORT_MAX_ROWS + 1 rows, so an oversized paste is rejected without mapping it all.
    const parsed = parseImportText(b.text, { maxRows: IMPORT_MAX_ROWS });
    if (parsed.truncated) throw tooManyRows(`more than ${IMPORT_MAX_ROWS}`);
    return { source: "text", rows: parsed.rows.map((r) => ({ line: r.line, values: r.values })), parsed, ignored: parsed.ignoredColumns };
  }
  if (hasRows) {
    if (!Array.isArray(b.rows)) throw badRequest("rows must be an array of objects.");
    if (b.rows.length > IMPORT_MAX_ROWS) throw tooManyRows(String(b.rows.length));
    const ignored = new Set<string>();
    const rows = b.rows.map((r, i) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) throw badRequest(`rows[${i}] must be an object.`);
      const m = mapRowObject(r as Record<string, unknown>);
      for (const k of m.ignored) ignored.add(k);
      return { values: m.values };
    });
    return { source: "rows", rows, ignored: [...ignored] };
  }
  throw badRequest("Paste the fleet list as text (CSV/TSV or one unit per line) or send rows.");
}

/**
 * POST /api/units/import. Classifies every row (new | duplicate | error) with a decode summary; with
 * dryRun false, creates the new rows through the same prepare → units.create path as POST /api/units, all in
 * one transaction. dryRun defaults to true so a malformed client never writes by accident.
 */
export function runFleetImport(deps: AppDeps, b: Body): ImportResponse {
  const dryRun = optBoolean(b.dryRun ?? b.dry_run, "dryRun") ?? true;
  const { source, rows, parsed, ignored } = readSource(b);
  if (rows.length === 0) throw badRequest("No unit rows found in the import.");
  if (rows.length > IMPORT_MAX_ROWS) throw tooManyRows(String(rows.length));
  const { repos } = deps;

  const reports: ImportRowReport[] = [];
  const pending: { report: ImportRowReport; prepared: PreparedUnit }[] = [];
  const seen = new Map<string, number>();

  rows.forEach((row, index) => {
    const report: ImportRowReport = { index, ...(row.line !== undefined ? { line: row.line } : {}), input: row.values, status: "new", decoded: null };
    reports.push(report);
    let prepared: PreparedUnit;
    try {
      prepared = prepareUnitCreate(deps, parseUnitInput({ ...row.values }));
    } catch (err) {
      const d = describeError(err);
      if (d.internal) throw err;
      report.status = "error";
      report.error = d.message;
      return;
    }
    report.decoded = summarizeDecode(prepared.columns as Record<string, unknown>, prepared.decoded);
    const key = batchKey(prepared, row.values);
    const earlier = key ? seen.get(key) : undefined;
    if (earlier !== undefined) {
      report.status = "duplicate";
      report.duplicateOf = earlier;
      report.error = `Same unit as row ${reports[earlier]?.line ?? earlier + 1} of this import.`;
      return;
    }
    if (key) seen.set(key, index);
    const existing: UnitRow | undefined = repos.units.findDuplicate({ model: prepared.model, serial: prepared.serial, site: row.values.site, unit_tag: row.values.unit_tag });
    if (existing) {
      report.status = "duplicate";
      report.existingUnitId = existing.id;
      report.error = `Already saved${existing.unit_tag ? ` as ${existing.unit_tag}` : ""}${existing.site ? ` at ${existing.site}` : ""}.`;
      return;
    }
    pending.push({ report, prepared });
  });

  const createdIds: string[] = [];
  if (!dryRun && pending.length) {
    repos.transaction(() => {
      for (const p of pending) {
        const unit = repos.units.create(p.prepared.columns);
        p.report.unitId = unit.id;
        createdIds.push(unit.id);
      }
    });
  }

  const count = (s: ImportRowStatus) => reports.filter((r) => r.status === s).length;
  return {
    dryRun,
    source,
    ...(parsed ? { delimiter: parsed.delimiter, header: parsed.header } : {}),
    ignoredColumns: ignored,
    warnings: parsed?.warnings ?? [],
    summary: { total: reports.length, new: count("new"), duplicate: count("duplicate"), error: count("error"), created: createdIds.length },
    createdIds,
    rows: reports,
  };
}
