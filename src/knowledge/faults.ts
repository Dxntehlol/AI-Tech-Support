import type { ControlPlatform, FaultCode, KnowledgeBase } from "../types.ts";

export interface FaultHit {
  manufacturerId: string;
  manufacturer: string;
  platform: ControlPlatform;
  fault: FaultCode;
  score: number;
}

/** Look up a fault/alarm code, optionally scoped by manufacturer and/or control platform. */
export function lookupFaultCode(kb: KnowledgeBase, code: string, opts?: { manufacturer?: string; platform?: string }): FaultHit[] {
  throw new Error("not implemented");
}
