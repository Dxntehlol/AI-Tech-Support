import { Router } from "express";
import type { AppDeps } from "../app.ts";
import { badRequest, optionalId, queryInt, queryString, stripImageBlocks } from "./util.ts";

/** GET /api/search?q=&unit_id=&site=&since=&limit= → { hits: SearchHit[] } */
export function searchRouter(deps: AppDeps): Router {
  const r = Router();
  r.get("/", (req, res) => {
    const q = queryString(req, "q");
    if (!q) throw badRequest("q is required.");
    const unitId = optionalId(queryString(req, "unit_id"), "unit_id") ?? undefined;
    const site = queryString(req, "site");
    const since = queryString(req, "since");
    if (since !== undefined && !Number.isFinite(Date.parse(since))) throw badRequest("since must be an ISO-8601 date.");
    const limit = queryInt(req, "limit", { min: 1, max: 200 }) ?? 20;
    const hits = deps.repos.search(q, { unitId, site, since, limit });
    res.json({ q, hits });
  });
  return r;
}

/** GET /api/export → JSON of units, conversations, messages (image data omitted) and findings. */
export function exportRouter(deps: AppDeps): Router {
  const r = Router();
  r.get("/", (_req, res) => {
    const { repos } = deps;
    const now = deps.now ? deps.now() : new Date();
    const units = repos.units.list({ includeArchived: true, limit: 1000 });
    const conversations = repos.conversations.list({ limit: 1000 });
    const messages: unknown[] = [];
    for (const c of conversations) {
      for (const m of repos.messages.list(c.id)) {
        messages.push({
          id: m.id,
          conversation_id: m.conversation_id,
          seq: m.seq,
          role: m.role,
          kind: m.kind,
          content: stripImageBlocks(m),
          text: m.text,
          created_at: m.created_at,
        });
      }
    }
    const findings = repos.findings.list({ limit: 1000 });
    const stamp = now.toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename="hvac-export-${stamp}.json"`);
    res.json({ exportedAt: now.toISOString(), version: 1, units, conversations, messages, findings });
  });
  return r;
}
