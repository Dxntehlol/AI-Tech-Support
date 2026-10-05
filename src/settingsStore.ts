import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { parseDotEnvText } from "./config.ts";

/**
 * UI-managed settings: `settings.env` next to the database (data/settings.env; /app/data in Docker).
 * Only the keys below are read from it; it overrides .env and the process environment for those keys,
 * and an empty value means "not set by the UI" (no override). Same KEY=value format and quoting rules as
 * .env (src/config.ts parseDotEnvText). Written atomically (temp file + rename), mode 0600.
 */
export const MANAGED_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_MODEL", "CLAUDE_EFFORT", "ENABLE_WEB_SEARCH"] as const;
export type ManagedKey = (typeof MANAGED_KEYS)[number];
export type ManagedSettings = Partial<Record<ManagedKey, string>>;

const MANAGED = new Set<string>(MANAGED_KEYS);

export const SETTINGS_FILE_NAME = "settings.env";
export const SETTINGS_HEADER = [
  "# HVAC Field Assistant: settings saved from the app (Settings → AI connection).",
  "# Values here override .env for ANTHROPIC_API_KEY, CLAUDE_MODEL, CLAUDE_EFFORT and ENABLE_WEB_SEARCH.",
  "# An empty value means \"use .env\". Keep this file private (mode 600): it can hold the API key.",
].join("\n");

/** settings.env lives in the database directory. */
export function settingsPathFor(dbPath: string): string {
  return join(dirname(dbPath), SETTINGS_FILE_NAME);
}

/** Managed keys with a non-empty value. Unknown keys and empty values are ignored. */
export function parseSettings(text: string): ManagedSettings {
  const out: ManagedSettings = {};
  for (const [key, value] of parseDotEnvText(text)) {
    if (MANAGED.has(key) && value !== "") out[key as ManagedKey] = value;
  }
  return out;
}

/** Read settings.env; a missing or unreadable file means no settings. */
export function readSettings(path: string): ManagedSettings {
  try {
    if (!existsSync(path)) return {};
    return parseSettings(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Overlay the settings onto `base` (override semantics, managed keys only, non-empty values only).
 * Returns a new object; `base` is not modified.
 */
export function mergeSettings<T extends Record<string, string | undefined>>(base: T, settings: ManagedSettings): T {
  const out: Record<string, string | undefined> = { ...base };
  for (const key of MANAGED_KEYS) {
    const v = settings[key];
    if (typeof v === "string" && v !== "") out[key] = v;
  }
  return out as T;
}

/** Apply the settings onto an env object in place (process.env at startup). Returns the keys applied. */
export function applySettings(env: NodeJS.ProcessEnv, settings: ManagedSettings): ManagedKey[] {
  const applied: ManagedKey[] = [];
  for (const key of MANAGED_KEYS) {
    const v = settings[key];
    if (typeof v === "string" && v !== "") {
      env[key] = v;
      applied.push(key);
    }
  }
  return applied;
}

/**
 * Format one value so parseDotEnvText reads it back unchanged: plain when it is safe, otherwise wrapped
 * in double quotes (the parser strips one pair of outer quotes and has no escapes, so any value without a
 * line break round-trips). Line breaks are rejected.
 */
export function formatValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Setting values cannot contain line breaks.");
  if (value === "") return "";
  const needsQuotes = /\s|#/.test(value) || /^["']/.test(value) || value !== value.trim();
  return needsQuotes ? `"${value}"` : value;
}

/**
 * Return the file text with `updates` applied: a key set to a string replaces its first `KEY=` line (later
 * duplicates are dropped so the file stays unambiguous) or is appended; `null` writes an empty value
 * (`KEY=`, i.e. no override). Comments, blank lines and other keys are kept as they are.
 */
export function updateSettingsText(text: string, updates: Partial<Record<ManagedKey, string | null>>): string {
  const pending = new Map<ManagedKey, string>();
  for (const key of MANAGED_KEYS) {
    if (!(key in updates)) continue;
    const v = updates[key];
    if (v === undefined) continue;
    pending.set(key, `${key}=${formatValue(v ?? "")}`);
  }
  const lines = text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);
  const written = new Set<ManagedKey>();
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = m?.[1] as ManagedKey | undefined;
    if (key && pending.has(key)) {
      if (written.has(key)) continue;
      out.push(pending.get(key)!);
      written.add(key);
      continue;
    }
    out.push(line);
  }
  for (const [key, line] of pending) if (!written.has(key)) out.push(line);
  return `${out.join("\n")}\n`;
}

/**
 * Write the updates to settings.env atomically: the new text goes to a temp file (mode 0600) in the same
 * directory, which is then renamed over the old one, so a crash never leaves a half-written file.
 */
export function writeSettings(path: string, updates: Partial<Record<ManagedKey, string | null>>): ManagedSettings {
  mkdirSync(dirname(path), { recursive: true });
  let current = "";
  try {
    if (existsSync(path)) current = readFileSync(path, "utf8");
  } catch {
    current = "";
  }
  if (current.trim() === "") current = `${SETTINGS_HEADER}\n`;
  const next = updateSettingsText(current, updates);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, next, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return parseSettings(next);
}
