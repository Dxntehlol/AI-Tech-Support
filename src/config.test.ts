import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.ts";

test("loadConfig defaults", () => {
  const c = loadConfig({});
  assert.equal(c.port, 8787);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.claudeModel, "claude-opus-5");
  assert.equal(c.claudeEffort, "high");
  assert.equal(c.claudeFallbacks, "default");
  assert.equal(c.enableWebSearch, false);
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
