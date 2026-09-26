import type { MessagesStreamer } from "./client.ts";
import type { Repos } from "../db/repos.ts";
import type { AppConfig, ChatEvent, KnowledgeBase } from "../types.ts";

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
 * Run one user turn: persist the user message, stream the assistant response with tool use,
 * persist every assistant/tool-result message verbatim, emit ChatEvents as they happen.
 * Resolves when the turn is complete (after emitting `done` or `error`). Never throws.
 */
export async function runTurn(deps: ChatDeps, conversationId: string, input: UserTurnInput, emit: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  throw new Error("not implemented");
}
