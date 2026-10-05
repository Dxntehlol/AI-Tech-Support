import { isAbsolute, relative } from "node:path";
import { createAnthropicClient, type MessagesStreamer } from "./agent/client.ts";
import { createFakeClient } from "./agent/fakeClient.ts";
import { keyHint } from "./agent/connectionTest.ts";
import { KNOWN_MODELS } from "./agent/pricing.ts";
import { PROJECT_ROOT, loadConfig } from "./config.ts";
import type { Runtime, RuntimeState } from "./runtime.ts";
import { MANAGED_KEYS, mergeSettings, readSettings, writeSettings, type ManagedKey, type ManagedSettings } from "./settingsStore.ts";
import type { AppConfig } from "./types.ts";

export type KeySource = "settings" | "env" | "profile" | "none";

/** GET/PUT /api/settings/ai response. Never carries the key itself. */
export interface AiSettingsView {
  demo: boolean;
  model: string;
  effort: AppConfig["claudeEffort"];
  webSearch: boolean;
  keySource: KeySource;
  keyHint: string | null;
  settingsPath: string;
  fakeForced: boolean;
  models: string[];
}

export interface AiSettingsPatch {
  /** undefined = unchanged; null or "" = clear the key saved in the app. */
  apiKey?: string | null;
  /** null = clear (back to .env). */
  model?: string | null;
  effort?: AppConfig["claudeEffort"] | null;
  webSearch?: boolean | null;
}

export interface AiSettings {
  view(): AiSettingsView;
  /** Validate-free: callers validate first (src/routes/settings.ts). Writes settings.env and swaps the runtime. */
  update(patch: AiSettingsPatch): AiSettingsView;
  /**
   * The credentials the test should use when no key is supplied: the effective API key, or
   * `{ apiKey: undefined }` when only an auth token / stored profile exists; null when there is nothing.
   */
  currentCredentials(): { apiKey?: string } | null;
  /** The effective model id (for the connection test). */
  model(): string;
  /** Build the runtime state for the current settings on top of `base` (does not install it). */
  buildState(base: AppConfig): RuntimeState;
}

export interface AiSettingsOptions {
  settingsPath: string;
  runtime: Runtime;
  /**
   * The environment as it was before settings.env was applied (.env + process environment). Only the
   * managed keys, ANTHROPIC_AUTH_TOKEN and CLAUDE_FAKE are read from it.
   */
  baseEnv: Record<string, string | undefined>;
  /** Whether an `ant auth login` profile was found at startup. */
  hasProfile: boolean;
  /** Process env kept in sync with the effective managed values (so the SDK's own env reads agree). Omit in tests. */
  syncEnv?: NodeJS.ProcessEnv;
  makeClient?: (config: AppConfig, opts: { apiKey?: string }) => MessagesStreamer;
  makeFake?: () => MessagesStreamer;
  log?: (msg: string) => void;
}

const truthy = (v: string | undefined): boolean => /^(1|true|yes)$/i.test(v ?? "");

/** Display form of the settings path: relative to the project root when inside it. */
export function displayPath(path: string, root = PROJECT_ROOT): string {
  const rel = relative(root, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : path;
}

/** Config fields the settings control, recomputed with the same parsing rules as loadConfig. */
export function managedConfig(env: Record<string, string | undefined>): Pick<AppConfig, "claudeModel" | "claudeEffort" | "enableWebSearch"> {
  const c = loadConfig(env as NodeJS.ProcessEnv);
  return { claudeModel: c.claudeModel, claudeEffort: c.claudeEffort, enableWebSearch: c.enableWebSearch };
}

export function createAiSettings(opts: AiSettingsOptions): AiSettings {
  const makeClient = opts.makeClient ?? createAnthropicClient;
  const makeFake = opts.makeFake ?? createFakeClient;
  const log = opts.log ?? (() => {});
  const fakeForced = truthy(opts.baseEnv.CLAUDE_FAKE);
  let settings: ManagedSettings = readSettings(opts.settingsPath);

  const effectiveEnv = (): Record<string, string | undefined> => mergeSettings({ ...opts.baseEnv }, settings);

  const keySource = (): KeySource => {
    if (settings.ANTHROPIC_API_KEY) return "settings";
    if (opts.baseEnv.ANTHROPIC_API_KEY?.trim() || opts.baseEnv.ANTHROPIC_AUTH_TOKEN?.trim()) return "env";
    if (opts.hasProfile) return "profile";
    return "none";
  };

  const effectiveKey = (): string | undefined => settings.ANTHROPIC_API_KEY || opts.baseEnv.ANTHROPIC_API_KEY?.trim() || undefined;

  /** Build the runtime state for the current settings (does not install it). */
  const build = (base: AppConfig): RuntimeState => {
    const env = effectiveEnv();
    const config: AppConfig = { ...base, ...managedConfig(env) };
    const demo = fakeForced || keySource() === "none";
    const apiKey = effectiveKey();
    const client = demo ? makeFake() : makeClient(config, apiKey ? { apiKey } : {});
    return { client, config, demo };
  };

  const sync = (): void => {
    if (!opts.syncEnv) return;
    const env = effectiveEnv();
    for (const key of MANAGED_KEYS) {
      const v = env[key];
      if (v === undefined) delete opts.syncEnv[key];
      else opts.syncEnv[key] = v;
    }
  };

  const view = (): AiSettingsView => {
    const state = opts.runtime.get();
    const source = keySource();
    return {
      demo: state.demo,
      model: state.config.claudeModel,
      effort: state.config.claudeEffort,
      webSearch: state.config.enableWebSearch,
      keySource: source,
      keyHint: source === "settings" || source === "env" ? keyHint(effectiveKey() ?? opts.baseEnv.ANTHROPIC_AUTH_TOKEN) : null,
      settingsPath: displayPath(opts.settingsPath),
      fakeForced,
      models: [...KNOWN_MODELS],
    };
  };

  return {
    view,
    update(patch) {
      const updates: Partial<Record<ManagedKey, string | null>> = {};
      if (patch.apiKey !== undefined) updates.ANTHROPIC_API_KEY = patch.apiKey ? patch.apiKey : null;
      if (patch.model !== undefined) updates.CLAUDE_MODEL = patch.model || null;
      if (patch.effort !== undefined) updates.CLAUDE_EFFORT = patch.effort || null;
      if (patch.webSearch !== undefined) updates.ENABLE_WEB_SEARCH = patch.webSearch === null ? null : patch.webSearch ? "1" : "0";
      settings = writeSettings(opts.settingsPath, updates);
      sync();
      const next = build(opts.runtime.get().config);
      opts.runtime.set(next);
      const changed = Object.keys(updates).join(", ") || "nothing";
      log(`AI settings saved (${changed}): model=${next.config.claudeModel} effort=${next.config.claudeEffort} webSearch=${next.config.enableWebSearch ? "on" : "off"} key=${keySource()}${next.demo ? " demo=on" : ""}`);
      return view();
    },
    currentCredentials() {
      const key = effectiveKey();
      if (key) return { apiKey: key };
      const source = keySource();
      return source === "env" || source === "profile" ? {} : null;
    },
    model: () => opts.runtime.get().config.claudeModel,
    buildState: build,
  };
}
