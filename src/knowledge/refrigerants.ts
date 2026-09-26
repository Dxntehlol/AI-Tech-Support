import type { DxMeasurements, KnowledgeBase, PtLookupResult, RefrigerantMeta, RefrigerantTable } from "../types.ts";

/** Resolve user input like "410a", "R410A", "Puron" to a canonical id ("R-410A"). */
export function resolveRefrigerant(kb: KnowledgeBase, input: string): RefrigerantMeta | undefined {
  throw new Error("not implemented");
}

export function getTable(kb: KnowledgeBase, id: string): RefrigerantTable | undefined {
  throw new Error("not implemented");
}

/** Pressure -> saturation temperatures (bubble & dew), linear interpolation. */
export function satTempsAtPressure(table: RefrigerantTable, psig: number): { bubbleF: number; dewF: number } | undefined {
  throw new Error("not implemented");
}

/** Temperature -> saturation pressures (bubble & dew). */
export function satPressuresAtTemp(table: RefrigerantTable, tempF: number): { bubblePsig: number; dewPsig: number } | undefined {
  throw new Error("not implemented");
}

export function ptLookup(kb: KnowledgeBase, refrigerant: string, query: { psig?: number; tempF?: number }): PtLookupResult {
  throw new Error("not implemented");
}

export interface ShScResult {
  refrigerant: string;
  evapSatF?: number;
  condSatF?: number;
  superheatF?: number;
  subcoolingF?: number;
  notes: string[];
}

/** Superheat (dew point basis) and subcooling (bubble point basis) from field readings. */
export function superheatSubcooling(kb: KnowledgeBase, m: Pick<DxMeasurements, "refrigerant" | "suctionPsig" | "suctionLineTempF" | "liquidPsig" | "dischargePsig" | "liquidLineTempF">): ShScResult {
  throw new Error("not implemented");
}
