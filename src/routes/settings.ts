import { Router } from "express";
import type { AppDeps } from "../app.ts";
import type { AiSettingsPatch } from "../aiSettings.ts";
import {
  CONNECTION_TEST_TIMEOUT_MS,
  defaultConnectionTester,
  describeConnectionError,
  scrubKeys,
  type ConnectionTestResult,
} from "../agent/connectionTest.ts";
import { body, HttpError, sendError } from "./util.ts";

export const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
export const MODEL_ID_RE = /^claude-[a-z0-9-]+$/;
export const CONNECTION_TEST_INTERVAL_MS = 3000;

/** An Anthropic API key: starts "sk-ant-", no whitespace, 20–300 characters. */
export function isPlausibleApiKey(key: string): boolean {
  return key.startsWith("sk-ant-") && !/\s/.test(key) && key.length >= 20 && key.length <= 300;
}

const KEY_FORMAT_MESSAGE = "That doesn't look like an Anthropic API key: it should start with sk-ant- and have no spaces.";

/** Parse a key from the body: trimmed (phones paste trailing spaces/newlines); "" and null mean "clear". */
function parseKey(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, "validation", "apiKey must be a string or null.");
  const key = v.trim();
  if (key === "") return null;
  if (!isPlausibleApiKey(key)) throw new HttpError(400, "validation", KEY_FORMAT_MESSAGE);
  return key;
}

/** Validate a PUT /api/settings/ai body. */
export function parseAiSettingsPatch(b: Record<string, unknown>): AiSettingsPatch {
  const patch: AiSettingsPatch = {};
  const apiKey = parseKey(b.apiKey);
  if (apiKey !== undefined) patch.apiKey = apiKey;
  if (b.model !== undefined) {
    if (b.model === null || b.model === "") patch.model = null;
    else if (typeof b.model !== "string" || b.model.length > 100 || !MODEL_ID_RE.test(b.model.trim())) {
      throw new HttpError(400, "validation", "model must be a Claude model id such as claude-opus-5.");
    } else patch.model = b.model.trim();
  }
  if (b.effort !== undefined) {
    if (b.effort === null || b.effort === "") patch.effort = null;
    else if (typeof b.effort !== "string" || !(EFFORT_VALUES as readonly string[]).includes(b.effort)) {
      throw new HttpError(400, "validation", `effort must be one of: ${EFFORT_VALUES.join(", ")}.`);
    } else patch.effort = b.effort as AiSettingsPatch["effort"];
  }
  if (b.webSearch !== undefined) {
    if (b.webSearch !== null && typeof b.webSearch !== "boolean") throw new HttpError(400, "validation", "webSearch must be true, false or null.");
    patch.webSearch = b.webSearch;
  }
  return patch;
}

function scrubResult(r: ConnectionTestResult, testedKey: string | undefined): ConnectionTestResult {
  const clean = (s: string): string => {
    let out = scrubKeys(s);
    if (testedKey) out = out.split(testedKey).join(`…${testedKey.slice(-4)}`);
    return out;
  };
  return { ...r, message: clean(r.message), ...(r.suggestion ? { suggestion: clean(r.suggestion) } : {}) };
}

/** /api/settings/ai: the AI connection a technician can finish from the phone (DESIGN.md "In-app AI connection"). */
export function settingsRouter(deps: AppDeps): Router {
  const r = Router();
  const log = deps.log ?? (() => {});
  const tester = deps.connectionTester ?? defaultConnectionTester;
  const interval = deps.connectionTestIntervalMs ?? CONNECTION_TEST_INTERVAL_MS;
  const timeoutMs = deps.connectionTestTimeoutMs ?? CONNECTION_TEST_TIMEOUT_MS;
  let lastTestAt = -Infinity;

  const manager = () => {
    if (!deps.aiSettings) throw new HttpError(503, "unavailable", "AI settings are not available on this server.");
    return deps.aiSettings;
  };

  r.get("/ai", (_req, res) => {
    res.json(manager().view());
  });

  r.put("/ai", (req, res) => {
    const m = manager();
    const patch = parseAiSettingsPatch(body(req));
    try {
      res.json(m.update(patch));
    } catch (err) {
      log(`AI settings save failed: ${scrubKeys(err instanceof Error ? err.message : String(err))}`);
      throw new HttpError(500, "internal", "Could not save the settings file. Check that the data folder is writable.");
    }
  });

  r.post("/ai/test", async (req, res) => {
    const m = manager();
    const b = body(req);
    let apiKey: string | undefined;
    if (b.apiKey !== undefined && b.apiKey !== null && !(typeof b.apiKey === "string" && b.apiKey.trim() === "")) {
      if (typeof b.apiKey !== "string" || !isPlausibleApiKey(b.apiKey.trim())) throw new HttpError(400, "validation", KEY_FORMAT_MESSAGE);
      apiKey = b.apiKey.trim();
    }
    const now = Date.now();
    if (now - lastTestAt < interval) {
      sendError(res, 429, "rate_limited", "Wait a few seconds before testing again.");
      return;
    }
    lastTestAt = now;

    const model = m.model();
    const creds = apiKey ? { apiKey } : m.currentCredentials();
    if (!creds) {
      const result: ConnectionTestResult = {
        ok: false,
        stage: "auth",
        model,
        latencyMs: 0,
        code: "no_key",
        message: "No API key is set. Paste your Anthropic API key above, then test again.",
      };
      res.json(result);
      return;
    }

    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ConnectionTestResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            stage: "auth",
            model,
            latencyMs: Date.now() - started,
            code: "network",
            message: "Anthropic did not answer in time. Check this server's internet connection and try again.",
          }),
        timeoutMs,
      );
      timer.unref?.();
    });
    let result: ConnectionTestResult;
    try {
      result = await Promise.race([tester({ ...creds, model, timeoutMs }), timeout]);
    } catch (err) {
      result = { ok: false, stage: "auth", model, latencyMs: Date.now() - started, ...describeConnectionError(err, model) };
    } finally {
      clearTimeout(timer);
    }
    result = scrubResult(result, creds.apiKey);
    log(`AI connection test: ${result.code} stage=${result.stage} model=${result.model} ${result.latencyMs} ms`);
    res.json(result);
  });

  return r;
}
