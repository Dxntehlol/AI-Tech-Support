import { Router, type Response } from "express";
import type { AppDeps } from "../app.ts";
import { readPackageVersion } from "../config.ts";
import { buildConversationReport, buildUnitReport, renderReport, REPORT_FORMATS, type ReportFormat } from "../reports.ts";
import { unitCompliance } from "../complianceStore.ts";
import { badRequest, notFound, queryString, requireId } from "./util.ts";

/** `?format=md|html|json|markdown` → ReportFormat (default md); anything else → 400. */
export function parseReportFormat(raw: string | undefined): ReportFormat {
  if (raw === undefined) return "md";
  const v = raw.trim().toLowerCase();
  if (v === "markdown") return "md";
  if ((REPORT_FORMATS as readonly string[]).includes(v)) return v as ReportFormat;
  throw badRequest(`format must be one of: ${REPORT_FORMATS.join(", ")}.`);
}

/**
 * Service reports, mounted on /api:
 *   GET /api/conversations/:id/report?format=md|html|json
 *   GET /api/units/:id/report?format=md|html|json
 * Both answer `Content-Disposition: inline; filename="…"` so a browser tab shows the report and "Save" keeps the name.
 */
export function reportsRouter(deps: AppDeps): Router {
  const r = Router();
  const { repos } = deps;
  const version = (): string => deps.version ?? readPackageVersion();
  const now = (): Date => (deps.now ? deps.now() : new Date());

  const send = (res: Response, out: { body: string; contentType: string; filename: string }): void => {
    res.setHeader("Content-Type", out.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${out.filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(out.body);
  };

  r.get("/conversations/:id/report", (req, res) => {
    const id = requireId(req.params.id);
    const format = parseReportFormat(queryString(req, "format"));
    const conversation = repos.conversations.get(id);
    if (!conversation) throw notFound("Conversation not found.");
    const unit = conversation.unit_id ? (repos.units.get(conversation.unit_id) ?? null) : null;
    const today = now().toISOString().slice(0, 10);
    const unitEvents = unit ? repos.refrigerantEvents.list({ unitId: unit.id, limit: 500 }) : [];
    const report = buildConversationReport({
      conversation,
      unit,
      messages: repos.messages.list(id),
      findings: repos.findings.list({ conversationId: id, limit: 500 }),
      now: now(),
      appVersion: version(),
      refrigerantEvents: unitEvents.filter((e) => e.conversation_id === id),
      compliance: unit ? unitCompliance(repos, unit, today, unitEvents) : null,
      pmVisits: unit ? repos.pmVisits.list({ unitId: unit.id, limit: 20 }).filter((v) => v.conversation_id === id) : [],
      signaturePng: repos.conversations.signaturePng(id),
    });
    send(res, renderReport(report, format));
  });

  r.get("/units/:id/report", (req, res) => {
    const id = requireId(req.params.id);
    const format = parseReportFormat(queryString(req, "format"));
    const unit = repos.units.get(id);
    if (!unit) throw notFound("Unit not found.");
    const events = repos.refrigerantEvents.list({ unitId: id, limit: 500 });
    const report = buildUnitReport({
      unit,
      findings: repos.findings.list({ unitId: id, limit: 500 }),
      corrections: repos.corrections.list({ unitId: id, limit: 500 }),
      conversations: repos.conversations.list({ unitId: id, limit: 200 }),
      now: now(),
      appVersion: version(),
      refrigerantEvents: events,
      compliance: unitCompliance(repos, unit, now().toISOString().slice(0, 10), events),
      pmVisits: repos.pmVisits.list({ unitId: id, limit: 20 }),
    });
    send(res, renderReport(report, format));
  });

  return r;
}
