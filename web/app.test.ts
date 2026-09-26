/* Tests for the web client's pure helpers (globalThis.HVAC_UI) and the tap-target CSS contract.
 * Run: node --disable-warning=ExperimentalWarning --test web/app.test.ts
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// app.js is a plain script that publishes its helpers on globalThis.HVAC_UI; boot() is skipped without a DOM.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let UI: any;
before(async () => {
  const mod = "./app.js";
  await import(mod);
  UI = (globalThis as { HVAC_UI?: unknown }).HVAC_UI;
  assert.ok(UI, "HVAC_UI not exported");
});

/** A fake ReadableStreamDefaultReader fed from a script of chunks / hangs. */
function fakeReader(script: (string | "hang")[]) {
  const enc = new TextEncoder();
  let i = 0;
  let cancelled = 0;
  const reads: number[] = [];
  return {
    cancelled: () => cancelled,
    reads,
    read(): Promise<{ value?: Uint8Array; done: boolean }> {
      reads.push(i);
      const step = script[i++];
      if (step === undefined) return Promise.resolve({ done: true });
      if (step === "hang") return new Promise(() => {});
      return Promise.resolve({ value: enc.encode(step), done: false });
    },
    cancel() {
      cancelled += 1;
      return Promise.resolve();
    },
  };
}

/** Manual timers so the watchdog can be fired deterministically. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let id = 0;
  return {
    setTimeout(fn: () => void, _ms: number) {
      pending.set(++id, fn);
      return id;
    },
    clearTimeout(t: number) {
      pending.delete(t);
    },
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    armed: () => pending.size,
  };
}

describe("pumpSse — heartbeat watchdog (finding: half-open SSE)", () => {
  test("delivers events and the terminal event; heartbeats are ignored", async () => {
    const reader = fakeReader([
      'data: {"type":"delta","text":"Hel"}\n\n',
      ": ping\n\n",
      'data: {"type":"delta","text":"lo"}\n\ndata: {"type":"done","conversationId":"c1","messageIds":[]}\n\n',
    ]);
    const seen: string[] = [];
    const out = await UI.pumpSse(reader, (ev: { type: string }) => seen.push(ev.type), { idleMs: 1000 });
    assert.deepEqual(seen, ["delta", "delta", "done"]);
    assert.equal(out.terminal.type, "done");
    assert.equal(out.idle, false);
    assert.equal(reader.cancelled(), 0);
  });

  test("a stream that goes silent is cancelled and reported idle instead of hanging", async () => {
    const timers = fakeTimers();
    const reader = fakeReader(['data: {"type":"delta","text":"partial"}\n\n', "hang"]);
    const seen: string[] = [];
    const p = UI.pumpSse(reader, (ev: { type: string }) => seen.push(ev.type), { idleMs: 45000, timers });
    // Let the first chunk be consumed and the second read() hang with a watchdog armed.
    await new Promise((r) => setImmediate(r));
    assert.equal(timers.armed(), 1, "watchdog armed while read() is pending");
    timers.fire();
    const out = await p;
    assert.deepEqual(seen, ["delta"]);
    assert.equal(out.terminal, null);
    assert.equal(out.idle, true);
    assert.equal(reader.cancelled(), 1, "reader cancelled so the fetch does not linger");
  });

  test("every received chunk (including a bare heartbeat) re-arms the watchdog", async () => {
    const timers = fakeTimers();
    const reader = fakeReader([": ping\n\n", ": ping\n\n", 'data: {"type":"done","conversationId":"c","messageIds":[]}\n\n']);
    const out = await UI.pumpSse(reader, () => {}, { idleMs: 45000, timers });
    assert.equal(out.idle, false);
    assert.equal(out.terminal.type, "done");
    assert.equal(timers.armed(), 0, "no timer left armed after the stream ends");
    assert.equal(reader.reads.length, 4);
  });

  test("a rejected read (AbortError from Stop) propagates and clears the watchdog", async () => {
    const timers = fakeTimers();
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const reader = { read: () => Promise.reject(err), cancel: () => Promise.resolve() };
    await assert.rejects(UI.pumpSse(reader, () => {}, { idleMs: 1000, timers }), (e: Error) => e.name === "AbortError");
    assert.equal(timers.armed(), 0);
  });

  test("default idle timeout is comfortably above the server's 15 s heartbeat", () => {
    assert.ok(UI.SSE_IDLE_MS >= 30000 && UI.SSE_IDLE_MS <= 90000, String(UI.SSE_IDLE_MS));
  });
});

describe("dropLocalEcho — composer kept until the server accepts (finding: lost text on 409/4xx)", () => {
  test("removes only the optimistic echo", () => {
    const msgs = [
      { id: "a1", seq: 1, role: "user", text: "old" },
      { id: "local-1", seq: 0, role: "user", text: "typed" },
    ];
    const out = UI.dropLocalEcho(msgs, "local-1");
    assert.deepEqual(out.map((m: { id: string }) => m.id), ["a1"]);
    assert.equal(msgs.length, 2, "input is not mutated");
  });
  test("is a no-op when the echo is already gone", () => {
    const msgs = [{ id: "a1", seq: 1, role: "user", text: "old" }];
    assert.deepEqual(UI.dropLocalEcho(msgs, "local-9"), msgs);
  });
});

describe("conversationFingerprint — reconcile re-renders only on change (finding: visibilitychange scroll jump)", () => {
  const base = () => ({
    conversation: { id: "c1", title: "RTU-7 no cooling", updated_at: "2026-09-26T10:00:00Z" },
    unit: { id: "u1", updated_at: "2026-09-01T00:00:00Z" },
    busy: false,
    messages: [
      { id: "m1", seq: 1, role: "user", text: "hi", createdAt: "2026-09-26T10:00:00Z" },
      { id: "m2", seq: 2, role: "assistant", text: "hello", createdAt: "2026-09-26T10:00:05Z", tools: [{ id: "t1" }] },
    ],
  });

  test("identical payloads fingerprint the same (so nothing re-renders)", () => {
    assert.equal(UI.conversationFingerprint(base()), UI.conversationFingerprint(base()));
  });
  test("a new message, busy flag, title, unit or folded tool result changes it", () => {
    const a = UI.conversationFingerprint(base());
    const withMsg = base();
    withMsg.messages.push({ id: "m3", seq: 3, role: "user", text: "more", createdAt: "2026-09-26T10:01:00Z" });
    assert.notEqual(UI.conversationFingerprint(withMsg), a);
    const busy = base();
    busy.busy = true;
    assert.notEqual(UI.conversationFingerprint(busy), a);
    const title = base();
    title.conversation.title = "Renamed";
    assert.notEqual(UI.conversationFingerprint(title), a);
    const unit = base();
    unit.unit = { id: "u2", updated_at: "" };
    assert.notEqual(UI.conversationFingerprint(unit), a);
    const tools = base();
    (tools.messages[1] as { tools: unknown[] }).tools = [];
    assert.notEqual(UI.conversationFingerprint(tools), a);
    const noUnit = base();
    (noUnit as { unit: unknown }).unit = null;
    assert.notEqual(UI.conversationFingerprint(noUnit), a);
  });
  test("a local echo differs from the server's row for the same text", () => {
    const local = base();
    local.messages.push({ id: "local-1", seq: 0, role: "user", text: "sent", createdAt: "x" });
    const server = base();
    server.messages.push({ id: "abcd1234abcd1234", seq: 3, role: "user", text: "sent", createdAt: "x" });
    assert.notEqual(UI.conversationFingerprint(local), UI.conversationFingerprint(server));
  });
  test("tolerates missing fields", () => {
    assert.equal(typeof UI.conversationFingerprint({}), "string");
    assert.equal(UI.conversationFingerprint({ messages: null }), UI.conversationFingerprint({}));
  });
});

describe("serverReachable / healthRetryDelay — sticky 'server unreachable' banner (finding)", () => {
  const res = (status: number, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers) });
  test("any real HTTP response, including errors, proves the server is up", () => {
    assert.equal(UI.serverReachable(res(200)), true);
    assert.equal(UI.serverReachable(res(404)), true);
    assert.equal(UI.serverReachable(res(409)), true);
    assert.equal(UI.serverReachable(res(500)), true);
  });
  test("service-worker cache hits and offline 503 stubs do not count", () => {
    assert.equal(UI.serverReachable(res(200, { "x-hvac-cache": "hit" })), false);
    assert.equal(UI.serverReachable(res(503)), false);
    assert.equal(UI.serverReachable(null), false);
  });
  test("retry backoff doubles from 5 s and caps at 60 s", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map((n) => UI.healthRetryDelay(n)), [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
    assert.equal(UI.healthRetryDelay(undefined), 5000);
    assert.equal(UI.healthRetryDelay(-3), 5000);
  });
});

describe("styles.css — tap targets (finding: undersized buttons override the coarse-pointer rule)", () => {
  const css = readFileSync(join(here, "styles.css"), "utf8");
  /** First declaration block for an exact selector (outside any @media unless `inMedia`). */
  const block = (selector: string, inMedia?: string) => {
    const src = inMedia ? css.slice(css.indexOf(inMedia)) : css;
    const i = src.indexOf(selector + " {");
    assert.ok(i >= 0, `selector not found: ${selector}`);
    return src.slice(i, src.indexOf("}", i));
  };
  const px = (decl: string, prop: string) => {
    const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*(\\d+)px`).exec(decl);
    return m ? Number(m[1]) : NaN;
  };
  test("search clear button is at least 44 px", () => {
    const b = block(".search-field .clear");
    assert.ok(px(b, "width") >= 44 && px(b, "height") >= 44, b);
    assert.ok(px(block(".search-field input"), "padding") >= 8);
    assert.match(block(".search-field input"), /padding:\s*8px 44px/);
  });
  test("banner dismiss button is at least 44 px", () => {
    const b = block(".banner .icon-btn");
    assert.ok(px(b, "width") >= 44 && px(b, "height") >= 44, b);
  });
  test("remove-photo button is at least 44 px with the disc drawn by ::before", () => {
    const b = block(".preview button");
    assert.ok(px(b, "width") >= 44 && px(b, "height") >= 44, b);
    assert.ok(css.includes(".preview button::before {"));
    // the overflow container leaves room so the corner button is not clipped
    assert.match(block(".image-previews"), /padding:\s*8px 8px/);
  });
  test("composer attach button is at least 44 px on coarse pointers", () => {
    const coarse = css.slice(css.indexOf(".composer-field .icon-btn {"));
    const m = /@media \(pointer: coarse\) \{ \.composer-field \.icon-btn \{([^}]*)\}/.exec(coarse);
    assert.ok(m, "coarse-pointer override missing");
    assert.ok(px(m![1]!, "width") >= 44 && px(m![1]!, "height") >= 44, m![1]);
  });
});
