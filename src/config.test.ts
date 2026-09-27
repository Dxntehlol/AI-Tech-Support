import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT, loadConfig, loadDotEnv, parseAllowOrigins, readPackageVersion } from "./config.ts";

test("loadConfig defaults", () => {
  const c = loadConfig({});
  assert.equal(c.port, 8787);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.claudeModel, "claude-opus-5");
  assert.equal(c.claudeEffort, "high");
  assert.equal(c.claudeFallbacks, "default");
  assert.equal(c.enableWebSearch, false);
  assert.deepEqual(c.allowOrigins, []);
});

test("loadConfig parses env", () => {
  const c = loadConfig({ PORT: "9000", HOST: "0.0.0.0", CLAUDE_EFFORT: "xhigh", CLAUDE_FALLBACKS: "off", ENABLE_WEB_SEARCH: "1", APP_PASSWORD: "pw" });
  assert.equal(c.port, 9000);
  assert.equal(c.host, "0.0.0.0");
  assert.equal(c.claudeEffort, "xhigh");
  assert.equal(c.claudeFallbacks, "off");
  assert.equal(c.enableWebSearch, true);
  assert.equal(c.appPassword, "pw");
});

test("loadConfig parses ALLOW_ORIGINS into an exact-match allowlist", () => {
  const c = loadConfig({ ALLOW_ORIGINS: "capacitor://localhost, http://localhost ,ionic://localhost" });
  assert.deepEqual(c.allowOrigins, ["capacitor://localhost", "http://localhost", "ionic://localhost"]);
});

test("parseAllowOrigins trims, drops trailing slashes and junk, dedupes case-insensitively", () => {
  assert.deepEqual(parseAllowOrigins(undefined), []);
  assert.deepEqual(parseAllowOrigins(""), []);
  assert.deepEqual(parseAllowOrigins("  ,, "), []);
  assert.deepEqual(parseAllowOrigins("https://app.example.com/"), ["https://app.example.com"]);
  assert.deepEqual(parseAllowOrigins("https://app.example.com:8443\nhttp://10.0.0.5:8787"), ["https://app.example.com:8443", "http://10.0.0.5:8787"]);
  assert.deepEqual(parseAllowOrigins("capacitor://localhost,CAPACITOR://localhost"), ["capacitor://localhost"]);
  // Not origins: bare hosts, paths, wildcards — never match a browser Origin header, so they are ignored.
  assert.deepEqual(parseAllowOrigins("example.com, *, https://a.example/path, https://"), []);
});

test("readPackageVersion reads package.json and falls back to 0.0.0", () => {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as { version: string };
  assert.equal(readPackageVersion(), pkg.version);
  assert.match(readPackageVersion(), /^\d+\.\d+\.\d+/);
  assert.equal(readPackageVersion("/nonexistent/dir"), "0.0.0");
});

test("loadDotEnv drops trailing comments and treats a comment-only value as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "hvac-env-"));
  const file = join(dir, ".env");
  // .env.example itself, with every key prefixed so the test never touches real settings.
  const example = readFileSync(join(PROJECT_ROOT, ".env.example"), "utf8").replace(/^([A-Z_]+)=/gm, "T_DOTENV_$1=");
  writeFileSync(file, `${example}\nT_DOTENV_PLAIN=value # note\nT_DOTENV_QUOTED="a # b"\nT_DOTENV_ONLY=   # comment\n`);
  try {
    loadDotEnv(file);
    assert.equal(process.env.T_DOTENV_APP_PASSWORD, "");
    assert.equal(process.env.T_DOTENV_ALLOW_ORIGINS, "");
    assert.equal(process.env.T_DOTENV_ANTHROPIC_API_KEY, "");
    assert.equal(process.env.T_DOTENV_CLAUDE_EFFORT, "high");
    assert.equal(process.env.T_DOTENV_MAX_TOOL_ITERATIONS, "12");
    assert.equal(process.env.T_DOTENV_PLAIN, "value");
    assert.equal(process.env.T_DOTENV_QUOTED, "a # b");
    assert.equal(process.env.T_DOTENV_ONLY, "");
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith("T_DOTENV_")) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  }
});
