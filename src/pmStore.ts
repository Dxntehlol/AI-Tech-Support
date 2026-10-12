/**
 * PM visit helpers shared by the routes, the assistant tools and the reports: evaluate results against a
 * template with the unit's nameplate references, and present stored rows with their JSON parsed.
 */
import type { Repos } from "./db/repos.ts";
import { evaluate, findTemplate, nameplateOf, parseSummary, type PmResults, type PmSummary } from "./knowledge/pm.ts";
import type { KnowledgeBase, PmTemplate, PmVisitRow, UnitRow } from "./types.ts";

export interface PmVisitView {
  id: string;
  unit_id: string;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
  date: string;
  template_id: string;
  template_name: string | null;
  status: PmVisitRow["status"];
  tech_name: string | null;
  results: PmResults;
  summary: PmSummary | null;
  note: string | null;
}

function parseResults(text: string | null | undefined): PmResults {
  if (typeof text !== "string" || text.trim() === "") return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as PmResults) : {};
  } catch {
    return {};
  }
}

export function pmVisitView(row: PmVisitRow, kb?: KnowledgeBase): PmVisitView {
  const summary = parseSummary(row.summary_json);
  const template = kb ? findTemplate(kb.pm, row.template_id) : undefined;
  return {
    id: row.id,
    unit_id: row.unit_id,
    conversation_id: row.conversation_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    date: row.created_at.slice(0, 10),
    template_id: row.template_id,
    template_name: summary?.templateName ?? template?.name ?? null,
    status: row.status,
    tech_name: row.tech_name,
    results: parseResults(row.results_json),
    summary,
    note: row.note,
  };
}

/** Evaluate results for a unit: the unit's voltage / nameplate RLA feed the nameplate comparisons. */
export function evaluateForUnit(template: PmTemplate, results: PmResults, unit: UnitRow): PmSummary {
  return evaluate(template, results, nameplateOf(unit));
}

/** Newest PM visit of a unit as a view (GET /api/units/:id `lastPm`), or null. */
export function unitLastPm(repos: Repos, unitId: string, kb?: KnowledgeBase): PmVisitView | null {
  const row = repos.pmVisits.latest(unitId);
  return row ? pmVisitView(row, kb) : null;
}

/** Shallow merge of stored results with a patch (per item: later keys win; null removes an item). */
export function mergeResults(existing: PmResults, patch: Record<string, unknown>): PmResults {
  const out: PmResults = { ...existing };
  for (const [id, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[id];
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    out[id] = { ...(out[id] ?? {}), ...(value as PmResults[string]) };
  }
  return out;
}
