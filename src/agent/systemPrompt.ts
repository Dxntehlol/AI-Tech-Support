import type { ConversationRow, FindingRow, UnitRow } from "../types.ts";

/** Static system prompt (cached). Must be deterministic: no dates, ids, or per-request data. */
export function staticSystemPrompt(opts: { webSearchEnabled: boolean }): string {
  throw new Error("not implemented");
}

/** Second system block: unit record, decoded data, findings, related conversations. */
export function unitContextBlock(unit: UnitRow, findings: FindingRow[], conversations: ConversationRow[], currentConversationId: string): string {
  throw new Error("not implemented");
}
