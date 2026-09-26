import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, isId } from "./index.ts";
import { createRepos, ftsMatchExpression, normalizeCode, normalizeTags, RepoError } from "./repos.ts";
import type { Repos } from "./repos.ts";

/** Deterministic clock: every call advances one second from a fixed epoch. */
function makeClock(start = "2026-01-01T00:00:00.000Z"): () => string {
  let t = Date.parse(start);
  return () => {
    t += 1000;
    return new Date(t).toISOString();
  };
}

function setup(): { repos: Repos; close(): void; clock: () => string } {
  const db = openDatabase(":memory:");
  const clock = makeClock();
  return { repos: createRepos(db, { now: clock }), close: () => db.close(), clock };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test("normalizeCode trims, uppercases, collapses whitespace; empty → null", () => {
  assert.equal(normalizeCode("  48tc da06 \t a2a5 "), "48TC DA06 A2A5");
  assert.equal(normalizeCode("   "), null);
  assert.equal(normalizeCode(null), null);
  assert.equal(normalizeCode(undefined), null);
});

test("normalizeTags accepts arrays and strings, lowercases, dedupes, tokenizes", () => {
  assert.equal(normalizeTags(["Low Charge", "TXV", " txv ", ""]), "low-charge,txv");
  assert.equal(normalizeTags("Compressor, Contactor ;electrical\nR-410A"), "compressor,contactor,electrical,r-410a");
  assert.equal(normalizeTags(""), null);
  assert.equal(normalizeTags([]), null);
});

test("ftsMatchExpression sanitizes into quoted tokens", () => {
  assert.equal(ftsMatchExpression("R-410A low SC"), '"R-410A" "low" "SC"');
  assert.equal(ftsMatchExpression("(( OR \"x\" NEAR(a b)"), '"OR" "x" "NEARa" "b"');
  assert.equal(ftsMatchExpression("(("), null);
  assert.equal(ftsMatchExpression("   "), null);
  assert.equal(ftsMatchExpression("- _ *"), null);
});

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------

test("units.create requires model, unit_tag or nickname", () => {
  const { repos, close } = setup();
  try {
    assert.throws(() => repos.units.create({}), { message: "model, unit_tag or nickname required" });
    assert.throws(() => repos.units.create({ model: "  ", unit_tag: "", nickname: null }), (e: unknown) => {
      assert.ok(e instanceof RepoError);
      assert.equal(e.code, "validation");
      return true;
    });
    assert.throws(() => repos.units.create({ site: "Store 12" }), RepoError);
    // each identity field alone is enough
    assert.ok(isId(repos.units.create({ unit_tag: "RTU-1" }).id));
    assert.ok(isId(repos.units.create({ nickname: "Roof east" }).id));
    assert.ok(isId(repos.units.create({ model: "48TC" }).id));
  } finally {
    close();
  }
});

test("units.create normalizes model/serial, coerces numbers and JSON columns", () => {
  const { repos, close } = setup();
  try {
    const u = repos.units.create({
      model: "  48tcda06a2a5 ",
      serial: "1234 g 56789",
      manufacturer: "  Carrier ",
      site: "Store 12",
      tonnage: "5" as unknown as number,
      circuits: 1.2,
      install_year: "2019" as unknown as number,
      elevation_ft: "5280" as unknown as number,
      decoded_json: { summary: "ok" } as unknown as string,
      charge_json: '{"1":"12 lb 4 oz"}',
      nameplate_json: "MCA 32" as unknown as string,
      notes: "",
    });
    assert.ok(isId(u.id));
    assert.equal(u.model, "48TCDA06A2A5");
    assert.equal(u.serial, "1234 G 56789");
    assert.equal(u.manufacturer, "Carrier");
    assert.equal(u.tonnage, 5);
    assert.equal(u.circuits, 1);
    assert.equal(u.install_year, 2019);
    assert.equal(u.elevation_ft, 5280);
    assert.equal(u.decoded_json, '{"summary":"ok"}');
    assert.equal(u.charge_json, '{"1":"12 lb 4 oz"}');
    assert.equal(u.nameplate_json, '"MCA 32"'); // non-JSON string wrapped so the column is always valid JSON
    assert.equal(u.notes, null);
    assert.equal(u.archived_at, null);
    assert.equal(u.created_at, u.updated_at);
    assert.deepEqual(repos.units.get(u.id), u);
    assert.equal(repos.units.get("nope"), undefined);

    assert.throws(() => repos.units.create({ model: "X", tonnage: "five" as unknown as number }), { message: /tonnage/ });
    assert.throws(() => repos.units.create({ model: "X", install_year: 1492 }), { message: /install_year/ });
    assert.throws(() => repos.units.create({ model: "X", circuits: Number.NaN }), RepoError);
  } finally {
    close();
  }
});

test("units.findByModelSerial normalizes input and ignores archived units", () => {
  const { repos, close } = setup();
  try {
    const a = repos.units.create({ model: "48TCDA06", serial: "1234G56789" });
    const b = repos.units.create({ model: "48TCDA06" }); // no serial
    assert.equal(repos.units.findByModelSerial(" 48tcda06 ", "1234g56789 ")?.id, a.id);
    assert.equal(repos.units.findByModelSerial("48tcda06")?.id, b.id);
    assert.equal(repos.units.findByModelSerial("48tcda06", "")?.id, b.id);
    assert.equal(repos.units.findByModelSerial("48TCDA06", "other"), undefined);
    assert.equal(repos.units.findByModelSerial(""), undefined);
    repos.units.archive(a.id);
    assert.equal(repos.units.findByModelSerial("48TCDA06", "1234G56789"), undefined);
  } finally {
    close();
  }
});

test("units.list: q LIKE with escaping, site exact case-insensitive, archived excluded, newest updated first, limit", () => {
  const { repos, close } = setup();
  try {
    const u1 = repos.units.create({ model: "48TCDA06", site: "Store 12", customer: "Acme Foods", unit_tag: "RTU-1" });
    const u2 = repos.units.create({ model: "YC090", site: "store 12", manufacturer: "York", unit_tag: "RTU_2" });
    const u3 = repos.units.create({ model: "TSC060", site: "Depot", nickname: "Old Trane" });
    // newest updated first
    assert.deepEqual(
      repos.units.list().map((u) => u.id),
      [u3.id, u2.id, u1.id],
    );
    repos.units.update(u1.id, { notes: "touched" });
    assert.deepEqual(
      repos.units.list().map((u) => u.id),
      [u1.id, u3.id, u2.id],
    );
    // site exact, case-insensitive
    assert.deepEqual(
      repos.units.list({ site: "STORE 12" }).map((u) => u.id).sort(),
      [u1.id, u2.id].sort(),
    );
    assert.deepEqual(repos.units.list({ site: "Store" }), []);
    // q over model/serial/unit_tag/nickname/site/customer/manufacturer
    assert.deepEqual(repos.units.list({ q: "acme" }).map((u) => u.id), [u1.id]);
    assert.deepEqual(repos.units.list({ q: "york" }).map((u) => u.id), [u2.id]);
    assert.deepEqual(repos.units.list({ q: "trane" }).map((u) => u.id), [u3.id]);
    assert.deepEqual(repos.units.list({ q: "rtu" }).map((u) => u.id).sort(), [u1.id, u2.id].sort());
    // LIKE wildcards are escaped: "_" must match literally
    assert.deepEqual(repos.units.list({ q: "RTU_" }).map((u) => u.id), [u2.id]);
    assert.deepEqual(repos.units.list({ q: "100%" }), []);
    // limit
    assert.equal(repos.units.list({ limit: 2 }).length, 2);
    // archived
    assert.equal(repos.units.archive(u3.id), true);
    assert.equal(repos.units.archive("missing"), false);
    assert.ok(repos.units.get(u3.id)?.archived_at);
    assert.deepEqual(repos.units.list().map((u) => u.id).sort(), [u1.id, u2.id].sort());
    assert.equal(repos.units.list({ includeArchived: true }).length, 3);
    assert.deepEqual(repos.units.list({ q: "trane", includeArchived: true }).map((u) => u.id), [u3.id]);
    // archive is idempotent and keeps the original timestamp
    const archivedAt = repos.units.get(u3.id)!.archived_at;
    assert.equal(repos.units.archive(u3.id), true);
    assert.equal(repos.units.get(u3.id)!.archived_at, archivedAt);
    // un-archive through update
    repos.units.update(u3.id, { archived_at: null });
    assert.equal(repos.units.list().length, 3);
  } finally {
    close();
  }
});

test("units.update: whitelisted columns only, bumps updated_at, keeps identity rule, returns row", () => {
  const { repos, close } = setup();
  try {
    const u = repos.units.create({ model: "48TCDA06", nickname: "North RTU" });
    const before = u.updated_at;
    const patched = repos.units.update(u.id, {
      serial: " abc123 ",
      refrigerant: "R-410A",
      tonnage: 7.5,
      // not a column: must be ignored, never injected
      ...({ id: "0000000000000000", created_at: "1999", evil: "DROP TABLE units" } as object),
    } as Parameters<Repos["units"]["update"]>[1]);
    assert.ok(patched);
    assert.equal(patched.id, u.id);
    assert.equal(patched.serial, "ABC123");
    assert.equal(patched.refrigerant, "R-410A");
    assert.equal(patched.tonnage, 7.5);
    assert.equal(patched.created_at, u.created_at);
    assert.ok(patched.updated_at > before);
    assert.equal(repos.units.update("missing", { notes: "x" }), undefined);
    // cannot strip every identity field
    assert.throws(() => repos.units.update(u.id, { model: null, nickname: "" }), { message: "model, unit_tag or nickname required" });
    // but can move identity from model to unit_tag in one patch
    const moved = repos.units.update(u.id, { model: null, nickname: null, unit_tag: "RTU-9" });
    assert.equal(moved?.model, null);
    assert.equal(moved?.unit_tag, "RTU-9");
  } finally {
    close();
  }
});

test("units.remove hard-deletes; conversations and findings keep rows with unit_id NULL", () => {
  const { repos, close } = setup();
  try {
    const u = repos.units.create({ model: "48TCDA06" });
    const c = repos.conversations.create({ title: "Job", unit_id: u.id });
    const f = repos.findings.create({ symptom: "No cooling", unit_id: u.id, conversation_id: c.id });
    assert.equal(repos.units.remove(u.id), true);
    assert.equal(repos.units.remove(u.id), false);
    assert.equal(repos.units.get(u.id), undefined);
    assert.equal(repos.conversations.get(c.id)?.unit_id, null);
    assert.equal(repos.findings.get(f.id)?.unit_id, null);
    assert.equal(repos.findings.get(f.id)?.conversation_id, c.id);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

test("conversations CRUD with unit FK", () => {
  const { repos, close } = setup();
  try {
    const c0 = repos.conversations.create();
    assert.ok(isId(c0.id));
    assert.equal(c0.title, "New conversation");
    assert.equal(c0.unit_id, null);
    assert.equal(c0.summary, null);

    const u = repos.units.create({ model: "48TCDA06" });
    const c1 = repos.conversations.create({ title: "  RTU-1 no cooling ", unit_id: u.id });
    assert.equal(c1.title, "RTU-1 no cooling");
    assert.equal(c1.unit_id, u.id);
    assert.throws(() => repos.conversations.create({ unit_id: "0000000000000000" }), (e: unknown) => {
      assert.ok(e instanceof RepoError);
      assert.equal(e.code, "not_found");
      return true;
    });

    // list newest updated first, unitId filter, q filter
    assert.deepEqual(repos.conversations.list().map((c) => c.id), [c1.id, c0.id]);
    assert.deepEqual(repos.conversations.list({ unitId: u.id }).map((c) => c.id), [c1.id]);
    assert.deepEqual(repos.conversations.list({ q: "cooling" }).map((c) => c.id), [c1.id]);
    assert.deepEqual(repos.conversations.list({ q: "%" }), []);
    assert.equal(repos.conversations.list({ limit: 1 }).length, 1);

    // update: title / unit_id (null allowed) / summary
    const upd = repos.conversations.update(c1.id, { summary: "Low charge, added 2 lb", unit_id: null });
    assert.equal(upd?.summary, "Low charge, added 2 lb");
    assert.equal(upd?.unit_id, null);
    assert.ok(upd!.updated_at > c1.updated_at);
    assert.equal(repos.conversations.update(c1.id, { unit_id: u.id })?.unit_id, u.id);
    assert.throws(() => repos.conversations.update(c1.id, { unit_id: "0000000000000000" }), RepoError);
    assert.throws(() => repos.conversations.update(c1.id, { title: "  " }), RepoError);
    assert.equal(repos.conversations.update("missing", { title: "x" }), undefined);

    // touch moves it to the top
    const t0 = repos.conversations.get(c0.id)!.updated_at;
    repos.conversations.touch(c0.id);
    assert.ok(repos.conversations.get(c0.id)!.updated_at > t0);
    assert.deepEqual(repos.conversations.list().map((c) => c.id), [c0.id, c1.id]);

    assert.equal(repos.conversations.remove(c0.id), true);
    assert.equal(repos.conversations.remove(c0.id), false);
    assert.equal(repos.conversations.get(c0.id), undefined);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

test("messages.append allocates seq, stores content verbatim, forces tool_result text empty, touches conversation", () => {
  const { repos, close } = setup();
  try {
    const c = repos.conversations.create({ title: "T" });
    const t0 = c.updated_at;
    const m1 = repos.messages.append(c.id, "user", [{ type: "text", text: "Hi there" }], "Hi there");
    const m2 = repos.messages.append(c.id, "assistant", [{ type: "tool_use", id: "tu1", name: "x", input: {} }], "calling", "chat");
    const m3 = repos.messages.append(c.id, "user", [{ type: "tool_result", tool_use_id: "tu1", content: "{}" }], "should vanish", "tool_result");
    assert.deepEqual([m1.seq, m2.seq, m3.seq], [1, 2, 3]);
    assert.ok(isId(m1.id));
    assert.equal(m1.kind, "chat");
    assert.equal(m2.kind, "chat");
    assert.equal(m3.kind, "tool_result");
    assert.equal(m3.text, "");
    assert.equal(m3.role, "user");
    assert.equal(m1.content_json, JSON.stringify([{ type: "text", text: "Hi there" }]));
    assert.equal(m1.conversation_id, c.id);
    assert.ok(repos.conversations.get(c.id)!.updated_at > t0);
    assert.equal(repos.conversations.get(c.id)!.updated_at, m3.created_at);

    // ordered by seq, count
    assert.deepEqual(repos.messages.list(c.id).map((m) => m.seq), [1, 2, 3]);
    assert.deepEqual(repos.messages.list(c.id).map((m) => m.id), [m1.id, m2.id, m3.id]);
    assert.equal(repos.messages.count(c.id), 3);
    assert.equal(repos.messages.count("missing"), 0);
    assert.deepEqual(repos.messages.list("missing"), []);

    // seq is per conversation
    const c2 = repos.conversations.create();
    assert.equal(repos.messages.append(c2.id, "user", [], "x").seq, 1);
    assert.equal(repos.messages.append(c.id, "user", [], "y").seq, 4);

    // invalid inputs never leave a transaction open
    assert.throws(() => repos.messages.append("0000000000000000", "user", [], "x"), (e: unknown) => e instanceof RepoError && e.code === "not_found");
    assert.throws(() => repos.messages.append(c.id, "system" as "user", [], "x"), RepoError);
    assert.throws(() => repos.messages.append(c.id, "user", {} as unknown[], "x"), RepoError);
    assert.equal(repos.messages.append(c.id, "user", [], "after").seq, 5);
  } finally {
    close();
  }
});

test("removing a conversation cascades to its messages (and FTS index)", () => {
  const { repos, close } = setup();
  try {
    const c = repos.conversations.create();
    repos.messages.append(c.id, "user", [{ type: "text", text: "cascade me" }], "cascade me");
    repos.messages.append(c.id, "assistant", [{ type: "text", text: "ok" }], "ok");
    assert.equal(repos.search("cascade").length, 1);
    assert.equal(repos.conversations.remove(c.id), true);
    assert.equal(repos.messages.count(c.id), 0);
    assert.deepEqual(repos.search("cascade"), []);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------

test("findings.create defaults, tag normalization, JSON columns, validation", () => {
  const { repos, close } = setup();
  try {
    const f = repos.findings.create({
      symptom: "  High head pressure ",
      tags: ["Condenser", "Dirty Coil", "condenser"] as unknown as string,
      measurements_json: { liquidPsig: 420 } as unknown as string,
      parts_json: '["contactor"]',
      refrigerant_added_lbs: "2.5" as unknown as number,
    });
    assert.ok(isId(f.id));
    assert.equal(f.symptom, "High head pressure");
    assert.equal(f.status, "resolved");
    assert.equal(f.origin, "tech");
    assert.equal(f.confirmed, 1);
    assert.equal(f.tags, "condenser,dirty-coil");
    assert.equal(f.measurements_json, '{"liquidPsig":420}');
    assert.equal(f.parts_json, '["contactor"]');
    assert.equal(f.refrigerant_added_lbs, 2.5);
    assert.equal(f.unit_id, null);
    assert.equal(f.conversation_id, null);
    assert.deepEqual(repos.findings.get(f.id), f);

    const g = repos.findings.create({ symptom: "x", tags: "TXV, hunting", status: "open", origin: "assistant", confirmed: 0 });
    assert.equal(g.tags, "txv,hunting");
    assert.equal(g.status, "open");
    assert.equal(g.origin, "assistant");
    assert.equal(g.confirmed, 0);
    const h = repos.findings.create({ symptom: "y", confirmed: true as unknown as 1 });
    assert.equal(h.confirmed, 1);

    assert.throws(() => repos.findings.create({ symptom: "  " }), { message: "symptom required" });
    assert.throws(() => repos.findings.create({} as { symptom: string }), RepoError);
    assert.throws(() => repos.findings.create({ symptom: "x", status: "bogus" as "open" }), RepoError);
    assert.throws(() => repos.findings.create({ symptom: "x", origin: "bot" as "tech" }), RepoError);
    assert.throws(() => repos.findings.create({ symptom: "x", unit_id: "0000000000000000" }), (e: unknown) => e instanceof RepoError && e.code === "not_found");
    assert.throws(() => repos.findings.create({ symptom: "x", conversation_id: "0000000000000000" }), (e: unknown) => e instanceof RepoError && e.code === "not_found");

    assert.equal(repos.findings.remove(f.id), true);
    assert.equal(repos.findings.remove(f.id), false);
    assert.equal(repos.findings.get(f.id), undefined);
  } finally {
    close();
  }
});

test("findings.list: newest first; open/monitor first when filtered by unit; conversation filter; limit", () => {
  const { repos, close } = setup();
  try {
    const u = repos.units.create({ model: "M" });
    const c = repos.conversations.create({ unit_id: u.id });
    const f1 = repos.findings.create({ symptom: "resolved old", unit_id: u.id, status: "resolved" });
    const f2 = repos.findings.create({ symptom: "open", unit_id: u.id, status: "open", conversation_id: c.id });
    const f3 = repos.findings.create({ symptom: "resolved new", unit_id: u.id, status: "resolved" });
    const f4 = repos.findings.create({ symptom: "monitor", unit_id: u.id, status: "monitor" });
    const other = repos.findings.create({ symptom: "other unit", status: "open" });

    assert.deepEqual(repos.findings.list().map((f) => f.id), [other.id, f4.id, f3.id, f2.id, f1.id]);
    assert.deepEqual(repos.findings.list({ unitId: u.id }).map((f) => f.id), [f2.id, f4.id, f3.id, f1.id]);
    assert.deepEqual(repos.findings.list({ conversationId: c.id }).map((f) => f.id), [f2.id]);
    assert.equal(repos.findings.list({ unitId: u.id, limit: 2 }).length, 2);
    assert.deepEqual(repos.findings.list({ unitId: "0000000000000000" }), []);
  } finally {
    close();
  }
});

test("findings.update patches status/confirmed/cause/resolution/follow_up and other whitelisted columns", () => {
  const { repos, close } = setup();
  try {
    const f = repos.findings.create({ symptom: "Trips on high pressure", status: "open", confirmed: 0 });
    const upd = repos.findings.update!(f.id, {
      status: "resolved",
      confirmed: 1,
      cause: "Dirty condenser",
      resolution: "Cleaned coil",
      follow_up: "Recheck in 30 days",
      tags: "condenser, Dirty coil",
      ...({ id: "x", created_at: "y", origin: "assistant" } as object),
    });
    assert.equal(upd?.status, "resolved");
    assert.equal(upd?.confirmed, 1);
    assert.equal(upd?.cause, "Dirty condenser");
    assert.equal(upd?.resolution, "Cleaned coil");
    assert.equal(upd?.follow_up, "Recheck in 30 days");
    assert.equal(upd?.tags, "condenser,dirty-coil");
    assert.equal(upd?.origin, "tech"); // not patchable
    assert.equal(upd?.id, f.id);
    assert.equal(repos.findings.update!(f.id, {})?.id, f.id);
    assert.equal(repos.findings.update!("missing", { status: "open" }), undefined);
    assert.throws(() => repos.findings.update!(f.id, { status: "nope" as "open" }), RepoError);
    assert.throws(() => repos.findings.update!(f.id, { symptom: "" }), RepoError);
    // the FTS index follows the update
    assert.equal(repos.search("dirty condenser").filter((h) => h.kind === "finding").length, 1);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

function seedSearch(repos: Repos) {
  const u1 = repos.units.create({ model: "48TCDA06A2A5", serial: "1234G56789", manufacturer: "Carrier", unit_tag: "RTU-7", site: "Store 12", customer: "Acme" });
  const u2 = repos.units.create({ model: "YC090", unit_tag: "RTU-2", site: "Depot" });
  const c1 = repos.conversations.create({ title: "RTU-7 low cooling", unit_id: u1.id });
  const c2 = repos.conversations.create({ title: "Depot unit", unit_id: u2.id });
  const c3 = repos.conversations.create({ title: "No unit" });
  const m1 = repos.messages.append(c1.id, "user", [{ type: "text", text: "Found R-410A low SC on RTU-7, superheat 25, subcooling 3" }], "Found R-410A low SC on RTU-7, superheat 25, subcooling 3");
  repos.messages.append(c1.id, "user", [{ type: "tool_result", tool_use_id: "t", content: "superheat subcooling hidden" }], "superheat subcooling hidden", "tool_result");
  const m2 = repos.messages.append(c2.id, "assistant", [{ type: "text", text: "Contactor pitted, low voltage at the coil" }], "Contactor pitted, low voltage at the coil");
  const m3 = repos.messages.append(c3.id, "assistant", [{ type: "text", text: "Generic subcooling question with no unit" }], "Generic subcooling question with no unit");
  const f1 = repos.findings.create({ symptom: "Low subcooling, undercharge", cause: "leak at schrader", resolution: "added 2 lb R-410A", tags: ["leak", "charge"] as unknown as string, unit_id: u1.id, conversation_id: c1.id });
  const f2 = repos.findings.create({ symptom: "Contactor failure", unit_id: u2.id });
  return { u1, u2, c1, c2, c3, m1, m2, m3, f1, f2 };
}

test("search: message hit with snippet and conversation info, finding hit, unit hit, merged and ranked", () => {
  const { repos, close } = setup();
  try {
    const s = seedSearch(repos);
    const hits = repos.search("subcooling");
    const msgs = hits.filter((h) => h.kind === "message");
    const finds = hits.filter((h) => h.kind === "finding");
    assert.deepEqual(msgs.map((h) => h.id).sort(), [s.m1.id, s.m3.id].sort()); // tool_result row excluded
    const m1 = msgs.find((h) => h.id === s.m1.id)!;
    assert.equal(m1.conversationId, s.c1.id);
    assert.equal(m1.conversationTitle, "RTU-7 low cooling");
    assert.equal(m1.unitId, s.u1.id);
    assert.match(m1.snippet, /\[subcooling\]/);
    assert.ok(m1.snippet.length < 120);
    assert.equal(m1.createdAt, s.m1.created_at);
    assert.ok(m1.rank < 0);
    assert.deepEqual(finds.map((h) => h.id), [s.f1.id]);
    assert.equal(finds[0]!.unitId, s.u1.id);
    assert.equal(finds[0]!.conversationId, s.c1.id);
    assert.equal(finds[0]!.conversationTitle, "RTU-7 low cooling");
    assert.match(finds[0]!.snippet, /\[subcooling\]/);
    // sorted by rank ascending
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1]!.rank <= hits[i]!.rank);

    // finding matched on a non-symptom column carries the symptom for context
    const bySchrader = repos.search("schrader");
    assert.equal(bySchrader.length, 1);
    assert.equal(bySchrader[0]!.kind, "finding");
    assert.match(bySchrader[0]!.snippet, /Low subcooling, undercharge — .*\[schrader\]/);

    // unit hit via LIKE over model/serial/tag/site/customer
    const unitHits = repos.search("rtu-7");
    const unit = unitHits.find((h) => h.kind === "unit")!;
    assert.ok(unit, "unit hit expected");
    assert.equal(unit.id, s.u1.id);
    assert.equal(unit.unitId, s.u1.id);
    assert.match(unit.snippet, /Carrier · 48TCDA06A2A5 · S\/N 1234G56789 · \[RTU-7\] · Store 12 · Acme/);
    assert.equal(unit.createdAt, s.u1.created_at);
    assert.ok(unitHits.some((h) => h.kind === "message" && h.id === s.m1.id));
    assert.equal(repos.search("1234g5")[0]?.kind, "unit");
    assert.equal(repos.search("acme")[0]?.id, s.u1.id);
    assert.deepEqual(repos.search("depot").filter((h) => h.kind === "unit").map((h) => h.id), [s.u2.id]);
    // archived units are not returned
    repos.units.archive(s.u2.id);
    assert.deepEqual(repos.search("depot").filter((h) => h.kind === "unit"), []);
  } finally {
    close();
  }
});

test("search: punctuation query, invalid FTS syntax, empty query, unitId / site / since / limit filters", () => {
  const { repos, close } = setup();
  try {
    const s = seedSearch(repos);
    // punctuation-heavy query is sanitized rather than passed to FTS raw
    const punct = repos.search("R-410A low SC");
    assert.ok(punct.some((h) => h.kind === "message" && h.id === s.m1.id));
    assert.match(punct.find((h) => h.id === s.m1.id)!.snippet, /\[R-410A\] \[low\] \[SC\]/);
    // invalid FTS syntax never throws
    assert.deepEqual(repos.search("(("), []);
    assert.deepEqual(repos.search('"'), []);
    assert.deepEqual(repos.search(""), []);
    assert.deepEqual(repos.search("   "), []);
    assert.deepEqual(repos.search("NEAR(a b) OR NOT * ^"), []);
    assert.deepEqual(repos.search(undefined as unknown as string), []);

    // unitId restricts messages (via conversation), findings and units
    const byUnit = repos.search("subcooling contactor", { unitId: s.u2.id });
    assert.deepEqual(byUnit, []);
    const u2hits = repos.search("contactor", { unitId: s.u2.id });
    assert.deepEqual(u2hits.map((h) => [h.kind, h.id]).sort(), [["finding", s.f2.id], ["message", s.m2.id]].sort());
    const u1sub = repos.search("subcooling", { unitId: s.u1.id });
    assert.deepEqual(u1sub.map((h) => h.id).sort(), [s.m1.id, s.f1.id].sort()); // m3 (no unit) excluded
    assert.deepEqual(repos.search("rtu", { unitId: s.u1.id }).filter((h) => h.kind === "unit").map((h) => h.id), [s.u1.id]);

    // site filter (case-insensitive exact) applies through unit joins
    assert.deepEqual(repos.search("subcooling", { site: "store 12" }).map((h) => h.id).sort(), [s.m1.id, s.f1.id].sort());
    assert.deepEqual(repos.search("contactor", { site: "Store 12" }), []);
    assert.deepEqual(repos.search("rtu", { site: "DEPOT" }).map((h) => [h.kind, h.id]), [["unit", s.u2.id]]);

    // since: only rows created at/after the timestamp
    assert.deepEqual(repos.search("subcooling", { since: s.m3.created_at }).map((h) => h.id).sort(), [s.m3.id, s.f1.id].sort());
    assert.deepEqual(repos.search("subcooling", { since: "2999-01-01T00:00:00.000Z" }), []);

    // limit
    assert.equal(repos.search("subcooling", { limit: 1 }).length, 1);
    assert.equal(repos.search("subcooling", { limit: 0 }).length, 3); // invalid limit falls back to the default
  } finally {
    close();
  }
});

test("search: findings tag column is searchable and units column LIKE wildcards are escaped", () => {
  const { repos, close } = setup();
  try {
    seedSearch(repos);
    const tag = repos.search("leak");
    assert.equal(tag.length, 1);
    assert.equal(tag[0]!.kind, "finding");
    assert.deepEqual(repos.search("_"), []);
    assert.deepEqual(repos.search("%"), []);
    assert.deepEqual(repos.search("RTU_7").filter((h) => h.kind === "unit"), []); // "_" is literal, not a wildcard
  } finally {
    close();
  }
});
