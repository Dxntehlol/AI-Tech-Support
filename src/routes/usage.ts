import { Router } from "express";
import type { AppDeps } from "../app.ts";
import { clampUsageDays, summarizeUsage, usageWindowStart } from "../agent/usage.ts";
import { PRICE_LABEL } from "../agent/pricing.ts";

/** GET /api/usage?days=7|30|90 (default 30, clamped 1–365): token and estimated-cost totals. */
export function usageRouter(deps: AppDeps): Router {
  const r = Router();
  r.get("/", (req, res) => {
    const days = clampUsageDays(typeof req.query.days === "string" ? req.query.days : undefined);
    const now = deps.now ? deps.now() : new Date();
    const rows = deps.repos.usage.listSince(usageWindowStart(days, now).toISOString());
    res.json({ ...summarizeUsage(rows, { days, now }), priceLabel: PRICE_LABEL });
  });
  return r;
}
