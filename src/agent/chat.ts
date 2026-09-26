import Anthropic from "@anthropic-ai/sdk";
import type { MessagesStreamer, StreamLike, StreamParams } from "./client.ts";
import type { Repos } from "../db/repos.ts";
import type { AppConfig, ChatEvent, KnowledgeBase, MessageRow } from "../types.ts";
import { staticSystemPrompt, unitContextBlock } from "./systemPrompt.ts";
import { describeToolCall, executeTool, toolDefinitions, type ToolContext, type ToolOutcome } from "./tools.ts";

export interface ChatDeps {
  client: MessagesStreamer;
  config: AppConfig;
  kb: KnowledgeBase;
  repos: Repos;
  log?: (msg: string) => void;
  /** Clock for dates in tool results / unit context (tests inject a fixed one). */
  now?: () => Date;
}

export interface UserTurnInput {
  text: string;
  images?: { media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string }[];
}

/** Text placeholder that replaces image blocks older than `replayImageWindow` user turns. */
export const IMAGE_PLACEHOLDER = "[photo omitted from context: see earlier message]";
/** Message persisted for a dangling tool_use after a restart (DESIGN.md "History repair"). */
export const INTERRUPTED_TOOL_MESSAGE = "Tool execution was interrupted (server restart). Re-run the tool if still needed.";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const MAX_PAUSE_CONTINUATIONS = 3;
export const SLOW_TOOL_NOTICE_MS = 5000;
export const MAX_TOKENS = 16000;

// ---------------------------------------------------------------------------
// Process-wide state
// ---------------------------------------------------------------------------

const running = new Map<string, AbortController>();

/** Cleared the first time the API rejects the server-side fallback beta; later turns skip it. */
let fallbacksSupported = true;

export function isFallbacksSupported(): boolean {
  return fallbacksSupported;
}

/** Tests reset the flag between cases. */
export function setFallbacksSupported(value: boolean): void {
  fallbacksSupported = value;
}

/** True while a turn is in flight for the conversation (module-level map). */
export function isTurnRunning(conversationId: string): boolean {
  return running.has(conversationId);
}

/** Abort the in-flight turn for a conversation (user pressed Stop). Returns false if none. */
export function stopTurn(conversationId: string): boolean {
  const ac = running.get(conversationId);
  if (!ac) return false;
  ac.abort();
  return true;
}

/** Number of turns in flight (used by graceful shutdown). */
export function turnsInFlight(): number {
  return running.size;
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

type Block = Record<string, unknown> & { type?: unknown };

function isBlock(v: unknown): v is Block {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function blockType(b: unknown): string {
  return isBlock(b) && typeof b.type === "string" ? b.type : "";
}

function parseBlocks(row: MessageRow): unknown[] {
  try {
    const parsed = JSON.parse(row.content_json) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Index of the last `fallback` block, or -1. */
function lastFallbackIndex(blocks: unknown[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) if (blockType(blocks[i]) === "fallback") return i;
  return -1;
}

/** Client-tool `tool_use` blocks the loop must execute: everything after the last fallback block. */
export function executableToolUses(blocks: unknown[]): Anthropic.Beta.BetaToolUseBlock[] {
  const start = lastFallbackIndex(blocks) + 1;
  return blocks.slice(start).filter((b): b is Anthropic.Beta.BetaToolUseBlock => blockType(b) === "tool_use");
}

/**
 * Convert a persisted assistant row's content blocks into API params for replay.
 * Rules (see DESIGN.md "Replay"): drop `fallback` blocks and every thinking/redacted_thinking/tool_use
 * (and server_tool_use lacking a result) block that precedes the last fallback block; keep text blocks;
 * everything after the last fallback block is replayed verbatim (thinking blocks included).
 */
export function toApiContent(blocks: unknown[]): Anthropic.Beta.BetaContentBlockParam[] {
  const cut = lastFallbackIndex(blocks);
  const out: unknown[] = [];
  if (cut >= 0) {
    const before = blocks.slice(0, cut);
    const resultIds = new Set<string>();
    for (const b of before) {
      if (isBlock(b) && /_tool_result$/.test(blockType(b)) && typeof b.tool_use_id === "string") resultIds.add(b.tool_use_id);
    }
    const keptServerToolIds = new Set<string>();
    for (const b of before) {
      if (!isBlock(b)) continue;
      const t = blockType(b);
      if (t === "text") {
        if (typeof b.text === "string" && b.text.length > 0) out.push(b);
      } else if (t === "server_tool_use") {
        if (typeof b.id === "string" && resultIds.has(b.id)) {
          keptServerToolIds.add(b.id);
          out.push(b);
        }
      } else if (/_tool_result$/.test(t)) {
        if (typeof b.tool_use_id === "string" && keptServerToolIds.has(b.tool_use_id)) out.push(b);
      }
      // thinking / redacted_thinking / tool_use / fallback / anything else before the cut: dropped
    }
  }
  for (const b of blocks.slice(cut + 1)) {
    if (!isBlock(b)) continue;
    const t = blockType(b);
    if (t === "fallback") continue;
    if (t === "text" && !(typeof b.text === "string" && b.text.length > 0)) continue;
    out.push(b);
  }
  return out as Anthropic.Beta.BetaContentBlockParam[];
}

function toolUseIds(content: Anthropic.Beta.BetaContentBlockParam[]): string[] {
  return content.filter((b) => b.type === "tool_use").map((b) => (b as Anthropic.Beta.BetaToolUseBlockParam).id);
}

function syntheticResult(id: string): Anthropic.Beta.BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: id, is_error: true, content: INTERRUPTED_TOOL_MESSAGE };
}

/**
 * Map stored rows to API messages. Applies toApiContent to assistant rows, replaces image blocks in user
 * rows older than `replayImageWindow` user turns with a text placeholder, and repairs a dangling
 * tool_use (assistant row with tool_use blocks not followed by matching tool_result blocks) by
 * persisting a synthetic tool_result row (is_error) — see DESIGN.md "History repair".
 * (runTurn persists the repair row before calling this; here an unmatched tool_use still gets an in-memory
 * synthetic result so the request is always well-formed. `kind` is ignored for the API; roles are preserved.)
 */
export function buildApiMessages(rows: MessageRow[], opts: { replayImageWindow: number }): Anthropic.Beta.BetaMessageParam[] {
  const window = Math.max(0, Math.floor(opts.replayImageWindow || 0));
  const userChatRows = rows.filter((r) => r.role === "user" && r.kind === "chat").length;
  let userTurnIndex = 0; // 0-based from the oldest; age = userChatRows - 1 - index
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  let pendingToolUseIds: string[] = [];

  for (const row of rows) {
    const blocks = parseBlocks(row);
    if (row.role === "assistant") {
      if (pendingToolUseIds.length) {
        out.push({ role: "user", content: pendingToolUseIds.map(syntheticResult) });
        pendingToolUseIds = [];
      }
      const content = toApiContent(blocks);
      if (content.length === 0) continue;
      out.push({ role: "assistant", content });
      pendingToolUseIds = toolUseIds(content);
      continue;
    }

    // user rows
    let content: unknown[] = blocks.filter(isBlock);
    if (row.kind === "chat") {
      const age = userChatRows - 1 - userTurnIndex;
      userTurnIndex += 1;
      if (window > 0 && age >= window && content.some((b) => blockType(b) === "image")) {
        let replaced = false;
        const next: unknown[] = [];
        for (const b of content) {
          if (blockType(b) === "image") {
            if (!replaced) {
              next.push({ type: "text", text: IMAGE_PLACEHOLDER });
              replaced = true;
            }
          } else next.push(b);
        }
        content = next;
      }
      if (pendingToolUseIds.length) {
        // tool results must directly follow the tool_use turn: prepend synthetic ones in their own message
        out.push({ role: "user", content: pendingToolUseIds.map(syntheticResult) });
        pendingToolUseIds = [];
      }
    } else {
      // tool_result row: keep only results that answer the preceding assistant's tool_use blocks
      const pending = new Set(pendingToolUseIds);
      const results = content.filter((b) => blockType(b) === "tool_result" && typeof (b as Block).tool_use_id === "string" && pending.has((b as Block).tool_use_id as string));
      const answered = new Set(results.map((b) => (b as Block).tool_use_id as string));
      const missing = pendingToolUseIds.filter((id) => !answered.has(id));
      content = [...results, ...missing.map(syntheticResult)];
      pendingToolUseIds = [];
    }
    if (content.length === 0) continue;
    out.push({ role: "user", content: content as Anthropic.Beta.BetaContentBlockParam[] });
  }
  if (pendingToolUseIds.length) {
    // History ends with a dangling tool_use (runTurn repairs and persists this case before building).
    out.push({ role: "user", content: pendingToolUseIds.map(syntheticResult) });
  }
  return out;
}

function textOfBlocks(blocks: unknown[]): string {
  return blocks
    .filter((b) => blockType(b) === "text")
    .map((b) => String((b as Block).text ?? ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

function titleFrom(text: string, hasImages: boolean): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (t) return t.length > 60 ? t.slice(0, 60).trimEnd() : t;
  if (hasImages) return "Photo of nameplate";
  return null;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

type Terminal = Extract<ChatEvent, { type: "error" }>;

function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (err instanceof Anthropic.APIUserAbortError) return true;
  return err instanceof Error && err.name === "AbortError";
}

function mapApiError(err: unknown): Terminal {
  if (err instanceof Anthropic.AuthenticationError) {
    return { type: "error", code: "auth", message: "Anthropic API key missing or invalid — set ANTHROPIC_API_KEY" };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { type: "error", code: "rate_limit", message: `Rate limited by the Anthropic API — wait a moment and retry (${err.message})` };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { type: "error", code: "network", message: `Could not reach the Anthropic API (${err.message})` };
  }
  if (err instanceof Anthropic.BadRequestError && /context|too long|exceed/i.test(err.message)) {
    return { type: "error", code: "context_full", message: "This conversation no longer fits in the model's context window — start a new conversation on this unit." };
  }
  if (err instanceof Anthropic.APIError) {
    return { type: "error", code: "api_error", message: `Anthropic API error${err.status ? ` ${err.status}` : ""}: ${err.message}` };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { type: "error", code: "internal", message: `Internal error: ${message}` };
}

// ---------------------------------------------------------------------------
// runTurn
// ---------------------------------------------------------------------------

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * Run one user turn: persist the user message, stream the assistant response with tool use,
 * persist every assistant/tool-result message verbatim, emit ChatEvents as they happen.
 * Resolves when the turn is complete (after emitting exactly one terminal `done` or `error`).
 * Never throws. A client disconnect does not abort the turn (emit becomes a no-op); only stopTurn() aborts.
 */
export async function runTurn(deps: ChatDeps, conversationId: string, input: UserTurnInput, emit: (e: ChatEvent) => void): Promise<void> {
  const log = deps.log ?? (() => {});
  let terminated = false;
  const send = (e: ChatEvent): void => {
    if (terminated) return;
    if (e.type === "done" || e.type === "error") terminated = true;
    try {
      emit(e);
    } catch (err) {
      log(`emit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 1. busy / not_found (synchronously, before any await, so a concurrent call sees the lock)
  if (running.has(conversationId)) {
    send({ type: "error", code: "busy", message: "A response is already in progress for this conversation." });
    return;
  }
  const conversation = deps.repos.conversations.get(conversationId);
  if (!conversation) {
    send({ type: "error", code: "not_found", message: "Conversation not found." });
    return;
  }
  const ac = new AbortController();
  running.set(conversationId, ac);
  try {
    await runTurnInner(deps, conversationId, input, send, ac, log);
  } catch (err) {
    log(`runTurn crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    send({ type: "error", code: "internal", message: `Internal error: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    running.delete(conversationId);
    if (!terminated) send({ type: "error", code: "internal", message: "The turn ended without a result." });
  }
}

async function runTurnInner(
  deps: ChatDeps,
  conversationId: string,
  input: UserTurnInput,
  send: (e: ChatEvent) => void,
  ac: AbortController,
  log: (msg: string) => void,
): Promise<void> {
  const { repos, config, kb } = deps;
  const now = deps.now ?? (() => new Date());
  const messageIds: string[] = [];

  // 2. History repair
  const existing = repos.messages.list(conversationId);
  const last = existing[existing.length - 1];
  if (last && last.role === "assistant") {
    const dangling = executableToolUses(parseBlocks(last));
    if (dangling.length) {
      const repaired = repos.messages.append(conversationId, "user", dangling.map((b) => syntheticResult(b.id)), "", "tool_result");
      messageIds.push(repaired.id);
      log(`history repair: ${dangling.length} dangling tool_use in ${conversationId}`);
    }
  }

  // 3. Persist the user row
  const text = typeof input.text === "string" ? input.text : "";
  const images = Array.isArray(input.images) ? input.images.filter((i) => i && typeof i.data === "string" && i.data.length > 0) : [];
  if (text.trim() === "" && images.length === 0) {
    send({ type: "error", code: "validation", message: "Message text or at least one image is required." });
    return;
  }
  const userContent: Anthropic.Beta.BetaContentBlockParam[] = [
    ...images.map((img): Anthropic.Beta.BetaImageBlockParam => ({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } })),
    ...(text.trim() !== "" ? [{ type: "text", text } as Anthropic.Beta.BetaTextBlockParam] : []),
  ];
  const userRow = repos.messages.append(conversationId, "user", userContent, text, "chat");
  messageIds.push(userRow.id);
  const conv = repos.conversations.get(conversationId);
  if (conv && conv.title === "New conversation") {
    const title = titleFrom(text, images.length > 0);
    if (title) repos.conversations.update(conversationId, { title });
  }

  // 4–5. Stream / tool loop
  const customTools = toolDefinitions();
  if (customTools.length) customTools[customTools.length - 1] = { ...customTools[customTools.length - 1]!, cache_control: { type: "ephemeral" } };
  const tools: Anthropic.Beta.BetaToolUnion[] = [...customTools];
  if (config.enableWebSearch) tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
  const staticBlock: Anthropic.Beta.BetaTextBlockParam = {
    type: "text",
    text: staticSystemPrompt({ webSearchEnabled: config.enableWebSearch }),
    cache_control: { type: "ephemeral" },
  };

  const buildSystem = (): Anthropic.Beta.BetaTextBlockParam[] => {
    const c = repos.conversations.get(conversationId);
    const unit = c?.unit_id ? repos.units.get(c.unit_id) : undefined;
    if (!unit) return [staticBlock];
    const block = unitContextBlock(unit, repos.findings.list({ unitId: unit.id, limit: 200 }), repos.conversations.list({ unitId: unit.id, limit: 50 }), conversationId, now());
    return [staticBlock, { type: "text", text: block }];
  };

  const buildParams = (withFallbacks: boolean): StreamParams => {
    const base = {
      model: config.claudeModel,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: config.claudeEffort },
      system: buildSystem(),
      tools,
      messages: buildApiMessages(repos.messages.list(conversationId), { replayImageWindow: config.replayImageWindow }),
    };
    const params = withFallbacks ? { ...base, betas: [FALLBACK_BETA], fallbacks: "default" } : base;
    return params as unknown as StreamParams;
  };

  const usage: Usage = { input: 0, output: 0, cacheRead: 0 };
  let model: string | undefined;
  let requestIndex = 0;
  let continuations = 0;

  for (let iteration = 0; ; iteration++) {
    if (ac.signal.aborted) {
      send({ type: "error", code: "aborted", message: "Stopped." });
      return;
    }
    if (iteration >= config.maxToolIterations) {
      send({ type: "error", code: "iteration_cap", message: `Stopped after ${config.maxToolIterations} tool iterations — send a follow-up to continue.` });
      return;
    }

    // --- one request (with the one-time fallback retry on the first request of the turn) ---
    let final: Anthropic.Beta.BetaMessage;
    try {
      final = await streamOnce(deps, buildParams, requestIndex === 0, ac.signal, send, log);
    } catch (err) {
      if (isAbort(err, ac.signal)) {
        send({ type: "error", code: "aborted", message: "Stopped." });
        return;
      }
      const mapped = mapApiError(err);
      log(`turn ${conversationId} failed: ${mapped.code} ${mapped.message}`);
      send(mapped);
      return;
    } finally {
      requestIndex += 1;
    }

    // --- bookkeeping ---
    usage.input += final.usage?.input_tokens ?? 0;
    usage.output += final.usage?.output_tokens ?? 0;
    usage.cacheRead += final.usage?.cache_read_input_tokens ?? 0;
    model = final.model ?? model;
    log(`turn ${conversationId} request ${requestIndex}: stop=${final.stop_reason} in=${final.usage?.input_tokens ?? 0} out=${final.usage?.output_tokens ?? 0} cache_read_input_tokens=${final.usage?.cache_read_input_tokens ?? 0}`);
    const content = Array.isArray(final.content) ? final.content : [];
    const serverToolUses = content.filter((b) => b.type === "server_tool_use").length;
    if (serverToolUses > 0) send({ type: "notice", text: `Web search ran (${serverToolUses} quer${serverToolUses === 1 ? "y" : "ies"}).` });
    const fallbackBlock = content.find((b): b is Anthropic.Beta.BetaFallbackBlock => b.type === "fallback");
    if (fallbackBlock) send({ type: "notice", text: `Answer routed to fallback model ${fallbackBlock.to?.model ?? "(unknown)"}.` });
    const toolUses = executableToolUses(content);
    const assistantText = textOfBlocks(content);
    const doneEvent = (): ChatEvent => ({ type: "done", conversationId, messageIds, model, usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead } });
    const persistAssistant = (): void => {
      const row = repos.messages.append(conversationId, "assistant", content, assistantText, "chat");
      messageIds.push(row.id);
    };

    // --- stop reasons ---
    switch (final.stop_reason) {
      case "refusal": {
        const explanation = final.stop_details?.explanation;
        send({ type: "error", code: "refusal", message: explanation ? `The model declined: ${explanation}` : "The model declined to answer this request." });
        return;
      }
      case "max_tokens":
      case "model_context_window_exceeded": {
        if (toolUses.length) {
          send({ type: "error", code: "max_tokens", message: "The response hit the output limit in the middle of a tool call — ask again with a narrower question." });
          return;
        }
        if (final.stop_reason === "model_context_window_exceeded" && assistantText.trim() === "") {
          send({ type: "error", code: "context_full", message: "This conversation no longer fits in the model's context window — start a new conversation on this unit." });
          return;
        }
        persistAssistant();
        send({ type: "notice", text: "Response was cut off" });
        send(doneEvent());
        return;
      }
      case "pause_turn": {
        persistAssistant();
        if (continuations >= MAX_PAUSE_CONTINUATIONS) {
          send({ type: "notice", text: `Stopped after ${MAX_PAUSE_CONTINUATIONS} server-side continuations — ask again to keep going.` });
          send(doneEvent());
          return;
        }
        continuations += 1;
        continue; // re-send with the assistant row last
      }
      case "tool_use": {
        persistAssistant();
        if (toolUses.length === 0) {
          // tool_use with nothing executable (e.g. everything before a fallback block): treat as finished
          send(doneEvent());
          return;
        }
        const results = await runTools(toolUses, deps, conversationId, send, log);
        const resultRow = repos.messages.append(conversationId, "user", results, "", "tool_result");
        messageIds.push(resultRow.id);
        continue;
      }
      case "end_turn":
      case "stop_sequence":
      case "compaction":
      default: {
        persistAssistant();
        send(doneEvent());
        return;
      }
    }
  }
}

/** Stream one request. Handles the one-time "fallback unsupported" retry for the first request of a turn. */
async function streamOnce(
  deps: ChatDeps,
  buildParams: (withFallbacks: boolean) => StreamParams,
  firstRequest: boolean,
  signal: AbortSignal,
  send: (e: ChatEvent) => void,
  log: (msg: string) => void,
): Promise<Anthropic.Beta.BetaMessage> {
  const wantFallbacks = deps.config.claudeFallbacks === "default" && fallbacksSupported;
  const attempt = (withFallbacks: boolean): Promise<Anthropic.Beta.BetaMessage> => {
    const stream: StreamLike = deps.client.stream(buildParams(withFallbacks), { signal });
    stream.on("text", (delta) => {
      if (delta) send({ type: "delta", text: delta });
    });
    return stream.finalMessage();
  };
  try {
    return await attempt(wantFallbacks);
  } catch (err) {
    if (firstRequest && wantFallbacks && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message) && !signal.aborted) {
      fallbacksSupported = false;
      log(`server-side fallbacks rejected by the API (${err.message}); disabled for this process`);
      send({ type: "notice", text: "Fallback routing unavailable; continuing without it." });
      return await attempt(false);
    }
    throw err;
  }
}

/** Execute tool_use blocks in order, emitting tool_start / tool_end and applying side effects. */
async function runTools(
  toolUses: Anthropic.Beta.BetaToolUseBlock[],
  deps: ChatDeps,
  conversationId: string,
  send: (e: ChatEvent) => void,
  log: (msg: string) => void,
): Promise<Anthropic.Beta.BetaToolResultBlockParam[]> {
  const { repos, kb } = deps;
  const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
  for (const block of toolUses) {
    const label = describeToolCall(block.name, block.input);
    send({ type: "tool_start", id: block.id, name: block.name, input: block.input, label });
    const ctx: ToolContext = {
      kb,
      repos,
      conversationId,
      unitId: repos.conversations.get(conversationId)?.unit_id ?? null,
      now: (deps.now ?? (() => new Date()))(),
    };
    const started = Date.now();
    const slowTimer = setTimeout(() => send({ type: "notice", text: `Still working on ${label}…` }), SLOW_TOOL_NOTICE_MS);
    slowTimer.unref?.();
    let outcome: ToolOutcome;
    try {
      outcome = await executeTool(block.name, block.input, ctx);
    } catch (err) {
      // executeTool never throws by contract; belt and braces
      const message = err instanceof Error ? err.message : String(err);
      outcome = { content: JSON.stringify({ error: message }), isError: true, summary: `${block.name} failed: ${message}` };
    } finally {
      clearTimeout(slowTimer);
    }
    const elapsed = Date.now() - started;
    if (elapsed > SLOW_TOOL_NOTICE_MS) log(`slow tool ${block.name}: ${elapsed} ms`);
    results.push({ type: "tool_result", tool_use_id: block.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
    send({ type: "tool_end", id: block.id, name: block.name, ok: !outcome.isError, summary: outcome.summary });

    // side effects
    try {
      if (outcome.attachUnitId) {
        repos.conversations.update(conversationId, { unit_id: outcome.attachUnitId });
        send({ type: "unit_attached", unitId: outcome.attachUnitId });
      }
      const patch: { title?: string; summary?: string } = {};
      if (outcome.setTitle) patch.title = outcome.setTitle;
      if (outcome.setSummary) patch.summary = outcome.setSummary;
      if (patch.title || patch.summary) repos.conversations.update(conversationId, patch);
    } catch (err) {
      log(`side effect for ${block.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return results;
}
