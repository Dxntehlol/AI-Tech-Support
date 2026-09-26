import type { DxDerived, DxMeasurements, DxResult, KnowledgeBase } from "../types.ts";

/** Target superheat for fixed-orifice systems from indoor WB / outdoor DB (interpolated). */
export function targetSuperheatFixedOrifice(kb: KnowledgeBase, indoorWbF: number, outdoorDbF: number): number | undefined {
  throw new Error("not implemented");
}

/** Compute all derived metrics the rules can reference. */
export function deriveMetrics(kb: KnowledgeBase, m: DxMeasurements): DxDerived {
  throw new Error("not implemented");
}

/** Full diagnosis: derived metrics + ranked rule findings + missing measurements + summary. */
export function diagnose(kb: KnowledgeBase, m: DxMeasurements): DxResult {
  throw new Error("not implemented");
}
