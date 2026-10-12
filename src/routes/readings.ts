import { Router } from "express";
import type { AppDeps } from "../app.ts";
import { trendFromReadings } from "../knowledge/trend.ts";
import { TREND_WINDOW, readingView } from "../readingsStore.ts";
import { notFound, queryInt, requireId } from "./util.ts";

export { readingView, storeReading, unitReadingsSummary, TREND_WINDOW, type ReadingView } from "../readingsStore.ts";

/** Mounted at /api/units next to unitsRouter: GET /:id/readings, DELETE /:id/readings/:rid. */
export function readingsRouter(deps: AppDeps): Router {
  const r = Router();
  const { repos } = deps;

  // GET /api/units/:id/readings?limit=   (newest first; default 20, max 200)
  r.get("/:id/readings", (req, res) => {
    const id = requireId(req.params.id);
    if (!repos.units.get(id)) throw notFound("Unit not found.");
    const limit = queryInt(req, "limit", { min: 1, max: 200 }) ?? 20;
    const rows = repos.readings.list({ unitId: id, limit });
    res.json({ readings: rows.map(readingView), trend: trendFromReadings(repos.readings.list({ unitId: id, limit: TREND_WINDOW })) });
  });

  // DELETE /api/units/:id/readings/:rid
  r.delete("/:id/readings/:rid", (req, res) => {
    const id = requireId(req.params.id);
    const rid = requireId(req.params.rid, "rid");
    const row = repos.readings.get(rid);
    if (!row || row.unit_id !== id) throw notFound("Reading not found.");
    repos.readings.remove(rid);
    res.json({ deleted: true, id: rid });
  });

  return r;
}
