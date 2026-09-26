import type { StatementSync } from "node:sqlite";
import type { Db } from "./index.ts";
import { newId, nowIso } from "./index.ts";
import type { ConversationRow, FindingRow, MessageRow, SearchHit, UnitRow } from "../types.ts";

/** At least one of model / unit_tag / nickname must be non-empty. */
export type UnitInput = Partial<Omit<UnitRow, "id" | "created_at" | "updated_at">>;
export type FindingInput = Partial<Omit<FindingRow, "id" | "created_at" | "symptom">> & { symptom: string };

/** Columns findings.update accepts (everything else in the row is immutable after creation). */
export type FindingPatch = Partial<
  Pick<
    FindingRow,
    | "symptom"
    | "cause"
    | "resolution"
    | "measurements_json"
    | "parts_json"
    | "tags"
    | "circuit"
    | "status"
    | "service_date"
    | "refrigerant"
    | "refrigerant_added_lbs"
    | "refrigerant_recovered_lbs"
    | "follow_up"
    | "confirmed"
  >
>;

/**
 * Errors thrown by the repos for caller mistakes. `code` lets routes map them to 400 / 404 without
 * string-matching messages. Anything else that escapes is a real database failure.
 */
export class RepoError extends Error {
  code: "validation" | "not_found";
  constructor(code: "validation" | "not_found", message: string) {
    super(message);
    this.name = "RepoError";
    this.code = code;
  }
}

export interface Repos {
  units: {
    create(input: UnitInput): UnitRow;
    get(id: string): UnitRow | undefined;
    findByModelSerial(model: string, serial?: string | null): UnitRow | undefined;
    /** Excludes archived units unless includeArchived. */
    list(opts?: { q?: string; site?: string; limit?: number; includeArchived?: boolean }): UnitRow[];
    update(id: string, patch: Partial<UnitInput>): UnitRow | undefined;
    /** Soft delete: sets archived_at. */
    archive(id: string): boolean;
    /** Hard delete (findings/conversations keep rows with unit_id = NULL). */
    remove(id: string): boolean;
  };
  conversations: {
    create(input?: { title?: string; unit_id?: string | null }): ConversationRow;
    get(id: string): ConversationRow | undefined;
    list(opts?: { q?: string; unitId?: string; limit?: number }): ConversationRow[];
    update(id: string, patch: Partial<Pick<ConversationRow, "title" | "unit_id" | "summary">>): ConversationRow | undefined;
    touch(id: string): void;
    remove(id: string): boolean;
  };
  messages: {
    /**
     * Allocates seq atomically (single INSERT ... SELECT COALESCE(MAX(seq),0)+1 or inside BEGIN IMMEDIATE),
     * stores content verbatim as JSON, and touches conversations.updated_at in the same transaction.
     * kind "tool_result" rows must have text "" (not searched).
     */
    append(conversationId: string, role: MessageRow["role"], content: unknown[], text: string, kind?: MessageRow["kind"]): MessageRow;
    list(conversationId: string): MessageRow[];
    count(conversationId: string): number;
  };
  findings: {
    create(input: FindingInput): FindingRow;
    get(id: string): FindingRow | undefined;
    list(opts?: { unitId?: string; conversationId?: string; limit?: number }): FindingRow[];
    remove(id: string): boolean;
    /** Optional extension: patch status/confirmed/cause/resolution/follow_up (and other FindingPatch columns). */
    update?(id: string, patch: FindingPatch): FindingRow | undefined;
  };
  /** FTS over messages (chat rows only) + findings, plus LIKE over units (model/serial/tag/site/customer). */
  search(query: string, opts?: { unitId?: string; site?: string; since?: string; limit?: number }): SearchHit[];
}

export interface RepoOptions {
  /** Clock used for created_at / updated_at (ISO-8601 UTC). Defaults to nowIso(). */
  now?: () => string;
}

// ---------------------------------------------------------------------------
// Value normalization helpers (exported so routes/tools can reuse the exact same rules)
// ---------------------------------------------------------------------------

type SqlValue = string | number | null;

/** Model / serial normalization: trim, uppercase, collapse whitespace. Empty → null. */
export function normalizeCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/\s+/g, " ").toUpperCase();
  return s === "" ? null : s;
}

/** Tags → comma-separated lowercase tokens (array or comma/semicolon/newline separated string). Empty → null. */
export function normalizeTags(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const parts: string[] = Array.isArray(value) ? value.map((v) => String(v ?? "")) : String(value).split(/[,;\n]/);
  const seen = new Set<string>();
  for (const part of parts) {
    const tok = part.trim().toLowerCase().replace(/\s+/g, "-");
    if (tok) seen.add(tok);
  }
  return seen.size ? [...seen].join(",") : null;
}

/**
 * Turn free text into a safe FTS5 MATCH expression: whitespace-split tokens stripped to [A-Za-z0-9_-],
 * each quoted, joined by spaces (implicit AND). Returns null when nothing searchable remains.
 */
export function ftsMatchExpression(query: string): string | null {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" ");
}

function searchTokens(query: string): string[] {
  if (typeof query !== "string") return [];
  return query
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z0-9_-]/g, ""))
    .filter((t) => /[A-Za-z0-9]/.test(t));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function validation(message: string): RepoError {
  return new RepoError("validation", message);
}

function textOrNull(value: unknown, col: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const s = value.trim();
    return s === "" ? null : s;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw validation(`${col} must be a string`);
}

/** JSON columns: objects are stringified; strings are stored as given when they are valid JSON, else wrapped as a JSON string. */
function jsonOrNull(value: unknown, col: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return null;
    try {
      JSON.parse(s);
      return s;
    } catch {
      return JSON.stringify(s);
    }
  }
  if (typeof value === "object" || typeof value === "number" || typeof value === "boolean") {
    try {
      const out = JSON.stringify(value);
      if (typeof out !== "string") throw new Error("unserializable");
      return out;
    } catch {
      throw validation(`${col} must be JSON-serializable`);
    }
  }
  throw validation(`${col} must be an object or JSON string`);
}

interface NumRule {
  int: boolean;
  min: number;
  max: number;
}

function numberOrNull(value: unknown, col: string, rule: NumRule): number | null {
  if (value === null || value === undefined) return null;
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return null;
    n = Number(s);
  } else throw validation(`${col} must be a number`);
  if (!Number.isFinite(n)) throw validation(`${col} must be a number`);
  if (rule.int) n = Math.round(n);
  if (n < rule.min || n > rule.max) throw validation(`${col} must be between ${rule.min} and ${rule.max}`);
  return n;
}

function boolToInt(value: unknown, col: string): 0 | 1 | null {
  if (value === null || value === undefined) return null;
  if (value === true || value === 1 || value === "1" || value === "true") return 1;
  if (value === false || value === 0 || value === "0" || value === "false") return 0;
  throw validation(`${col} must be 0 or 1`);
}

function clampLimit(limit: unknown, fallback: number, max = 1000): number {
  const n = typeof limit === "number" ? limit : typeof limit === "string" ? Number(limit) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

/** node:sqlite returns null-prototype objects; convert to plain objects so callers can compare/serialize freely. */
function plain<T>(row: unknown): T {
  return { ...(row as Record<string, unknown>) } as T;
}

// ---------------------------------------------------------------------------
// Column whitelists
// ---------------------------------------------------------------------------

type ColKind = "text" | "code" | "json" | "num";

const NUM_RULES: Record<string, NumRule> = {
  tonnage: { int: false, min: 0, max: 10000 },
  circuits: { int: true, min: 0, max: 64 },
  install_year: { int: true, min: 1900, max: 2100 },
  elevation_ft: { int: true, min: -1500, max: 30000 },
  refrigerant_added_lbs: { int: false, min: 0, max: 100000 },
  refrigerant_recovered_lbs: { int: false, min: 0, max: 100000 },
};

const UNIT_COLUMNS: Record<string, ColKind> = {
  manufacturer: "text",
  brand: "text",
  model: "code",
  serial: "code",
  nickname: "text",
  site: "text",
  customer: "text",
  location_note: "text",
  refrigerant: "text",
  tonnage: "num",
  voltage: "text",
  phase: "text",
  decoded_json: "json",
  notes: "text",
  unit_tag: "text",
  circuits: "num",
  charge_json: "json",
  nameplate_json: "json",
  control_platform: "text",
  heat_type: "text",
  metering_device: "text",
  install_year: "num",
  last_service_at: "text",
  elevation_ft: "num",
  archived_at: "text",
};
const UNIT_COLUMN_NAMES = Object.keys(UNIT_COLUMNS);

const FINDING_STATUSES = new Set(["open", "resolved", "monitor"]);
const FINDING_ORIGINS = new Set(["tech", "assistant"]);

function coerceUnitColumn(col: string, value: unknown): SqlValue {
  const kind = UNIT_COLUMNS[col];
  switch (kind) {
    case "text":
      return textOrNull(value, col);
    case "code":
      return normalizeCode(value);
    case "json":
      return jsonOrNull(value, col);
    case "num":
      return numberOrNull(value, col, NUM_RULES[col] ?? { int: false, min: -Infinity, max: Infinity });
    default:
      throw validation(`unknown unit column ${col}`);
  }
}

function hasIdentity(row: Record<string, unknown>): boolean {
  return [row.model, row.unit_tag, row.nickname].some((v) => typeof v === "string" && v.trim() !== "");
}

const MESSAGE_COLS = "id, conversation_id, seq, role, kind, content_json, text, created_at";
const FINDING_COLS =
  "id, unit_id, conversation_id, symptom, cause, resolution, measurements_json, parts_json, tags, circuit, status, " +
  "service_date, refrigerant, refrigerant_added_lbs, refrigerant_recovered_lbs, follow_up, origin, confirmed, created_at";

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

export function createRepos(db: Db, options: RepoOptions = {}): Repos {
  const raw = db.raw;
  const now = options.now ?? nowIso;
  const cache = new Map<string, StatementSync>();

  /** Prepared statements are cached by SQL text; every user value travels as a bound parameter. */
  const prep = (sql: string): StatementSync => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = raw.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };

  const transaction = <T>(fn: () => T): T => {
    raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      raw.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        raw.exec("ROLLBACK");
      } catch {
        /* connection already out of the transaction */
      }
      throw err;
    }
  };

  // ----- units --------------------------------------------------------------

  const getUnit = (id: string): UnitRow | undefined => {
    const row = prep("SELECT * FROM units WHERE id = ?").get(id);
    return row ? plain<UnitRow>(row) : undefined;
  };

  const unitExists = (id: unknown): boolean =>
    typeof id === "string" && prep("SELECT 1 FROM units WHERE id = ?").get(id) !== undefined;

  const conversationExists = (id: unknown): boolean =>
    typeof id === "string" && prep("SELECT 1 FROM conversations WHERE id = ?").get(id) !== undefined;

  const units: Repos["units"] = {
    create(input) {
      if (!input || typeof input !== "object") throw validation("unit input required");
      const src = input as Record<string, unknown>;
      const values: Record<string, SqlValue> = {};
      for (const col of UNIT_COLUMN_NAMES) values[col] = col in src ? coerceUnitColumn(col, src[col]) : null;
      if (!hasIdentity(values)) throw validation("model, unit_tag or nickname required");
      const id = newId();
      const ts = now();
      const sql =
        `INSERT INTO units (id, ${UNIT_COLUMN_NAMES.join(", ")}, created_at, updated_at) ` +
        `VALUES (?, ${UNIT_COLUMN_NAMES.map(() => "?").join(", ")}, ?, ?)`;
      prep(sql).run(id, ...UNIT_COLUMN_NAMES.map((c) => values[c] ?? null), ts, ts);
      return getUnit(id)!;
    },

    get(id) {
      return typeof id === "string" ? getUnit(id) : undefined;
    },

    findByModelSerial(model, serial) {
      const m = normalizeCode(model);
      if (!m) return undefined;
      const s = normalizeCode(serial);
      const row = s
        ? prep("SELECT * FROM units WHERE model = ? AND serial = ? AND archived_at IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(m, s)
        : prep("SELECT * FROM units WHERE model = ? AND serial IS NULL AND archived_at IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(m);
      return row ? plain<UnitRow>(row) : undefined;
    },

    list(opts = {}) {
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (!opts.includeArchived) where.push("archived_at IS NULL");
      const site = typeof opts.site === "string" ? opts.site.trim() : "";
      if (site) {
        where.push("lower(site) = lower(?)");
        params.push(site);
      }
      const q = typeof opts.q === "string" ? opts.q.trim() : "";
      if (q) {
        const cols = ["model", "serial", "unit_tag", "nickname", "site", "customer", "manufacturer"];
        where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
        const pattern = `%${escapeLike(q)}%`;
        for (let i = 0; i < cols.length; i++) params.push(pattern);
      }
      const sql =
        "SELECT * FROM units" +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        " ORDER BY updated_at DESC, rowid DESC LIMIT ?";
      params.push(clampLimit(opts.limit, 100));
      return prep(sql).all(...params).map((r) => plain<UnitRow>(r));
    },

    update(id, patch) {
      if (typeof id !== "string") return undefined;
      const existing = getUnit(id);
      if (!existing) return undefined;
      if (!patch || typeof patch !== "object") throw validation("patch required");
      const src = patch as Record<string, unknown>;
      const cols: string[] = [];
      const values: SqlValue[] = [];
      const merged: Record<string, unknown> = { ...existing };
      for (const col of UNIT_COLUMN_NAMES) {
        if (!(col in src)) continue;
        const v = coerceUnitColumn(col, src[col]);
        cols.push(col);
        values.push(v);
        merged[col] = v;
      }
      if (!hasIdentity(merged)) throw validation("model, unit_tag or nickname required");
      const ts = now();
      const sql = `UPDATE units SET ${cols.map((c) => `${c} = ?`).concat("updated_at = ?").join(", ")} WHERE id = ?`;
      prep(sql).run(...values, ts, id);
      return getUnit(id);
    },

    archive(id) {
      if (typeof id !== "string") return false;
      const ts = now();
      const res = prep("UPDATE units SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?").run(ts, ts, id);
      return Number(res.changes) > 0;
    },

    remove(id) {
      if (typeof id !== "string") return false;
      const res = prep("DELETE FROM units WHERE id = ?").run(id);
      return Number(res.changes) > 0;
    },
  };

  // ----- conversations --------------------------------------------------------

  const getConversation = (id: string): ConversationRow | undefined => {
    const row = prep("SELECT id, title, unit_id, summary, created_at, updated_at FROM conversations WHERE id = ?").get(id);
    return row ? plain<ConversationRow>(row) : undefined;
  };

  const requireUnit = (unitId: unknown): string | null => {
    if (unitId === null || unitId === undefined || unitId === "") return null;
    if (typeof unitId !== "string") throw validation("unit_id must be a string");
    if (!unitExists(unitId)) throw new RepoError("not_found", "unit not found");
    return unitId;
  };

  const conversations: Repos["conversations"] = {
    create(input = {}) {
      const title = textOrNull(input.title, "title") ?? "New conversation";
      const unitId = requireUnit(input.unit_id);
      const id = newId();
      const ts = now();
      prep("INSERT INTO conversations (id, title, unit_id, summary, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)").run(
        id,
        title,
        unitId,
        ts,
        ts,
      );
      return getConversation(id)!;
    },

    get(id) {
      return typeof id === "string" ? getConversation(id) : undefined;
    },

    list(opts = {}) {
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (typeof opts.unitId === "string" && opts.unitId) {
        where.push("unit_id = ?");
        params.push(opts.unitId);
      }
      const q = typeof opts.q === "string" ? opts.q.trim() : "";
      if (q) {
        where.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
        const pattern = `%${escapeLike(q)}%`;
        params.push(pattern, pattern);
      }
      const sql =
        "SELECT id, title, unit_id, summary, created_at, updated_at FROM conversations" +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        " ORDER BY updated_at DESC, rowid DESC LIMIT ?";
      params.push(clampLimit(opts.limit, 100));
      return prep(sql).all(...params).map((r) => plain<ConversationRow>(r));
    },

    update(id, patch) {
      if (typeof id !== "string") return undefined;
      if (!getConversation(id)) return undefined;
      if (!patch || typeof patch !== "object") throw validation("patch required");
      const cols: string[] = [];
      const values: SqlValue[] = [];
      if ("title" in patch) {
        const title = textOrNull(patch.title, "title");
        if (!title) throw validation("title must not be empty");
        cols.push("title");
        values.push(title);
      }
      if ("unit_id" in patch) {
        cols.push("unit_id");
        values.push(requireUnit(patch.unit_id));
      }
      if ("summary" in patch) {
        cols.push("summary");
        values.push(textOrNull(patch.summary, "summary"));
      }
      const ts = now();
      const sql = `UPDATE conversations SET ${cols.map((c) => `${c} = ?`).concat("updated_at = ?").join(", ")} WHERE id = ?`;
      prep(sql).run(...values, ts, id);
      return getConversation(id);
    },

    touch(id) {
      if (typeof id !== "string") return;
      prep("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), id);
    },

    remove(id) {
      if (typeof id !== "string") return false;
      const res = prep("DELETE FROM conversations WHERE id = ?").run(id);
      return Number(res.changes) > 0;
    },
  };

  // ----- messages -------------------------------------------------------------

  const messages: Repos["messages"] = {
    append(conversationId, role, content, text, kind = "chat") {
      if (typeof conversationId !== "string") throw validation("conversation_id required");
      if (role !== "user" && role !== "assistant") throw validation("role must be user or assistant");
      if (kind !== "chat" && kind !== "tool_result") throw validation("kind must be chat or tool_result");
      if (!Array.isArray(content)) throw validation("content must be an array of content blocks");
      const contentJson = JSON.stringify(content);
      const storedText = kind === "tool_result" ? "" : typeof text === "string" ? text : "";
      const id = newId();
      const ts = now();
      return transaction(() => {
        if (!conversationExists(conversationId)) throw new RepoError("not_found", "conversation not found");
        prep(
          "INSERT INTO messages (id, conversation_id, seq, role, kind, content_json, text, created_at) " +
            "SELECT ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ? FROM messages WHERE conversation_id = ?",
        ).run(id, conversationId, role, kind, contentJson, storedText, ts, conversationId);
        prep("UPDATE conversations SET updated_at = ? WHERE id = ?").run(ts, conversationId);
        const row = prep(`SELECT ${MESSAGE_COLS} FROM messages WHERE id = ?`).get(id);
        return plain<MessageRow>(row);
      });
    },

    list(conversationId) {
      if (typeof conversationId !== "string") return [];
      return prep(`SELECT ${MESSAGE_COLS} FROM messages WHERE conversation_id = ? ORDER BY seq ASC`)
        .all(conversationId)
        .map((r) => plain<MessageRow>(r));
    },

    count(conversationId) {
      if (typeof conversationId !== "string") return 0;
      const row = prep("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(conversationId) as { n: number } | undefined;
      return Number(row?.n ?? 0);
    },
  };

  // ----- findings -------------------------------------------------------------

  const getFinding = (id: string): FindingRow | undefined => {
    const row = prep(`SELECT ${FINDING_COLS} FROM findings WHERE id = ?`).get(id);
    return row ? plain<FindingRow>(row) : undefined;
  };

  const coerceFindingColumn = (col: string, value: unknown): SqlValue => {
    switch (col) {
      case "symptom": {
        const s = textOrNull(value, col);
        if (!s) throw validation("symptom required");
        return s;
      }
      case "cause":
      case "resolution":
      case "circuit":
      case "service_date":
      case "refrigerant":
      case "follow_up":
        return textOrNull(value, col);
      case "measurements_json":
      case "parts_json":
        return jsonOrNull(value, col);
      case "tags":
        return normalizeTags(value);
      case "refrigerant_added_lbs":
      case "refrigerant_recovered_lbs":
        return numberOrNull(value, col, NUM_RULES[col]!);
      case "status": {
        const s = textOrNull(value, col) ?? "resolved";
        if (!FINDING_STATUSES.has(s)) throw validation("status must be open, resolved or monitor");
        return s;
      }
      case "origin": {
        const s = textOrNull(value, col) ?? "tech";
        if (!FINDING_ORIGINS.has(s)) throw validation("origin must be tech or assistant");
        return s;
      }
      case "confirmed":
        return boolToInt(value, col) ?? 1;
      default:
        throw validation(`unknown finding column ${col}`);
    }
  };

  const FINDING_PATCH_COLS = [
    "symptom",
    "cause",
    "resolution",
    "measurements_json",
    "parts_json",
    "tags",
    "circuit",
    "status",
    "service_date",
    "refrigerant",
    "refrigerant_added_lbs",
    "refrigerant_recovered_lbs",
    "follow_up",
    "confirmed",
  ];

  const findings: Repos["findings"] = {
    create(input) {
      if (!input || typeof input !== "object") throw validation("finding input required");
      const src = input as Record<string, unknown>;
      const unitId = requireUnit(src.unit_id);
      let conversationId: string | null = null;
      if (src.conversation_id !== null && src.conversation_id !== undefined && src.conversation_id !== "") {
        if (typeof src.conversation_id !== "string") throw validation("conversation_id must be a string");
        if (!conversationExists(src.conversation_id)) throw new RepoError("not_found", "conversation not found");
        conversationId = src.conversation_id;
      }
      const cols = [
        "symptom",
        "cause",
        "resolution",
        "measurements_json",
        "parts_json",
        "tags",
        "circuit",
        "status",
        "service_date",
        "refrigerant",
        "refrigerant_added_lbs",
        "refrigerant_recovered_lbs",
        "follow_up",
        "origin",
        "confirmed",
      ];
      const values = cols.map((c) => coerceFindingColumn(c, src[c]));
      const id = newId();
      const ts = now();
      prep(
        `INSERT INTO findings (id, unit_id, conversation_id, ${cols.join(", ")}, created_at) ` +
          `VALUES (?, ?, ?, ${cols.map(() => "?").join(", ")}, ?)`,
      ).run(id, unitId, conversationId, ...values, ts);
      return getFinding(id)!;
    },

    get(id) {
      return typeof id === "string" ? getFinding(id) : undefined;
    },

    list(opts = {}) {
      const where: string[] = [];
      const params: SqlValue[] = [];
      const byUnit = typeof opts.unitId === "string" && opts.unitId !== "";
      if (byUnit) {
        where.push("unit_id = ?");
        params.push(opts.unitId as string);
      }
      if (typeof opts.conversationId === "string" && opts.conversationId) {
        where.push("conversation_id = ?");
        params.push(opts.conversationId);
      }
      const order = byUnit
        ? "ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'monitor' THEN 1 ELSE 2 END, created_at DESC, rid DESC"
        : "ORDER BY created_at DESC, rid DESC";
      const sql =
        `SELECT ${FINDING_COLS} FROM findings` + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + ` ${order} LIMIT ?`;
      params.push(clampLimit(opts.limit, 100));
      return prep(sql).all(...params).map((r) => plain<FindingRow>(r));
    },

    update(id, patch) {
      if (typeof id !== "string") return undefined;
      if (!getFinding(id)) return undefined;
      if (!patch || typeof patch !== "object") throw validation("patch required");
      const src = patch as Record<string, unknown>;
      const cols: string[] = [];
      const values: SqlValue[] = [];
      for (const col of FINDING_PATCH_COLS) {
        if (!(col in src)) continue;
        cols.push(col);
        values.push(coerceFindingColumn(col, src[col]));
      }
      if (cols.length === 0) return getFinding(id);
      prep(`UPDATE findings SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...values, id);
      return getFinding(id);
    },

    remove(id) {
      if (typeof id !== "string") return false;
      const res = prep("DELETE FROM findings WHERE id = ?").run(id);
      return Number(res.changes) > 0;
    },
  };

  // ----- search ---------------------------------------------------------------

  interface MessageHitRow {
    id: string;
    conversation_id: string;
    conversation_title: string;
    unit_id: string | null;
    created_at: string;
    snippet: string;
    rank: number;
  }
  interface FindingHitRow {
    id: string;
    conversation_id: string | null;
    conversation_title: string | null;
    unit_id: string | null;
    symptom: string;
    created_at: string;
    snippet: string;
    rank: number;
  }
  interface UnitHitRow {
    id: string;
    manufacturer: string | null;
    model: string | null;
    serial: string | null;
    unit_tag: string | null;
    nickname: string | null;
    site: string | null;
    customer: string | null;
    created_at: string;
  }

  const search: Repos["search"] = (query, opts = {}) => {
    try {
      const match = ftsMatchExpression(query);
      if (!match) return [];
      const tokens = searchTokens(query);
      const limit = clampLimit(opts.limit, 20, 200);
      const unitId = typeof opts.unitId === "string" && opts.unitId !== "" ? opts.unitId : null;
      const site = typeof opts.site === "string" && opts.site.trim() !== "" ? opts.site.trim() : null;
      const since = typeof opts.since === "string" && opts.since.trim() !== "" ? opts.since.trim() : null;
      const hits: SearchHit[] = [];

      // Messages (chat rows only) → conversations (→ units for the site filter).
      {
        const where: string[] = ["messages_fts MATCH ?", "m.kind = 'chat'"];
        const params: SqlValue[] = [match];
        if (unitId) {
          where.push("c.unit_id = ?");
          params.push(unitId);
        }
        if (site) {
          where.push("lower(u.site) = lower(?)");
          params.push(site);
        }
        if (since) {
          where.push("m.created_at >= ?");
          params.push(since);
        }
        params.push(limit);
        const rows = prep(
          "SELECT m.id, m.conversation_id, c.title AS conversation_title, c.unit_id, m.created_at, " +
            "snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet, bm25(messages_fts) AS rank " +
            "FROM messages_fts JOIN messages m ON m.rid = messages_fts.rowid " +
            "JOIN conversations c ON c.id = m.conversation_id " +
            "LEFT JOIN units u ON u.id = c.unit_id " +
            `WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`,
        ).all(...params) as unknown as MessageHitRow[];
        for (const r of rows) {
          hits.push({
            kind: "message",
            id: r.id,
            conversationId: r.conversation_id,
            conversationTitle: r.conversation_title,
            unitId: r.unit_id ?? undefined,
            snippet: r.snippet,
            createdAt: r.created_at,
            rank: Number(r.rank),
          });
        }
      }

      // Findings (symptom/cause/resolution/tags).
      {
        const where: string[] = ["findings_fts MATCH ?"];
        const params: SqlValue[] = [match];
        if (unitId) {
          where.push("f.unit_id = ?");
          params.push(unitId);
        }
        if (site) {
          where.push("lower(u.site) = lower(?)");
          params.push(site);
        }
        if (since) {
          where.push("f.created_at >= ?");
          params.push(since);
        }
        params.push(limit);
        const rows = prep(
          "SELECT f.id, f.conversation_id, c.title AS conversation_title, f.unit_id, f.symptom, f.created_at, " +
            "snippet(findings_fts, -1, '[', ']', '…', 12) AS snippet, bm25(findings_fts) AS rank " +
            "FROM findings_fts JOIN findings f ON f.rid = findings_fts.rowid " +
            "LEFT JOIN conversations c ON c.id = f.conversation_id " +
            "LEFT JOIN units u ON u.id = f.unit_id " +
            `WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`,
        ).all(...params) as unknown as FindingHitRow[];
        for (const r of rows) {
          // The snippet comes from whichever column matched best; prefix the symptom when it is not already in view.
          const bare = r.snippet.replace(/[[\]]/g, "");
          const symptom = r.symptom.length > 80 ? `${r.symptom.slice(0, 79)}…` : r.symptom;
          const snippet = r.symptom.includes(bare.replace(/^…|…$/g, "").trim()) ? r.snippet : `${symptom} — ${r.snippet}`;
          hits.push({
            kind: "finding",
            id: r.id,
            conversationId: r.conversation_id ?? undefined,
            conversationTitle: r.conversation_title ?? undefined,
            unitId: r.unit_id ?? undefined,
            snippet,
            createdAt: r.created_at,
            rank: Number(r.rank),
          });
        }
      }

      // Units: every token must match at least one identity column (LIKE, case-insensitive).
      {
        const cols = ["model", "serial", "unit_tag", "nickname", "site", "customer"];
        const where: string[] = ["archived_at IS NULL"];
        const params: SqlValue[] = [];
        for (const tok of tokens) {
          where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
          const pattern = `%${escapeLike(tok)}%`;
          for (let i = 0; i < cols.length; i++) params.push(pattern);
        }
        if (unitId) {
          where.push("id = ?");
          params.push(unitId);
        }
        if (site) {
          where.push("lower(site) = lower(?)");
          params.push(site);
        }
        if (since) {
          where.push("created_at >= ?");
          params.push(since);
        }
        params.push(limit);
        const rows = prep(
          "SELECT id, manufacturer, model, serial, unit_tag, nickname, site, customer, created_at FROM units " +
            `WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
        ).all(...params) as unknown as UnitHitRow[];
        for (const r of rows) {
          const fields = [r.manufacturer, r.model, r.serial ? `S/N ${r.serial}` : null, r.unit_tag, r.nickname, r.site, r.customer];
          const exact = tokens.some((tok) =>
            [r.model, r.serial, r.unit_tag, r.nickname].some((v) => typeof v === "string" && v.toLowerCase() === tok.toLowerCase()),
          );
          hits.push({
            kind: "unit",
            id: r.id,
            unitId: r.id,
            snippet: highlight(fields.filter((f): f is string => !!f).join(" · "), tokens),
            createdAt: r.created_at,
            // bm25 ranks are negative (lower = better); exact identity matches outrank partial ones.
            rank: exact ? -5 : -1,
          });
        }
      }

      hits.sort((a, b) => a.rank - b.rank || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      return hits.slice(0, limit);
    } catch {
      return [];
    }
  };

  return { units, conversations, messages, findings, search };
}

/** Bracket the first case-insensitive occurrence of each token (mirrors the FTS snippet markers). */
function highlight(text: string, tokens: string[]): string {
  let out = text;
  for (const tok of tokens) {
    const idx = out.toLowerCase().indexOf(tok.toLowerCase());
    if (idx < 0) continue;
    // Skip when the match already sits inside a marker from a previous token.
    const before = out.slice(0, idx);
    if (before.lastIndexOf("[") > before.lastIndexOf("]")) continue;
    out = `${before}[${out.slice(idx, idx + tok.length)}]${out.slice(idx + tok.length)}`;
  }
  return out;
}
