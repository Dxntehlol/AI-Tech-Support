import express from "express";
import type { ChatDeps } from "./agent/chat.ts";

export interface AppDeps extends ChatDeps {}

/** Build the Express app (routes + static UI). Does not listen. */
export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}
