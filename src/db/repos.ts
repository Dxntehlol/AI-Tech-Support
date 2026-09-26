import type { Db } from "./index.ts";
import type { ConversationRow, FindingRow, MessageRow, SearchHit, UnitRow } from "../types.ts";

export type UnitInput = Partial<Omit<UnitRow, "id" | "created_at" | "updated_at">> & { model: string };
export type FindingInput = Omit<FindingRow, "id" | "created_at">;

export interface Repos {
  units: {
    create(input: UnitInput): UnitRow;
    get(id: string): UnitRow | undefined;
    findByModelSerial(model: string, serial?: string | null): UnitRow | undefined;
    list(q?: string, limit?: number): UnitRow[];
    update(id: string, patch: Partial<UnitInput>): UnitRow | undefined;
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
    append(conversationId: string, role: MessageRow["role"], content: unknown[], text: string): MessageRow;
    list(conversationId: string): MessageRow[];
    count(conversationId: string): number;
  };
  findings: {
    create(input: FindingInput): FindingRow;
    get(id: string): FindingRow | undefined;
    list(opts?: { unitId?: string; conversationId?: string; limit?: number }): FindingRow[];
    remove(id: string): boolean;
  };
  search(query: string, opts?: { unitId?: string; limit?: number }): SearchHit[];
}

export function createRepos(db: Db): Repos {
  throw new Error("not implemented");
}
