import type { Request, Response, NextFunction, RequestHandler } from "express";
import { isId } from "../db/index.ts";
import { RepoError } from "../db/repos.ts";
import { describeToolCall } from "../agent/tools.ts";
import type { UserTurnInput } from "../agent/chat.ts";
import { DX_MEASUREMENT_ENUM_CODED_KEYS, DX_MEASUREMENT_NUMERIC_KEYS, METERING_DEVICES, SYSTEM_MODES } from "../knowledge/loader.ts";
import type { ApiError, DisplayMessage, DxMeasurements, MessageRow } from "../types.ts";

// ---------------------------------------------------------------------------
// Errors and the JSON envelope
// ---------------------------------------------------------------------------

/** Error carrying an HTTP status + envelope code. Thrown by routes; mapped by the error handler. */
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, "validation", message);
}

export function notFound(message = "Not found"): HttpError {
  return new HttpError(404, "not_found", message);
}

export function sendError(res: Response, status: number, code: string, message: string): void {
  const body: ApiError = { error: { code, message } };
  res.status(status).json(body);
}

const CODE_BY_STATUS: Record<number, string> = {
  400: "validation",
  401: "auth",
  403: "forbidden",
  404: "not_found",
  405: "validation",
  409: "busy",
  413: "too_large",
  415: "validation",
  500: "internal",
};

/**
 * Map any thrown value to (status, code, message). Body-parser errors (entity.too.large → 413,
 * entity.parse.failed → 400), RepoError (validation → 400, not_found → 404), HttpError as-is,
 * everything else → 500 with a generic message (no stack traces leave the process).
 */
export function describeError(err: unknown): { status: number; code: string; message: string; internal: boolean } {
  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message, internal: false };
  if (err instanceof RepoError) {
    return { status: err.code === "not_found" ? 404 : 400, code: err.code, message: err.message, internal: false };
  }
  if (err && typeof err === "object") {
    const e = err as { type?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; expose?: unknown };
    const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
    if (typeof e.type === "string" && status !== undefined && status >= 400 && status < 500) {
      // body-parser / raw-body errors
      if (e.type === "entity.too.large" || status === 413) {
        return { status: 413, code: "too_large", message: "Request body too large.", internal: false };
      }
      const message =
        e.type === "entity.parse.failed"
          ? "Request body is not valid JSON."
          : typeof e.message === "string"
            ? e.message
            : "Bad request.";
      return { status: 400, code: "validation", message, internal: false };
    }
    if (status !== undefined && status >= 400 && status < 500 && e.expose === true && typeof e.message === "string") {
      return { status, code: CODE_BY_STATUS[status] ?? "validation", message: e.message, internal: false };
    }
  }
  return { status: 500, code: "internal", message: "Internal server error.", internal: true };
}

/** Express error middleware (4 args). Logs internals via `log`; never leaks stacks. */
export function errorHandler(log: (msg: string) => void): (err: unknown, req: Request, res: Response, next: NextFunction) => void {
  return (err, req, res, next) => {
    const d = describeError(err);
    if (d.internal) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log(`${req.method} ${req.originalUrl} -> 500: ${detail}`);
    }
    if (res.headersSent) {
      // SSE or a partially written response: nothing sensible to add, just close it.
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    void next;
    sendError(res, d.status, d.code, d.message);
  };
}

/** JSON 404 for unknown /api paths. */
export const apiNotFound: RequestHandler = (req, res) => {
  sendError(res, 404, "not_found", `No route for ${req.method} ${req.originalUrl.split("?")[0]}`);
};

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export type Body = Record<string, unknown>;

/** The parsed JSON body as a plain object ({} when absent); arrays/primitives → 400. */
export function body(req: Request): Body {
  const b: unknown = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== "object" || Array.isArray(b)) throw badRequest("Request body must be a JSON object.");
  return b as Body;
}

/** A route param that must be a public id (16 lowercase hex). */
export function requireId(value: unknown, name = "id"): string {
  if (!isId(value)) throw badRequest(`${name} must be a 16-character hex id.`);
  return value;
}

/** Optional id field: undefined/null/"" → null; otherwise must be a valid id. */
export function optionalId(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isId(value)) throw badRequest(`${name} must be a 16-character hex id.`);
  return value;
}

/** First value of a query parameter as a trimmed string, or undefined when absent/empty. */
export function queryString(req: Request, name: string): string | undefined {
  const raw = (req.query as Record<string, unknown>)[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s;
}

export function queryNumber(req: Request, name: string): number | undefined {
  const s = queryString(req, name);
  if (s === undefined) return undefined;
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n)) throw badRequest(`${name} must be a number.`);
  return n;
}

export function queryInt(req: Request, name: string, opts: { min?: number; max?: number } = {}): number | undefined {
  const n = queryNumber(req, name);
  if (n === undefined) return undefined;
  const i = Math.floor(n);
  if (opts.min !== undefined && i < opts.min) throw badRequest(`${name} must be ≥ ${opts.min}.`);
  if (opts.max !== undefined && i > opts.max) throw badRequest(`${name} must be ≤ ${opts.max}.`);
  return i;
}

export function queryBool(req: Request, name: string): boolean {
  const s = queryString(req, name);
  return s !== undefined && /^(1|true|yes|on)$/i.test(s);
}

/** Optional string body field: undefined/null → undefined; numbers are stringified; anything else → 400. */
export function optString(v: unknown, name: string, max = 4000): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") throw badRequest(`${name} must be a string.`);
  if (v.length > max) throw badRequest(`${name} must be at most ${max} characters.`);
  return v;
}

export function requireString(v: unknown, name: string, max = 4000): string {
  const s = optString(v, name, max);
  if (s === undefined || s.trim() === "") throw badRequest(`${name} is required.`);
  return s.trim();
}

/** Optional numeric body field (numbers or numeric strings); null/""/undefined → undefined. */
export function optNumber(v: unknown, name: string, range?: { min: number; max: number }): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") n = Number(v.trim().replace(/,/g, ""));
  else throw badRequest(`${name} must be a number.`);
  if (!Number.isFinite(n)) throw badRequest(`${name} must be a number.`);
  if (range && (n < range.min || n > range.max)) throw badRequest(`${name} must be between ${range.min} and ${range.max}.`);
  return n;
}

export function requireNumber(v: unknown, name: string, range?: { min: number; max: number }): number {
  const n = optNumber(v, name, range);
  if (n === undefined) throw badRequest(`${name} is required.`);
  return n;
}

export function optBoolean(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (v === true || v === 1 || v === "1" || v === "true") return true;
  if (v === false || v === 0 || v === "0" || v === "false") return false;
  throw badRequest(`${name} must be true or false.`);
}

export function optEnum<T extends string>(v: unknown, name: string, allowed: readonly T[] | Set<string>): T | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw badRequest(`${name} must be a string.`);
  const ok = allowed instanceof Set ? allowed.has(v) : (allowed as readonly string[]).includes(v);
  if (!ok) throw badRequest(`${name} must be one of: ${[...allowed].join(", ")}.`);
  return v as T;
}

export function safeParseJson(text: string | null | undefined): unknown {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** snake_case → camelCase ("suction_line_temp_f" → "suctionLineTempF"). Keys already camelCase are unchanged. */
export function camelize(key: string): string {
  return key.replace(/_+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Images (POST /api/conversations/:id/messages)
// ---------------------------------------------------------------------------

export const MAX_IMAGES = 4;
/** Base64 characters per image (3.5 MB). */
export const MAX_IMAGE_BASE64_CHARS = Math.floor(3.5 * 1024 * 1024);

type ImageMediaType = NonNullable<UserTurnInput["images"]>[number]["media_type"];

/** Media type from the first bytes of the image (magic numbers), or undefined when unrecognised. */
export function detectImageType(head: Buffer): ImageMediaType | undefined {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 6) {
    const sig = head.subarray(0, 6).toString("latin1");
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

function normalizeMediaType(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (s === "") return undefined;
  return s === "image/jpg" ? "image/jpeg" : s;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validate the `images` field of a chat message: ≤ 4 entries, each { media_type?, data } with data as
 * base64 (a data-URL prefix is stripped), ≤ 3.5 MB of base64, and a JPEG/PNG/WebP/GIF signature that
 * agrees with the declared media type. Throws 400 validation errors.
 */
export function parseImages(raw: unknown): UserTurnInput["images"] {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw badRequest("images must be an array.");
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_IMAGES) throw badRequest(`At most ${MAX_IMAGES} images per message.`);
  const out: NonNullable<UserTurnInput["images"]> = [];
  raw.forEach((item, idx) => {
    const n = idx + 1;
    let data: unknown;
    let declared: string | undefined;
    if (typeof item === "string") data = item;
    else if (item && typeof item === "object") {
      data = (item as Record<string, unknown>).data;
      declared = normalizeMediaType((item as Record<string, unknown>).media_type ?? (item as Record<string, unknown>).mediaType);
    } else throw badRequest(`Image ${n} must be an object with base64 data.`);
    if (typeof data !== "string" || data.trim() === "") throw badRequest(`Image ${n} has no data.`);
    let b64 = data.trim();
    const prefix = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[^,]*)?;base64,/i.exec(b64);
    if (prefix) {
      if (prefix[1] && !declared) declared = normalizeMediaType(prefix[1]);
      b64 = b64.slice(prefix[0].length);
    }
    b64 = b64.replace(/\s+/g, "");
    if (b64.length > MAX_IMAGE_BASE64_CHARS) throw badRequest(`Image ${n} is larger than 3.5 MB (base64); resize it before sending.`);
    if (b64.length < 16 || !BASE64_RE.test(b64)) throw badRequest(`Image ${n} is not valid base64.`);
    const head = Buffer.from(b64.slice(0, 32), "base64");
    const detected = detectImageType(head);
    if (!detected) throw badRequest(`Image ${n} is not a JPEG, PNG, WebP or GIF.`);
    if (declared && declared !== detected) throw badRequest(`Image ${n}: declared media type ${declared} does not match the image data (${detected}).`);
    out.push({ media_type: detected, data: b64 });
  });
  return out;
}

// ---------------------------------------------------------------------------
// DisplayMessage folding (GET /api/conversations/:id) and export stripping
// ---------------------------------------------------------------------------

type Block = Record<string, unknown> & { type?: unknown };

function isBlock(v: unknown): v is Block {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseBlocks(row: MessageRow): Block[] {
  const parsed = safeParseJson(row.content_json);
  return Array.isArray(parsed) ? parsed.filter(isBlock) : [];
}

function blockText(b: Block): string {
  return typeof b.text === "string" ? b.text : "";
}

/** Plain text of a tool_result content (string or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(isBlock).map((b) => (b.type === "text" ? blockText(b) : "")).join("");
  return "";
}

/** `summary` field of a JSON result when present, else the first 200 chars of the text. */
export function summarizeToolResult(content: unknown): string {
  const text = resultText(content);
  const parsed = safeParseJson(text);
  if (parsed && typeof parsed === "object" && typeof (parsed as { summary?: unknown }).summary === "string") {
    return (parsed as { summary: string }).summary;
  }
  return text.length > 200 ? text.slice(0, 200) : text;
}

const PENDING_SUMMARY = "No result recorded (tool interrupted or still running).";

/**
 * Fold stored rows into browser messages: user rows keep text + images; assistant rows carry text and
 * their tool_use blocks joined with the results from the following tool_result row (by id). tool_result
 * rows are not emitted; thinking/redacted_thinking/fallback blocks never reach the browser.
 */
export function foldMessages(rows: MessageRow[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  let lastAssistant: DisplayMessage | null = null;
  for (const row of rows) {
    const blocks = parseBlocks(row);
    if (row.role === "user" && row.kind === "tool_result") {
      if (lastAssistant?.tools) {
        for (const b of blocks) {
          if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
          const tool = lastAssistant.tools.find((t) => t.id === b.tool_use_id);
          if (!tool) continue;
          tool.ok = b.is_error !== true;
          tool.summary = summarizeToolResult(b.content);
        }
      }
      continue;
    }
    if (row.role === "user") {
      const images = blocks
        .filter((b) => b.type === "image" && isBlock(b.source) && b.source.type === "base64" && typeof b.source.data === "string")
        .map((b) => {
          const src = b.source as Record<string, unknown>;
          return { media_type: String(src.media_type ?? "image/jpeg"), data: String(src.data) };
        });
      const text = row.text || blocks.filter((b) => b.type === "text").map(blockText).filter(Boolean).join("\n");
      const msg: DisplayMessage = { id: row.id, seq: row.seq, role: "user", createdAt: row.created_at, text };
      if (images.length) msg.images = images;
      out.push(msg);
      lastAssistant = null;
      continue;
    }
    // assistant row
    const tools: NonNullable<DisplayMessage["tools"]> = [];
    const serverResults = new Map<string, Block>();
    for (const b of blocks) {
      if (/_tool_result$/.test(String(b.type)) && typeof b.tool_use_id === "string") serverResults.set(b.tool_use_id, b);
    }
    for (const b of blocks) {
      if (b.type === "tool_use" && typeof b.id === "string") {
        const name = typeof b.name === "string" ? b.name : "tool";
        tools.push({ id: b.id, name, input: b.input, label: describeToolCall(name, b.input), ok: false, summary: PENDING_SUMMARY });
      } else if (b.type === "server_tool_use" && typeof b.id === "string") {
        const name = typeof b.name === "string" ? b.name : "web_search";
        const result = serverResults.get(b.id);
        const input = isBlock(b.input) ? b.input : {};
        const query = typeof input.query === "string" ? input.query : "";
        const label = name === "web_search" ? `Web search${query ? `: ${query.length > 60 ? `${query.slice(0, 59)}…` : query}` : ""}` : describeToolCall(name, b.input);
        let ok = false;
        let summary = PENDING_SUMMARY;
        if (result) {
          const content = result.content;
          if (isBlock(content) && content.type === "web_search_tool_result_error") {
            ok = false;
            summary = `Web search failed: ${String(content.error_code ?? "error")}`;
          } else {
            ok = true;
            const n = Array.isArray(content) ? content.length : 0;
            summary = n ? `${n} result${n === 1 ? "" : "s"}` : "completed";
          }
        }
        tools.push({ id: b.id, name, input: b.input, label, ok, summary });
      }
    }
    const text = row.text || blocks.filter((b) => b.type === "text").map(blockText).filter(Boolean).join("\n");
    const msg: DisplayMessage = { id: row.id, seq: row.seq, role: "assistant", createdAt: row.created_at, text };
    if (tools.length) msg.tools = tools;
    out.push(msg);
    lastAssistant = msg;
  }
  return out;
}

/** Content blocks of a row with image data replaced by { type: "image_omitted" } (export). */
export function stripImageBlocks(row: MessageRow): unknown[] {
  return parseBlocks(row).map((b) => (b.type === "image" ? { type: "image_omitted" } : b));
}

// ---------------------------------------------------------------------------
// DxMeasurements parsing (snake_case or camelCase)
// ---------------------------------------------------------------------------

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

/**
 * Build DxMeasurements from a request body whose keys may be snake_case (tool style) or camelCase (UI
 * style). Numbers may arrive as numeric strings; blanks are dropped; enums are validated (400).
 * `refrigerant` is required unless `requireRefrigerant` is false; meteringDevice defaults to "unknown",
 * mode to "ac_cooling".
 */
export function parseMeasurements(src: Body, opts: { requireRefrigerant?: boolean } = {}): DxMeasurements {
  const v: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(src)) v[camelize(k)] = val;
  const refrigerant = optString(v.refrigerant, "refrigerant", 40)?.trim() ?? "";
  if (opts.requireRefrigerant !== false && refrigerant === "") throw badRequest("refrigerant is required.");
  const m: Record<string, unknown> = {
    refrigerant,
    meteringDevice: optEnum(v.meteringDevice, "metering_device", METERING_DEVICES) ?? "unknown",
    mode: optEnum(v.mode, "mode", SYSTEM_MODES) ?? "ac_cooling",
  };
  for (const key of DX_MEASUREMENT_NUMERIC_KEYS) {
    const n = optNumber(v[key], key, dxRange(key));
    if (n !== undefined) m[key] = n;
  }
  for (const key of DX_MEASUREMENT_ENUM_CODED_KEYS) {
    const e = DX_ENUMS[key];
    if (e === "boolean") {
      const b = optBoolean(v[key], key);
      if (b !== undefined) m[key] = b;
    } else {
      const s = optEnum(v[key], key, e);
      if (s !== undefined) m[key] = s;
    }
  }
  const circuit = optString(v.circuit, "circuit", 20)?.trim();
  if (circuit) m.circuit = circuit;
  const tier = optEnum(v.efficiencyTier, "efficiency_tier", ["standard", "high"]);
  if (tier) m.efficiencyTier = tier;
  const notes = optString(v.notes, "notes", 2000)?.trim();
  if (notes) m.notes = notes;
  return m as unknown as DxMeasurements;
}
