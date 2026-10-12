import { Router } from "express";
import type { AppDeps } from "../app.ts";
import { REFRIGERANT_EVENT_TYPES, type RefrigerantEventInput } from "../db/repos.ts";
import { refrigerantEventView, refrigerantLogCsv, unitCompliance } from "../complianceStore.ts";
import { badRequest, body, notFound, optBoolean, optEnum, optNumber, optString, optionalId, queryInt, requireId, type Body } from "./util.ts";

/** Validate + whitelist a refrigerant event body (POST /api/units/:id/refrigerant and the log_refrigerant tool). */
export function parseRefrigerantEvent(b: Body, unitId: string): RefrigerantEventInput {
  const eventType = optEnum(typeof b.event_type === "string" ? b.event_type.toLowerCase() : b.event_type, "event_type", REFRIGERANT_EVENT_TYPES);
  if (!eventType) throw badRequest(`event_type is required: one of ${REFRIGERANT_EVENT_TYPES.join(", ")}.`);
  const out: RefrigerantEventInput = { unit_id: unitId, event_type: eventType };
  out.conversation_id = optionalId(b.conversation_id, "conversation_id");
  const refrigerant = optString(b.refrigerant, "refrigerant", 40)?.trim();
  if (refrigerant) out.refrigerant = refrigerant;
  const amount = optNumber(b.amount_lbs, "amount_lbs", { min: 0, max: 100000 });
  if (amount !== undefined) out.amount_lbs = amount;
  if ((eventType === "add" || eventType === "recover") && !(amount !== undefined && amount > 0)) throw badRequest(`amount_lbs (pounds, > 0) is required for ${eventType}.`);
  const circuit = optNumber(b.circuit, "circuit", { min: 1, max: 64 });
  if (circuit !== undefined) {
    if (!Number.isInteger(circuit)) throw badRequest("circuit must be an integer (1, 2, …).");
    out.circuit = circuit;
  }
  for (const f of ["cylinder_id", "tech_name", "tech_cert"] as const) {
    const s = optString(b[f], f, 120)?.trim();
    if (s) out[f] = s;
  }
  const note = optString(b.note, "note", 2000)?.trim();
  if (note) out.note = note;
  const leakFound = optBoolean(b.leak_found, "leak_found");
  if (leakFound !== undefined) out.leak_found = leakFound;
  const passed = optBoolean(b.passed, "passed");
  if (passed !== undefined) out.passed = passed;
  const date = optString(b.date, "date", 10)?.trim();
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("date must be YYYY-MM-DD.");
    out.date = date;
  }
  return out;
}

/**
 * Refrigerant log, mounted at /api/units next to unitsRouter (before it, so /:id does not swallow the paths):
 *   POST   /api/units/:id/refrigerant        {event_type, refrigerant?, amount_lbs?, circuit?, cylinder_id?, tech_name?, tech_cert?, leak_found?, passed?, note?, conversation_id?, date?}
 *   GET    /api/units/:id/refrigerant?limit=  {events (newest first), compliance}
 *   DELETE /api/units/:id/refrigerant/:eid
 */
export function refrigerantRouter(deps: AppDeps): Router {
  const r = Router();
  const { repos } = deps;
  const today = (): string => (deps.now ? deps.now() : new Date()).toISOString().slice(0, 10);

  r.get("/:id/refrigerant", (req, res) => {
    const id = requireId(req.params.id);
    const unit = repos.units.get(id);
    if (!unit) throw notFound("Unit not found.");
    const limit = queryInt(req, "limit", { min: 1, max: 1000 }) ?? 100;
    const events = repos.refrigerantEvents.list({ unitId: id, limit });
    res.json({ events: events.map(refrigerantEventView), compliance: unitCompliance(repos, unit, today()) });
  });

  r.post("/:id/refrigerant", (req, res) => {
    const id = requireId(req.params.id);
    const unit = repos.units.get(id);
    if (!unit) throw notFound("Unit not found.");
    const input = parseRefrigerantEvent(body(req), id);
    if (input.conversation_id && !repos.conversations.get(input.conversation_id)) throw notFound("Conversation not found.");
    const event = repos.refrigerantEvents.create(input);
    const finding = event.finding_id ? (repos.findings.get(event.finding_id) ?? null) : null;
    res.status(201).json({ event: refrigerantEventView(event), finding, compliance: unitCompliance(repos, unit, today()) });
  });

  r.delete("/:id/refrigerant/:eid", (req, res) => {
    const id = requireId(req.params.id);
    const eid = requireId(req.params.eid, "eid");
    const row = repos.refrigerantEvents.get(eid);
    if (!row || row.unit_id !== id) throw notFound("Refrigerant event not found.");
    repos.refrigerantEvents.remove(eid);
    res.json({ deleted: true, id: eid });
  });

  return r;
}

/** GET /api/refrigerant/export.csv — every event joined with its unit, RFC 4180, as an attachment. */
export function refrigerantExportRouter(deps: AppDeps): Router {
  const r = Router();
  r.get("/export.csv", (_req, res) => {
    const stamp = (deps.now ? deps.now() : new Date()).toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="hvac-refrigerant-log-${stamp}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(refrigerantLogCsv(deps.repos));
  });
  return r;
}
