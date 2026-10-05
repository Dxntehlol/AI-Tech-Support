import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { PROJECT_ROOT, loadConfig } from "../config.ts";
import { loadKnowledge } from "../knowledge/loader.ts";
import { openDatabase } from "../db/index.ts";
import { createRepos, type Repos } from "../db/repos.ts";
import { createFakeClient, type FakeClient } from "../agent/fakeClient.ts";
import type { MessagesStreamer, StreamLike, StreamParams } from "../agent/client.ts";
import { isTurnRunning } from "../agent/chat.ts";
import type { ConnectionTester, ConnectionTestInput, ConnectionTestResult } from "../agent/connectionTest.ts";
import { estimateCost } from "../agent/pricing.ts";
import { createAiSettings, type AiSettings } from "../aiSettings.ts";
import { createRuntime, type Runtime } from "../runtime.ts";
import type { AppConfig, ChatEvent, KnowledgeBase } from "../types.ts";
import { createApp } from "../app.ts";
import { isPlausibleApiKey, parseAiSettingsPatch } from "./settings.ts";

const KEY = "sk-ant-test-0000000000000000KEY1";
const KEY2 = "sk-ant-test-1111111111111111KEY2";
const NOW = new Date("2026-09-26T12:00:00Z");

let kb: KnowledgeBase;
before(() => {
  kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });
});

interface Ctx {
  repos: Repos;
  runtime: Runtime;
  ai: AiSettings;
  settingsPath: string;
  logs: string[];
  /** Clients built by makeClient, with the key each was built for. */
  built: { client: FakeClient; apiKey?: string }[];
  testerCalls: ConnectionTestInput[];
  get(path: string): Promise<Response>;
  json(method: string, path: string, body?: unknown): Promise<Response>;
}

interface Opts {
  baseEnv?: Record<string, string | undefined>;
  settingsText?: string;
  hasProfile?: boolean;
  tester?: ConnectionTester;
  intervalMs?: number;
  timeoutMs?: number;
  /** Factory for the real-mode client (default: a scripted fake that answers "Real answer."). */
  realClient?: () => FakeClient;
  config?: Partial<AppConfig>;
}

async function withServer(opts: Opts, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "hvac-ai-settings-"));
  const settingsPath = join(dir, "settings.env");
  if (opts.settingsText !== undefined) writeFileSync(settingsPath, opts.settingsText);
  const db = openDatabase(":memory:");
  const repos = createRepos(db);
  const config: AppConfig = { ...loadConfig({}), dbPath: join(dir, "hvac.sqlite"), ...opts.config };
  const logs: string[] = [];
  const built: Ctx["built"] = [];
  const testerCalls: ConnectionTestInput[] = [];
  const runtime = createRuntime({ client: createFakeClient(), config, demo: true });
  const ai = createAiSettings({
    settingsPath,
    runtime,
    baseEnv: opts.baseEnv ?? {},
    hasProfile: opts.hasProfile ?? false,
    makeClient: (_cfg, o) => {
      const client = opts.realClient ? opts.realClient() : createFakeClient(Array.from({ length: 20 }, () => ({ text: "Real answer.", model: "claude-opus-5" })));
      built.push({ client, apiKey: o.apiKey });
      return client;
    },
    log: (m) => logs.push(m),
  });
  runtime.set(ai.buildState(config));
  const tester: ConnectionTester =
    opts.tester ??
    (async (input) => ({ ok: true, stage: "message", code: "ok", model: input.model, latencyMs: 5, message: "Connected.", availableModels: ["claude-opus-5"] }));
  const app = createApp({
    client: runtime.get().client,
    config,
    kb,
    repos,
    runtime,
    aiSettings: ai,
    connectionTester: async (input) => {
      testerCalls.push(input);
      return tester(input);
    },
    connectionTestIntervalMs: opts.intervalMs ?? 0,
    connectionTestTimeoutMs: opts.timeoutMs,
    log: (m) => logs.push(m),
    now: () => NOW,
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ctx: Ctx = {
    repos,
    runtime,
    ai,
    settingsPath,
    logs,
    built,
    testerCalls,
    get: (path) => fetch(base + path),
    json: (method, path, body) =>
      fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
  };
  try {
    await fn(ctx);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseSse(text: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const line of text.split(/\r?\n/)) if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5).trim()) as ChatEvent);
  return events;
}

async function expectError(res: Response, status: number, code: string): Promise<string> {
  assert.equal(res.status, status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, code);
  return body.error.message;
}

async function newConversation(c: Ctx): Promise<string> {
  return ((await (await c.json("POST", "/api/conversations", {})).json()) as { conversation: { id: string } }).conversation.id;
}

async function chat(c: Ctx, id: string, text: string): Promise<ChatEvent[]> {
  return parseSse(await (await c.json("POST", `/api/conversations/${id}/messages`, { text })).text());
}

type View = {
  demo: boolean;
  model: string;
  effort: string;
  webSearch: boolean;
  keySource: string;
  keyHint: string | null;
  settingsPath: string;
  fakeForced: boolean;
  models: string[];
};

describe("validation helpers", () => {
  test("API key shape", () => {
    assert.equal(isPlausibleApiKey(KEY), true);
    assert.equal(isPlausibleApiKey("sk-ant-short"), false);
    assert.equal(isPlausibleApiKey("sk-xyz-0000000000000000000000"), false);
    assert.equal(isPlausibleApiKey("sk-ant-0000 0000000000000000"), false);
    assert.equal(isPlausibleApiKey(`sk-ant-${"a".repeat(300)}`), false);
  });

  test("patch parsing: trims keys, clears with null/empty, validates model/effort/webSearch", () => {
    assert.deepEqual(parseAiSettingsPatch({ apiKey: ` ${KEY}\n` }), { apiKey: KEY });
    assert.deepEqual(parseAiSettingsPatch({ apiKey: "" }), { apiKey: null });
    assert.deepEqual(parseAiSettingsPatch({ apiKey: null, model: null, effort: "", webSearch: null }), { apiKey: null, model: null, effort: null, webSearch: null });
    assert.deepEqual(parseAiSettingsPatch({ model: "claude-fable-5-1", effort: "xhigh", webSearch: true }), { model: "claude-fable-5-1", effort: "xhigh", webSearch: true });
    assert.throws(() => parseAiSettingsPatch({ apiKey: "hello" }), /sk-ant-/);
    assert.throws(() => parseAiSettingsPatch({ model: "gpt-4" }), /model/);
    assert.throws(() => parseAiSettingsPatch({ model: "claude-Opus" }), /model/);
    assert.throws(() => parseAiSettingsPatch({ effort: "huge" }), /effort/);
    assert.throws(() => parseAiSettingsPatch({ webSearch: "yes" }), /webSearch/);
  });
});

describe("GET/PUT /api/settings/ai", () => {
  test("no credentials: demo, keySource none, no hint; the picker lists catalog models", async () => {
    await withServer({}, async (c) => {
      const v = (await (await c.get("/api/settings/ai")).json()) as View;
      assert.equal(v.demo, true);
      assert.equal(v.keySource, "none");
      assert.equal(v.keyHint, null);
      assert.equal(v.fakeForced, false);
      assert.equal(v.model, "claude-opus-5");
      assert.ok(v.models.includes("claude-opus-5") && v.models.includes("claude-fable-5-1"));
      assert.ok(v.settingsPath.endsWith("settings.env"));
    });
  });

  test("PUT a key: written to settings.env (0600), demo off, hint only, hot-swapped into health and config.js", async () => {
    await withServer({}, async (c) => {
      const res = await c.json("PUT", "/api/settings/ai", { apiKey: KEY, model: "claude-fable-5-1", effort: "medium", webSearch: true });
      assert.equal(res.status, 200);
      const raw = await res.text();
      assert.ok(!raw.includes(KEY), "the key never comes back");
      const v = JSON.parse(raw) as View;
      assert.equal(v.demo, false);
      assert.equal(v.keySource, "settings");
      assert.equal(v.keyHint, "…KEY1");
      assert.equal(v.model, "claude-fable-5-1");
      assert.equal(v.effort, "medium");
      assert.equal(v.webSearch, true);

      const file = readFileSync(c.settingsPath, "utf8");
      assert.match(file, new RegExp(`^ANTHROPIC_API_KEY=${KEY}$`, "m"));
      assert.match(file, /^CLAUDE_MODEL=claude-fable-5-1$/m);
      assert.match(file, /^ENABLE_WEB_SEARCH=1$/m);
      assert.match(file, /^#/, "header comment");
      if (process.platform !== "win32") {
        const { statSync } = await import("node:fs");
        assert.equal(statSync(c.settingsPath).mode & 0o777, 0o600);
      }
      assert.equal(c.built.length, 1);
      assert.equal(c.built[0]!.apiKey, KEY);

      const h = (await (await c.get("/api/health")).json()) as { demo: boolean; model: string; effort: string; webSearch: boolean };
      assert.deepEqual([h.demo, h.model, h.effort, h.webSearch], [false, "claude-fable-5-1", "medium", true]);
      assert.match(await (await c.get("/config.js")).text(), /demo: false/);
      assert.ok(c.logs.every((l) => !l.includes(KEY)), "key never logged");

      // Clearing the key goes back to demo mode (no other credentials).
      const cleared = (await (await c.json("PUT", "/api/settings/ai", { apiKey: null })).json()) as View;
      assert.equal(cleared.demo, true);
      assert.equal(cleared.keySource, "none");
      assert.equal(cleared.model, "claude-fable-5-1", "other settings kept");
      assert.match(await (await c.get("/config.js")).text(), /demo: true/);
      assert.ok(!readFileSync(c.settingsPath, "utf8").includes(KEY));
    });
  });

  test("validation errors use the envelope and leave the file alone", async () => {
    await withServer({}, async (c) => {
      await expectError(await c.json("PUT", "/api/settings/ai", { apiKey: "not-a-key" }), 400, "validation");
      await expectError(await c.json("PUT", "/api/settings/ai", { effort: "turbo" }), 400, "validation");
      await expectError(await c.json("PUT", "/api/settings/ai", { model: "Claude Opus" }), 400, "validation");
      const { existsSync } = await import("node:fs");
      assert.equal(existsSync(c.settingsPath), false);
    });
  });

  test("env key: keySource env with hint; a settings key overrides it; clearing it falls back to the env key", async () => {
    await withServer({ baseEnv: { ANTHROPIC_API_KEY: KEY2, CLAUDE_MODEL: "claude-opus-5-5" } }, async (c) => {
      let v = (await (await c.get("/api/settings/ai")).json()) as View;
      assert.equal(v.keySource, "env");
      assert.equal(v.keyHint, "…KEY2");
      assert.equal(v.demo, false);
      assert.equal(v.model, "claude-opus-5-5");
      v = (await (await c.json("PUT", "/api/settings/ai", { apiKey: KEY })).json()) as View;
      assert.equal(v.keySource, "settings");
      assert.equal(c.built.at(-1)!.apiKey, KEY);
      v = (await (await c.json("PUT", "/api/settings/ai", { apiKey: "", model: null })).json()) as View;
      assert.equal(v.keySource, "env");
      assert.equal(v.model, "claude-opus-5-5", "cleared model falls back to the env value");
      assert.equal(c.built.at(-1)!.apiKey, KEY2);
    });
  });

  test("settings.env present at startup overrides env; empty values do not", async () => {
    await withServer(
      { baseEnv: { CLAUDE_MODEL: "claude-opus-5-5", CLAUDE_EFFORT: "max" }, settingsText: `ANTHROPIC_API_KEY=${KEY}\nCLAUDE_MODEL=claude-fable-5-1\nCLAUDE_EFFORT=\nAPP_PASSWORD=ignored\n` },
      async (c) => {
        const v = (await (await c.get("/api/settings/ai")).json()) as View;
        assert.equal(v.keySource, "settings");
        assert.equal(v.model, "claude-fable-5-1");
        assert.equal(v.effort, "max");
        assert.equal(v.demo, false);
      },
    );
  });

  test("stored profile counts as credentials; CLAUDE_FAKE=1 still saves but reports fakeForced and stays demo", async () => {
    await withServer({ hasProfile: true }, async (c) => {
      const v = (await (await c.get("/api/settings/ai")).json()) as View;
      assert.equal(v.keySource, "profile");
      assert.equal(v.keyHint, null);
      assert.equal(v.demo, false);
    });
    await withServer({ baseEnv: { CLAUDE_FAKE: "1" } }, async (c) => {
      const v = (await (await c.json("PUT", "/api/settings/ai", { apiKey: KEY })).json()) as View;
      assert.equal(v.fakeForced, true);
      assert.equal(v.demo, true);
      assert.equal(v.keySource, "settings");
      assert.match(readFileSync(c.settingsPath, "utf8"), /ANTHROPIC_API_KEY=/);
      assert.equal(c.built.length, 0, "no real client while CLAUDE_FAKE=1");
    });
  });
});

describe("hot swap and the chat loop", () => {
  test("an in-flight turn keeps the client it started with; the next turn uses the new one", async () => {
    let release: (() => void) | null = null;
    const slow: MessagesStreamer & { calls: number } = {
      calls: 0,
      stream(_p: StreamParams, _o?: { signal?: AbortSignal }): StreamLike {
        slow.calls += 1;
        const final = new Promise<Anthropic.Beta.BetaMessage>((resolve) => {
          release = () =>
            resolve({
              id: "m",
              type: "message",
              role: "assistant",
              model: "claude-opus-5",
              content: [{ type: "text", text: "Slow answer." }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 5 },
            } as unknown as Anthropic.Beta.BetaMessage);
        });
        return {
          on() {
            return this;
          },
          finalMessage: () => final,
          abort() {},
        };
      },
    };
    let first = true;
    await withServer(
      {
        baseEnv: { ANTHROPIC_API_KEY: KEY2 },
        realClient: () => {
          if (first) {
            first = false;
            return slow as unknown as FakeClient;
          }
          return createFakeClient([{ text: "New client answer.", model: "claude-opus-5" }]);
        },
      },
      async (c) => {
        assert.equal(c.runtime.get().client, slow);
        const id = await newConversation(c);
        const pending = c.json("POST", `/api/conversations/${id}/messages`, { text: "first question" });
        const res = await pending;
        assert.equal(res.status, 200);
        while (!isTurnRunning(id)) await new Promise((r) => setTimeout(r, 5));
        // Swap mid-turn.
        await c.json("PUT", "/api/settings/ai", { apiKey: KEY });
        assert.notEqual(c.runtime.get().client, slow);
        // The busy lock still holds across the swap.
        await expectError(await c.json("POST", `/api/conversations/${id}/messages`, { text: "again" }), 409, "busy");
        release!();
        const ev = parseSse(await res.text());
        assert.equal(ev.at(-1)?.type, "done");
        const next = await chat(c, id, "second question");
        assert.equal(next.at(-1)?.type, "done");
        assert.equal(slow.calls, 1);
        const newClient = c.built.at(-1)!.client;
        assert.equal(newClient.calls.length, 1);
        const texts = c.repos.messages.list(id).map((m) => m.text);
        assert.deepEqual(texts.filter((t) => /answer/.test(t)), ["Slow answer.", "New client answer."]);
      },
    );
  });

  test("usage: not recorded in demo mode; recorded per request with a real client and reported by /api/usage", async () => {
    await withServer(
      {
        realClient: () =>
          createFakeClient([
            {
              text: "Answer.",
              model: "claude-opus-5",
              usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300, server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } as Anthropic.Beta.BetaServerToolUsage },
            },
          ]),
      },
      async (c) => {
        const id = await newConversation(c);
        assert.equal((await chat(c, id, "demo question")).at(-1)?.type, "done");
        assert.equal(c.repos.usage.listSince("2000-01-01").length, 0, "demo turns are not recorded");

        await c.json("PUT", "/api/settings/ai", { apiKey: KEY });
        assert.equal((await chat(c, id, "real question")).at(-1)?.type, "done");
        const rows = c.repos.usage.listSince("2000-01-01");
        assert.equal(rows.length, 1);
        const r = rows[0]!;
        assert.deepEqual(
          [r.conversation_id, r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.web_searches, r.stop_reason],
          [id, "claude-opus-5", 1000, 200, 5000, 300, 2, "end_turn"],
        );

        // Usage rows at fixed times relative to NOW (the app clock).
        c.repos.usage.record({ conversation_id: null, model: "claude-sonnet-5", input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, web_searches: 0, stop_reason: "end_turn", created_at: NOW.toISOString() });
        c.repos.usage.record({ conversation_id: null, model: "claude-opus-5", input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, web_searches: 0, stop_reason: "end_turn", created_at: "2026-01-01T12:00:00Z" });

        type U = { days: number; totals: { requests: number; estimatedCostUsd: number | null; costComplete: boolean; webSearches: number }; byDay: unknown[]; byModel: { model: string }[]; perConversationAvgUsd: number | null; priceLabel: string };
        const u = (await (await c.get("/api/usage?days=7")).json()) as U;
        assert.equal(u.days, 7);
        assert.equal(u.byDay.length, 7);
        assert.equal(u.priceLabel, "estimated at list price");
        // The chat row is stamped with the real clock (now), so only count what falls in the window.
        const inWindow = u.totals.requests;
        assert.ok(inWindow >= 1);
        assert.equal(u.totals.costComplete, false, "claude-sonnet-5 has no list price here");
        const def = (await (await c.get("/api/usage")).json()) as U;
        assert.equal(def.days, 30);
        const clamped = (await (await c.get("/api/usage?days=5000")).json()) as U;
        assert.equal(clamped.days, 365);
        assert.ok(clamped.totals.requests >= 2);
        const expected = estimateCost({ model: "claude-opus-5", input_tokens: 1000, output_tokens: 200, cache_read_tokens: 5000, cache_write_tokens: 300, web_searches: 2 })!;
        assert.ok(Math.abs(expected - 0.034375) < 1e-9, String(expected));
      },
    );
  });

  test("a failing usage write never breaks the turn", async () => {
    await withServer({ baseEnv: { ANTHROPIC_API_KEY: KEY2 } }, async (c) => {
      c.repos.usage.record = () => {
        throw new Error("disk full");
      };
      const id = await newConversation(c);
      assert.equal((await chat(c, id, "question")).at(-1)?.type, "done");
      assert.ok(c.logs.some((l) => /usage record failed: disk full/.test(l)));
    });
  });
});

describe("POST /api/settings/ai/test", () => {
  test("tests a supplied key without saving it; the key is scrubbed from the result", async () => {
    await withServer(
      {
        tester: async (input) => ({ ok: false, stage: "auth", code: "invalid_key", model: input.model, latencyMs: 3, message: `Rejected ${input.apiKey}` }),
      },
      async (c) => {
        const res = await c.json("POST", "/api/settings/ai/test", { apiKey: KEY });
        assert.equal(res.status, 200);
        const raw = await res.text();
        assert.ok(!raw.includes(KEY));
        const r = JSON.parse(raw) as ConnectionTestResult;
        assert.equal(r.code, "invalid_key");
        assert.match(r.message, /sk-ant-…KEY1|…KEY1/);
        assert.equal(c.testerCalls[0]!.apiKey, KEY);
        assert.equal(c.testerCalls[0]!.model, "claude-opus-5");
        const { existsSync } = await import("node:fs");
        assert.equal(existsSync(c.settingsPath), false, "testing does not save");
      },
    );
  });

  test("no key anywhere → no_key without calling the tester; bad key shape → 400", async () => {
    await withServer({}, async (c) => {
      const r = (await (await c.json("POST", "/api/settings/ai/test", {})).json()) as ConnectionTestResult;
      assert.equal(r.ok, false);
      assert.equal(r.code, "no_key");
      assert.equal(c.testerCalls.length, 0);
      await expectError(await c.json("POST", "/api/settings/ai/test", { apiKey: "nope" }), 400, "validation");
    });
  });

  test("current credentials: settings key, else default chain for a profile", async () => {
    await withServer({ settingsText: `ANTHROPIC_API_KEY=${KEY}\nCLAUDE_MODEL=claude-fable-5-1\n` }, async (c) => {
      const r = (await (await c.json("POST", "/api/settings/ai/test", {})).json()) as ConnectionTestResult;
      assert.equal(r.ok, true);
      assert.equal(c.testerCalls[0]!.apiKey, KEY);
      assert.equal(c.testerCalls[0]!.model, "claude-fable-5-1");
      assert.ok(c.testerCalls[0]!.timeoutMs > 0);
    });
    await withServer({ hasProfile: true }, async (c) => {
      await c.json("POST", "/api/settings/ai/test", {});
      assert.equal(c.testerCalls.length, 1);
      assert.equal(c.testerCalls[0]!.apiKey, undefined);
    });
  });

  test("rate limited to one call per interval (429 envelope)", async () => {
    await withServer({ intervalMs: 60_000, baseEnv: { ANTHROPIC_API_KEY: KEY2 } }, async (c) => {
      assert.equal((await c.json("POST", "/api/settings/ai/test", {})).status, 200);
      await expectError(await c.json("POST", "/api/settings/ai/test", {}), 429, "rate_limited");
      assert.equal(c.testerCalls.length, 1);
    });
  });

  test("a tester that hangs is cut off by the timeout; a thrown error maps to a code", async () => {
    await withServer({ timeoutMs: 50, baseEnv: { ANTHROPIC_API_KEY: KEY2 }, tester: () => new Promise(() => {}) }, async (c) => {
      const r = (await (await c.json("POST", "/api/settings/ai/test", {})).json()) as ConnectionTestResult;
      assert.equal(r.code, "network");
      assert.equal(r.ok, false);
    });
    await withServer({ baseEnv: { ANTHROPIC_API_KEY: KEY2 }, tester: async () => Promise.reject(new Error(`exploded with ${KEY2}`)) }, async (c) => {
      const raw = await (await c.json("POST", "/api/settings/ai/test", {})).text();
      assert.ok(!raw.includes(KEY2));
      assert.equal((JSON.parse(raw) as ConnectionTestResult).code, "unknown");
    });
  });

  test("routes need the password when one is set", async () => {
    await withServer({ config: { appPassword: "pw" } }, async (c) => {
      await expectError(await c.get("/api/settings/ai"), 401, "auth");
      await expectError(await c.get("/api/usage"), 401, "auth");
    });
  });
});
