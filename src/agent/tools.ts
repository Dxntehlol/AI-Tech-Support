import type Anthropic from "@anthropic-ai/sdk";
import type { Repos } from "../db/repos.ts";
import type { KnowledgeBase } from "../types.ts";

export interface ToolContext {
  kb: KnowledgeBase;
  repos: Repos;
  conversationId: string;
  unitId: string | null;
  now?: Date;
}

export interface ToolOutcome {
  /** Text returned to the model as the tool_result content. */
  content: string;
  isError?: boolean;
  /** Short human label for the UI chip, e.g. "PT: R-410A 118 psig → 40 °F". */
  summary: string;
  /** Side effects the loop should apply (e.g. conversation now attached to a unit). */
  attachUnitId?: string;
}

/** Tool definitions sent to the API (custom tools only; server tools are added by the loop). */
export function toolDefinitions(): Anthropic.Beta.BetaTool[] {
  throw new Error("not implemented");
}

/** Human-readable label for a tool call before it runs (used by the UI). */
export function describeToolCall(name: string, input: unknown): string {
  throw new Error("not implemented");
}

/** Validate input against the tool's schema and execute. Never throws; errors become isError results. */
export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  throw new Error("not implemented");
}
