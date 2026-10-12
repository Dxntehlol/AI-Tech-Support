import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PROJECT_ROOT, loadConfig } from "../config.ts";
import { loadKnowledge } from "../knowledge/loader.ts";
import { openDatabase } from "../db/index.ts";
import { createRepos, type Repos } from "../db/repos.ts";
import { createFakeClient } from "../agent/fakeClient.ts";
import type { AppConfig, KnowledgeBase } from "../types.ts";
import { createApp } from "../app.ts";
import { generateTesterPassword, hashTesterPassword, matchTester } from "./auth.ts";
import { capFor, testerBudget } from "../testers.ts";

const OWNER = "owner-secret";
const NOW = new Date("2026-10-12T20:00:00Z");

let kb: KnowledgeBase;
before(() => {
  kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });
});

interface Ctx {
  repos: Repos;
  logs: string[];
  call(method: string, path: string, opts?: { body?: unknown; auth?: string | null; basic?: [string, string] }): Promise<Response>;
}

async function withServer(opts: { config?: Partial<AppConfig>; demo?: boolean }, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const db = openDatabase(":memory:");
  const repos = createRepos(db, { now: () => NOW.toISOString() });
  const config: AppConfig = { ...loadConfig({}), appPassword: OWNER, testerDailyCapUsd: 2, ...opts.config };
  const logs: string[] = [];
  const client = createFakeClient(Array.from({ length: 50 }, () => ({ text: "Fake answer.", model: "claude-opus-5", usage: { input_tokens: 1000, output_tokens: 500 } })));
  const app = createApp({ client, config, kb, repos, demo: opts.demo ?? false, log: (m) => logs.push(m), now: () => NOW });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ctx: Ctx = {
    repos,
    logs,
    call(method, path, o = {}) {
      const headers: Record<string, string> = {};
      if (o.body !== undefined) headers["Content-Type"] = "application/json";
      if (o.basic) headers.Authorization = `Basic ${Buffer.from(`${o.basic[0]}:${o.basic[1]}`).toString("base64")}`;
      else if (o.auth !== null) headers.Authorization = `Bearer ${o.auth ?? OWNER}`;
      return fetch(base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    },
  };
  try {
    await fn(ctx);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

async function createTester(ctx: Ctx, name: string, extra: Record<string, unknown> = {}): Promise<{ id: string; password: string }> {
  const res = await ctx.call("POST", "/api/testers", { body: { name, ...extra } });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  const j = JSON.parse(text) as { tester: { id: string }; password: string };
  return { id: j.tester.id, password: j.password };
}

describe("tester passwords", () => {
  test("generated passwords are 16 chars from the unambiguous alphabet and hash to hex sha256", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generateTesterPassword();
      assert.match(p, /^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789]{16}$/);
      seen.add(p);
    }
    assert.equal(seen.size, 50);
    assert.match(hashTesterPassword("x"), /^[0-9a-f]{64}$/);
  });

  test("matchTester narrows by Basic username and reports disabled rows", () => {
    const db = openDatabase(":memory:");
    const repos = createRepos(db);
    const a = repos.testers.create({ name: "Alice", password_sha256: hashTesterPassword("pw-a") });
    repos.testers.create({ name: "Bob", password_sha256: hashTesterPassword("pw-b") });
    assert.equal(matchTester(repos.testers, { username: null, password: "pw-b" })?.tester.name, "Bob");
    assert.equal(matchTester(repos.testers, { username: "alice", password: "pw-a" })?.tester.name, "Alice");
    assert.equal(matchTester(repos.testers, { username: "alice", password: "pw-b" }), undefined, "username narrows the comparison");
    assert.equal(matchTester(repos.testers, { username: null, password: "nope" }), undefined);
    repos.testers.update(a.id, { disabled: 1 });
    assert.equal(matchTester(repos.testers, { username: null, password: "pw-a" })?.disabled, true);
    db.close();
  });

  test("capFor prefers the tester's own cap over the server default", () => {
    assert.equal(capFor({ daily_cap_usd: null }, { testerDailyCapUsd: 3 }), 3);
    assert.equal(capFor({ daily_cap_usd: 0.5 }, { testerDailyCapUsd: 3 }), 0.5);
    assert.equal(capFor({ daily_cap_usd: 0 }, { testerDailyCapUsd: 3 }), 0, "0 = unlimited for this tester");
    assert.equal(capFor({ daily_cap_usd: null }, {}), 2, "built-in default");
  });
});

describe("tester routes", () => {
  test("/api/me: owner, unauthenticated, tester with budget", async () => {
    await withServer({}, async (ctx) => {
      assert.equal((await ctx.call("GET", "/api/me", { auth: null })).status, 401);
      const me = (await (await ctx.call("GET", "/api/me")).json()) as Record<string, unknown>;
      assert.equal(me.role, "owner");
      assert.equal(me.authRequired, true);
      const t = await createTester(ctx, "Sam", { dailyCapUsd: 1.5 });
      const asTester = (await (await ctx.call("GET", "/api/me", { auth: t.password })).json()) as { role: string; name: string; budget: { capUsd: number; spentTodayUsd: number; exhausted: boolean } };
      assert.equal(asTester.role, "tester");
      assert.equal(asTester.name, "Sam");
      assert.deepEqual(asTester.budget.capUsd, 1.5);
      assert.equal(asTester.budget.spentTodayUsd, 0);
      assert.equal(asTester.budget.exhausted, false);
      // Basic auth with the tester's name as username works too (browser prompt).
      const viaBasic = await ctx.call("GET", "/api/me", { basic: ["Sam", t.password] });
      assert.equal(viaBasic.status, 200);
      assert.equal(((await viaBasic.json()) as { role: string }).role, "tester");
    });
  });

  test("owner-only routes refuse testers with 403", async () => {
    await withServer({}, async (ctx) => {
      const t = await createTester(ctx, "Sam");
      for (const path of ["/api/testers", "/api/usage", "/api/settings/ai", "/api/export"]) {
        const res = await ctx.call("GET", path, { auth: t.password });
        assert.equal(res.status, 403, path);
        assert.equal(((await res.json()) as { error: { code: string } }).error.code, "forbidden");
      }
      assert.equal((await ctx.call("POST", "/api/testers", { auth: t.password, body: { name: "Mallory" } })).status, 403);
      // Shared data is still reachable for a tester.
      assert.equal((await ctx.call("GET", "/api/units", { auth: t.password })).status, 200);
      assert.equal((await ctx.call("GET", "/api/health", { auth: t.password })).status, 200);
    });
  });

  test("create, list, rename, cap, disable, password reset, delete", async () => {
    await withServer({}, async (ctx) => {
      const res = await ctx.call("POST", "/api/testers", { body: { name: "  Sam  ", dailyCapUsd: 0.75, notes: "phone tester" } });
      assert.equal(res.status, 201);
      const created = (await res.json()) as { tester: Record<string, unknown>; password: string };
      assert.equal(created.tester.name, "Sam");
      assert.equal(created.tester.dailyCapUsd, 0.75);
      assert.equal(created.tester.effectiveCapUsd, 0.75);
      assert.equal(created.tester.disabled, false);
      assert.ok(!("password_sha256" in created.tester), "digest never leaves the server");
      assert.match(created.password, /^[A-Za-z0-9]{16}$/);
      const id = created.tester.id as string;

      assert.equal((await ctx.call("POST", "/api/testers", { body: { name: "sam" } })).status, 400, "names are unique, case-insensitively");
      assert.equal((await ctx.call("POST", "/api/testers", { body: { name: "" } })).status, 400);
      assert.equal((await ctx.call("POST", "/api/testers", { body: { name: "X", dailyCapUsd: -1 } })).status, 400);

      const list = (await (await ctx.call("GET", "/api/testers")).json()) as { testers: Record<string, unknown>[]; defaultCapUsd: number };
      assert.equal(list.testers.length, 1);
      assert.equal(list.defaultCapUsd, 2);

      // The tester signs in and is stamped as seen.
      assert.equal((await ctx.call("GET", "/api/me", { auth: created.password })).status, 200);
      assert.equal(ctx.repos.testers.get(id)!.last_seen_at, NOW.toISOString());

      // Rename + default cap.
      const patched = (await (await ctx.call("PATCH", `/api/testers/${id}`, { body: { name: "Samantha", dailyCapUsd: null } })).json()) as { tester: Record<string, unknown> };
      assert.equal(patched.tester.name, "Samantha");
      assert.equal(patched.tester.dailyCapUsd, null);
      assert.equal(patched.tester.effectiveCapUsd, 2);
      assert.equal((await ctx.call("PATCH", `/api/testers/${id}`, { body: {} })).status, 400);
      assert.equal((await ctx.call("PATCH", `/api/testers/${id}`, { body: { disabled: "yes" } })).status, 400);

      // Disable: the login stops at once with a clear 401.
      await ctx.call("PATCH", `/api/testers/${id}`, { body: { disabled: true } });
      const off = await ctx.call("GET", "/api/me", { auth: created.password });
      assert.equal(off.status, 401);
      assert.match(((await off.json()) as { error: { message: string } }).error.message, /turned off/);
      await ctx.call("PATCH", `/api/testers/${id}`, { body: { disabled: false } });
      assert.equal((await ctx.call("GET", "/api/me", { auth: created.password })).status, 200);

      // Password reset: old fails, new works.
      const reset = (await (await ctx.call("POST", `/api/testers/${id}/password`, { body: {} })).json()) as { password: string };
      assert.notEqual(reset.password, created.password);
      assert.equal((await ctx.call("GET", "/api/me", { auth: created.password })).status, 401);
      assert.equal((await ctx.call("GET", "/api/me", { auth: reset.password })).status, 200);

      // Delete.
      assert.equal((await ctx.call("DELETE", `/api/testers/${id}`)).status, 200);
      assert.equal((await ctx.call("GET", `/api/testers/${id}`)).status, 404);
      assert.equal((await ctx.call("GET", "/api/me", { auth: reset.password })).status, 401);
      assert.ok(ctx.logs.some((l) => l.includes("tester created: Sam")));
    });
  });

  test("testers cannot be created while the app runs without a password", async () => {
    await withServer({ config: { appPassword: null } }, async (ctx) => {
      const res = await ctx.call("POST", "/api/testers", { auth: null, body: { name: "Sam" } });
      assert.equal(res.status, 409);
      const me = (await (await ctx.call("GET", "/api/me", { auth: null })).json()) as { role: string; authRequired: boolean };
      assert.equal(me.role, "owner");
      assert.equal(me.authRequired, false);
    });
  });

  test("conversations are scoped to the tester who started them; the owner sees all with tester names", async () => {
    await withServer({}, async (ctx) => {
      const sam = await createTester(ctx, "Sam");
      const kim = await createTester(ctx, "Kim");
      const ownerConv = ((await (await ctx.call("POST", "/api/conversations", { body: { title: "Owner's" } })).json()) as { conversation: { id: string } }).conversation;
      const samConv = ((await (await ctx.call("POST", "/api/conversations", { auth: sam.password, body: { title: "Sam's" } })).json()) as { conversation: { id: string; tester_id: string } }).conversation;
      assert.equal(samConv.tester_id, sam.id);
      await ctx.call("POST", "/api/conversations", { auth: kim.password, body: { title: "Kim's" } });

      const samList = (await (await ctx.call("GET", "/api/conversations", { auth: sam.password })).json()) as { conversations: { title: string }[] };
      assert.deepEqual(samList.conversations.map((c) => c.title), ["Sam's"]);
      const ownerList = (await (await ctx.call("GET", "/api/conversations")).json()) as { conversations: { title: string; tester_name: string | null }[] };
      assert.deepEqual(
        ownerList.conversations.map((c) => [c.title, c.tester_name]).sort(),
        [
          ["Kim's", "Kim"],
          ["Owner's", null],
          ["Sam's", "Sam"],
        ],
      );

      // Foreign conversations look missing to a tester, on every /:id route.
      for (const [method, path, body] of [
        ["GET", `/api/conversations/${ownerConv.id}`, undefined],
        ["PATCH", `/api/conversations/${ownerConv.id}`, { title: "hijack" }],
        ["DELETE", `/api/conversations/${ownerConv.id}`, undefined],
        ["POST", `/api/conversations/${ownerConv.id}/stop`, {}],
        ["POST", `/api/conversations/${ownerConv.id}/messages`, { text: "hi" }],
        ["GET", `/api/conversations/${samConv.id}`, undefined],
      ] as const) {
        const res = await ctx.call(method, path, { auth: kim.password, body });
        assert.equal(res.status, 404, `${method} ${path}`);
      }
      assert.equal((await ctx.call("GET", `/api/conversations/${samConv.id}`, { auth: sam.password })).status, 200);
      assert.equal((await ctx.call("GET", `/api/conversations/${samConv.id}`)).status, 200, "owner sees it");
      assert.equal(ctx.repos.conversations.get(ownerConv.id)!.title, "Owner's", "the PATCH did not land");
    });
  });

  test("a tester's turn is attributed in usage_events and logged; the daily cap refuses with 429", async () => {
    await withServer({ config: { testerDailyCapUsd: 0.05 } }, async (ctx) => {
      const sam = await createTester(ctx, "Sam");
      const conv = ((await (await ctx.call("POST", "/api/conversations", { auth: sam.password, body: { title: "t" } })).json()) as { conversation: { id: string } }).conversation;
      const res = await ctx.call("POST", `/api/conversations/${conv.id}/messages`, { auth: sam.password, body: { text: "Low suction, what next?" } });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /"type":"done"/);
      const rows = ctx.repos.usage.listSince("2000-01-01T00:00:00Z", sam.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.tester_id, sam.id);
      assert.equal(rows[0]!.input_tokens, 1000);
      assert.equal(ctx.repos.usage.listSince("2000-01-01T00:00:00Z").length, 1, "owner's view includes it");
      const events = ctx.repos.testers.listEvents(sam.id);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.kind, "turn");
      assert.equal(events[0]!.conversation_id, conv.id);

      // Spend past the cap (list price for 1000 in / 500 out of claude-opus-5 is well under 5 cents, so add rows).
      for (let i = 0; i < 20; i++) ctx.repos.usage.record({ conversation_id: conv.id, model: "claude-opus-5", input_tokens: 100_000, output_tokens: 20_000, cache_read_tokens: 0, cache_write_tokens: 0, web_searches: 0, stop_reason: "end_turn", tester_id: sam.id });
      const budget = testerBudget(ctx.repos, ctx.repos.testers.get(sam.id)!, { testerDailyCapUsd: 0.05 }, NOW);
      assert.equal(budget.exhausted, true);
      const refused = await ctx.call("POST", `/api/conversations/${conv.id}/messages`, { auth: sam.password, body: { text: "again" } });
      assert.equal(refused.status, 429);
      const err = (await refused.json()) as { error: { code: string; message: string } };
      assert.equal(err.error.code, "cap");
      assert.match(err.error.message, /Daily test budget reached/);
      assert.equal(ctx.repos.testers.countEvents(sam.id, "2000-01-01T00:00:00Z").cap, 1);
      const me = (await (await ctx.call("GET", "/api/me", { auth: sam.password })).json()) as { budget: { exhausted: boolean } };
      assert.equal(me.budget.exhausted, true);
      // The owner's overview shows it.
      const list = (await (await ctx.call("GET", "/api/testers")).json()) as { testers: { today: { exhausted: boolean; requests: number }; last30Days: { capHits: number; turns: number } }[] };
      assert.equal(list.testers[0]!.today.exhausted, true);
      assert.equal(list.testers[0]!.today.requests, 21);
      assert.equal(list.testers[0]!.last30Days.capHits, 1);
      assert.equal(list.testers[0]!.last30Days.turns, 1);
      // Per-tester usage summary and event log for the owner.
      const usage = (await (await ctx.call("GET", `/api/testers/${sam.id}/usage?days=7`)).json()) as { totals: { requests: number } };
      assert.equal(usage.totals.requests, 21);
      const evs = (await (await ctx.call("GET", `/api/testers/${sam.id}/events?kind=cap`)).json()) as { events: { kind: string }[] };
      assert.equal(evs.events.length, 1);
      // Raising the tester's own cap lets them continue; 0 means no cap at all.
      await ctx.call("PATCH", `/api/testers/${sam.id}`, { body: { dailyCapUsd: 0 } });
      const resumed = await ctx.call("POST", `/api/conversations/${conv.id}/messages`, { auth: sam.password, body: { text: "and now?" } });
      assert.equal(resumed.status, 200);
      await resumed.text();
      // The owner is never capped.
      const ownerConv = ((await (await ctx.call("POST", "/api/conversations", { body: {} })).json()) as { conversation: { id: string } }).conversation;
      const ownerTurn = await ctx.call("POST", `/api/conversations/${ownerConv.id}/messages`, { body: { text: "owner" } });
      assert.equal(ownerTurn.status, 200);
      assert.match(await ownerTurn.text(), /"type":"done"/);
      assert.equal(ctx.repos.usage.listSince("2000-01-01T00:00:00Z").filter((r) => r.tester_id === null).length, 1);
    });
  });

  test("a tester's failed turn is logged as an error event", async () => {
    await withServer({}, async (ctx) => {
      const sam = await createTester(ctx, "Sam");
      const conv = ((await (await ctx.call("POST", "/api/conversations", { auth: sam.password, body: {} })).json()) as { conversation: { id: string } }).conversation;
      const res = await ctx.call("POST", `/api/conversations/${conv.id}/messages`, { auth: sam.password, body: { text: "" } });
      assert.equal(res.status, 400, "validation errors are not tester events");
      assert.equal(ctx.repos.testers.listEvents(sam.id).length, 0);
    });
  });
});
