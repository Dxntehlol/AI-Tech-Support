import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { PROJECT_ROOT } from "../config.ts";
import { loadKnowledge } from "../knowledge/loader.ts";
import { openDatabase } from "../db/index.ts";
import { createRepos, type Repos } from "../db/repos.ts";
import type { AppConfig, ChatEvent, KnowledgeBase, MessageRow } from "../types.ts";
import { createFakeClient, type FakeClient, type FakeTurn } from "./fakeClient.ts";
import {
  buildApiMessages,
  IMAGE_PLACEHOLDER,
  INTERRUPTED_TOOL_MESSAGE,
  isFallbacksSupported,
  isTurnRunning,
  runTurn,
  setFallbacksSupported,
  stopTurn,
  toApiContent,
  turnsInFlight,
  type ChatDeps,
} from "./chat.ts";

const NOW = new Date("2026-09-26T12:00:00Z");
const CARRIER_MODEL = "48TCDA04A2A5-0A0A0";

let kb: KnowledgeBase;
before(() => {
  kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });
});
beforeEach(() => setFallbacksSupported(true));

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dbPath: ":memory:",
    appPassword: null,
    claudeModel: "claude-opus-5",
    claudeEffort: "high",
    claudeFallbacks: "default",
    enableWebSearch: false,
    maxToolIterations: 4,
    replayImageWindow: 2,
    knowledgeDir: join(PROJECT_ROOT, "knowledge"),
    webDir: join(PROJECT_ROOT, "web"),
    ...overrides,
  };
}

interface Harness {
  repos: Repos;
  client: FakeClient;
  deps: ChatDeps;
  events: ChatEvent[];
  logs: string[];
  conversationId: string;
  run(text: string, images?: { media_type: "image/jpeg"; data: string }[]): Promise<ChatEvent[]>;
  rows(): MessageRow[];
}

function harness(turns: FakeTurn[] | undefined, opts: { config?: Partial<AppConfig>; unitId?: string | null; withUnit?: boolean } = {}): Harness {
  const repos = createRepos(openDatabase(":memory:"));
  let unitId: string | null = opts.unitId ?? null;
  if (opts.withUnit) {
    const unit = repos.units.create({ model: CARRIER_MODEL, unit_tag: "RTU-7", site: "Pharmacy", refrigerant: "R-410A" });
    repos.findings.create({ unit_id: unit.id, symptom: "Bad contactor", resolution: "Replaced", service_date: "2025-05-01" });
    unitId = unit.id;
  }
  const conv = repos.conversations.create({ unit_id: unitId });
  const client = createFakeClient(turns);
  const events: ChatEvent[] = [];
  const logs: string[] = [];
  const deps: ChatDeps = { client, config: config(opts.config), kb, repos, log: (m) => logs.push(m), now: () => NOW };
  return {
    repos,
    client,
    deps,
    events,
    logs,
    conversationId: conv.id,
    async run(text, images) {
      const mine: ChatEvent[] = [];
      await runTurn(deps, conv.id, { text, images }, (e) => {
        mine.push(e);
        events.push(e);
      });
      return mine;
    },
    rows: () => repos.messages.list(conv.id),
  };
}

function terminal(events: ChatEvent[]): ChatEvent[] {
  return events.filter((e) => e.type === "done" || e.type === "error");
}

function types(events: ChatEvent[]): string[] {
  return events.map((e) => e.type);
}

function blocks(row: MessageRow): Record<string, unknown>[] {
  return JSON.parse(row.content_json) as Record<string, unknown>[];
}

function apiError(status: number, message: string): Error {
  return Anthropic.APIError.generate(status, { error: { type: "invalid_request_error", message } }, message, new Headers());
}

// ---------------------------------------------------------------------------
// (1) plain answer
// ---------------------------------------------------------------------------

test("plain answer: 2 rows, delta…done with model and usage", async () => {
  const h = harness([{ text: "Check the filters first.", usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 90 } }]);
  const events = await h.run("Unit is not cooling");
  const rows = h.rows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.role, "user");
  assert.equal(rows[0]!.kind, "chat");
  assert.equal(rows[0]!.text, "Unit is not cooling");
  assert.deepEqual(blocks(rows[0]!), [{ type: "text", text: "Unit is not cooling" }]);
  assert.equal(rows[1]!.role, "assistant");
  assert.equal(rows[1]!.text, "Check the filters first.");
  assert.equal(blocks(rows[1]!)[0]!.type, "text");

  const deltas = events.filter((e): e is Extract<ChatEvent, { type: "delta" }> => e.type === "delta");
  assert.ok(deltas.length >= 1);
  assert.equal(deltas.map((d) => d.text).join(""), "Check the filters first.");
  const term = terminal(events);
  assert.equal(term.length, 1, "exactly one terminal event");
  const done = term[0]!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.conversationId, h.conversationId);
  assert.deepEqual(done.messageIds, rows.map((r) => r.id));
  assert.equal(done.model, "fake-claude");
  assert.deepEqual(done.usage, { input: 120, output: 30, cacheRead: 90 });
  assert.equal(types(events)[types(events).length - 1], "done");
  assert.ok(h.logs.some((l) => /cache_read_input_tokens=90/.test(l)), "cache read logged");
  assert.equal(isTurnRunning(h.conversationId), false);
  assert.equal(turnsInFlight(), 0);

  // request shape
  const params = h.client.calls[0]! as unknown as Record<string, unknown>;
  assert.equal(params.model, "claude-opus-5");
  assert.equal(params.max_tokens, 16000);
  assert.deepEqual(params.thinking, { type: "adaptive" });
  assert.deepEqual(params.output_config, { effort: "high" });
  const system = params.system as { type: string; text: string; cache_control?: unknown }[];
  assert.equal(system.length, 1, "no unit → single system block");
  assert.deepEqual(system[0]!.cache_control, { type: "ephemeral" });
  const tools = params.tools as { name: string; cache_control?: unknown; type?: string }[];
  assert.ok(tools.length >= 13);
  assert.deepEqual(tools[tools.length - 1]!.cache_control, { type: "ephemeral" }, "last custom tool cached");
  assert.ok(!tools.some((t) => t.name === "web_search"), "web search off");
  assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(params.fallbacks, "default");
});

test("web search tool is appended when enabled; fallbacks omitted when off", async () => {
  const h = harness([{ text: "ok" }], { config: { enableWebSearch: true, claudeFallbacks: "off" } });
  await h.run("hi");
  const params = h.client.calls[0]! as unknown as Record<string, unknown>;
  const tools = params.tools as { name: string; type?: string; max_uses?: number; cache_control?: unknown }[];
  const last = tools[tools.length - 1]!;
  assert.deepEqual(last, { type: "web_search_20260209", name: "web_search", max_uses: 5 });
  assert.deepEqual(tools[tools.length - 2]!.cache_control, { type: "ephemeral" }, "cache_control stays on the last custom tool");
  assert.equal(params.betas, undefined);
  assert.equal(params.fallbacks, undefined);
  const system = params.system as { text: string }[];
  assert.match(system[0]!.text, /Web search is enabled/);
});

// ---------------------------------------------------------------------------
// (2) tool-call turn
// ---------------------------------------------------------------------------

test("tool-call turn: rows, events and replay pairing", async () => {
  const h = harness([
    { text: "Let me look that up.", toolCalls: [{ name: "refrigerant_pt", input: { refrigerant: "R-410A", psig: 118 } }] },
    { text: "118 psig on R-410A is about 40 °F saturated." },
  ]);
  const events = await h.run("What is 118 psig on 410A?");
  const rows = h.rows();
  assert.deepEqual(
    rows.map((r) => [r.role, r.kind]),
    [
      ["user", "chat"],
      ["assistant", "chat"],
      ["user", "tool_result"],
      ["assistant", "chat"],
    ],
  );
  const toolUse = blocks(rows[1]!).find((b) => b.type === "tool_use")!;
  assert.equal(toolUse.name, "refrigerant_pt");
  assert.equal(rows[2]!.text, "");
  const resultBlocks = blocks(rows[2]!);
  assert.equal(resultBlocks.length, 1);
  assert.equal(resultBlocks[0]!.type, "tool_result");
  assert.equal(resultBlocks[0]!.tool_use_id, toolUse.id);
  assert.equal(resultBlocks[0]!.is_error, undefined);
  assert.ok(typeof resultBlocks[0]!.content === "string" && JSON.parse(resultBlocks[0]!.content as string).refrigerant === "R-410A");
  assert.equal(rows[3]!.text, "118 psig on R-410A is about 40 °F saturated.");

  const t = types(events);
  const iStart = t.indexOf("tool_start");
  const iEnd = t.indexOf("tool_end");
  const iDone = t.indexOf("done");
  assert.ok(iStart >= 0 && iEnd > iStart && iDone > iEnd, `order ${t.join(",")}`);
  assert.ok(t.slice(iEnd + 1, iDone).includes("delta"), "final answer streamed after tool_end");
  const start = events[iStart] as Extract<ChatEvent, { type: "tool_start" }>;
  assert.equal(start.id, toolUse.id);
  assert.equal(start.label, "PT: R-410A 118 psig");
  const end = events[iEnd] as Extract<ChatEvent, { type: "tool_end" }>;
  assert.equal(end.ok, true);
  assert.match(end.summary, /PT: R-410A 118 psig → /);
  assert.equal(terminal(events).length, 1);
  const done = terminal(events)[0] as Extract<ChatEvent, { type: "done" }>;
  assert.deepEqual(done.messageIds, rows.map((r) => r.id));
  assert.deepEqual(done.usage, { input: 200, output: 100, cacheRead: 0 }, "usage summed across iterations");

  // second request replays the tool_use → tool_result pair
  assert.equal(h.client.calls.length, 2);
  const messages = h.client.calls[1]!.messages;
  assert.equal(messages.length, 3);
  assert.equal(messages[1]!.role, "assistant");
  assert.equal(messages[2]!.role, "user");
  const replayed = (messages[2]!.content as { type: string; tool_use_id?: string }[]).find((b) => b.type === "tool_result")!;
  assert.equal(replayed.tool_use_id, toolUse.id);
  const replayedToolUse = (messages[1]!.content as { type: string; id?: string }[]).find((b) => b.type === "tool_use")!;
  assert.equal(replayedToolUse.id, toolUse.id);
});

test("tool errors are persisted with is_error and tool_end ok=false; side effects attach the unit and set the title", async () => {
  const h = harness([
    {
      toolCalls: [
        { name: "update_unit", input: { circuits: 2 } },
        { name: "decode_unit", input: { model: CARRIER_MODEL, serial: "3216E54321", save: true, unit_tag: "RTU-7" } },
        { name: "update_unit", input: { circuits: 2 } },
        { name: "set_conversation", input: { title: "RTU-7 checkout", summary: "Decoded and saved." } },
      ],
    },
    { text: "Saved." },
  ]);
  const events = await h.run("Here is the plate");
  const results = blocks(h.rows()[2]!);
  assert.equal(results.length, 4);
  assert.equal(results[0]!.is_error, true, "update before attach fails");
  assert.equal(results[1]!.is_error, undefined);
  assert.equal(results[2]!.is_error, undefined, "update after attach succeeds in the same batch");
  const ends = events.filter((e): e is Extract<ChatEvent, { type: "tool_end" }> => e.type === "tool_end");
  assert.deepEqual(
    ends.map((e) => e.ok),
    [false, true, true, true],
  );
  const attached = events.find((e): e is Extract<ChatEvent, { type: "unit_attached" }> => e.type === "unit_attached")!;
  assert.ok(attached);
  const conv = h.repos.conversations.get(h.conversationId)!;
  assert.equal(conv.unit_id, attached.unitId);
  assert.equal(conv.title, "RTU-7 checkout");
  assert.equal(conv.summary, "Decoded and saved.");
  assert.equal(h.repos.units.get(attached.unitId)!.circuits, 2);
  // the second request carries the unit context block now that a unit is attached
  assert.equal((h.client.calls[1]!.system as unknown[]).length, 2);
});

// ---------------------------------------------------------------------------
// (3) unit context
// ---------------------------------------------------------------------------

test("unit context block is the second system block when the conversation has a unit", async () => {
  const h = harness([{ text: "ok" }], { withUnit: true });
  await h.run("hello");
  const system = h.client.calls[0]!.system as { type: string; text: string; cache_control?: unknown }[];
  assert.equal(system.length, 2);
  assert.equal(system[1]!.cache_control, undefined, "unit block is not cached");
  assert.match(system[1]!.text, /UNIT ATTACHED/);
  assert.match(system[1]!.text, /RTU-7/);
  assert.match(system[1]!.text, /Bad contactor/);
});

// ---------------------------------------------------------------------------
// (4) busy
// ---------------------------------------------------------------------------

test("busy: a concurrent second runTurn errors busy and does not persist", async () => {
  const h = harness([{ text: "first answer" }]);
  const first = h.run("one");
  assert.equal(isTurnRunning(h.conversationId), true);
  assert.equal(turnsInFlight(), 1);
  const second = await h.run("two");
  assert.deepEqual(types(second), ["error"]);
  assert.equal((second[0] as Extract<ChatEvent, { type: "error" }>).code, "busy");
  await first;
  assert.equal(h.rows().length, 2);
  assert.equal(h.rows()[0]!.text, "one");
  assert.equal(isTurnRunning(h.conversationId), false);
});

test("unknown conversation → error not_found", async () => {
  const h = harness([{ text: "x" }]);
  const events: ChatEvent[] = [];
  await runTurn(h.deps, "0123456789abcdef", { text: "hi" }, (e) => events.push(e));
  assert.deepEqual(types(events), ["error"]);
  assert.equal((events[0] as Extract<ChatEvent, { type: "error" }>).code, "not_found");
});

test("empty input → validation error, nothing persisted", async () => {
  const h = harness([{ text: "x" }]);
  const events = await h.run("   ");
  assert.equal((events[0] as Extract<ChatEvent, { type: "error" }>).code, "validation");
  assert.equal(h.rows().length, 0);
});

// ---------------------------------------------------------------------------
// (5) title
// ---------------------------------------------------------------------------

test("title is auto-set from the first user text (60 chars, whitespace collapsed) only while it is 'New conversation'", async () => {
  const h = harness([{ text: "a" }, { text: "b" }]);
  const long = "RTU-7   on the  pharmacy roof\nis short cycling and the breaker trips every twenty minutes";
  await h.run(long);
  const title1 = h.repos.conversations.get(h.conversationId)!.title;
  assert.ok(title1.length <= 60);
  assert.equal(title1, "RTU-7 on the pharmacy roof is short cycling and the breaker");
  await h.run("Another question that must not change the title");
  assert.equal(h.repos.conversations.get(h.conversationId)!.title, title1);
});

test("image-only first message titles 'Photo of nameplate' and persists the image block before the text", async () => {
  const h = harness([{ text: "a" }, { text: "b" }]);
  const png = Buffer.from("fake").toString("base64");
  await h.run("", [{ media_type: "image/jpeg", data: png }]);
  assert.equal(h.repos.conversations.get(h.conversationId)!.title, "Photo of nameplate");
  assert.deepEqual(blocks(h.rows()[0]!), [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: png } }]);
  await h.run("and this text", [{ media_type: "image/jpeg", data: png }]);
  const b = blocks(h.rows()[2]!);
  assert.equal(b[0]!.type, "image");
  assert.deepEqual(b[1], { type: "text", text: "and this text" });
  assert.equal(h.rows()[2]!.text, "and this text");
});

// ---------------------------------------------------------------------------
// (6) refusal
// ---------------------------------------------------------------------------

test("refusal → error refusal with the explanation, no assistant row, no tools run", async () => {
  const h = harness([
    {
      text: "",
      toolCalls: [{ name: "refrigerant_pt", input: { refrigerant: "R-410A", psig: 118 } }],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "general_harms", explanation: "Cannot help with that.", fallback_credit_token: null } as unknown as Anthropic.Beta.BetaMessage["stop_details"],
    },
  ]);
  const events = await h.run("do something bad");
  const term = terminal(events);
  assert.equal(term.length, 1);
  assert.deepEqual(term[0], { type: "error", code: "refusal", message: "The model declined: Cannot help with that." });
  assert.equal(h.rows().length, 1, "only the user row");
  assert.ok(!events.some((e) => e.type === "tool_start"));
});

test("refusal without explanation uses a generic message", async () => {
  const h = harness([{ text: "no", stop_reason: "refusal" }]);
  const events = await h.run("x");
  assert.equal((terminal(events)[0] as Extract<ChatEvent, { type: "error" }>).message, "The model declined to answer this request.");
});

// ---------------------------------------------------------------------------
// (7) iteration cap
// ---------------------------------------------------------------------------

test("iteration cap → error iteration_cap after maxToolIterations requests", async () => {
  const call = { name: "refrigerant_pt", input: { refrigerant: "R-410A", psig: 118 } };
  const h = harness(
    Array.from({ length: 10 }, () => ({ toolCalls: [call] })),
    { config: { maxToolIterations: 3 } },
  );
  const events = await h.run("loop");
  const term = terminal(events);
  assert.equal(term.length, 1);
  assert.equal((term[0] as Extract<ChatEvent, { type: "error" }>).code, "iteration_cap");
  assert.equal(h.client.calls.length, 3);
  // user + 3 × (assistant + tool_result)
  assert.equal(h.rows().length, 7);
  assert.equal(events.filter((e) => e.type === "tool_end").length, 3);
});

// ---------------------------------------------------------------------------
// (8) fallback retry
// ---------------------------------------------------------------------------

test("BadRequestError mentioning fallback on the first request → retry without fallbacks + notice; later turns skip fallbacks", async () => {
  const err = new Anthropic.BadRequestError(400, { error: { type: "invalid_request_error", message: "fallbacks not supported" } }, "fallbacks not supported", new Headers());
  const h = harness([{ throw: err }, { text: "retry ok" }, { text: "second turn" }]);
  const events = await h.run("hello");
  assert.equal(h.client.calls.length, 2);
  const first = h.client.calls[0]! as unknown as Record<string, unknown>;
  const second = h.client.calls[1]! as unknown as Record<string, unknown>;
  assert.equal(first.fallbacks, "default");
  assert.equal(second.fallbacks, undefined);
  assert.equal(second.betas, undefined);
  const notice = events.find((e): e is Extract<ChatEvent, { type: "notice" }> => e.type === "notice")!;
  assert.equal(notice.text, "Fallback routing unavailable; continuing without it.");
  assert.equal(terminal(events)[0]!.type, "done");
  assert.equal(h.rows()[1]!.text, "retry ok");
  assert.equal(isFallbacksSupported(), false);

  await h.run("again");
  assert.equal(h.client.calls.length, 3);
  assert.equal((h.client.calls[2]! as unknown as Record<string, unknown>).fallbacks, undefined);
});

test("a fallback 400 on a later request is not retried (maps to api_error)", async () => {
  const err = new Anthropic.BadRequestError(400, { error: { type: "invalid_request_error", message: "fallbacks not supported" } }, "fallbacks not supported", new Headers());
  const h = harness([{ toolCalls: [{ name: "refrigerant_pt", input: { refrigerant: "R-410A", psig: 118 } }] }, { throw: err }]);
  const events = await h.run("x");
  assert.equal((terminal(events)[0] as Extract<ChatEvent, { type: "error" }>).code, "api_error");
  assert.equal(h.client.calls.length, 2);
  assert.equal(isFallbacksSupported(), true);
});

test("error mapping: auth, rate_limit, network, context_full, api_error, internal", async () => {
  const cases: [Error, string][] = [
    [apiError(401, "invalid x-api-key"), "auth"],
    [apiError(429, "rate limited"), "rate_limit"],
    [new Anthropic.APIConnectionError({ message: "ECONNRESET" }), "network"],
    [apiError(400, "prompt is too long: 250000 tokens > 200000 maximum"), "context_full"],
    [apiError(400, "invalid model"), "api_error"],
    [apiError(500, "overloaded"), "api_error"],
    [new Error("boom"), "internal"],
  ];
  for (const [err, code] of cases) {
    const h = harness([{ throw: err }]);
    const events = await h.run("x");
    const term = terminal(events);
    assert.equal(term.length, 1);
    assert.equal((term[0] as Extract<ChatEvent, { type: "error" }>).code, code, `${err.constructor.name}: ${err.message}`);
    assert.equal(h.rows().length, 1, "user row persisted, nothing else");
  }
  const h = harness([{ throw: apiError(401, "bad key") }]);
  const [e] = terminal(await h.run("x"));
  assert.match((e as Extract<ChatEvent, { type: "error" }>).message, /Settings → AI connection/);
  const ctx = harness([{ throw: apiError(400, "context window exceeded") }]);
  const [ce] = terminal(await ctx.run("x"));
  assert.match((ce as Extract<ChatEvent, { type: "error" }>).message, /start a new conversation on this unit/);
});

// ---------------------------------------------------------------------------
// (9) history repair
// ---------------------------------------------------------------------------

test("history repair: a dangling tool_use gets a synthetic tool_result row before the new user row", async () => {
  const h = harness([{ text: "continuing" }]);
  h.repos.messages.append(h.conversationId, "user", [{ type: "text", text: "decode this" }], "decode this");
  h.repos.messages.append(
    h.conversationId,
    "assistant",
    [
      { type: "text", text: "On it." },
      { type: "tool_use", id: "toolu_dangling_1", name: "decode_unit", input: { model: "X" } },
      { type: "tool_use", id: "toolu_dangling_2", name: "refrigerant_pt", input: { refrigerant: "R-22", psig: 70 } },
    ],
    "On it.",
  );
  const events = await h.run("still there?");
  const rows = h.rows();
  assert.deepEqual(
    rows.map((r) => [r.role, r.kind]),
    [
      ["user", "chat"],
      ["assistant", "chat"],
      ["user", "tool_result"],
      ["user", "chat"],
      ["assistant", "chat"],
    ],
  );
  const repair = blocks(rows[2]!);
  assert.deepEqual(repair, [
    { type: "tool_result", tool_use_id: "toolu_dangling_1", is_error: true, content: INTERRUPTED_TOOL_MESSAGE },
    { type: "tool_result", tool_use_id: "toolu_dangling_2", is_error: true, content: INTERRUPTED_TOOL_MESSAGE },
  ]);
  assert.equal(rows[2]!.text, "");
  const done = terminal(events)[0] as Extract<ChatEvent, { type: "done" }>;
  assert.deepEqual(done.messageIds, [rows[2]!.id, rows[3]!.id, rows[4]!.id]);
  const messages = h.client.calls[0]!.messages;
  assert.equal(messages.length, 4);
  assert.equal(messages[2]!.role, "user");
  assert.equal((messages[2]!.content as { type: string }[])[0]!.type, "tool_result");
  assert.equal(messages[3]!.role, "user");
});

// ---------------------------------------------------------------------------
// (10) pause_turn
// ---------------------------------------------------------------------------

test("pause_turn persists the assistant row and re-sends with it last (≤ 3 continuations)", async () => {
  const h = harness([
    { text: "Searching…", stop_reason: "pause_turn" },
    { text: "Found it." },
  ]);
  const events = await h.run("look up the IOM");
  const rows = h.rows();
  assert.deepEqual(rows.map((r) => [r.role, r.text]), [
    ["user", "look up the IOM"],
    ["assistant", "Searching…"],
    ["assistant", "Found it."],
  ]);
  assert.equal(h.client.calls.length, 2);
  const second = h.client.calls[1]!.messages;
  assert.equal(second[second.length - 1]!.role, "assistant", "assistant row last, no trailing user row");
  assert.equal(terminal(events)[0]!.type, "done");
  assert.deepEqual((terminal(events)[0] as Extract<ChatEvent, { type: "done" }>).messageIds, rows.map((r) => r.id));
});

test("pause_turn stops after 3 continuations with a notice and done", async () => {
  const h = harness(Array.from({ length: 10 }, (_, i) => ({ text: `p${i}`, stop_reason: "pause_turn" as const })), { config: { maxToolIterations: 12 } });
  const events = await h.run("go");
  assert.equal(h.client.calls.length, 4, "initial + 3 continuations");
  assert.equal(h.rows().length, 5);
  assert.equal(terminal(events)[0]!.type, "done");
  assert.ok(events.some((e) => e.type === "notice" && /continuations/.test(e.text)));
});

// ---------------------------------------------------------------------------
// (11) max_tokens
// ---------------------------------------------------------------------------

test("max_tokens with a tool_use block → error max_tokens and no assistant row", async () => {
  const h = harness([{ text: "partial", toolCalls: [{ name: "refrigerant_pt", input: { refrigerant: "R-410A" } }], stop_reason: "max_tokens" }]);
  const events = await h.run("x");
  const term = terminal(events);
  assert.equal(term.length, 1);
  assert.equal((term[0] as Extract<ChatEvent, { type: "error" }>).code, "max_tokens");
  assert.equal(h.rows().length, 1);
  assert.ok(!events.some((e) => e.type === "tool_start"));
});

test("max_tokens with text only → persisted + notice 'Response was cut off' + done", async () => {
  const h = harness([{ text: "a very long answer that stops mid", stop_reason: "max_tokens" }]);
  const events = await h.run("x");
  assert.equal(h.rows().length, 2);
  assert.equal(h.rows()[1]!.text, "a very long answer that stops mid");
  assert.ok(events.some((e) => e.type === "notice" && e.text === "Response was cut off"));
  assert.equal(terminal(events)[0]!.type, "done");
});

test("model_context_window_exceeded with a tool_use block → error context_full (not max_tokens), no assistant row, no tools run", async () => {
  const h = harness([{ text: "partial", toolCalls: [{ name: "refrigerant_pt", input: { refrigerant: "R-410A" } }], stop_reason: "model_context_window_exceeded" }]);
  const events = await h.run("x");
  const term = terminal(events);
  assert.equal(term.length, 1);
  const err = term[0] as Extract<ChatEvent, { type: "error" }>;
  assert.equal(err.code, "context_full");
  assert.match(err.message, /start a new conversation/);
  assert.equal(h.rows().length, 1, "user row only");
  assert.ok(!events.some((e) => e.type === "tool_start"));
});

test("model_context_window_exceeded with no content → context_full; with text only → persisted + cut-off notice", async () => {
  const empty = harness([{ stop_reason: "model_context_window_exceeded" }]);
  const e1 = await empty.run("x");
  assert.equal((terminal(e1)[0] as Extract<ChatEvent, { type: "error" }>).code, "context_full");
  assert.equal(empty.rows().length, 1);

  const partial = harness([{ text: "an answer that ran out of room", stop_reason: "model_context_window_exceeded" }]);
  const e2 = await partial.run("x");
  assert.equal(partial.rows().length, 2);
  assert.ok(e2.some((e) => e.type === "notice" && e.text === "Response was cut off"));
  assert.equal(terminal(e2)[0]!.type, "done");
});

// ---------------------------------------------------------------------------
// (11b) slow-tool notice
// ---------------------------------------------------------------------------

test("database-backed tools emit a notice between tool_start and tool_end; in-memory tools do not", async () => {
  const h = harness(
    [{ toolCalls: [{ name: "find_unit", input: { query: "RTU-7 Pharmacy" } }, { name: "refrigerant_pt", input: { refrigerant: "R-410A", psig: 118 } }] }, { text: "done" }],
    { withUnit: true },
  );
  const events = await h.run("x");
  const t = types(events);
  const starts = t.map((x, i) => (x === "tool_start" ? i : -1)).filter((i) => i >= 0);
  const ends = t.map((x, i) => (x === "tool_end" ? i : -1)).filter((i) => i >= 0);
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  const inFirst = events.slice(starts[0]! + 1, ends[0]!).filter((e): e is Extract<ChatEvent, { type: "notice" }> => e.type === "notice");
  assert.equal(inFirst.length, 1, "find_unit gets one notice while it runs");
  assert.match(inFirst[0]!.text, /^Working on Find unit/);
  const inSecond = events.slice(starts[1]! + 1, ends[1]!).filter((e) => e.type === "notice");
  assert.equal(inSecond.length, 0, "refrigerant_pt gets no notice");
  assert.equal(terminal(events)[0]!.type, "done");
});

// ---------------------------------------------------------------------------
// (12) stopTurn
// ---------------------------------------------------------------------------

test("stopTurn aborts the stream → error aborted, no assistant row", async () => {
  const h = harness([{ text: "This answer is long enough to be split into several chunks by the fake client." }]);
  assert.equal(stopTurn(h.conversationId), false, "nothing running yet");
  let stopped = false;
  const events: ChatEvent[] = [];
  await runTurn(h.deps, h.conversationId, { text: "go" }, (e) => {
    events.push(e);
    if (e.type === "delta" && !stopped) {
      stopped = true;
      assert.equal(stopTurn(h.conversationId), true);
    }
  });
  const term = terminal(events);
  assert.equal(term.length, 1);
  assert.deepEqual(term[0], { type: "error", code: "aborted", message: "Stopped." });
  assert.equal(h.rows().length, 1, "user row only");
  assert.equal(isTurnRunning(h.conversationId), false);
  assert.equal(turnsInFlight(), 0);
});

test("stopTurn during tool execution stops before the next request", async () => {
  const h = harness([{ toolCalls: [{ name: "refrigerant_pt", input: { refrigerant: "R-410A", psig: 118 } }] }, { text: "never sent" }]);
  const events: ChatEvent[] = [];
  await runTurn(h.deps, h.conversationId, { text: "go" }, (e) => {
    events.push(e);
    if (e.type === "tool_start") stopTurn(h.conversationId);
  });
  assert.equal((terminal(events)[0] as Extract<ChatEvent, { type: "error" }>).code, "aborted");
  assert.equal(h.client.calls.length, 1);
  assert.equal(h.rows().length, 3, "user, assistant(tool_use), tool_result persisted; no second answer");
});

test("emit throwing (client gone) does not break the turn", async () => {
  const h = harness([{ text: "fine" }]);
  let n = 0;
  await runTurn(h.deps, h.conversationId, { text: "x" }, () => {
    n++;
    throw new Error("socket closed");
  });
  assert.ok(n >= 2);
  assert.equal(h.rows().length, 2);
  assert.equal(isTurnRunning(h.conversationId), false);
});

// ---------------------------------------------------------------------------
// (13) replayImageWindow
// ---------------------------------------------------------------------------

test("buildApiMessages replaces image blocks older than replayImageWindow user turns with a placeholder", () => {
  const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } };
  const row = (seq: number, role: MessageRow["role"], content: unknown[], kind: MessageRow["kind"] = "chat"): MessageRow => ({
    id: `id${seq}`,
    conversation_id: "c",
    seq,
    role,
    kind,
    content_json: JSON.stringify(content),
    text: "",
    created_at: "2026-01-01T00:00:00Z",
  });
  const rows: MessageRow[] = [
    row(1, "user", [img, { type: "text", text: "first photo" }]),
    row(2, "assistant", [{ type: "text", text: "a1" }]),
    row(3, "user", [img, img, { type: "text", text: "second photo" }]),
    row(4, "assistant", [{ type: "text", text: "a2" }]),
    row(5, "user", [img, { type: "text", text: "third photo" }]),
    row(6, "assistant", [{ type: "text", text: "a3" }]),
    row(7, "user", [{ type: "text", text: "no photo" }]),
  ];
  const out = buildApiMessages(rows, { replayImageWindow: 2 });
  assert.equal(out.length, 7);
  assert.deepEqual(out[0]!.content, [{ type: "text", text: IMAGE_PLACEHOLDER }, { type: "text", text: "first photo" }]);
  assert.deepEqual(out[2]!.content, [{ type: "text", text: IMAGE_PLACEHOLDER }, { type: "text", text: "second photo" }], "one placeholder for multiple images");
  assert.deepEqual(out[4]!.content, [img, { type: "text", text: "third photo" }], "within the window: image kept");
  assert.deepEqual(out[6]!.content, [{ type: "text", text: "no photo" }]);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant", "user"]);
  // window 0 = keep everything
  const all = buildApiMessages(rows, { replayImageWindow: 0 });
  assert.deepEqual(all[0]!.content, [img, { type: "text", text: "first photo" }]);
});

test("buildApiMessages ignores kind, preserves roles, and fills a dangling tool_use defensively", () => {
  const mk = (seq: number, role: MessageRow["role"], kind: MessageRow["kind"], content: unknown[]): MessageRow => ({
    id: `id${seq}`,
    conversation_id: "c",
    seq,
    role,
    kind,
    content_json: JSON.stringify(content),
    text: "",
    created_at: "2026-01-01T00:00:00Z",
  });
  const rows = [
    mk(1, "user", "chat", [{ type: "text", text: "q" }]),
    mk(2, "assistant", "chat", [{ type: "tool_use", id: "t1", name: "refrigerant_pt", input: {} }]),
    mk(3, "user", "tool_result", [{ type: "tool_result", tool_use_id: "t1", content: "{}" }]),
    mk(4, "assistant", "chat", [{ type: "tool_use", id: "t2", name: "refrigerant_pt", input: {} }]),
    mk(5, "user", "chat", [{ type: "text", text: "user typed before the tool ran" }]),
  ];
  const out = buildApiMessages(rows, { replayImageWindow: 0 });
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "user"]);
  assert.deepEqual(out[2]!.content, [{ type: "tool_result", tool_use_id: "t1", content: "{}" }]);
  assert.deepEqual(out[4]!.content, [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: INTERRUPTED_TOOL_MESSAGE }]);
  assert.deepEqual(out[5]!.content, [{ type: "text", text: "user typed before the tool ran" }]);
});

// ---------------------------------------------------------------------------
// (14) toApiContent
// ---------------------------------------------------------------------------

test("toApiContent drops thinking/tool_use before a fallback block, keeps text, replays the rest verbatim", () => {
  const thinking = { type: "thinking", thinking: "hmm", signature: "sig1" };
  const toolUse = { type: "tool_use", id: "t1", name: "refrigerant_pt", input: {} };
  const serverUseKept = { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } };
  const serverResultKept = { type: "web_search_tool_result", tool_use_id: "s1", content: [] };
  const serverUseDropped = { type: "server_tool_use", id: "s2", name: "web_search", input: { query: "y" } };
  const fallback = { type: "fallback", from: { model: "a" }, to: { model: "b" }, trigger: { type: "refusal" } };
  const thinkingAfter = { type: "thinking", thinking: "after", signature: "sig2" };
  const toolUseAfter = { type: "tool_use", id: "t2", name: "refrigerant_pt", input: {} };
  const out = toApiContent([
    thinking,
    { type: "text", text: "before" },
    toolUse,
    serverUseKept,
    serverResultKept,
    serverUseDropped,
    { type: "text", text: "" },
    fallback,
    thinkingAfter,
    { type: "text", text: "after" },
    toolUseAfter,
  ]);
  assert.deepEqual(out, [{ type: "text", text: "before" }, serverUseKept, serverResultKept, thinkingAfter, { type: "text", text: "after" }, toolUseAfter]);
});

test("toApiContent without a fallback block replays everything (thinking included) and drops empty text", () => {
  const blocksIn = [
    { type: "thinking", thinking: "t", signature: "s" },
    { type: "text", text: "" },
    { type: "text", text: "hi" },
    { type: "tool_use", id: "t1", name: "x", input: {} },
  ];
  assert.deepEqual(toApiContent(blocksIn), [blocksIn[0], blocksIn[2], blocksIn[3]]);
  assert.deepEqual(toApiContent([]), []);
});

test("multiple fallback blocks: only the last one is the cut; all fallback blocks are dropped", () => {
  const fb = { type: "fallback", from: { model: "a" }, to: { model: "b" }, trigger: { type: "refusal" } };
  const out = toApiContent([{ type: "text", text: "one" }, fb, { type: "tool_use", id: "t1", name: "x", input: {} }, fb, { type: "text", text: "three" }]);
  assert.deepEqual(out, [
    { type: "text", text: "one" },
    { type: "text", text: "three" },
  ]);
});

// ---------------------------------------------------------------------------
// Fake client default script (demo mode)
// ---------------------------------------------------------------------------

describe("demo script", () => {
  test("decodes a model number found in the user text, then answers quoting the tool summary", async () => {
    const h = harness(undefined);
    const events = await h.run(`Nameplate says ${CARRIER_MODEL}`);
    const starts = events.filter((e): e is Extract<ChatEvent, { type: "tool_start" }> => e.type === "tool_start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.name, "decode_unit");
    assert.equal((starts[0]!.input as { model: string }).model, CARRIER_MODEL);
    assert.match(starts[0]!.id, /^toolu_fake_\d+$/);
    const done = terminal(events)[0]!;
    assert.equal(done.type, "done");
    const final = h.rows()[3]!.text;
    assert.match(final, /Demo mode/);
    assert.match(final, /Carrier 48\/50TC/, "quotes the decode result summary");
  });

  test("falls back to a PT lookup and keeps going turn after turn", async () => {
    const h = harness(undefined);
    await h.run("no cooling");
    await h.run("still no cooling");
    const starts = h.events.filter((e): e is Extract<ChatEvent, { type: "tool_start" }> => e.type === "tool_start");
    assert.equal(starts.length, 2);
    assert.ok(starts.every((s) => s.name === "refrigerant_pt"));
    assert.equal(h.rows().length, 8);
    assert.equal(terminal(h.events).length, 2);
  });
});
