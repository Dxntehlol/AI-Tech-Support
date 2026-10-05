import { Router } from "express";
import type { AppDeps } from "../app.ts";
import { readPackageVersion } from "../config.ts";
import { CORRECTION_FIELDS, CORRECTION_STATUSES } from "../db/repos.ts";
import type { CorrectionField, CorrectionRow, CorrectionStatus, DecodeResult, UnitRow } from "../types.ts";
import { parseUnitInput } from "./units.ts";
import { badRequest, notFound, optBoolean, optEnum, optString, queryString, requireId, requireString, safeParseJson, type Body } from "./util.ts";

/** Correction fields that map onto a unit column and can be applied to the unit record. */
export const APPLICABLE_CORRECTION_FIELDS: readonly CorrectionField[] = ["manufacturer", "tonnage", "voltage", "phase", "refrigerant"];

/** Export file format version (bump on breaking changes to the JSON shape). */
export const CORRECTIONS_EXPORT_VERSION = 1;

function decodedOf(unit: UnitRow): DecodeResult | null {
  const parsed = safeParseJson(unit.decoded_json);
  return parsed && typeof parsed === "object" ? (parsed as DecodeResult) : null;
}

/** Matched pack + format from the unit's stored decode; manufacture_date points at the serial format. */
export function decoderMatch(decoded: DecodeResult | null, field: CorrectionField): { pack_id: string | null; format_id: string | null } {
  if (!decoded) return { pack_id: null, format_id: null };
  const model = Array.isArray(decoded.model) ? decoded.model[0] : undefined;
  const serial = Array.isArray(decoded.serial) ? decoded.serial[0] : undefined;
  const first = field === "manufacture_date" ? (serial ?? model) : (model ?? serial);
  const packId = first?.manufacturerId ?? decoded.manufacturerCandidates?.[0]?.id ?? null;
  return { pack_id: packId ?? null, format_id: first?.formatId ?? null };
}

/** What the app currently shows for `field` (used when the client does not send app_value). */
export function currentAppValue(unit: UnitRow, decoded: DecodeResult | null, field: CorrectionField): string | null {
  const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
  switch (field) {
    case "manufacturer":
      return s(unit.manufacturer);
    case "tonnage":
      return s(unit.tonnage);
    case "voltage":
      return s(unit.voltage);
    case "phase":
      return s(unit.phase);
    case "refrigerant":
      return s(unit.refrigerant);
    case "control_platform":
      return s(unit.control_platform);
    case "family":
      return s(decoded?.model?.[0]?.family);
    case "manufacture_date":
      return s(decoded?.serial?.[0]?.manufactureDate);
    default:
      return null;
  }
}

/**
 * POST /api/units/:id/corrections body → stored correction. Snapshots model/serial/manufacturer and the decoder
 * match; `apply: true` on an applicable field also patches the unit column with PATCH /api/units/:id validation
 * (both writes in one transaction).
 */
export function createCorrection(deps: AppDeps, unit: UnitRow, b: Body): { correction: CorrectionRow; unit: UnitRow } {
  const field = optEnum(b.field, "field", CORRECTION_FIELDS);
  if (!field) throw badRequest(`field is required: one of ${CORRECTION_FIELDS.join(", ")}.`);
  const actual = requireString(b.actual_value, "actual_value", 500);
  const decoded = decodedOf(unit);
  const appValueRaw = "app_value" in b ? optString(b.app_value, "app_value", 500) : undefined;
  const appValue = appValueRaw !== undefined ? appValueRaw.trim() || null : currentAppValue(unit, decoded, field);
  const note = optString(b.note, "note", 2000)?.trim() || null;
  const apply = optBoolean(b.apply, "apply") === true && APPLICABLE_CORRECTION_FIELDS.includes(field);
  // Same whitelist/validation as PATCH /api/units/:id (e.g. tonnage must be a number 0–10000).
  const patch = apply ? parseUnitInput({ [field]: actual }) : undefined;
  const { repos } = deps;
  return repos.transaction(() => {
    const updated = patch ? (repos.units.update(unit.id, patch) ?? unit) : unit;
    const correction = repos.corrections.create({
      unit_id: unit.id,
      field,
      app_value: appValue,
      actual_value: actual,
      note,
      model: unit.model,
      serial: unit.serial,
      manufacturer: unit.manufacturer,
      ...decoderMatch(decoded, field),
      applied: apply,
    });
    return { correction, unit: updated };
  });
}

export function correctionsRouter(deps: AppDeps): Router {
  const r = Router();
  const { repos } = deps;

  // GET /api/corrections?status=open|exported
  r.get("/", (req, res) => {
    const status = optEnum<CorrectionStatus>(queryString(req, "status"), "status", CORRECTION_STATUSES);
    res.json({ corrections: repos.corrections.list({ status, limit: 5000 }) });
  });

  // POST /api/corrections/export → attachment hvac-corrections-YYYY-MM-DD.json; marks every row exported.
  // A POST (not GET) so the Origin / Content-Type guard applies: a cross-site <img> or a link prefetcher must not
  // be able to flip the technician's open corrections to exported.
  r.post("/export", (_req, res) => {
    const now = deps.now ? deps.now() : new Date();
    const { all, marked } = repos.transaction(() => {
      const before = repos.corrections.list({ limit: 5000 });
      const n = repos.corrections.markExported(before.filter((c) => c.status === "open").map((c) => c.id));
      return { all: repos.corrections.list({ limit: 5000 }), marked: n };
    });
    const stamp = now.toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename="hvac-corrections-${stamp}.json"`);
    res.json({
      kind: "hvac-corrections",
      version: CORRECTIONS_EXPORT_VERSION,
      appVersion: deps.version ?? readPackageVersion(),
      exportedAt: now.toISOString(),
      count: all.length,
      newlyExported: marked,
      corrections: all,
    });
  });

  // DELETE /api/corrections/:id
  r.delete("/:id", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.corrections.remove(id)) throw notFound("Correction not found.");
    res.json({ deleted: true, id });
  });

  return r;
}
