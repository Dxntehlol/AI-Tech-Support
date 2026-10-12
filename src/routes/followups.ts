import { Router } from "express";
import type { AppDeps } from "../app.ts";
import { FOLLOW_UP_STATUSES, type FollowUpStatus } from "../db/repos.ts";
import type { FollowUpRow } from "../types.ts";
import { optEnum, queryInt, queryString } from "./util.ts";

export interface FollowUpCounts {
  open: number;
  overdue: number;
  dueThisWeek: number;
}

/** YYYY-MM-DD of a Date in UTC (follow-up due dates are calendar dates, compared as strings). */
export function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Add days to a YYYY-MM-DD string. */
export function addDays(day: string, days: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return ymd(new Date(ms + days * 86_400_000));
}

/** Pure: open (not done) follow-ups overdue before `today` and due within the next 7 days (today inclusive). */
export function followUpCounts(rows: FollowUpRow[], today: string): FollowUpCounts {
  const weekEnd = addDays(today, 7);
  let open = 0;
  let overdue = 0;
  let dueThisWeek = 0;
  for (const f of rows) {
    if (f.follow_up_done === 1) continue;
    open += 1;
    const due = f.follow_up_due;
    if (!due) continue;
    if (due < today) overdue += 1;
    else if (due <= weekEnd) dueThisWeek += 1;
  }
  return { open, overdue, dueThisWeek };
}

/** GET /api/followups?status=open|done|all&limit=   {followups, counts, today} */
export function followupsRouter(deps: AppDeps): Router {
  const r = Router();
  const { repos } = deps;
  r.get("/", (req, res) => {
    const status = optEnum<FollowUpStatus>(queryString(req, "status"), "status", FOLLOW_UP_STATUSES) ?? "open";
    const limit = queryInt(req, "limit", { min: 1, max: 500 }) ?? 100;
    const today = ymd(deps.now ? deps.now() : new Date());
    const rows = repos.findings.listFollowUps({ status, limit });
    // Counts always describe the open set, whatever the list filter shows.
    const openRows = status === "open" ? rows : repos.findings.listFollowUps({ status: "open", limit: 500 });
    res.json({ followups: rows, counts: followUpCounts(openRows, today), today });
  });
  return r;
}
