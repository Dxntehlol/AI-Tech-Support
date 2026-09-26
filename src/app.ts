import express, { type Express, type RequestHandler } from "express";
import type { ChatDeps } from "./agent/chat.ts";
import { isFallbacksSupported } from "./agent/chat.ts";
import { authMiddleware, corsMiddleware, originAndContentTypeGuard } from "./routes/auth.ts";
import { conversationsRouter } from "./routes/conversations.ts";
import { calcRouter, referenceRouter } from "./routes/reference.ts";
import { exportRouter, searchRouter } from "./routes/search.ts";
import { decodeRouter, findingsRouter, unitsRouter } from "./routes/units.ts";
import { apiNotFound, errorHandler } from "./routes/util.ts";

export interface AppDeps extends ChatDeps {
  /** True when the assistant runs on the fake client (no API key / CLAUDE_FAKE=1). Reported by /api/health. */
  demo?: boolean;
  /** Origins allowed via CORS (native shells); empty = same-origin only. */
  allowOrigins?: string[];
}

export const JSON_LIMIT_DEFAULT = "1mb";
export const JSON_LIMIT_MESSAGES = "25mb";

const MESSAGES_PATH_RE = /^\/conversations\/[^/]+\/messages\/?$/;

/** Build the Express app (routes + static UI). Does not listen. */
export function createApp(deps: AppDeps): Express {
  const { config, kb } = deps;
  const log = deps.log ?? (() => {});
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  const allowOrigins = deps.allowOrigins ?? [];
  app.use(corsMiddleware(allowOrigins));
  app.use(authMiddleware(config.appPassword));

  // ----- /api -----
  const api = express.Router();
  api.use(originAndContentTypeGuard(allowOrigins));
  const smallJson = express.json({ limit: JSON_LIMIT_DEFAULT });
  const bigJson = express.json({ limit: JSON_LIMIT_MESSAGES });
  const jsonByRoute: RequestHandler = (req, res, next) => {
    if (req.method === "POST" && MESSAGES_PATH_RE.test(req.path)) return bigJson(req, res, next);
    return smallJson(req, res, next);
  };
  api.use(jsonByRoute);

  api.get("/health", (_req, res) => {
    res.json({
      ok: true,
      model: config.claudeModel,
      effort: config.claudeEffort,
      webSearch: config.enableWebSearch,
      fallbacks: config.claudeFallbacks === "default" && isFallbacksSupported() ? "default" : "off",
      packs: kb.manufacturers.length,
      refrigerants: kb.refrigerants.tables.size,
      rules: kb.diagnostics.rules.rules.length,
      demo: deps.demo === true,
    });
  });

  api.use("/conversations", conversationsRouter(deps));
  api.use("/units", unitsRouter(deps));
  api.use("/decode", decodeRouter(deps));
  api.use("/findings", findingsRouter(deps));
  api.use("/search", searchRouter(deps));
  api.use("/export", exportRouter(deps));
  api.use("/reference", referenceRouter(deps));
  api.use("/calc", calcRouter(deps));
  api.use(apiNotFound);
  app.use("/api", api);

  // ----- static UI -----
  app.get("/config.js", (_req, res) => {
    res.type("application/javascript").set("Cache-Control", "no-cache").send('window.APP_CONFIG = { apiBase: "" };\n');
  });
  app.use(express.static(config.webDir, { index: "index.html", fallthrough: true, etag: true }));

  app.use(errorHandler(log));
  return app;
}
