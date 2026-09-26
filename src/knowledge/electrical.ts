import type { ElectricalCalcRequest, ElectricalCalcResult, ElectricalComponent, ElectricalProcedure, KnowledgeBase } from "../types.ts";

export function calcElectrical(req: ElectricalCalcRequest): ElectricalCalcResult {
  throw new Error("not implemented");
}

/** Fuzzy lookup by component id/name/alias. */
export function findComponent(kb: KnowledgeBase, query: string): ElectricalComponent[] {
  throw new Error("not implemented");
}

/** Fuzzy lookup by symptom text. */
export function findProcedure(kb: KnowledgeBase, query: string): ElectricalProcedure[] {
  throw new Error("not implemented");
}

/** Reference topics (voltage imbalance, motor nameplates, rotation...). */
export function findReference(kb: KnowledgeBase, query: string): { topic: string; content: string[] }[] {
  throw new Error("not implemented");
}
