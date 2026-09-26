import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, loadConfig, parseAllowOrigins, readPackageVersion } from "./config.ts";

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
