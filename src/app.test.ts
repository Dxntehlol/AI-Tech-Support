import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { PROJECT_ROOT, loadConfig } from "./config.ts";
import { loadKnowledge } from "./knowledge/loader.ts";
import { openDatabase } from "./db/index.ts";
import { createRepos, type Repos } from "./db/repos.ts";
import { createFakeClient } from "./agent/fakeClient.ts";
import type { MessagesStreamer, StreamLike, StreamParams } from "./agent/client.ts";
import { isTurnRunning } from "./agent/chat.ts";
import type { AppConfig, ChatEvent, DisplayMessage, KnowledgeBase } from "./types.ts";
import { createApp, renderConfigJs, type AppDeps } from "./app.ts";
import { detectImageType, foldMessages, parseImages, parseMeasurements, summarizeToolResult } from "./routes/util.ts";
import { isPublicPath, normalizeRequestPath, passwordFromAuthorization, secretsMatch } from "./routes/auth.ts";
import { EXPORT_LIST_CAP } from "./routes/search.ts";
import { openStreamCount } from "./routes/conversations.ts";

const NOW = new Date("2026-09-26T12:00:00Z");
const CARRIER_MODEL = "48TCDA04A2A5-0A0A0";
const CARRIER_MODEL_4T = "48TCDA05A2A5-0A0A0";
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPEG_HEAD = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(28, 1)]).toString("base64");

let kb: KnowledgeBase;
/** A stand-in web/ directory with the PWA files, so header rules are tested independently of the real client. */
let pwaDir: string;
before(() => {
  kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });
  pwaDir = mkdtempSync(join(tmpdir(), "hvac-web-"));
  mkdirSync(join(pwaDir, "icons"));
  mkdirSync(join(pwaDir, "vendor"));
  writeFileSync(join(pwaDir, "index.html"), "<!doctype html><html><body>shell</body></html>");
  writeFileSync(join(pwaDir, "app.js"), "console.log('app');");
  writeFileSync(join(pwaDir, "styles.css"), "body{margin:0}");
  writeFileSync(join(pwaDir, "sw.js"), "self.addEventListener('fetch', () => {});");
  writeFileSync(join(pwaDir, "manifest.webmanifest"), JSON.stringify({ name: "HVAC Field Assistant", short_name: "HVAC Assist", display: "standalone" }));
  writeFileSync(join(pwaDir, "icons", "icon-192.png"), Buffer.from(PNG_1PX, "base64"));
  writeFileSync(join(pwaDir, "vendor", "marked.min.js"), "// vendored");
});
after(() => {
  rmSync(pwaDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Ctx {
  base: string;
  port: number;
  repos: Repos;
  deps: AppDeps;
  logs: string[];
  get(path: string, init?: RequestInit): Promise<Response>;
  json(method: string, path: string, body?: unknown, init?: RequestInit): Promise<Response>;
}

interface Opts {
  config?: Partial<AppConfig>;
  client?: MessagesStreamer;
  demo?: boolean;
  allowOrigins?: string[];
}

async function withServer(opts: Opts, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const db = openDatabase(":memory:");
  const repos = createRepos(db);
  const config: AppConfig = { ...loadConfig({}), ...opts.config };
  const logs: string[] = [];
  const deps: AppDeps = {
    client: opts.client ?? createFakeClient(),
    config,
    kb,
    repos,
    log: (m) => logs.push(m),
    now: () => NOW,
    demo: opts.demo ?? true,
    allowOrigins: opts.allowOrigins,
  };
  const app = createApp(deps);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const ctx: Ctx = {
    base,
    port,
    repos,
    deps,
    logs,
    get: (path, init) => fetch(base + path, init),
    json: (method, path, body, init = {}) =>
      fetch(base + path, {
        ...init,
        method,
        headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
  try {
    await fn(ctx);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

/**
 * A GET over a raw socket, so the request target reaches the server verbatim: `fetch` (WHATWG URL) resolves
 * `..` and `%2e%2e` segments client-side and would never send the paths the auth exemption must reject.
 */
function rawGet(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => (buf += d));
    sock.on("error", reject);
    sock.on("end", () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf)?.[1] ?? 0);
      resolve({ status, body: buf.slice(buf.indexOf("\r\n\r\n") + 4) });
    });
  });
}

/** Parse an SSE body into its JSON events (heartbeat comments ignored). */
function parseSse(text: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      events.push(JSON.parse(line.slice(5).trim()) as ChatEvent);
    }
  }
  return events;
}

async function expectError(res: Response, status: number, code: string): Promise<string> {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}`);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  return body.error.message;
}

/** A client whose turn hangs until released — for busy / stop tests. */
function controlledClient(): { client: MessagesStreamer; release(text: string): void; calls: number } {
  let resolveFinal: ((m: Anthropic.Beta.BetaMessage) => void) | null = null;
  const ctl = {
    calls: 0,
    release(text: string) {
      const msg = {
        id: "msg_ctl",
        type: "message",
        role: "assistant",
        model: "controlled",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as Anthropic.Beta.BetaMessage;
      resolveFinal?.(msg);
      resolveFinal = null;
    },
    client: {
      stream(_params: StreamParams, opts?: { signal?: AbortSignal }): StreamLike {
        ctl.calls += 1;
        const final = new Promise<Anthropic.Beta.BetaMessage>((resolve, reject) => {
          resolveFinal = resolve;
          const abort = (): void => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          };
          if (opts?.signal?.aborted) abort();
          opts?.signal?.addEventListener("abort", abort, { once: true });
        });
        final.catch(() => {});
        return {
          on() {
            return this;
          },
          finalMessage: () => final,
          abort() {},
        };
      },
    },
  };
  return ctl;
}

// ---------------------------------------------------------------------------
// Health, static, 404
// ---------------------------------------------------------------------------

describe("app basics", () => {
  test("GET /api/health reports config + knowledge counts and demo flag", async () => {
    await withServer({ demo: true }, async (c) => {
      const res = await c.get("/api/health");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-powered-by"), null);
      const h = (await res.json()) as Record<string, unknown>;
      assert.equal(h.ok, true);
      assert.equal(h.model, "claude-opus-5");
      assert.equal(h.effort, "high");
      assert.equal(h.webSearch, false);
      assert.equal(h.fallbacks, "default");
      assert.equal(h.packs, kb.manufacturers.length);
      assert.equal(h.refrigerants, kb.refrigerants.tables.size);
      assert.equal(h.rules, kb.diagnostics.rules.rules.length);
      assert.equal(h.demo, true);
    });
  });

  test("static UI and config.js are served at /", async () => {
    await withServer({}, async (c) => {
      const res = await c.get("/");
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await res.text(), /<html/i);
      const cfg = await c.get("/config.js");
      assert.equal(cfg.status, 200);
      assert.match(await cfg.text(), /APP_CONFIG/);
    });
  });

  test("GET /config.js: same-origin apiBase, package.json version, demo flag, never cached", async () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as { version: string };
    await withServer({ demo: true }, async (c) => {
      const res = await c.get("/config.js");
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^(application|text)\/javascript/);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const text = await res.text();
      assert.equal(text, `window.APP_CONFIG = { apiBase: "", version: ${JSON.stringify(pkg.version)}, demo: true };\n`);
      // The script must evaluate to the documented shape.
      const sandbox: { APP_CONFIG?: { apiBase: string; version: string; demo: boolean } } = {};
      new Function("window", text)(sandbox);
      assert.deepEqual(sandbox.APP_CONFIG, { apiBase: "", version: pkg.version, demo: true });
    });
    await withServer({ demo: false }, async (c) => {
      assert.match(await (await c.get("/config.js")).text(), /demo: false \};\n$/);
    });
    assert.equal(renderConfigJs({ version: '1.0.0"; alert(1); "', demo: false }), 'window.APP_CONFIG = { apiBase: "", version: "1.0.0\\"; alert(1); \\"", demo: false };\n');
  });

  test("static header rules: sw.js scope + no-cache, manifest media type, shell revalidated, assets cached an hour", async () => {
    await withServer({ config: { webDir: pwaDir } }, async (c) => {
      const sw = await c.get("/sw.js");
      assert.equal(sw.status, 200);
      assert.equal(sw.headers.get("service-worker-allowed"), "/");
      assert.equal(sw.headers.get("cache-control"), "no-cache");
      assert.match(sw.headers.get("content-type") ?? "", /javascript/);

      const manifest = await c.get("/manifest.webmanifest");
      assert.equal(manifest.status, 200);
      assert.match(manifest.headers.get("content-type") ?? "", /^application\/manifest\+json/);
      assert.equal(manifest.headers.get("cache-control"), "public, max-age=3600");
      assert.equal(((await manifest.json()) as { short_name: string }).short_name, "HVAC Assist");

      for (const path of ["/", "/index.html"]) {
        const shell = await c.get(path);
        assert.equal(shell.status, 200, path);
        assert.equal(shell.headers.get("cache-control"), "no-cache", path);
        assert.equal(shell.headers.get("service-worker-allowed"), null, path);
      }
      for (const path of ["/app.js", "/styles.css", "/icons/icon-192.png", "/vendor/marked.min.js"]) {
        const asset = await c.get(path);
        assert.equal(asset.status, 200, path);
        assert.equal(asset.headers.get("cache-control"), "public, max-age=3600", path);
        assert.equal(asset.headers.get("service-worker-allowed"), null, path);
      }
      assert.match((await c.get("/icons/icon-192.png")).headers.get("content-type") ?? "", /image\/png/);
      assert.equal((await c.get("/config.js")).headers.get("cache-control"), "no-store");
    });
  });

  test("unknown /api path → JSON 404 envelope", async () => {
    await withServer({}, async (c) => {
      await expectError(await c.get("/api/nope"), 404, "not_found");
      await expectError(await c.json("POST", "/api/nope/deeper", {}), 404, "not_found");
    });
  });

  test("malformed JSON → 400 validation; oversized body → 413 too_large", async () => {
    await withServer({}, async (c) => {
      const bad = await fetch(`${c.base}/api/decode`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
      await expectError(bad, 400, "validation");
      const big = await c.json("POST", "/api/decode", { model: "x".repeat(1_200_000) });
      await expectError(big, 413, "too_large");
    });
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe("security", () => {
  test("basic auth: 401 without credentials, 200 with Basic or Bearer, /api/health exempt", async () => {
    await withServer({ config: { appPassword: "s3cret" } }, async (c) => {
      const denied = await c.get("/api/units");
      assert.equal(denied.status, 401);
      assert.match(denied.headers.get("www-authenticate") ?? "", /^Basic realm=/);
      await expectError(denied, 401, "auth");
      const wrong = await c.get("/api/units", { headers: { Authorization: `Basic ${Buffer.from("tech:nope").toString("base64")}` } });
      assert.equal(wrong.status, 401);
      const basic = await c.get("/api/units", { headers: { Authorization: `Basic ${Buffer.from("anyone:s3cret").toString("base64")}` } });
      assert.equal(basic.status, 200);
      const bearer = await c.get("/api/units", { headers: { Authorization: "Bearer s3cret" } });
      assert.equal(bearer.status, 200);
      const health = await c.get("/api/health");
      assert.equal(health.status, 200);
      const page = await c.get("/");
      assert.equal(page.status, 401);
    });
  });

  test("bearer auth: token compared like the password; wrong/empty/odd schemes → 401 with WWW-Authenticate", async () => {
    await withServer({ config: { appPassword: "s3cret" } }, async (c) => {
      for (const auth of ["Bearer nope", "Bearer s3cre", "Bearer s3cret extra", "Bearer", "Bearer ", "Token s3cret", "s3cret", ""]) {
        const res = await c.get("/api/units", { headers: auth ? { Authorization: auth } : {} });
        assert.equal(res.status, 401, `Authorization: ${JSON.stringify(auth)}`);
        assert.match(res.headers.get("www-authenticate") ?? "", /^Basic realm="HVAC Field Assistant"/);
        await expectError(res, 401, "auth");
      }
      for (const auth of ["Bearer s3cret", "bearer s3cret", "  Bearer   s3cret  ", "BASIC " + Buffer.from(":s3cret").toString("base64")]) {
        const res = await c.get("/api/units", { headers: { Authorization: auth } });
        assert.equal(res.status, 200, `Authorization: ${JSON.stringify(auth)}`);
      }
      // Bearer works on state-changing routes too (the native shell's only option).
      const created = await c.json("POST", "/api/conversations", {}, { headers: { Authorization: "Bearer s3cret" } });
      assert.equal(created.status, 201);
      // A password with a colon survives Basic (split on the first colon only) and Bearer (verbatim).
    });
    await withServer({ config: { appPassword: "a:b:c" } }, async (c) => {
      assert.equal((await c.get("/api/units", { headers: { Authorization: "Bearer a:b:c" } })).status, 200);
      assert.equal((await c.get("/api/units", { headers: { Authorization: `Basic ${Buffer.from("tech:a:b:c").toString("base64")}` } })).status, 200);
    });
  });

  test("public paths need no password: health, config.js, manifest, sw.js, icons — everything else does", async () => {
    await withServer({ config: { appPassword: "s3cret", webDir: pwaDir } }, async (c) => {
      for (const path of ["/api/health", "/config.js", "/manifest.webmanifest", "/sw.js", "/icons/icon-192.png"]) {
        const res = await c.get(path);
        assert.equal(res.status, 200, path);
      }
      for (const path of ["/", "/index.html", "/app.js", "/styles.css", "/vendor/marked.min.js", "/api/units", "/api/reference/refrigerants"]) {
        const res = await c.get(path);
        assert.equal(res.status, 401, path);
        await expectError(res, 401, "auth");
      }
      // Missing public files are still 404s, not 401s, so the client can tell "not installed" from "locked".
      assert.equal((await c.get("/icons/missing.png")).status, 404);
      // Prefix tricks do not widen the exemption.
      assert.equal((await c.get("/iconsx/app.js")).status, 401);
      assert.equal((await c.get("/api/healthz")).status, 401);
    });
  });

  test("dot segments under the public /icons/ prefix cannot reach protected files", async () => {
    await withServer({ config: { appPassword: "s3cret", webDir: pwaDir } }, async (c) => {
      // Raw targets: serve-static resolves these to /app.js, /index.html, /vendor/… after the auth check ran.
      for (const target of [
        "/icons/../app.js",
        "/icons/%2e%2e/app.js",
        "/icons/..%2fapp.js",
        "/icons/..%2Fapp.js",
        "/icons/%2e%2e%2fapp.js",
        "/icons/../index.html",
        "/icons/../",
        "/icons/..",
        "/icons/x/../../vendor/marked.min.js",
        "//icons/../app.js",
        "/icons/../../package.json",
        "/icons/%2e%2e/api/units",
      ]) {
        const res = await rawGet(c.port, target);
        assert.equal(res.status, 401, target);
        assert.equal(res.body.includes("console.log('app')"), false, target);
        assert.equal(res.body.includes("shell"), false, target);
      }
      // Undecodable percent-encoding is not public either.
      assert.equal((await rawGet(c.port, "/icons/%zz/icon-192.png")).status, 401);
      // Genuine icon paths keep working, also when spelled with a `.` segment or percent-encoded letters.
      for (const target of ["/icons/icon-192.png", "/icons/./icon-192.png", "/icons/%69con-192.png", "/icons//icon-192.png"]) {
        assert.equal((await rawGet(c.port, target)).status, 200, target);
      }
      // A missing icon is still a 404 (not 401) so the client can tell "not installed" from "locked".
      assert.equal((await rawGet(c.port, "/icons/./missing.png")).status, 404);
    });
  });

  test("auth helpers", () => {
    assert.equal(passwordFromAuthorization(`Basic ${Buffer.from("u:p:w").toString("base64")}`), "p:w");
    assert.equal(passwordFromAuthorization("Bearer tok"), "tok");
    assert.equal(passwordFromAuthorization("Digest x"), undefined);
    assert.equal(passwordFromAuthorization(undefined), undefined);
    assert.equal(secretsMatch("a", "a"), true);
    assert.equal(secretsMatch("a", "b"), false);
    for (const p of ["/api/health", "/api/health/", "/config.js", "/manifest.webmanifest", "/sw.js", "/icons/icon-192.png", "/icons/maskable/512.png"]) {
      assert.equal(isPublicPath(p), true, p);
    }
    for (const p of ["/", "/index.html", "/app.js", "/api/units", "/api/healthz", "/icons", "/iconsx/a.png", "/sw.js.map", "/api/health/x"]) {
      assert.equal(isPublicPath(p), false, p);
    }
    // Public-path decisions are made on the decoded, dot-segment-free path (what serve-static will open).
    for (const p of ["/icons/../app.js", "/icons/%2e%2e/app.js", "/icons/..%2fapp.js", "/icons/..%2Findex.html", "/icons/..", "/icons/../", "/icons/a/../../app.js", "/icons/%zz"]) {
      assert.equal(isPublicPath(p), false, p);
    }
    for (const p of ["/icons/./a.png", "/icons/%69con.png", "/icons//a.png", "/icons/a/../b.png", "/api/health/./"]) {
      assert.equal(isPublicPath(p), true, p);
    }
    assert.equal(normalizeRequestPath("/icons/%2e%2e/app.js"), "/app.js");
    assert.equal(normalizeRequestPath("/icons/..%2fapp.js"), "/app.js");
    assert.equal(normalizeRequestPath("/icons/./a/../b.png"), "/icons/b.png");
    assert.equal(normalizeRequestPath("//icons/../app.js"), "/app.js");
    assert.equal(normalizeRequestPath("icons/../app.js"), "/app.js");
    assert.equal(normalizeRequestPath("/icons/%zz"), null);
  });

  test("Origin mismatch → 403; same host and allowlisted origins pass; GET ignores Origin", async () => {
    await withServer({ allowOrigins: ["capacitor://localhost"] }, async (c) => {
      const evil = await c.json("POST", "/api/conversations", {}, { headers: { Origin: "http://evil.example" } });
      await expectError(evil, 403, "forbidden");
      const same = await c.json("POST", "/api/conversations", {}, { headers: { Origin: c.base } });
      assert.equal(same.status, 201);
      const native = await c.json("POST", "/api/conversations", {}, { headers: { Origin: "capacitor://localhost" } });
      assert.equal(native.status, 201);
      assert.equal(native.headers.get("access-control-allow-origin"), "capacitor://localhost");
      const read = await c.get("/api/conversations", { headers: { Origin: "http://evil.example" } });
      assert.equal(read.status, 200);
      const preflight = await fetch(`${c.base}/api/conversations`, { method: "OPTIONS", headers: { Origin: "capacitor://localhost", "Access-Control-Request-Method": "POST" } });
      assert.equal(preflight.status, 204);
      assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Authorization/);
    });
  });

  test("Origin matching honours X-Forwarded-Host behind a reverse proxy", async () => {
    await withServer({}, async (c) => {
      const viaProxy = await c.json("POST", "/api/conversations", {}, { headers: { Origin: "https://shop-pc.tail1234.ts.net", "X-Forwarded-Host": "shop-pc.tail1234.ts.net" } });
      assert.equal(viaProxy.status, 201, await viaProxy.text());
      const withPort = await c.json("POST", "/api/conversations", {}, { headers: { Origin: "https://shop.example:8443", "X-Forwarded-Host": "shop.example:8443, 10.0.0.2" } });
      assert.equal(withPort.status, 201);
      const forged = await c.json("POST", "/api/conversations", {}, { headers: { Origin: "http://evil.example", "X-Forwarded-Host": "shop-pc.tail1234.ts.net" } });
      assert.equal(forged.status, 403);
      const otherHost = await c.json("POST", "/api/conversations", {}, { headers: { Origin: "https://shop-pc.tail1234.ts.net", "X-Forwarded-Host": "other.example" } });
      assert.equal(otherHost.status, 403);
    });
    // A raw client can send Origin == X-Forwarded-Host for any host; the password, not the Origin guard, is the
    // barrier there (a browser cannot add X-Forwarded-Host cross-site without a CORS preflight).
    await withServer({ config: { appPassword: "s3cret" } }, async (c) => {
      const raw = await c.json("POST", "/api/conversations", {}, { headers: { Origin: "http://evil.example", "X-Forwarded-Host": "evil.example" } });
      assert.equal(raw.status, 401);
    });
  });

  test("CORS: allowlisted origins get an echoed origin + Vary; preflight passes without auth; others get nothing", async () => {
    const native = "capacitor://localhost";
    await withServer({ config: { appPassword: "s3cret" }, allowOrigins: [native, "http://localhost"] }, async (c) => {
      // Preflight: 204, no auth needed, full CORS header set.
      const pre = await fetch(`${c.base}/api/conversations`, {
        method: "OPTIONS",
        headers: { Origin: native, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" },
      });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get("access-control-allow-origin"), native);
      assert.equal(pre.headers.get("access-control-allow-headers"), "Authorization, Content-Type");
      assert.equal(pre.headers.get("access-control-allow-methods"), "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      // PUT /api/settings/ai (Settings → AI connection) must pass the preflight from a native shell.
      const prePut = await fetch(`${c.base}/api/settings/ai`, {
        method: "OPTIONS",
        headers: { Origin: native, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization, content-type" },
      });
      assert.equal(prePut.status, 204);
      assert.equal(prePut.headers.get("access-control-allow-origin"), native);
      assert.ok((prePut.headers.get("access-control-allow-methods") ?? "").split(/,\s*/).includes("PUT"));
      assert.equal(pre.headers.get("access-control-allow-credentials"), null);
      assert.match(pre.headers.get("vary") ?? "", /\bOrigin\b/);
      assert.match(pre.headers.get("access-control-max-age") ?? "", /^\d+$/);
      assert.equal(pre.headers.get("www-authenticate"), null);

      // Actual request: origin echoed (never "*"), auth still enforced.
      const denied = await c.get("/api/units", { headers: { Origin: native } });
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get("access-control-allow-origin"), native);
      const ok = await c.json("POST", "/api/conversations", {}, { headers: { Origin: native, Authorization: "Bearer s3cret" } });
      assert.equal(ok.status, 201);
      assert.equal(ok.headers.get("access-control-allow-origin"), native);
      assert.match(ok.headers.get("vary") ?? "", /\bOrigin\b/);
      // Exact match: case-insensitive on the origin, but scheme/port variants are distinct origins.
      assert.equal((await c.get("/api/health", { headers: { Origin: "CAPACITOR://LOCALHOST" } })).headers.get("access-control-allow-origin"), "CAPACITOR://LOCALHOST");
      for (const other of ["https://localhost", "http://localhost:8787", "http://evil.example", "null"]) {
        const res = await c.get("/api/health", { headers: { Origin: other } });
        assert.equal(res.status, 200, other);
        assert.equal(res.headers.get("access-control-allow-origin"), null, other);
        assert.match(res.headers.get("vary") ?? "", /\bOrigin\b/, other);
        const rejectedPre = await fetch(`${c.base}/api/conversations`, { method: "OPTIONS", headers: { Origin: other, "Access-Control-Request-Method": "POST" } });
        assert.equal(rejectedPre.status, 204, other);
        assert.equal(rejectedPre.headers.get("access-control-allow-origin"), null, other);
        assert.equal(rejectedPre.headers.get("access-control-allow-methods"), null, other);
        // ...and the Origin/Host guard still blocks state changes from them.
        const write = await c.json("POST", "/api/conversations", {}, { headers: { Origin: other, Authorization: "Bearer s3cret" } });
        await expectError(write, 403, "forbidden");
      }
      // Requests without an Origin (curl, same-origin GET) are untouched.
      const plain = await c.get("/api/health");
      assert.equal(plain.headers.get("access-control-allow-origin"), null);
    });
    // Empty allowlist: no CORS headers at all, even for an origin that would otherwise be common.
    await withServer({ allowOrigins: [] }, async (c) => {
      const res = await c.get("/api/health", { headers: { Origin: native } });
      assert.equal(res.headers.get("access-control-allow-origin"), null);
      assert.doesNotMatch(res.headers.get("vary") ?? "", /\bOrigin\b/);
    });
    // Allowlist from config (ALLOW_ORIGINS) is honoured when deps.allowOrigins is not given.
    await withServer({ config: { allowOrigins: ["ionic://localhost"] } }, async (c) => {
      const res = await c.get("/api/health", { headers: { Origin: "ionic://localhost" } });
      assert.equal(res.headers.get("access-control-allow-origin"), "ionic://localhost");
    });
  });

  test("wrong Content-Type on state-changing route → 400 validation (DELETE without body is fine)", async () => {
    await withServer({}, async (c) => {
      const res = await fetch(`${c.base}/api/conversations`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
      await expectError(res, 400, "validation");
      const none = await fetch(`${c.base}/api/conversations`, { method: "POST" });
      await expectError(none, 400, "validation");
      const created = (await (await c.json("POST", "/api/conversations", {})).json()) as { conversation: { id: string } };
      const del = await fetch(`${c.base}/api/conversations/${created.conversation.id}`, { method: "DELETE" });
      assert.equal(del.status, 200);
    });
  });
});

// ---------------------------------------------------------------------------
// Units, decode, findings
// ---------------------------------------------------------------------------

describe("units", () => {
  test("create decodes the model, existing model+serial returns 200, get/patch/archive/list", async () => {
    await withServer({}, async (c) => {
      const created = await c.json("POST", "/api/units", { model: CARRIER_MODEL, serial: "1523G12345", manufacturer: "Carrier", unit_tag: "RTU-7", site: "Pharmacy", elevation_ft: 5280 });
      assert.equal(created.status, 201);
      const body = (await created.json()) as { unit: Record<string, unknown>; decoded: Record<string, unknown> | null; existing: boolean };
      const unit = body.unit;
      assert.equal(body.existing, false);
      assert.equal(unit.manufacturer, "Carrier");
      assert.equal(unit.model, CARRIER_MODEL);
      assert.equal(unit.tonnage, 3);
      assert.equal(unit.refrigerant, "R-410A");
      assert.equal(unit.voltage, "208/230-3-60");
      assert.equal(unit.phase, "3");
      assert.equal(unit.site, "Pharmacy");
      assert.equal(unit.elevation_ft, 5280);
      assert.equal(typeof unit.control_platform, "string");
      assert.ok(body.decoded && Array.isArray(body.decoded.model));
      const id = unit.id as string;

      // same model + serial → 200 with the existing unit (decoded_json refreshed, new fields merged)
      const again = await c.json("POST", "/api/units", { model: ` ${CARRIER_MODEL.toLowerCase()} `, serial: "1523G12345", customer: "Acme" });
      assert.equal(again.status, 200);
      const againBody = (await again.json()) as { unit: Record<string, unknown>; existing: boolean };
      assert.equal(againBody.existing, true);
      assert.equal(againBody.unit.id, id);
      assert.equal(againBody.unit.customer, "Acme");
      assert.equal(againBody.unit.site, "Pharmacy");

      // get
      const got = (await (await c.get(`/api/units/${id}`)).json()) as { unit: Record<string, unknown>; decoded: { input: { model: string } }; findings: unknown[]; conversations: unknown[] };
      assert.equal(got.unit.id, id);
      assert.equal(got.decoded.input.model, CARRIER_MODEL);
      assert.deepEqual(got.findings, []);
      assert.deepEqual(got.conversations, []);

      // patch (no re-decode)
      const patched = await c.json("PATCH", `/api/units/${id}`, { site: "Pharmacy North", notes: "roof access via ladder", decoded_json: "ignored", id: "ignored" });
      assert.equal(patched.status, 200);
      const p = (await patched.json()) as { unit: Record<string, unknown> };
      assert.equal(p.unit.site, "Pharmacy North");
      assert.equal(p.unit.notes, "roof access via ladder");
      assert.equal(p.unit.tonnage, 3);

      // patch model → re-decode (tonnage changes 3 → 4)
      const redecoded = (await (await c.json("PATCH", `/api/units/${id}`, { model: CARRIER_MODEL_4T })).json()) as { unit: Record<string, unknown>; decoded: { input: { model: string } } };
      assert.equal(redecoded.unit.model, CARRIER_MODEL_4T);
      assert.equal(redecoded.unit.tonnage, 4);
      assert.equal(redecoded.decoded.input.model, CARRIER_MODEL_4T);

      // validation
      await expectError(await c.json("PATCH", `/api/units/${id}`, {}), 400, "validation");
      await expectError(await c.json("PATCH", `/api/units/${id}`, { tonnage: "lots" }), 400, "validation");
      await expectError(await c.get("/api/units/not-an-id"), 400, "validation");
      await expectError(await c.get("/api/units/0123456789abcdef"), 404, "not_found");
      await expectError(await c.json("POST", "/api/units", { site: "Nowhere" }), 400, "validation");

      // archive + list
      const del = await c.json("DELETE", `/api/units/${id}`);
      assert.equal(del.status, 200);
      const list = (await (await c.get("/api/units?limit=200")).json()) as { units: { id: string }[] };
      assert.equal(list.units.some((u) => u.id === id), false);
      const all = (await (await c.get("/api/units?include_archived=1")).json()) as { units: { id: string; archived_at: string | null }[] };
      const archived = all.units.find((u) => u.id === id);
      assert.ok(archived && archived.archived_at);
      await expectError(await c.json("DELETE", "/api/units/0123456789abcdef"), 404, "not_found");
    });
  });

  test("list filters by q and site; unit without model is keyed by tag", async () => {
    await withServer({}, async (c) => {
      await c.json("POST", "/api/units", { unit_tag: "AHU-1", site: "Clinic", nickname: "Big blue" });
      await c.json("POST", "/api/units", { unit_tag: "RTU-2", site: "Pharmacy" });
      const bySite = (await (await c.get("/api/units?site=clinic")).json()) as { units: { unit_tag: string }[] };
      assert.deepEqual(bySite.units.map((u) => u.unit_tag), ["AHU-1"]);
      const byQ = (await (await c.get("/api/units?q=rtu")).json()) as { units: { unit_tag: string }[] };
      assert.deepEqual(byQ.units.map((u) => u.unit_tag), ["RTU-2"]);
    });
  });

  test("POST /api/decode returns a DecodeResult; model required", async () => {
    await withServer({}, async (c) => {
      const res = await c.json("POST", "/api/decode", { model: CARRIER_MODEL, serial: "1523G12345" });
      assert.equal(res.status, 200);
      const d = (await res.json()) as { manufacturerCandidates: { id: string }[]; serial: { year: number }[]; summary: string };
      assert.equal(d.manufacturerCandidates[0]?.id, "carrier");
      assert.equal(d.serial[0]?.year, 2023);
      assert.equal(typeof d.summary, "string");
      await expectError(await c.json("POST", "/api/decode", { serial: "123" }), 400, "validation");
      await expectError(await c.json("POST", "/api/decode", { model: "   " }), 400, "validation");
    });
  });
});

describe("findings", () => {
  test("create / list / patch (confirmed, status, cause, resolution, follow_up) / delete", async () => {
    await withServer({}, async (c) => {
      const unit = ((await (await c.json("POST", "/api/units", { unit_tag: "RTU-7", site: "Pharmacy" })).json()) as { unit: { id: string } }).unit;
      const conv = ((await (await c.json("POST", "/api/conversations", { unit_id: unit.id })).json()) as { conversation: { id: string } }).conversation;
      const created = await c.json("POST", "/api/findings", {
        unit_id: unit.id,
        conversation_id: conv.id,
        symptom: "Low suction, high superheat",
        cause: "Undercharge",
        status: "open",
        origin: "assistant",
        confirmed: 0,
        tags: ["Charge", "leak check"],
        measurements: { suctionPsig: 95, superheatF: 25 },
        refrigerant: "R-410A",
      });
      assert.equal(created.status, 201);
      const f = ((await created.json()) as { finding: Record<string, unknown> }).finding;
      assert.equal(f.status, "open");
      assert.equal(f.confirmed, 0);
      assert.equal(f.origin, "assistant");
      assert.equal(f.tags, "charge,leak-check");
      assert.equal(f.unit_id, unit.id);

      const list = (await (await c.get(`/api/findings?unit_id=${unit.id}`)).json()) as { findings: { id: string }[] };
      assert.deepEqual(list.findings.map((x) => x.id), [f.id]);
      const byConv = (await (await c.get(`/api/findings?conversation_id=${conv.id}`)).json()) as { findings: { id: string }[] };
      assert.equal(byConv.findings.length, 1);

      const patched = await c.json("PATCH", `/api/findings/${f.id}`, { confirmed: 1, status: "resolved", resolution: "Found leak at schrader, repaired, added 2 lb", follow_up: "Recheck in 30 days", refrigerant_added_lbs: 2 });
      assert.equal(patched.status, 200);
      const pf = ((await patched.json()) as { finding: Record<string, unknown> }).finding;
      assert.equal(pf.confirmed, 1);
      assert.equal(pf.status, "resolved");
      assert.equal(pf.refrigerant_added_lbs, 2);
      assert.equal(pf.follow_up, "Recheck in 30 days");
      assert.equal(pf.cause, "Undercharge");

      await expectError(await c.json("PATCH", `/api/findings/${f.id}`, { status: "bogus" }), 400, "validation");
      await expectError(await c.json("PATCH", `/api/findings/${f.id}`, {}), 400, "validation");
      // A present-but-empty status on PATCH is a 400, never a silent flip to "resolved".
      const reopened = await c.json("PATCH", `/api/findings/${f.id}`, { status: "open" });
      assert.equal(reopened.status, 200);
      for (const status of ["", null]) {
        await expectError(await c.json("PATCH", `/api/findings/${f.id}`, { status }), 400, "validation");
        await expectError(await c.json("PATCH", `/api/findings/${f.id}`, { cause: "Leak", status }), 400, "validation");
        const still = ((await (await c.get(`/api/findings/${f.id}`)).json()) as { finding: Record<string, unknown> }).finding;
        assert.equal(still.status, "open", `status ${JSON.stringify(status)}`);
        assert.equal(still.cause, "Undercharge");
      }
      // On create, an omitted/empty status still defaults to "resolved" (the tech is logging a finished job).
      for (const body of [{ symptom: "Dirty filter" }, { symptom: "Dirty filter", status: null }, { symptom: "Dirty filter", status: "" }]) {
        const made = await c.json("POST", "/api/findings", body);
        assert.equal(made.status, 201);
        const mf = ((await made.json()) as { finding: Record<string, unknown> }).finding;
        assert.equal(mf.status, "resolved");
        await c.json("DELETE", `/api/findings/${mf.id as string}`);
      }
      await expectError(await c.json("POST", "/api/findings", { symptom: "x", status: "bogus" }), 400, "validation");
      await expectError(await c.json("POST", "/api/findings", { cause: "no symptom" }), 400, "validation");
      await expectError(await c.json("POST", "/api/findings", { symptom: "x", unit_id: "nope" }), 400, "validation");
      await expectError(await c.json("POST", "/api/findings", { symptom: "x", unit_id: "0123456789abcdef" }), 404, "not_found");
      await expectError(await c.get("/api/findings?unit_id=zzz"), 400, "validation");

      const del = await c.json("DELETE", `/api/findings/${f.id}`);
      assert.equal(del.status, 200);
      await expectError(await c.json("DELETE", `/api/findings/${f.id}`), 404, "not_found");
    });
  });
});

// ---------------------------------------------------------------------------
// Conversations + SSE
// ---------------------------------------------------------------------------

describe("conversations", () => {
  test("CRUD, list filter, 400 on bad ids, 404 on unknown", async () => {
    await withServer({}, async (c) => {
      const unit = ((await (await c.json("POST", "/api/units", { unit_tag: "RTU-7", site: "Pharmacy", model: CARRIER_MODEL })).json()) as { unit: { id: string } }).unit;
      const res = await c.json("POST", "/api/conversations", {});
      assert.equal(res.status, 201);
      const conv = ((await res.json()) as { conversation: { id: string; title: string; unit_id: string | null } }).conversation;
      assert.equal(conv.title, "New conversation");
      assert.equal(conv.unit_id, null);

      const onUnit = ((await (await c.json("POST", "/api/conversations", { unit_id: unit.id, title: "RTU-7 no cooling" })).json()) as { conversation: { id: string; unit_id: string; unit: { unit_tag: string } } }).conversation;
      assert.equal(onUnit.unit_id, unit.id);
      assert.equal(onUnit.unit.unit_tag, "RTU-7");

      const got = (await (await c.get(`/api/conversations/${onUnit.id}`)).json()) as { conversation: { id: string }; unit: { id: string }; messages: unknown[]; busy: boolean };
      assert.equal(got.conversation.id, onUnit.id);
      assert.equal(got.unit.id, unit.id);
      assert.deepEqual(got.messages, []);
      assert.equal(got.busy, false);

      const list = (await (await c.get(`/api/conversations?unit_id=${unit.id}`)).json()) as { conversations: { id: string }[] };
      assert.deepEqual(list.conversations.map((x) => x.id), [onUnit.id]);
      const all = (await (await c.get("/api/conversations?limit=10")).json()) as { conversations: { id: string }[] };
      assert.equal(all.conversations.length, 2);
      assert.equal(all.conversations[0]?.id, onUnit.id); // newest updated first

      const patched = ((await (await c.json("PATCH", `/api/conversations/${conv.id}`, { title: "Renamed", unit_id: unit.id })).json()) as { conversation: { title: string; unit_id: string } }).conversation;
      assert.equal(patched.title, "Renamed");
      assert.equal(patched.unit_id, unit.id);
      const detached = ((await (await c.json("PATCH", `/api/conversations/${conv.id}`, { unit_id: null })).json()) as { conversation: { unit_id: string | null } }).conversation;
      assert.equal(detached.unit_id, null);

      await expectError(await c.get("/api/conversations/not-hex"), 400, "validation");
      await expectError(await c.get("/api/conversations?unit_id=bad"), 400, "validation");
      await expectError(await c.json("POST", "/api/conversations", { unit_id: "bad" }), 400, "validation");
      await expectError(await c.json("POST", "/api/conversations", { unit_id: "0123456789abcdef" }), 404, "not_found");
      await expectError(await c.json("PATCH", `/api/conversations/${conv.id}`, { title: "" }), 400, "validation");
      await expectError(await c.json("PATCH", `/api/conversations/${conv.id}`, {}), 400, "validation");
      await expectError(await c.get("/api/conversations/0123456789abcdef"), 404, "not_found");

      const del = await c.json("DELETE", `/api/conversations/${conv.id}`);
      assert.equal(del.status, 200);
      await expectError(await c.get(`/api/conversations/${conv.id}`), 404, "not_found");
      await expectError(await c.json("DELETE", `/api/conversations/${conv.id}`), 404, "not_found");
    });
  });

  test("POST messages streams SSE (tool_start first, done last) and the tool folds into the assistant message", async () => {
    await withServer({}, async (c) => {
      const conv = ((await (await c.json("POST", "/api/conversations", {})).json()) as { conversation: { id: string } }).conversation;
      const res = await c.json("POST", `/api/conversations/${conv.id}/messages`, { text: `Decode ${CARRIER_MODEL} for me` });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
      assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
      assert.equal(res.headers.get("x-accel-buffering"), "no");
      const text = await res.text();
      assert.ok(text.endsWith("\n\n"), "frames end with a blank line");
      const events = parseSse(text);
      assert.ok(events.length >= 3);
      assert.equal(events[0]?.type, "tool_start");
      assert.equal((events[0] as { name: string }).name, "decode_unit");
      assert.ok(events.some((e) => e.type === "tool_end" && e.ok === true));
      assert.ok(events.some((e) => e.type === "delta"));
      const last = events[events.length - 1]!;
      assert.equal(last.type, "done");
      assert.equal((last as { conversationId: string }).conversationId, conv.id);
      assert.equal(events.filter((e) => e.type === "done" || e.type === "error").length, 1);

      const got = (await (await c.get(`/api/conversations/${conv.id}`)).json()) as { conversation: { title: string }; messages: DisplayMessage[]; busy: boolean };
      assert.equal(got.busy, false);
      assert.equal(got.conversation.title, `Decode ${CARRIER_MODEL} for me`);
      assert.equal(got.messages[0]?.role, "user");
      assert.equal(got.messages[0]?.text, `Decode ${CARRIER_MODEL} for me`);
      const withTools = got.messages.find((m) => m.role === "assistant" && m.tools && m.tools.length > 0);
      assert.ok(withTools, "assistant message with folded tools");
      const tool = withTools.tools![0]!;
      assert.equal(tool.name, "decode_unit");
      assert.equal(tool.ok, true);
      assert.match(tool.label, /Decode/);
      assert.ok(tool.summary.length > 0);
      assert.equal(got.messages.some((m) => (m as { kind?: string }).kind === "tool_result"), false);
      const final = got.messages[got.messages.length - 1]!;
      assert.equal(final.role, "assistant");
      assert.match(final.text, /Demo mode/);
      assert.equal(openStreamCount(), 0);
      assert.equal(c.repos.messages.list(conv.id).length, 4); // user, assistant(tool_use), tool_result, assistant
    });
  });

  test("images: valid PNG accepted (data-URL prefix stripped); bad base64 / mismatched media type / too many → 400", async () => {
    await withServer({}, async (c) => {
      const conv = ((await (await c.json("POST", "/api/conversations", {})).json()) as { conversation: { id: string } }).conversation;
      const p = `/api/conversations/${conv.id}/messages`;
      await expectError(await c.json("POST", p, { text: "x", images: [{ media_type: "image/png", data: "!!!not-base64!!!" }] }), 400, "validation");
      await expectError(await c.json("POST", p, { text: "x", images: [{ media_type: "image/png", data: JPEG_HEAD }] }), 400, "validation");
      await expectError(await c.json("POST", p, { text: "x", images: [{ media_type: "image/png", data: Buffer.from("plain text, no magic").toString("base64") }] }), 400, "validation");
      await expectError(await c.json("POST", p, { text: "x", images: Array.from({ length: 5 }, () => ({ media_type: "image/png", data: PNG_1PX })) }), 400, "validation");
      await expectError(await c.json("POST", p, { text: "x", images: "nope" }), 400, "validation");
      await expectError(await c.json("POST", p, { text: "   " }), 400, "validation");
      await expectError(await c.json("POST", p, {}), 400, "validation");
      await expectError(await c.json("POST", "/api/conversations/zz/messages", { text: "x" }), 400, "validation");
      await expectError(await c.json("POST", "/api/conversations/0123456789abcdef/messages", { text: "x" }), 404, "not_found");

      const ok = await c.json("POST", p, { text: "", images: [{ data: `data:image/png;base64,${PNG_1PX}` }] });
      assert.equal(ok.status, 200);
      const events = parseSse(await ok.text());
      assert.equal(events[events.length - 1]?.type, "done");
      const got = (await (await c.get(`/api/conversations/${conv.id}`)).json()) as { conversation: { title: string }; messages: DisplayMessage[] };
      assert.equal(got.conversation.title, "Photo of nameplate");
      assert.equal(got.messages[0]?.images?.[0]?.media_type, "image/png");
      assert.equal(got.messages[0]?.images?.[0]?.data, PNG_1PX);
    });
  });

  test("409 busy while a turn is running; stop endpoint aborts it", async () => {
    const ctl = controlledClient();
    await withServer({ client: ctl.client }, async (c) => {
      const conv = ((await (await c.json("POST", "/api/conversations", {})).json()) as { conversation: { id: string } }).conversation;
      const p = `/api/conversations/${conv.id}/messages`;
      const first = await c.json("POST", p, { text: "hang on" });
      assert.equal(first.status, 200);
      assert.equal(isTurnRunning(conv.id), true);
      await expectError(await c.json("POST", p, { text: "second" }), 409, "busy");
      await expectError(await c.json("DELETE", `/api/conversations/${conv.id}`), 409, "busy");
      const busy = (await (await c.get(`/api/conversations/${conv.id}`)).json()) as { busy: boolean };
      assert.equal(busy.busy, true);

      const stopped = (await (await c.json("POST", `/api/conversations/${conv.id}/stop`, {})).json()) as { stopped: boolean };
      assert.equal(stopped.stopped, true);
      const events = parseSse(await first.text());
      const last = events[events.length - 1]!;
      assert.equal(last.type, "error");
      assert.equal((last as { code: string }).code, "aborted");
      assert.equal(isTurnRunning(conv.id), false);
      const again = (await (await c.json("POST", `/api/conversations/${conv.id}/stop`, {})).json()) as { stopped: boolean };
      assert.equal(again.stopped, false);
      const after = (await (await c.get(`/api/conversations/${conv.id}`)).json()) as { busy: boolean; messages: DisplayMessage[] };
      assert.equal(after.busy, false);
      assert.equal(after.messages.length, 1); // only the user row was persisted

      // a released turn completes normally afterwards
      const second = await c.json("POST", p, { text: "go" });
      ctl.release("All done.");
      const ev2 = parseSse(await second.text());
      assert.equal(ev2[ev2.length - 1]?.type, "done");
    });
  });

  test("client disconnect does not abort the turn: it completes and persists", async () => {
    const ctl = controlledClient();
    await withServer({ client: ctl.client }, async (c) => {
      const conv = ((await (await c.json("POST", "/api/conversations", {})).json()) as { conversation: { id: string } }).conversation;
      const ac = new AbortController();
      const res = await fetch(`${c.base}/api/conversations/${conv.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "keep going" }), signal: ac.signal });
      assert.equal(res.status, 200);
      ac.abort();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(isTurnRunning(conv.id), true);
      ctl.release("Persisted anyway.");
      for (let i = 0; i < 100 && isTurnRunning(conv.id); i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(isTurnRunning(conv.id), false);
      const got = (await (await c.get(`/api/conversations/${conv.id}`)).json()) as { messages: DisplayMessage[] };
      assert.equal(got.messages.length, 2);
      assert.equal(got.messages[1]?.text, "Persisted anyway.");
      assert.equal(openStreamCount(), 0);
    });
  });
});

// ---------------------------------------------------------------------------
// Search + export
// ---------------------------------------------------------------------------

describe("search and export", () => {
  test("search returns message, finding and unit hits; q required", async () => {
    await withServer({}, async (c) => {
      const unit = ((await (await c.json("POST", "/api/units", { unit_tag: "RTU-7", site: "Pharmacy", model: CARRIER_MODEL })).json()) as { unit: { id: string } }).unit;
      await c.json("POST", "/api/findings", { unit_id: unit.id, symptom: "Burned contactor on compressor 1", resolution: "Replaced contactor" });
      const conv = c.repos.conversations.create({ unit_id: unit.id, title: "Contactor job" });
      c.repos.messages.append(conv.id, "user", [{ type: "text", text: "the contactor is pitted and humming" }], "the contactor is pitted and humming");
      const res = await c.get("/api/search?q=contactor&limit=30");
      assert.equal(res.status, 200);
      const { hits } = (await res.json()) as { hits: { kind: string; id: string; conversationId?: string; snippet: string }[] };
      assert.ok(hits.some((h) => h.kind === "finding"));
      assert.ok(hits.some((h) => h.kind === "message" && h.conversationId === conv.id));
      const units = (await (await c.get("/api/search?q=RTU-7")).json()) as { hits: { kind: string; unitId?: string }[] };
      assert.ok(units.hits.some((h) => h.kind === "unit" && h.unitId === unit.id));
      const scoped = (await (await c.get(`/api/search?q=contactor&unit_id=${unit.id}&site=Pharmacy`)).json()) as { hits: unknown[] };
      assert.ok(scoped.hits.length >= 2);
      await expectError(await c.get("/api/search"), 400, "validation");
      await expectError(await c.get("/api/search?q=x&since=yesterday"), 400, "validation");
    });
  });

  test("export includes units, conversations, messages (images omitted) and findings", async () => {
    await withServer({}, async (c) => {
      const unit = c.repos.units.create({ unit_tag: "RTU-1", site: "Pharmacy" });
      c.repos.units.archive(c.repos.units.create({ unit_tag: "OLD-1" }).id);
      const conv = c.repos.conversations.create({ unit_id: unit.id });
      c.repos.messages.append(conv.id, "user", [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX } }, { type: "text", text: "nameplate" }], "nameplate");
      c.repos.findings.create({ unit_id: unit.id, symptom: "Dirty condenser" });
      const res = await c.get("/api/export");
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="hvac-export-2026-09-26\.json"/);
      const ex = (await res.json()) as { exportedAt: string; complete: boolean; truncated: string[]; limit: number; units: unknown[]; conversations: unknown[]; messages: { content: { type: string }[] }[]; findings: unknown[] };
      assert.equal(ex.exportedAt, NOW.toISOString());
      assert.equal(ex.units.length, 2);
      assert.equal(ex.conversations.length, 1);
      assert.equal(ex.findings.length, 1);
      assert.equal(ex.messages.length, 1);
      assert.deepEqual(ex.messages[0]!.content.map((b) => b.type), ["image_omitted", "text"]);
      assert.equal(JSON.stringify(ex).includes(PNG_1PX), false);
      assert.equal(ex.complete, true);
      assert.deepEqual(ex.truncated, []);
      assert.equal(ex.limit, EXPORT_LIST_CAP);
    });
  });

  test("export says which collections hit the list cap instead of silently dropping rows", async () => {
    await withServer({}, async (c) => {
      const unit = c.repos.units.create({ unit_tag: "RTU-1" });
      for (let i = 0; i < EXPORT_LIST_CAP + 5; i++) c.repos.findings.create({ unit_id: unit.id, symptom: `Finding ${i}` });
      const res = await c.get("/api/export");
      assert.equal(res.status, 200);
      const ex = (await res.json()) as { complete: boolean; truncated: string[]; findings: unknown[]; units: unknown[] };
      assert.equal(ex.findings.length, EXPORT_LIST_CAP);
      assert.equal(ex.units.length, 1);
      assert.equal(ex.complete, false);
      assert.deepEqual(ex.truncated, ["findings"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Reference + calculators
// ---------------------------------------------------------------------------

describe("reference", () => {
  test("refrigerants list carries meta and every table id", async () => {
    await withServer({}, async (c) => {
      const { refrigerants } = (await (await c.get("/api/reference/refrigerants")).json()) as { refrigerants: { id: string; safetyClass?: string; hasTable: boolean }[] };
      const ids = new Set(refrigerants.map((r) => r.id));
      for (const id of kb.refrigerants.tables.keys()) assert.ok(ids.has(id), `table ${id} listed`);
      const r410 = refrigerants.find((r) => r.id === "R-410A")!;
      assert.equal(r410.safetyClass, "A1");
      assert.equal(r410.hasTable, true);
    });
  });

  test("pt lookup by psig and temp_f, with elevation; validation and unknown refrigerant", async () => {
    await withServer({}, async (c) => {
      const byPsig = (await (await c.get("/api/reference/pt?refrigerant=R-410A&psig=118")).json()) as { dewTempF: number; bubbleTempF: number; safetyClass: string; notes: string[] };
      assert.ok(Math.abs(byPsig.dewTempF - 40) < 1.5);
      assert.equal(byPsig.safetyClass, "A1");
      const byTemp = (await (await c.get("/api/reference/pt?refrigerant=410a&temp_f=40")).json()) as { dewPsig: number; bubblePsig: number };
      assert.ok(Math.abs(byTemp.dewPsig - 118.8) < 2);
      const elev = (await (await c.get("/api/reference/pt?refrigerant=R-410A&psig=118&elevation_ft=5000")).json()) as { dewTempF: number; notes: string[]; elevationFt?: number };
      assert.ok(elev.notes.some((n) => /5,000 ft/.test(n)));
      assert.ok(elev.dewTempF > byPsig.dewTempF);
      await expectError(await c.get("/api/reference/pt?refrigerant=R-410A"), 400, "validation");
      await expectError(await c.get("/api/reference/pt?psig=100"), 400, "validation");
      await expectError(await c.get("/api/reference/pt?refrigerant=R-410A&psig=abc"), 400, "validation");
      await expectError(await c.get("/api/reference/pt?refrigerant=R-9999&psig=100"), 404, "not_found");
    });
  });

  test("electrical reference and fault lookup", async () => {
    await withServer({}, async (c) => {
      const comp = (await (await c.get("/api/reference/electrical?component=run%20capacitor")).json()) as { kind: string; components: { id: string }[] };
      assert.equal(comp.kind, "component");
      assert.ok(comp.components.length > 0);
      const proc = (await (await c.get("/api/reference/electrical?symptom=unit%20dead")).json()) as { kind: string; procedures: unknown[] };
      assert.equal(proc.kind, "procedure");
      assert.ok(proc.procedures.length > 0);
      const any = (await (await c.get("/api/reference/electrical?q=voltage%20imbalance")).json()) as { kind: string; reference: unknown[] };
      assert.equal(any.kind, "any");
      assert.ok(any.reference.length > 0);
      await expectError(await c.get("/api/reference/electrical"), 400, "validation");

      const fault = (await (await c.get("/api/reference/fault?code=A140&manufacturer=carrier")).json()) as { code: string; hits: { manufacturer: string; platform: { id: string; name: string }; fault: { code: string; meaning: string } }[] };
      assert.equal(fault.code, "A140");
      assert.ok(fault.hits.length > 0);
      assert.equal(fault.hits[0]!.fault.code, "A140");
      assert.equal(typeof fault.hits[0]!.platform.name, "string");
      await expectError(await c.get("/api/reference/fault"), 400, "validation");
    });
  });
});

describe("calculators", () => {
  test("superheat-subcooling accepts snake_case and camelCase and adds targets", async () => {
    await withServer({}, async (c) => {
      const snake = (await (await c.json("POST", "/api/calc/superheat-subcooling", { refrigerant: "R-410A", metering_device: "txv", suction_psig: 118, suction_line_temp_f: 50, liquid_psig: 340, liquid_line_temp_f: 95 })).json()) as Record<string, number>;
      assert.ok(Math.abs(snake.superheatF! - 10.2) < 0.2);
      assert.ok(Math.abs(snake.subcoolingF! - 9.6) < 0.2);
      assert.equal(snake.targetSubcoolingF, 10);
      assert.ok(Math.abs(snake.subcoolingDelta! - -0.4) < 0.01);
      const camel = (await (await c.json("POST", "/api/calc/superheat-subcooling", { refrigerant: "R-410A", meteringDevice: "unknown", mode: "ac_cooling", suctionPsig: "118", suctionLineTempF: 50 })).json()) as Record<string, number>;
      assert.equal(camel.superheatF, snake.superheatF);
      await expectError(await c.json("POST", "/api/calc/superheat-subcooling", { refrigerant: "R-410A" }), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/superheat-subcooling", { suction_psig: 118 }), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/superheat-subcooling", { refrigerant: "R-999", suction_psig: 118 }), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/superheat-subcooling", { refrigerant: "R-410A", suction_psig: "high" }), 400, "validation");
    });
  });

  test("diagnose runs the rule engine on a normal system and validates enums", async () => {
    await withServer({}, async (c) => {
      const res = await c.json("POST", "/api/calc/diagnose", {
        refrigerant: "R-410A",
        meteringDevice: "txv",
        mode: "ac_cooling",
        suctionPsig: 118,
        suctionLineTempF: 50,
        liquidPsig: 340,
        liquidLineTempF: 95,
        outdoorDbF: 85,
        indoorDbF: 75,
        indoorWbF: 63,
        supplyDbF: 57,
        compressorAmps: 16,
        compressorRla: 20,
        runtime_minutes: 20,
        economizer_position: "closed",
      });
      assert.equal(res.status, 200);
      const dx = (await res.json()) as { derived: Record<string, number>; validity: { ok: boolean }; findings: { severity: string }[]; missing: string[]; summary: string };
      assert.equal(dx.validity.ok, true);
      assert.ok(Math.abs(dx.derived.superheatF! - 10.2) < 0.2);
      assert.equal(dx.derived.deltaTF, 18);
      assert.equal(dx.derived.ampsPercentRla, 80);
      assert.equal(dx.findings.some((f) => f.severity === "warning" || f.severity === "critical"), false);
      assert.equal(typeof dx.summary, "string");
      await expectError(await c.json("POST", "/api/calc/diagnose", { refrigerant: "R-410A", mode: "heating" }), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/diagnose", { refrigerant: "R-410A", metering_device: "piston" }), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/diagnose", { refrigerant: "R-410A", sight_glass: "foggy" }), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/diagnose", { refrigerant: "R-999" }), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/diagnose", []), 400, "validation");
    });
  });

  test("electrical calculators validate kind and required numbers", async () => {
    await withServer({}, async (c) => {
      const vi = (await (await c.json("POST", "/api/calc/electrical", { kind: "voltage_imbalance", vab: 480, vbc: 470, vca: 475 })).json()) as { kind: string; values: Record<string, number>; interpretation: string[]; warnings: string[] };
      assert.equal(vi.kind, "voltage_imbalance");
      assert.ok(Math.abs(vi.values.imbalancePercent! - 1.05) < 0.01);
      const cap = (await (await c.json("POST", "/api/calc/electrical", { kind: "capacitor_under_load", amps: "1.5", volts: 380, ratedUf: 15 })).json()) as { values: Record<string, number> };
      assert.equal(typeof cap.values, "object");
      const heat = await c.json("POST", "/api/calc/electrical", { kind: "electric_heat_kw", volts: 480, amps: 24, phase: 3 });
      assert.equal(heat.status, 200);
      const snake = await c.json("POST", "/api/calc/electrical", { kind: "psychrometrics", db_f: 75, wb_f: 63, elevation_ft: 1000 });
      assert.equal(snake.status, 200);
      await expectError(await c.json("POST", "/api/calc/electrical", { kind: "laser" }), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/electrical", { vab: 480 }), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/electrical", { kind: "voltage_imbalance", vab: 480, vbc: 470 }), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/electrical", { kind: "winding_check", phase: 2, r1: 1, r2: 2, r3: 3 }), 400, "validation");
      await expectError(await c.json("POST", "/api/calc/electrical", { kind: "ohms_law", volts: 24 }), 400, "validation");
    });
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("route helpers", () => {
  test("detectImageType / parseImages", () => {
    assert.equal(detectImageType(Buffer.from(PNG_1PX, "base64")), "image/png");
    assert.equal(detectImageType(Buffer.from(JPEG_HEAD, "base64")), "image/jpeg");
    assert.equal(detectImageType(Buffer.from("GIF89a......")), "image/gif");
    assert.equal(detectImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
    assert.equal(detectImageType(Buffer.from("hello world")), undefined);
    assert.equal(parseImages(undefined), undefined);
    assert.equal(parseImages([]), undefined);
    const ok = parseImages([{ media_type: "image/jpg", data: `data:image/jpeg;base64,${JPEG_HEAD}` }])!;
    assert.equal(ok[0]!.media_type, "image/jpeg");
    assert.equal(ok[0]!.data, JPEG_HEAD);
    assert.throws(() => parseImages([{ data: "x".repeat(4 * 1024 * 1024) }]), /3\.5 MB/);
    assert.throws(() => parseImages([{ media_type: "image/gif", data: PNG_1PX }]), /does not match/);
  });

  test("foldMessages joins tool_use with tool_result, hides thinking, keeps images", () => {
    const rows = [
      { id: "a", conversation_id: "c", seq: 1, role: "user" as const, kind: "chat" as const, content_json: JSON.stringify([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }, { type: "text", text: "hi" }]), text: "hi", created_at: "2026-01-01T00:00:00Z" },
      {
        id: "b",
        conversation_id: "c",
        seq: 2,
        role: "assistant" as const,
        kind: "chat" as const,
        content_json: JSON.stringify([
          { type: "thinking", thinking: "secret", signature: "x" },
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "t1", name: "refrigerant_pt", input: { refrigerant: "R-410A", psig: 118 } },
          { type: "tool_use", id: "t2", name: "lookup_fault_code", input: { code: "A140" } },
        ]),
        text: "Let me check.",
        created_at: "2026-01-01T00:00:01Z",
      },
      {
        id: "r",
        conversation_id: "c",
        seq: 3,
        role: "user" as const,
        kind: "tool_result" as const,
        content_json: JSON.stringify([
          { type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ summary: "R-410A 118 psig = 40 °F", other: 1 }) },
          { type: "tool_result", tool_use_id: "t2", is_error: true, content: "x".repeat(300) },
        ]),
        text: "",
        created_at: "2026-01-01T00:00:02Z",
      },
      { id: "d", conversation_id: "c", seq: 4, role: "assistant" as const, kind: "chat" as const, content_json: JSON.stringify([{ type: "text", text: "Done." }, { type: "tool_use", id: "t3", name: "save_finding", input: {} }]), text: "Done.", created_at: "2026-01-01T00:00:03Z" },
    ];
    const out = foldMessages(rows);
    assert.equal(out.length, 3);
    assert.deepEqual(out[0]!.images, [{ media_type: "image/png", data: "AAA" }]);
    const a = out[1]!;
    assert.equal(a.text, "Let me check.");
    assert.equal(JSON.stringify(a).includes("secret"), false);
    assert.equal(a.tools!.length, 2);
    assert.deepEqual(a.tools![0], { id: "t1", name: "refrigerant_pt", input: { refrigerant: "R-410A", psig: 118 }, label: a.tools![0]!.label, ok: true, summary: "R-410A 118 psig = 40 °F" });
    assert.equal(a.tools![1]!.ok, false);
    assert.equal(a.tools![1]!.summary.length, 200);
    assert.equal(out[2]!.tools![0]!.ok, false); // dangling tool_use: no result recorded
    assert.equal(summarizeToolResult([{ type: "text", text: '{"summary":"s"}' }]), "s");
  });

  test("parseMeasurements maps snake_case and validates", () => {
    const m = parseMeasurements({ refrigerant: "R-22", metering_device: "fixed", mode: "refrigeration", suction_psig: "60", indoor_wb_f: 63, defrost_active: "true", head_pressure_control: "fan_cycling", efficiency_tier: "high", circuit: "2", ignored: 1 });
    assert.equal(m.meteringDevice, "fixed");
    assert.equal(m.mode, "refrigeration");
    assert.equal(m.suctionPsig, 60);
    assert.equal(m.indoorWbF, 63);
    assert.equal(m.defrostActive, true);
    assert.equal(m.headPressureControl, "fan_cycling");
    assert.equal(m.efficiencyTier, "high");
    assert.equal(m.circuit, "2");
    assert.equal("ignored" in m, false);
    assert.throws(() => parseMeasurements({}), /refrigerant/);
    assert.throws(() => parseMeasurements({ refrigerant: "R-22", suction_psig: 5000 }), /between/);
  });
});
