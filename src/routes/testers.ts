import { Router } from "express";
import type { AppDeps } from "../app.ts";
import { summarizeUsage, usageWindowStart } from "../agent/usage.ts";
import { generateTesterPassword, hashTesterPassword, ownerOnly, principalOf } from "./auth.ts";
import { HttpError, badRequest, body, notFound, optString, queryInt, queryString, requireId } from "./util.ts";
import { DEFAULT_TESTER_DAILY_CAP_USD, capFor, testerBudget, testerSpendSince } from "../testers.ts";
import type { TesterRow } from "../types.ts";

export const TESTERS_OVERVIEW_DAYS = 30;
const EVENT_KINDS = new Set(["turn", "error", "cap"]);

function parseCap(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 10_000) throw badRequest("dailyCapUsd must be a number between 0 and 10000, or null for the default.");
  return Math.round(n * 100) / 100;
}

/** Public shape of a tester (no digest) with usage and event counts for the owner's list. */
function present(deps: AppDeps, t: TesterRow, now: Date): Record<string, unknown> {
  const budget = testerBudget(deps.repos, t, deps.config, now);
  const since = usageWindowStart(TESTERS_OVERVIEW_DAYS, now).toISOString();
  const spend = testerSpendSince(deps.repos, t.id, since);
  const events = deps.repos.testers.countEvents(t.id, since);
  return {
    id: t.id,
    name: t.name,
    createdAt: t.created_at,
    disabled: t.disabled !== 0,
    dailyCapUsd: t.daily_cap_usd,
    effectiveCapUsd: capFor(t, deps.config),
    lastSeenAt: t.last_seen_at,
    notes: t.notes,
    today: { spentUsd: budget.spentTodayUsd, requests: budget.requestsToday, exhausted: budget.exhausted },
    last30Days: { spentUsd: spend.usd, requests: spend.requests, turns: events.turn, errors: events.error, capHits: events.cap },
  };
}

/**
 * /api/me (any signed-in user): who am I and, for a tester, today's budget.
 * /api/testers (owner only): manage tester logins. Passwords are generated server-side and returned once.
 */
export function meRouter(deps: AppDeps): Router {
  const r = Router();
  r.get("/", (req, res) => {
    const p = principalOf(req);
    const authRequired = typeof deps.config.appPassword === "string" && deps.config.appPassword !== "";
    if (p.role === "owner") {
      res.json({ role: "owner", authRequired, testerCount: authRequired ? deps.repos.testers.list().length : 0, defaultCapUsd: deps.config.testerDailyCapUsd ?? DEFAULT_TESTER_DAILY_CAP_USD });
      return;
    }
    const t = deps.repos.testers.get(p.id);
    if (!t) {
      res.json({ role: "tester", name: p.name, authRequired });
      return;
    }
    const now = deps.now ? deps.now() : new Date();
    const b = testerBudget(deps.repos, t, deps.config, now);
    res.json({ role: "tester", name: t.name, authRequired, budget: { capUsd: b.capUsd, spentTodayUsd: b.spentTodayUsd, requestsToday: b.requestsToday, exhausted: b.exhausted, day: b.day } });
  });
  return r;
}

export function testersRouter(deps: AppDeps): Router {
  const r = Router();
  const { repos } = deps;
  const log = deps.log ?? (() => {});
  const nowDate = (): Date => (deps.now ? deps.now() : new Date());
  r.use(ownerOnly());

  // GET /api/testers → {testers: [...], defaultCapUsd, authRequired}
  r.get("/", (_req, res) => {
    const now = nowDate();
    const authRequired = typeof deps.config.appPassword === "string" && deps.config.appPassword !== "";
    res.json({ testers: repos.testers.list().map((t) => present(deps, t, now)), defaultCapUsd: deps.config.testerDailyCapUsd ?? DEFAULT_TESTER_DAILY_CAP_USD, authRequired });
  });

  // POST /api/testers {name, dailyCapUsd?, notes?} → 201 {tester, password}  (password shown once)
  r.post("/", (req, res) => {
    const b = body(req);
    const name = optString(b.name, "name", 60)?.trim();
    if (!name) throw badRequest("name is required.");
    const dailyCapUsd = parseCap(b.dailyCapUsd);
    const notes = optString(b.notes, "notes", 500)?.trim() || null;
    if (!deps.config.appPassword) {
      throw new HttpError(409, "no_password", "Set APP_PASSWORD on the server first: tester logins only apply when the app asks for a password.");
    }
    const password = generateTesterPassword();
    const row = repos.testers.create({ name, password_sha256: hashTesterPassword(password), daily_cap_usd: dailyCapUsd ?? null, notes });
    log(`tester created: ${row.name} (${row.id})`);
    res.status(201).json({ tester: present(deps, row, nowDate()), password });
  });

  // GET /api/testers/:id → {tester}
  r.get("/:id", (req, res) => {
    const t = repos.testers.get(requireId(req.params.id));
    if (!t) throw notFound("Tester not found.");
    res.json({ tester: present(deps, t, nowDate()) });
  });

  // PATCH /api/testers/:id {name?, disabled?, dailyCapUsd?|null, notes?}
  r.patch("/:id", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.testers.get(id)) throw notFound("Tester not found.");
    const b = body(req);
    const patch: Parameters<typeof repos.testers.update>[1] = {};
    if ("name" in b) {
      const name = optString(b.name, "name", 60)?.trim();
      if (!name) throw badRequest("name must not be empty.");
      patch.name = name;
    }
    if ("disabled" in b) {
      if (typeof b.disabled !== "boolean") throw badRequest("disabled must be true or false.");
      patch.disabled = b.disabled ? 1 : 0;
    }
    if ("dailyCapUsd" in b) patch.daily_cap_usd = parseCap(b.dailyCapUsd) ?? null;
    if ("notes" in b) patch.notes = optString(b.notes, "notes", 500)?.trim() || null;
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to update: send name, disabled, dailyCapUsd and/or notes.");
    const row = repos.testers.update(id, patch);
    if (!row) throw notFound("Tester not found.");
    log(`tester updated: ${row.name} (${row.id}) ${Object.keys(patch).join(",")}`);
    res.json({ tester: present(deps, row, nowDate()) });
  });

  // POST /api/testers/:id/password → {tester, password}  (new password, old one stops working at once)
  r.post("/:id/password", (req, res) => {
    const id = requireId(req.params.id);
    const password = generateTesterPassword();
    const row = repos.testers.update(id, { password_sha256: hashTesterPassword(password) });
    if (!row) throw notFound("Tester not found.");
    log(`tester password reset: ${row.name} (${row.id})`);
    res.json({ tester: present(deps, row, nowDate()), password });
  });

  // GET /api/testers/:id/events?limit=&kind= → {events}
  r.get("/:id/events", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.testers.get(id)) throw notFound("Tester not found.");
    const limit = queryInt(req, "limit", { min: 1, max: 500 }) ?? 50;
    const kindRaw = queryString(req, "kind");
    const kind = kindRaw && EVENT_KINDS.has(kindRaw) ? (kindRaw as "turn" | "error" | "cap") : undefined;
    res.json({ events: repos.testers.listEvents(id, { limit, kind }) });
  });

  // GET /api/testers/:id/usage?days= → the same summary shape as /api/usage, for one tester
  r.get("/:id/usage", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.testers.get(id)) throw notFound("Tester not found.");
    const days = Math.min(365, Math.max(1, queryInt(req, "days", { min: 1, max: 365 }) ?? TESTERS_OVERVIEW_DAYS));
    const now = nowDate();
    const rows = repos.usage.listSince(usageWindowStart(days, now).toISOString(), id);
    res.json(summarizeUsage(rows, { days, now }));
  });

  // DELETE /api/testers/:id → their login is gone; conversations and usage rows stay (tester_id dangles) for the cost history
  r.delete("/:id", (req, res) => {
    const id = requireId(req.params.id);
    const t = repos.testers.get(id);
    if (!t || !repos.testers.remove(id)) throw notFound("Tester not found.");
    log(`tester removed: ${t.name} (${id})`);
    res.json({ deleted: true, id });
  });

  return r;
}
