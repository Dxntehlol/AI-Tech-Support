/**
 * Bulk fleet import parser (pure; no I/O). Turns pasted CSV / TSV / plain lines into unit field maps.
 *
 * - Delimiter auto-detect on the first non-empty line (outside quotes): tab, else comma, else semicolon (only when
 *   that line is a recognized header or the lines are consistently semicolon-separated), else none
 *   (whitespace-separated plain lines).
 * - RFC 4180 quoting ("a, b" and "" escapes, newlines inside quotes), UTF-8 BOM stripped, CRLF / CR / LF.
 * - Header row matched case-insensitively against IMPORT_ALIASES; unknown columns are ignored and reported.
 * - Work is bounded: at most IMPORT_MAX_COLUMNS header columns, `maxRows` data rows (then `truncated`), and
 *   MAX_WARNINGS warnings, so a hostile or very wide paste cannot make parsing quadratic.
 * - No recognizable header: every non-empty line is "model serial [site] [tag]" split on the delimiter, or on
 *   whitespace when there is no comma/tab (then 5+ tokens = model, serial, site words…, tag).
 */

export type ImportField = "model" | "serial" | "manufacturer" | "site" | "unit_tag" | "nickname" | "customer" | "location_note";

export const IMPORT_FIELDS: readonly ImportField[] = ["model", "serial", "manufacturer", "site", "unit_tag", "nickname", "customer", "location_note"];

/** Header aliases per field (compared after normalizeHeader). */
export const IMPORT_ALIASES: Readonly<Record<ImportField, readonly string[]>> = {
  model: ["model", "model number", "model #", "model_no", "model no", "model no.", "model num", "m/n", "mn"],
  serial: ["serial", "serial number", "serial #", "s/n", "sn", "serial_no", "serial no", "serial no.", "serial num"],
  manufacturer: ["manufacturer", "brand", "make", "mfr", "mfg", "manufacturer name"],
  site: ["site", "location", "building", "customer site", "site name", "address"],
  unit_tag: ["tag", "unit tag", "unit", "rtu", "name", "unit_tag", "unit name", "unit id", "equipment tag", "asset tag"],
  nickname: ["nickname", "nick name", "alias"],
  customer: ["customer", "client", "account", "customer name"],
  location_note: ["notes", "note", "location note", "location_note", "location notes", "comments"],
};

/** Header columns read; cells past this are ignored (with a warning). */
export const IMPORT_MAX_COLUMNS = 64;
/** Warnings kept in a parse result (the rest are summarized in one line). */
const MAX_WARNINGS = 20;

export type ImportDelimiter = "," | "\t" | ";" | "whitespace";

export interface ParsedImportRow {
  /** 1-based physical line where the record starts (for error messages). */
  line: number;
  /** Recognized fields only, trimmed, empty values omitted. */
  values: Partial<Record<ImportField, string>>;
}

export interface ParsedImport {
  delimiter: ImportDelimiter;
  /** True when the first record was a recognized header row. */
  header: boolean;
  /** Field per column (null = ignored) when header is true; positional mapping otherwise. */
  columns: (ImportField | null)[];
  /** Header cells that matched no alias. */
  ignoredColumns: string[];
  rows: ParsedImportRow[];
  warnings: string[];
  /** True when the text had more than `maxRows` data rows; `rows` then holds only the first `maxRows`. */
  truncated: boolean;
}

export interface ParseImportOptions {
  /** Stop after this many data rows (header excluded) and set `truncated`. */
  maxRows?: number;
}

/** Lowercase, trim, collapse whitespace, strip a trailing ":" — "  Model  # :" → "model #". */
export function normalizeHeader(cell: string): string {
  return cell
    .replace(/^﻿/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*:$/, "")
    .trim();
}

const ALIAS_LOOKUP: Map<string, ImportField> = (() => {
  const m = new Map<string, ImportField>();
  for (const f of IMPORT_FIELDS) {
    for (const a of IMPORT_ALIASES[f]) {
      const n = normalizeHeader(a);
      m.set(n, f);
      m.set(n.replace(/_/g, " "), f);
      m.set(n.replace(/ /g, "_"), f);
    }
  }
  return m;
})();

/** Field for a header cell, or null when unrecognized. Underscores and spaces are interchangeable. */
export function fieldForHeader(cell: string): ImportField | null {
  const n = normalizeHeader(cell);
  if (n === "") return null;
  return ALIAS_LOOKUP.get(n) ?? ALIAS_LOOKUP.get(n.replace(/_/g, " ")) ?? null;
}

/**
 * Delimiter of the first non-empty line, counted outside double quotes. A semicolon only counts when that line
 * is a recognized header, or when at least half the lines carry one and the first cell (a model number) has no
 * spaces (unless quoted); otherwise a stray ";" inside a whitespace line ("48TC 123 Bldg;A RTU-1") would split every line on it.
 */
export function detectDelimiter(text: string): ImportDelimiter {
  const lines = stripBom(text).split(/\r\n|\r|\n/);
  const first = lines.find((l) => l.trim() !== "") ?? "";
  const d = firstLineDelimiter(first);
  if (d !== ";") return d;
  const cells = tokenizeDelimited(first, ";").records[0]?.cells ?? [];
  if (headerMapping(cells, "delimited")) return ";";
  const sample = lines.filter((l) => l.trim() !== "").slice(0, 50);
  const withSemicolon = sample.filter((l) => l.includes(";")).length;
  // A quoted first cell is deliberate structure; an unquoted one with spaces is a whitespace line.
  const firstCellOk = first.trimStart().startsWith('"') || !/\s/.test((cells[0] ?? "").trim());
  return withSemicolon * 2 >= sample.length && firstCellOk ? ";" : "whitespace";
}

function firstLineDelimiter(first: string): ImportDelimiter {
  let inQuotes = false;
  const counts = { "\t": 0, ",": 0, ";": 0 };
  for (const ch of first) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\t" || ch === "," || ch === ";")) counts[ch]++;
  }
  if (counts["\t"] > 0 && counts["\t"] >= counts[","]) return "\t";
  if (counts[","] > 0) return ",";
  if (counts[";"] > 0) return ";";
  return "whitespace";
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * RFC 4180 records with their starting line numbers. A quote only opens a quoted field at the start of a field;
 * elsewhere it is literal. An unterminated quote runs to the end of input (reported via `unterminated`).
 */
export function tokenizeDelimited(
  text: string,
  delimiter: string,
  maxNonBlankRecords = Infinity,
): { records: { line: number; cells: string[] }[]; unterminated: boolean; stopped: boolean } {
  const src = stripBom(text);
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let fieldStart = true;
  let line = 1;
  let recordLine = 1;
  let nonBlank = 0;
  let stopped = false;
  const endRecord = () => {
    cells.push(cell);
    records.push({ line: recordLine, cells });
    if (!isBlankRecord(cells) && ++nonBlank >= maxNonBlankRecords) stopped = true;
    cells = [];
    cell = "";
    fieldStart = true;
  };
  for (let i = 0; i < src.length && !stopped; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n" || (ch === "\r" && src[i + 1] !== "\n")) line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
      continue;
    }
    if (ch === delimiter) {
      cells.push(cell);
      cell = "";
      fieldStart = true;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
      continue;
    }
    if (fieldStart && (ch === " " || ch === "\t") && delimiter !== ch) {
      // Leading spaces before an opening quote (`a, "b, c"`) are tolerated.
      let j = i;
      while (src[j] === " " || (src[j] === "\t" && delimiter !== "\t")) j++;
      if (src[j] === '"') {
        i = j - 1;
        continue;
      }
    }
    fieldStart = false;
    cell += ch;
  }
  if (!stopped && (cell !== "" || cells.length > 0)) endRecord();
  return { records, unterminated: !stopped && inQuotes, stopped };
}

const POSITIONAL: ImportField[] = ["model", "serial", "site", "unit_tag"];

function isBlankRecord(cells: string[]): boolean {
  return cells.every((c) => c.trim() === "");
}

/**
 * Recognized header: ≥ 1 identity column (model/serial/tag/nickname), and
 *  - delimited rows: ≥ 2 known columns (1 is enough for a 1–2 cell row); when fewer than half the cells are known,
 *    the unknown cells must look like labels (no digits), so a wide export ("Site,Unit,Model,Serial,Tons,Volts,…")
 *    is a header while a data row is not;
 *  - space-separated rows: at least half the tokens known (a data line can contain words like "unit" or "building").
 */
function headerMapping(cells: string[], mode: "delimited" | "whitespace"): { columns: (ImportField | null)[]; ignored: string[] } | null {
  const columns = cells.map(fieldForHeader);
  const nonEmpty = cells.filter((c) => c.trim() !== "").length;
  const known = columns.filter((c) => c !== null);
  const identity = known.some((f) => f === "model" || f === "serial" || f === "unit_tag" || f === "nickname");
  if (!identity) return null;
  if (mode === "whitespace") {
    if (known.length * 2 < nonEmpty) return null;
  } else {
    if (known.length < 2 && nonEmpty > 2) return null;
    if (known.length * 2 < nonEmpty && cells.some((c, i) => columns[i] === null && /\d/.test(c))) return null;
  }
  const ignored = cells.filter((c, i) => c.trim() !== "" && columns[i] === null).map((c) => c.trim());
  return { columns, ignored };
}

function assign(values: Partial<Record<ImportField, string>>, field: ImportField | null | undefined, raw: string | undefined): void {
  if (!field || raw === undefined) return;
  const v = raw.trim();
  if (v === "" || values[field] !== undefined) return;
  values[field] = v;
}

/** Split a plain line on whitespace into model, serial, [site words…], [tag]. */
function whitespaceRow(lineText: string): Partial<Record<ImportField, string>> {
  const tokens = lineText.trim().split(/\s+/).filter(Boolean);
  const values: Partial<Record<ImportField, string>> = {};
  assign(values, "model", tokens[0]);
  assign(values, "serial", tokens[1]);
  if (tokens.length === 3) assign(values, "site", tokens[2]);
  else if (tokens.length >= 4) {
    assign(values, "site", tokens.slice(2, -1).join(" "));
    assign(values, "unit_tag", tokens[tokens.length - 1]);
  }
  return values;
}

/** Keep the first IMPORT_MAX_COLUMNS header cells (warning when more were given). */
function capColumns(cells: string[], warnings: string[]): string[] {
  if (cells.length <= IMPORT_MAX_COLUMNS) return cells;
  warnings.push(`The header has ${cells.length} columns; only the first ${IMPORT_MAX_COLUMNS} were read.`);
  return cells.slice(0, IMPORT_MAX_COLUMNS);
}

function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_WARNINGS) return warnings;
  return [...warnings.slice(0, MAX_WARNINGS - 1), `…and ${warnings.length - MAX_WARNINGS + 1} more warnings.`];
}

/**
 * Space-separated row under a recognized header. When the header has a site column and the row has extra tokens,
 * the site absorbs them (like the headerless "model serial site words… tag" rule), so "48TC 1234 Main Street RTU-1"
 * under "model serial site tag" keeps the tag. Returns whether tokens were left over (no site column to absorb them).
 */
function whitespaceHeaderRow(lineText: string, columns: (ImportField | null)[], values: Partial<Record<ImportField, string>>): boolean {
  const tokens = lineText.trim().split(/\s+/).filter(Boolean);
  const siteIdx = columns.indexOf("site");
  if (tokens.length > columns.length && siteIdx >= 0) {
    const extra = tokens.length - columns.length;
    columns.forEach((f, ci) => {
      if (ci < siteIdx) assign(values, f, tokens[ci]);
      else if (ci === siteIdx) assign(values, f, tokens.slice(ci, ci + extra + 1).join(" "));
      else assign(values, f, tokens[ci + extra]);
    });
    return false;
  }
  columns.forEach((f, ci) => assign(values, f, tokens[ci]));
  return tokens.length > columns.length;
}

export function parseImportText(text: string, opts: ParseImportOptions = {}): ParsedImport {
  const warnings: string[] = [];
  const maxRows = opts.maxRows !== undefined && opts.maxRows >= 0 ? opts.maxRows : Infinity;
  const src = stripBom(typeof text === "string" ? text : "");
  const delimiter = detectDelimiter(src);

  if (delimiter === "whitespace") {
    const lines = src.split(/\r\n|\r|\n/);
    const firstIdx = lines.findIndex((l) => l.trim() !== "");
    // A single-column header ("Model") or space-separated header ("model serial site tag") still counts.
    let header = false;
    let columns: (ImportField | null)[] = [...POSITIONAL];
    let ignored: string[] = [];
    let skipFirst = false;
    if (firstIdx >= 0) {
      const first = lines[firstIdx]!;
      const whole = fieldForHeader(first);
      const tokens = capColumns(first.trim().split(/\s+/), warnings);
      const mapping = whole ? { columns: [whole], ignored: [] } : headerMapping(tokens, "whitespace");
      if (mapping && (whole || mapping.columns.every((c) => c !== null))) {
        header = true;
        columns = mapping.columns;
        ignored = mapping.ignored;
      } else if (mapping) {
        // Multi-word column names cannot be split on spaces ("Model Number Serial Number"): skip the header row.
        skipFirst = true;
        warnings.push("The header row has multi-word column names separated by spaces; put commas or tabs between columns. Rows were read as model serial [site] [tag].");
      }
    }
    const rows: ParsedImportRow[] = [];
    const overflowLines: number[] = [];
    let truncated = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.trim() === "" || ((header || skipFirst) && i === firstIdx)) continue;
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      let values: Partial<Record<ImportField, string>>;
      if (header) {
        values = {};
        if (whitespaceHeaderRow(l, columns, values)) overflowLines.push(i + 1);
      } else values = whitespaceRow(l);
      rows.push({ line: i + 1, values });
    }
    if (ignored.length) warnings.push(`Ignored columns: ${ignored.join(", ")}.`);
    if (overflowLines.length) {
      const shown = overflowLines.slice(0, 5).join(", ") + (overflowLines.length > 5 ? ", …" : "");
      warnings.push(
        `${overflowLines.length === 1 ? "Line" : "Lines"} ${shown} had more values than the header has columns; the extra values were ignored. Put commas or tabs between columns.`,
      );
    }
    return { delimiter, header, columns, ignoredColumns: ignored, rows, warnings: capWarnings(warnings), truncated };
  }

  // Header + maxRows data rows + 1 more to detect "too many"; the tokenizer stops there.
  const { records, unterminated } = tokenizeDelimited(src, delimiter, maxRows + 2);
  if (unterminated) warnings.push("A quoted field was never closed; the rest of the text was read as one value.");
  const nonBlank = records.filter((r) => !isBlankRecord(r.cells));
  const headerCells = nonBlank.length ? capColumns(nonBlank[0]!.cells, []) : [];
  const mapping = nonBlank.length ? headerMapping(headerCells, "delimited") : null;
  if (mapping && headerCells.length < nonBlank[0]!.cells.length) capColumns(nonBlank[0]!.cells, warnings);
  const columns: (ImportField | null)[] = mapping ? mapping.columns : [...POSITIONAL];
  if (mapping) {
    const seen = new Set<ImportField>();
    mapping.columns.forEach((f, i) => {
      if (!f) return;
      if (seen.has(f)) {
        warnings.push(`Column "${headerCells[i]!.trim()}" repeats ${f}; the first ${f} column is used.`);
        columns[i] = null;
      }
      seen.add(f);
    });
    if (mapping.ignored.length) warnings.push(`Ignored columns: ${mapping.ignored.join(", ")}.`);
  }
  const allBody = mapping ? nonBlank.slice(1) : nonBlank;
  const truncated = allBody.length > maxRows;
  const body = truncated ? allBody.slice(0, maxRows) : allBody;
  const rows = body.map((r) => {
    const values: Partial<Record<ImportField, string>> = {};
    if (mapping) columns.forEach((f, ci) => assign(values, f, r.cells[ci]));
    else POSITIONAL.forEach((f, ci) => assign(values, f, r.cells[ci]));
    return { line: r.line, values };
  });
  return { delimiter, header: mapping !== null, columns, ignoredColumns: mapping ? mapping.ignored : [], rows, warnings: capWarnings(warnings), truncated };
}

/**
 * Map a JSON row object (`rows[]` in the request) onto import fields using the same aliases, so
 * `{ "Model #": "…", "S/N": "…" }` and `{ model, serial }` both work. Non-string scalars are stringified;
 * unknown keys are returned in `ignored`.
 */
export function mapRowObject(row: Record<string, unknown>): { values: Partial<Record<ImportField, string>>; ignored: string[] } {
  const values: Partial<Record<ImportField, string>> = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    const f = fieldForHeader(k);
    if (!f) {
      ignored.push(k);
      continue;
    }
    if (v === null || v === undefined) continue;
    if (typeof v === "string") assign(values, f, v);
    else if (typeof v === "number" && Number.isFinite(v)) assign(values, f, String(v));
    else ignored.push(k);
  }
  return { values, ignored };
}
