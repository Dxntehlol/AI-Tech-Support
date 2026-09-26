import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesStreamer } from "./client.ts";
import type { Repos } from "../db/repos.ts";
import type { AppConfig, ChatEvent, KnowledgeBase, MessageRow } from "../types.ts";

export interface ChatDeps {
  client: MessagesStreamer;
  config: AppConfig;
  kb: KnowledgeBase;
  repos: Repos;
  log?: (msg: string) => void;
}

export interface UserTurnInput {
  text: string;
  images?: { media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string }[];
}

/**
 * Convert a persisted assistant row's content blocks into API params for replay.
 * Rules (see DESIGN.md "Replay"): drop `fallback` blocks and every thinking/redacted_thinking/tool_use
 * (and server_tool_use lacking a result) block that precedes the last fallback block; keep text blocks;
 * everything after the last fallback block is replayed verbatim (thinking blocks included).
 */
export function toApiContent(blocks: unknown[]): Anthropic.Beta.BetaContentBlockParam[] {
  throw new Error("not implemented");
}

/**
 * Map stored rows to API messages. Applies toApiContent to assistant rows, replaces image blocks in user
 * rows older than `replayImageWindow` user turns with a text placeholder, and repairs a dangling
 * tool_use (assistant row with tool_use blocks not followed by matching tool_result blocks) by
 * persisting a synthetic tool_result row (is_error) — see DESIGN.md "History repair".
 */
export function buildApiMessages(rows: MessageRow[], opts: { replayImageWindow: number }): Anthropic.Beta.BetaMessageParam[] {
  throw new Error("not implemented");
}

/** True while a turn is in flight for the conversation (module-level map). */
export function isTurnRunning(conversationId: string): boolean {
  throw new Error("not implemented");
}

/** Abort the in-flight turn for a conversation (user pressed Stop). Returns false if none. */
export function stopTurn(conversationId: string): boolean {
  throw new Error("not implemented");
}

/** Number of turns in flight (used by graceful shutdown). */
export function turnsInFlight(): number {
  throw new Error("not implemented");
}

/**
 * Run one user turn: persist the user message, stream the assistant response with tool use,
 * persist every assistant/tool-result message verbatim, emit ChatEvents as they happen.
 * Resolves when the turn is complete (after emitting exactly one terminal `done` or `error`).
 * Never throws. A client disconnect does not abort the turn (emit becomes a no-op); only stopTurn() aborts.
 */
export async function runTurn(deps: ChatDeps, conversationId: string, input: UserTurnInput, emit: (e: ChatEvent) => void): Promise<void> {
  throw new Error("not implemented");
}
