import type { Db } from "./index.ts";
import type { ConversationRow, FindingRow, MessageRow, SearchHit, UnitRow } from "../types.ts";

/** At least one of model / unit_tag / nickname must be non-empty. */
export type UnitInput = Partial<Omit<UnitRow, "id" | "created_at" | "updated_at">>;
export type FindingInput = Partial<Omit<FindingRow, "id" | "created_at" | "symptom">> & { symptom: string };

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
  };
  /** FTS over messages (chat rows only) + findings, plus LIKE over units (model/serial/tag/site/customer). */
  search(query: string, opts?: { unitId?: string; site?: string; since?: string; limit?: number }): SearchHit[];
}

export function createRepos(db: Db): Repos {
  throw new Error("not implemented");
}
