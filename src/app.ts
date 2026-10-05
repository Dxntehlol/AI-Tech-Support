import { basename, extname } from "node:path";
import express, { type Express, type RequestHandler, type Response } from "express";
import type { ChatDeps } from "./agent/chat.ts";
import { isFallbacksSupported } from "./agent/chat.ts";
import { readPackageVersion } from "./config.ts";
import { authMiddleware, corsMiddleware, originAndContentTypeGuard } from "./routes/auth.ts";
import { conversationsRouter } from "./routes/conversations.ts";
import { calcRouter, referenceRouter } from "./routes/reference.ts";
import { exportRouter, searchRouter } from "./routes/search.ts";
import { decodeRouter, findingsRouter, unitsRouter } from "./routes/units.ts";
import { settingsRouter } from "./routes/settings.ts";
import { usageRouter } from "./routes/usage.ts";
import { correctionsRouter } from "./routes/corrections.ts";
import { apiNotFound, errorHandler } from "./routes/util.ts";
import { createRuntime, type Runtime } from "./runtime.ts";
import type { AiSettings } from "./aiSettings.ts";
import type { ConnectionTester } from "./agent/connectionTest.ts";

export interface AppDeps extends ChatDeps {
  /**
   * The swappable client/config/demo holder (Settings → AI connection). When given, it is the source of
   * truth for client, config and demo (the plain fields are only the fallback used to create one).
   * `demo` (from ChatDeps) is reported by /api/health and /config.js.
   */
  runtime?: Runtime;
  /** Reads/writes settings.env and swaps the runtime; without it /api/settings/ai answers 503. */
  aiSettings?: AiSettings;
  /** POST /api/settings/ai/test implementation (tests inject a fake; default: the real SDK). */
  connectionTester?: ConnectionTester;
  /** Minimum gap between connection tests (default 3000 ms). */
  connectionTestIntervalMs?: number;
  /** Connection test budget (default 20 s). */
  connectionTestTimeoutMs?: number;
  /** Origins allowed via CORS (native shells); overrides config.allowOrigins; empty = same-origin only. */
  allowOrigins?: string[];
  /** App version reported by /config.js (defaults to package.json's). */
  version?: string;
}

export const JSON_LIMIT_DEFAULT = "1mb";
export const JSON_LIMIT_MESSAGES = "25mb";
/** Cache lifetime for immutable-ish static assets (scripts, styles, icons, vendor). The SW versions its cache. */
export const STATIC_MAX_AGE_S = 3600;

const MESSAGES_PATH_RE = /^\/conversations\/[^/]+\/messages\/?$/;

/** The client bootstrap script: same-origin API by default, version for the SW cache name, demo flag for the UI banner. */
export function renderConfigJs(opts: { apiBase?: string; version: string; demo: boolean }): string {
  const cfg = { apiBase: opts.apiBase ?? "", version: opts.version, demo: opts.demo };
  return `window.APP_CONFIG = { apiBase: ${JSON.stringify(cfg.apiBase)}, version: ${JSON.stringify(cfg.version)}, demo: ${cfg.demo ? "true" : "false"} };\n`;
}

/**
 * Header rules for files under web/: the app shell (index.html) and the service worker are always
 * revalidated so an update reaches phones on the next open; sw.js may control the whole origin; the
 * manifest gets its registered media type; everything else (app.js, styles, vendor, icons) is cached for
 * STATIC_MAX_AGE_S — the service worker's versioned cache handles the rest.
 */
export function staticHeaders(res: Response, filePath: string): void {
  const name = basename(filePath).toLowerCase();
  if (name === "sw.js") {
    res.setHeader("Service-Worker-Allowed", "/");
    res.setHeader("Cache-Control", "no-cache");
    return;
  }
  if (name === "index.html") {
    res.setHeader("Cache-Control", "no-cache");
    return;
  }
  if (extname(name) === ".webmanifest") res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
  res.setHeader("Cache-Control", `public, max-age=${STATIC_MAX_AGE_S}`);
}

/** Build the Express app (routes + static UI). Does not listen. */
export function createApp(appDeps: AppDeps): Express {
  const runtime = appDeps.runtime ?? createRuntime({ client: appDeps.client, config: appDeps.config, demo: appDeps.demo === true });
  // Every router sees the live client/config/demo; a chat turn snapshots them when it starts.
  const deps: AppDeps = {
    ...appDeps,
    runtime,
    get client() {
      return runtime.get().client;
    },
    get config() {
      return runtime.get().config;
    },
    get demo() {
      return runtime.get().demo;
    },
  };
  const { config, kb } = deps;
  const log = deps.log ?? (() => {});
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  const allowOrigins = deps.allowOrigins ?? config.allowOrigins ?? [];
  const version = deps.version ?? readPackageVersion();
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
    const live = runtime.get().config;
    res.json({
      ok: true,
      model: live.claudeModel,
      effort: live.claudeEffort,
      webSearch: live.enableWebSearch,
      fallbacks: live.claudeFallbacks === "default" && isFallbacksSupported() ? "default" : "off",
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
  api.use("/settings", settingsRouter(deps));
  api.use("/usage", usageRouter(deps));
  api.use("/corrections", correctionsRouter(deps));
  api.use(apiNotFound);
  app.use("/api", api);

  // ----- static UI (public paths — config.js, manifest, sw.js, icons — are exempted in authMiddleware) -----
  app.get("/config.js", (_req, res) => {
    const configJs = renderConfigJs({ apiBase: "", version, demo: runtime.get().demo });
    res.type("application/javascript").set("Cache-Control", "no-store").send(configJs);
  });
  app.use(express.static(config.webDir, { index: "index.html", fallthrough: true, etag: true, setHeaders: staticHeaders }));

  app.use(errorHandler(log));
  return app;
}
