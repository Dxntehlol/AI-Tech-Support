import { Router } from "express";
import type { AppDeps } from "../app.ts";
import { PM_VISIT_STATUSES } from "../db/repos.ts";
import { findTemplate, templateSummary, type PmResults } from "../knowledge/pm.ts";
import { evaluateForUnit, mergeResults, pmVisitView } from "../pmStore.ts";
import type { PmTemplate, PmVisitStatus } from "../types.ts";
import { badRequest, body, notFound, optEnum, optString, optionalId, queryInt, requireId, type Body } from "./util.ts";

const RESULT_KEYS = new Set(["value", "checked", "asFound", "asLeft", "pass", "note", "rated"]);

/** Validate a `results` object: { itemId: { value?, checked?, asFound?, asLeft?, pass?, note?, rated? } }; unknown items / keys → 400. */
export function parseResults(raw: unknown, template: PmTemplate): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("results must be an object keyed by item id.");
  const ids = new Set(template.sections.flatMap((s) => s.items.map((i) => i.id)));
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!ids.has(id)) throw badRequest(`results: unknown item "${id}" for template ${template.id}.`);
    if (entry === null) {
      out[id] = null;
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw badRequest(`results.${id} must be an object.`);
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (!RESULT_KEYS.has(k)) throw badRequest(`results.${id}: unknown key "${k}" (value, checked, asFound, asLeft, pass, note, rated).`);
      if (v === undefined) continue;
      if (k === "note") {
        if (v !== null && typeof v !== "string") throw badRequest(`results.${id}.note must be a string.`);
        if (typeof v === "string" && v.length > 2000) throw badRequest(`results.${id}.note must be at most 2000 characters.`);
        clean[k] = v;
      } else if (k === "checked" || k === "pass") {
        if (v !== null && typeof v !== "boolean") throw badRequest(`results.${id}.${k} must be true, false or null.`);
        clean[k] = v;
      } else if (k === "value") {
        if (v !== null && typeof v !== "number" && typeof v !== "string") throw badRequest(`results.${id}.value must be a number or string.`);
        if (typeof v === "number" && !Number.isFinite(v)) throw badRequest(`results.${id}.value must be finite.`);
        if (typeof v === "string" && v.length > 2000) throw badRequest(`results.${id}.value must be at most 2000 characters.`);
        clean[k] = v;
      } else {
        if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) throw badRequest(`results.${id}.${k} must be a number.`);
        clean[k] = v;
      }
    }
    out[id] = clean;
  }
  return out;
}

function templateOf(deps: AppDeps, id: unknown): PmTemplate {
  const s = optString(id, "template_id", 60)?.trim();
  if (!s) throw badRequest("template_id is required.");
  const t = findTemplate(deps.kb.pm, s);
  if (!t) throw badRequest(`Unknown template_id "${s}". Known: ${(deps.kb.pm?.templates ?? []).map((x) => x.id).join(", ")}.`);
  return t;
}

/** GET /api/pm/templates, GET /api/pm/templates/:id */
export function pmTemplatesRouter(deps: AppDeps): Router {
  const r = Router();
  r.get("/templates", (_req, res) => {
    res.json({ templates: (deps.kb.pm?.templates ?? []).map(templateSummary), sources: deps.kb.pm?.sources ?? [], version: deps.kb.pm?.version ?? null });
  });
  r.get("/templates/:id", (req, res) => {
    const id = String(req.params.id ?? "");
    const t = findTemplate(deps.kb.pm, id);
    if (!t) throw notFound(`No PM template "${id}".`);
    res.json({ template: t });
  });
  return r;
}

/**
 * PM visits per unit, mounted at /api/units before unitsRouter:
 *   GET    /api/units/:id/pm?limit=           {visits (newest first)}
 *   POST   /api/units/:id/pm                  {template_id, results?, status?, tech_name?, note?, conversation_id?}  201 {visit}
 *   PATCH  /api/units/:id/pm/:vid             {results? (merged), status?, tech_name?, note?}  {visit}
 *   DELETE /api/units/:id/pm/:vid
 */
export function pmVisitsRouter(deps: AppDeps): Router {
  const r = Router();
  const { repos, kb } = deps;

  r.get("/:id/pm", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.units.get(id)) throw notFound("Unit not found.");
    const limit = queryInt(req, "limit", { min: 1, max: 200 }) ?? 20;
    res.json({ visits: repos.pmVisits.list({ unitId: id, limit }).map((row) => pmVisitView(row, kb)) });
  });

  r.post("/:id/pm", (req, res) => {
    const id = requireId(req.params.id);
    const unit = repos.units.get(id);
    if (!unit) throw notFound("Unit not found.");
    const b: Body = body(req);
    const template = templateOf(deps, b.template_id);
    const results = mergeResults({}, parseResults(b.results, template));
    const conversationId = optionalId(b.conversation_id, "conversation_id");
    if (conversationId && !repos.conversations.get(conversationId)) throw notFound("Conversation not found.");
    const status = optEnum<PmVisitStatus>(b.status, "status", PM_VISIT_STATUSES) ?? "in_progress";
    const summary = evaluateForUnit(template, results, unit);
    const row = repos.pmVisits.create({
      unit_id: id,
      conversation_id: conversationId,
      template_id: template.id,
      status,
      tech_name: optString(b.tech_name, "tech_name", 120)?.trim() || null,
      note: optString(b.note, "note", 4000)?.trim() || null,
      results_json: results,
      summary_json: summary,
    });
    res.status(201).json({ visit: pmVisitView(row, kb) });
  });

  r.patch("/:id/pm/:vid", (req, res) => {
    const id = requireId(req.params.id);
    const vid = requireId(req.params.vid, "vid");
    const unit = repos.units.get(id);
    if (!unit) throw notFound("Unit not found.");
    const existing = repos.pmVisits.get(vid);
    if (!existing || existing.unit_id !== id) throw notFound("PM visit not found.");
    const template = findTemplate(kb.pm, existing.template_id);
    if (!template) throw badRequest(`The visit's template "${existing.template_id}" is no longer available.`);
    const b: Body = body(req);
    const patch: { status?: PmVisitStatus; tech_name?: string | null; note?: string | null; results_json?: PmResults; summary_json?: unknown } = {};
    if ("status" in b) {
      const status = optEnum<PmVisitStatus>(b.status, "status", PM_VISIT_STATUSES);
      if (!status) throw badRequest(`status must be one of: ${PM_VISIT_STATUSES.join(", ")}.`);
      patch.status = status;
    }
    if ("tech_name" in b) patch.tech_name = optString(b.tech_name, "tech_name", 120)?.trim() || null;
    if ("note" in b) patch.note = optString(b.note, "note", 4000)?.trim() || null;
    if ("results" in b) {
      const current = pmVisitView(existing).results;
      const merged = mergeResults(current, parseResults(b.results, template));
      patch.results_json = merged;
      patch.summary_json = evaluateForUnit(template, merged, unit);
    }
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to update: send results, status, tech_name or note.");
    const row = repos.pmVisits.update(vid, patch);
    if (!row) throw notFound("PM visit not found.");
    res.json({ visit: pmVisitView(row, kb) });
  });

  r.delete("/:id/pm/:vid", (req, res) => {
    const id = requireId(req.params.id);
    const vid = requireId(req.params.vid, "vid");
    const row = repos.pmVisits.get(vid);
    if (!row || row.unit_id !== id) throw notFound("PM visit not found.");
    repos.pmVisits.remove(vid);
    res.json({ deleted: true, id: vid });
  });

  return r;
}
