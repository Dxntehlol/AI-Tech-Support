import type { DecodeResult, DecodedModel, DecodedSerial, KnowledgeBase, ManufacturerPack } from "../types.ts";

export interface DecodeInput {
  model: string;
  serial?: string;
  manufacturer?: string; // optional hint (brand or manufacturer name)
  now?: Date; // for age calculation (tests)
}

/** Normalize a nameplate string: trim, uppercase, collapse whitespace, strip stray punctuation. */
export function normalizeNameplate(s: string): string {
  throw new Error("not implemented");
}

/** Rank manufacturer packs by how well they match the hint / model / serial. */
export function rankManufacturers(kb: KnowledgeBase, input: DecodeInput): { pack: ManufacturerPack; score: number; reason: string }[] {
  throw new Error("not implemented");
}

export function decodeSerialWithPack(pack: ManufacturerPack, serial: string, now?: Date): DecodedSerial[] {
  throw new Error("not implemented");
}

export function decodeModelWithPack(pack: ManufacturerPack, model: string): DecodedModel[] {
  throw new Error("not implemented");
}

/** Full decode across all packs. Never throws on bad input; returns warnings instead. */
export function decodeUnit(kb: KnowledgeBase, input: DecodeInput): DecodeResult {
  throw new Error("not implemented");
}
