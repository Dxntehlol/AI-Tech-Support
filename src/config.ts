import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** Project root (works from src/ and from dist/). */
export const PROJECT_ROOT = resolve(here, "..");

/** Minimal .env loader (no dependency). Does not override existing env vars. */
export function loadDotEnv(path = resolve(PROJECT_ROOT, ".env")): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const hash = value.search(/\s#/);
    if (hash >= 0 && !/^["']/.test(value)) value = value.slice(0, hash).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * Parse ALLOW_ORIGINS: comma- or whitespace-separated origins for CORS (native shells such as
 * `capacitor://localhost`). Entries are trimmed, trailing slashes dropped, duplicates removed. Anything
 * that is not `scheme://host[:port]` is ignored (a path or a bare host would never match a browser Origin).
 */
export function parseAllowOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of (raw ?? "").split(/[,\s]+/)) {
    const origin = piece.trim().replace(/\/+$/, "");
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/i.test(origin)) continue;
    const key = origin.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(origin);
  }
  return out;
}

/** Version from package.json (served to the client by /config.js); "0.0.0" when unreadable. */
export function readPackageVersion(root = PROJECT_ROOT): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim() !== "" ? pkg.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const effort = (env.CLAUDE_EFFORT ?? "high").toLowerCase();
  return {
    port: Number.parseInt(env.PORT ?? "8787", 10) || 8787,
    host: env.HOST?.trim() || "127.0.0.1",
    dbPath: resolve(PROJECT_ROOT, env.DB_PATH?.trim() || "./data/hvac.sqlite"),
    appPassword: env.APP_PASSWORD?.trim() || null,
    claudeModel: env.CLAUDE_MODEL?.trim() || "claude-opus-5",
    claudeEffort: (EFFORTS.has(effort) ? effort : "high") as AppConfig["claudeEffort"],
    claudeFallbacks: (env.CLAUDE_FALLBACKS ?? "default").toLowerCase() === "off" ? "off" : "default",
    enableWebSearch: /^(1|true|yes)$/i.test(env.ENABLE_WEB_SEARCH ?? ""),
    maxToolIterations: Number.parseInt(env.MAX_TOOL_ITERATIONS ?? "12", 10) || 12,
    replayImageWindow: Math.max(0, Number.parseInt(env.REPLAY_IMAGE_WINDOW ?? "10", 10) || 0),
    knowledgeDir: resolve(PROJECT_ROOT, "knowledge"),
    webDir: resolve(PROJECT_ROOT, "web"),
    allowOrigins: parseAllowOrigins(env.ALLOW_ORIGINS),
  };
}
