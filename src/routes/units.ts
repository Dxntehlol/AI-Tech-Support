import { Router } from "express";
import type { AppDeps } from "../app.ts";
import { normalizeCode, type FindingInput, type FindingPatch, type UnitInput } from "../db/repos.ts";
import { decodeUnit } from "../knowledge/decoder.ts";
import type { DecodeResult, FindingRow, UnitRow } from "../types.ts";
import { HttpError, badRequest, body, notFound, optBoolean, optEnum, optNumber, optString, optionalId, queryBool, queryInt, queryString, requireId, requireString, safeParseJson, type Body } from "./util.ts";

// ---------------------------------------------------------------------------
// Unit input whitelist
// ---------------------------------------------------------------------------

const UNIT_TEXT_FIELDS = [
  "manufacturer",
  "brand",
  "nickname",
  "site",
  "customer",
  "location_note",
  "refrigerant",
  "voltage",
  "phase",
  "notes",
  "unit_tag",
  "control_platform",
  "heat_type",
  "metering_device",
  "last_service_at",
] as const;
const UNIT_CODE_FIELDS = ["model", "serial"] as const;
const UNIT_NUM_FIELDS: Record<string, { min: number; max: number }> = {
  tonnage: { min: 0, max: 10000 },
  circuits: { min: 0, max: 64 },
  install_year: { min: 1900, max: 2100 },
  elevation_ft: { min: -1500, max: 30000 },
};
/** JSON columns and their friendlier aliases (charge → charge_json, nameplate → nameplate_json). */
const UNIT_JSON_FIELDS: Record<string, string> = { charge_json: "charge_json", charge: "charge_json", nameplate_json: "nameplate_json", nameplate: "nameplate_json" };

/** Validate + whitelist a unit body into repo columns. Keys absent from the body are not included. */
export function parseUnitInput(b: Body): UnitInput {
  const out: Record<string, unknown> = {};
  for (const f of UNIT_TEXT_FIELDS) {
    if (!(f in b)) continue;
    const s = optString(b[f], f, 2000);
    out[f] = s === undefined ? null : s.trim() || null;
  }
  for (const f of UNIT_CODE_FIELDS) {
    if (!(f in b)) continue;
    const s = optString(b[f], f, 200);
    out[f] = s === undefined ? null : normalizeCode(s);
  }
  for (const [f, range] of Object.entries(UNIT_NUM_FIELDS)) {
    if (!(f in b)) continue;
    const n = optNumber(b[f], f, range);
    out[f] = n === undefined ? null : n;
  }
  for (const [alias, col] of Object.entries(UNIT_JSON_FIELDS)) {
    if (!(alias in b)) continue;
    const v = b[alias];
    if (v === undefined || v === null || v === "") out[col] = null;
    else if (typeof v === "string" || typeof v === "object") out[col] = v;
    else throw badRequest(`${alias} must be an object or JSON string.`);
  }
  if ("metering_device" in out && out.metering_device) {
    optEnum(String(out.metering_device).toLowerCase(), "metering_device", ["txv", "fixed", "eev", "unknown"]);
    out.metering_device = String(out.metering_device).toLowerCase();
  }
  return out as UnitInput;
}

function phaseFromVoltage(voltage: string | undefined): string | undefined {
  if (!voltage) return undefined;
  const m = /[-/](1|3)[-/]\s*(50|60)/.exec(voltage) ?? /[-/](1|3)\s*(ph|phase|$)/i.exec(voltage);
  return m ? m[1] : undefined;
}

function parseTonnage(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Columns derived from a DecodeResult (same rules as the decode_unit tool): manufacturer/brand,
 * refrigerant, tonnage, voltage + phase, heat type, control platform, decoded_json.
 */
export function columnsFromDecode(deps: AppDeps, result: DecodeResult, hint: string | undefined): UnitInput {
  const patch: Record<string, unknown> = { decoded_json: JSON.stringify(result) };
  const best = result.model[0];
  const packId = best?.manufacturerId ?? result.manufacturerCandidates[0]?.id;
  const pack = packId ? deps.kb.manufacturers.find((p) => p.id === packId) : undefined;
  const mfrName = pack?.manufacturer ?? result.manufacturerCandidates[0]?.manufacturer;
  if (mfrName) patch.manufacturer = mfrName;
  if (hint) patch.brand = hint;
  else if (mfrName) patch.brand = mfrName;
  const refrigerant = best?.refrigerant ?? best?.attributes.refrigerant;
  if (refrigerant) patch.refrigerant = refrigerant;
  const tonnage = parseTonnage(best?.attributes.tonnage);
  if (tonnage !== undefined) patch.tonnage = tonnage;
  if (best?.attributes.voltage) {
    patch.voltage = best.attributes.voltage;
    const phase = phaseFromVoltage(best.attributes.voltage);
    if (phase) patch.phase = phase;
  }
  if (best?.attributes.heat_type) patch.heat_type = best.attributes.heat_type;
  const platformId = best?.controlPlatformIds?.[0];
  const platform = platformId ? (result.controls.find((c) => c.id === platformId) ?? result.controls[0]) : result.controls[0];
  if (platform) patch.control_platform = platform.name;
  return patch as UnitInput;
}

function decodeFor(deps: AppDeps, model: string, serial: string | null | undefined, hint: string | undefined): DecodeResult {
  const now = deps.now ? deps.now() : new Date();
  return decodeUnit(deps.kb, { model, serial: serial ?? undefined, manufacturer: hint, now });
}

function decodedOf(unit: UnitRow): DecodeResult | null {
  const parsed = safeParseJson(unit.decoded_json);
  return parsed && typeof parsed === "object" ? (parsed as DecodeResult) : null;
}

// ---------------------------------------------------------------------------
// Findings input
// ---------------------------------------------------------------------------

const FINDING_STATUSES = ["open", "resolved", "monitor"] as const;
const FINDING_ORIGINS = ["tech", "assistant"] as const;

function parseFindingFields(b: Body, out: Record<string, unknown>): void {
  for (const f of ["cause", "resolution", "circuit", "service_date", "refrigerant", "follow_up"] as const) {
    if (!(f in b)) continue;
    const s = optString(b[f], f, 4000);
    out[f] = s === undefined ? null : s.trim() || null;
  }
  for (const [alias, col] of [
    ["measurements", "measurements_json"],
    ["measurements_json", "measurements_json"],
    ["parts", "parts_json"],
    ["parts_json", "parts_json"],
  ] as const) {
    if (!(alias in b)) continue;
    const v = b[alias];
    if (v === undefined || v === null || v === "") out[col] = null;
    else if (typeof v === "string" || typeof v === "object") out[col] = v;
    else throw badRequest(`${alias} must be an object, array or JSON string.`);
  }
  if ("tags" in b) {
    const v = b.tags;
    if (v === undefined || v === null) out.tags = null;
    else if (typeof v === "string" || (Array.isArray(v) && v.every((t) => typeof t === "string" || typeof t === "number"))) out.tags = v;
    else throw badRequest("tags must be a string or an array of strings.");
  }
  if ("confirmed" in b) {
    const c = optBoolean(b.confirmed, "confirmed");
    if (c !== undefined) out.confirmed = c ? 1 : 0;
  }
  for (const f of ["refrigerant_added_lbs", "refrigerant_recovered_lbs"] as const) {
    if (!(f in b)) continue;
    const n = optNumber(b[f], f, { min: 0, max: 100000 });
    out[f] = n === undefined ? null : n;
  }
}

export function parseFindingCreate(b: Body): FindingInput {
  const out: Record<string, unknown> = { symptom: requireString(b.symptom, "symptom", 4000) };
  out.unit_id = optionalId(b.unit_id, "unit_id");
  out.conversation_id = optionalId(b.conversation_id, "conversation_id");
  parseFindingFields(b, out);
  // A new finding defaults to "resolved" (the tech is usually logging a finished job); null/"" mean "default".
  if ("status" in b) out.status = optEnum(b.status, "status", FINDING_STATUSES) ?? "resolved";
  if ("origin" in b) out.origin = optEnum(b.origin, "origin", FINDING_ORIGINS) ?? "tech";
  return out as FindingInput;
}

export function parseFindingPatch(b: Body): FindingPatch {
  const out: Record<string, unknown> = {};
  if ("symptom" in b) out.symptom = requireString(b.symptom, "symptom", 4000);
  parseFindingFields(b, out);
  // On an update there is no default: a present but empty status would silently flip open/monitor to resolved.
  if ("status" in b) {
    const status = optEnum(b.status, "status", FINDING_STATUSES);
    if (status === undefined) throw badRequest(`status must be one of: ${FINDING_STATUSES.join(", ")}.`);
    out.status = status;
  }
  if (Object.keys(out).length === 0) throw badRequest("Nothing to update: send confirmed, status, cause, resolution, follow_up or another finding field.");
  return out as FindingPatch;
}

// ---------------------------------------------------------------------------
// Routers
// ---------------------------------------------------------------------------

export function unitsRouter(deps: AppDeps): Router {
  const r = Router();
  const { repos } = deps;

  // GET /api/units?q=&site=&limit=&include_archived=
  r.get("/", (req, res) => {
    const units = repos.units.list({
      q: queryString(req, "q"),
      site: queryString(req, "site"),
      limit: queryInt(req, "limit", { min: 1, max: 1000 }) ?? 100,
      includeArchived: queryBool(req, "include_archived"),
    });
    res.json({ units });
  });

  // POST /api/units {model?, serial?, manufacturer?, unit_tag?, ...}
  r.post("/", (req, res) => {
    const b = body(req);
    const input = parseUnitInput(b) as Record<string, unknown>;
    const model = typeof input.model === "string" ? input.model : null;
    const serial = typeof input.serial === "string" ? input.serial : null;
    const hasIdentity = [input.model, input.unit_tag, input.nickname].some((v) => typeof v === "string" && v.trim() !== "");
    if (!hasIdentity) throw badRequest("At least one of model, unit_tag or nickname is required.");
    const hint = (typeof input.manufacturer === "string" && input.manufacturer) || (typeof input.brand === "string" && input.brand) || undefined;
    let decoded: DecodeResult | null = null;
    let derived: Record<string, unknown> = {};
    if (model) {
      decoded = decodeFor(deps, model, serial, hint);
      derived = columnsFromDecode(deps, decoded, hint) as Record<string, unknown>;
    }
    const existing = model ? repos.units.findByModelSerial(model, serial) : undefined;
    if (existing) {
      // Explicit body fields win over decoded columns; decoded_json is always refreshed.
      const patch = { ...derived, ...input } as UnitInput;
      const unit = repos.units.update(existing.id, patch) ?? existing;
      res.status(200).json({ unit, decoded: decodedOf(unit), existing: true });
      return;
    }
    const unit = repos.units.create({ ...derived, ...input } as UnitInput);
    res.status(201).json({ unit, decoded: decodedOf(unit), existing: false });
  });

  // GET /api/units/:id → {unit, decoded, findings, conversations}
  r.get("/:id", (req, res) => {
    const id = requireId(req.params.id);
    const unit = repos.units.get(id);
    if (!unit) throw notFound("Unit not found.");
    res.json({
      unit,
      decoded: decodedOf(unit),
      findings: repos.findings.list({ unitId: id, limit: 500 }),
      conversations: repos.conversations.list({ unitId: id, limit: 200 }),
    });
  });

  // PATCH /api/units/:id (whitelist; re-decode when model/serial change)
  r.patch("/:id", (req, res) => {
    const id = requireId(req.params.id);
    const existing = repos.units.get(id);
    if (!existing) throw notFound("Unit not found.");
    const b = body(req);
    const input = parseUnitInput(b) as Record<string, unknown>;
    if (Object.keys(input).length === 0) throw badRequest("Nothing to update.");
    const nextModel = "model" in input ? (input.model as string | null) : existing.model;
    const nextSerial = "serial" in input ? (input.serial as string | null) : existing.serial;
    const modelChanged = "model" in input && nextModel !== existing.model;
    const serialChanged = "serial" in input && nextSerial !== existing.serial;
    let patch: Record<string, unknown> = input;
    if (modelChanged || serialChanged) {
      if (nextModel) {
        const hint =
          (typeof input.brand === "string" && input.brand) ||
          (typeof input.manufacturer === "string" && input.manufacturer) ||
          existing.brand ||
          existing.manufacturer ||
          undefined;
        const decoded = decodeFor(deps, nextModel, nextSerial, hint);
        patch = { ...(columnsFromDecode(deps, decoded, hint) as Record<string, unknown>), ...input };
      } else {
        patch = { decoded_json: null, ...input };
      }
    }
    const unit = repos.units.update(id, patch as UnitInput);
    if (!unit) throw notFound("Unit not found.");
    res.json({ unit, decoded: decodedOf(unit) });
  });

  // DELETE /api/units/:id → archive
  r.delete("/:id", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.units.get(id)) throw notFound("Unit not found.");
    repos.units.archive(id);
    res.json({ archived: true, id });
  });

  return r;
}

/** POST /api/decode {model, serial?, manufacturer?} → DecodeResult */
export function decodeRouter(deps: AppDeps): Router {
  const r = Router();
  r.post("/", (req, res) => {
    const b = body(req);
    const model = requireString(b.model, "model", 200);
    const serial = optString(b.serial, "serial", 200)?.trim() || undefined;
    const manufacturer = optString(b.manufacturer, "manufacturer", 100)?.trim() || undefined;
    res.json(decodeFor(deps, model, serial, manufacturer));
  });
  return r;
}

export function findingsRouter(deps: AppDeps): Router {
  const r = Router();
  const { repos } = deps;

  // GET /api/findings?unit_id=&conversation_id=&limit=
  r.get("/", (req, res) => {
    const unitId = optionalId(queryString(req, "unit_id"), "unit_id") ?? undefined;
    const conversationId = optionalId(queryString(req, "conversation_id"), "conversation_id") ?? undefined;
    const limit = queryInt(req, "limit", { min: 1, max: 1000 }) ?? 100;
    res.json({ findings: repos.findings.list({ unitId, conversationId, limit }) });
  });

  // POST /api/findings
  r.post("/", (req, res) => {
    const input = parseFindingCreate(body(req));
    if (input.unit_id && !repos.units.get(input.unit_id)) throw notFound("Unit not found.");
    if (input.conversation_id && !repos.conversations.get(input.conversation_id)) throw notFound("Conversation not found.");
    const finding = repos.findings.create(input);
    res.status(201).json({ finding });
  });

  r.get("/:id", (req, res) => {
    const id = requireId(req.params.id);
    const finding = repos.findings.get(id);
    if (!finding) throw notFound("Finding not found.");
    res.json({ finding });
  });

  // PATCH /api/findings/:id {confirmed?, status?, cause?, resolution?, follow_up?, ...}
  r.patch("/:id", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.findings.get(id)) throw notFound("Finding not found.");
    const patch = parseFindingPatch(body(req));
    if (typeof repos.findings.update !== "function") throw new HttpError(500, "internal", "Finding updates are not supported by this database layer.");
    const finding: FindingRow | undefined = repos.findings.update(id, patch);
    if (!finding) throw notFound("Finding not found.");
    res.json({ finding });
  });

  // DELETE /api/findings/:id
  r.delete("/:id", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.findings.remove(id)) throw notFound("Finding not found.");
    res.json({ deleted: true, id });
  });

  return r;
}
