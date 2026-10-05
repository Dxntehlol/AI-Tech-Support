import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, parseDotEnvText } from "./config.ts";
import {
  SETTINGS_HEADER,
  applySettings,
  formatValue,
  mergeSettings,
  parseSettings,
  readSettings,
  settingsPathFor,
  updateSettingsText,
  writeSettings,
} from "./settingsStore.ts";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "hvac-settings-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const KEY = "sk-ant-test-0123456789abcdefWXYZ";

describe("settingsStore", () => {
  test("settings.env lives in the database directory", () => {
    assert.equal(settingsPathFor("/app/data/hvac.sqlite"), join("/app/data", "settings.env"));
  });

  test("parse: managed keys only, empty values ignored, first occurrence wins", () => {
    const s = parseSettings(
      [
        "# comment",
        `ANTHROPIC_API_KEY=${KEY}`,
        "ANTHROPIC_API_KEY=sk-ant-second-should-not-win",
        "CLAUDE_MODEL=",
        "CLAUDE_EFFORT=   # note only",
        "ENABLE_WEB_SEARCH=1",
        "APP_PASSWORD=hunter2",
        "PORT=9999",
      ].join("\n"),
    );
    assert.deepEqual(s, { ANTHROPIC_API_KEY: KEY, ENABLE_WEB_SEARCH: "1" });
  });

  test("quoting rules are identical to loadDotEnv", () => {
    const text = [
      'CLAUDE_MODEL="claude-opus-5"',
      "CLAUDE_EFFORT='low'  ",
      "ENABLE_WEB_SEARCH=1 # trailing comment",
      `ANTHROPIC_API_KEY="${KEY} #inside quotes"`,
    ].join("\n");
    const parsed = parseSettings(text);
    assert.equal(parsed.CLAUDE_MODEL, "claude-opus-5");
    assert.equal(parsed.CLAUDE_EFFORT, "low");
    assert.equal(parsed.ENABLE_WEB_SEARCH, "1");
    assert.equal(parsed.ANTHROPIC_API_KEY, `${KEY} #inside quotes`);
    // The same text through the .env loader gives the same values.
    withDir((dir) => {
      const file = join(dir, ".env");
      writeFileSync(file, text);
      const saved: Record<string, string | undefined> = {};
      for (const k of ["CLAUDE_MODEL", "CLAUDE_EFFORT", "ENABLE_WEB_SEARCH", "ANTHROPIC_API_KEY"]) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
      try {
        loadDotEnv(file);
        for (const [k, v] of Object.entries(parsed)) assert.equal(process.env[k], v, k);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  });

  test("override rules: settings win over env for managed keys; empty values never override", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-from-env-aaaaaaaaaaaa", CLAUDE_MODEL: "claude-opus-5", APP_PASSWORD: "keep" };
    const settings = parseSettings(`ANTHROPIC_API_KEY=${KEY}\nCLAUDE_MODEL=\nAPP_PASSWORD=changed\n`);
    const merged = mergeSettings(env as Record<string, string | undefined>, settings);
    assert.equal(merged.ANTHROPIC_API_KEY, KEY);
    assert.equal(merged.CLAUDE_MODEL, "claude-opus-5");
    assert.equal(merged.APP_PASSWORD, "keep");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-from-env-aaaaaaaaaaaa", "merge does not mutate");
    const applied = applySettings(env, settings);
    assert.deepEqual(applied, ["ANTHROPIC_API_KEY"]);
    assert.equal(env.ANTHROPIC_API_KEY, KEY);
    assert.equal(env.APP_PASSWORD, "keep");
  });

  test("formatValue round-trips through the parser; line breaks are rejected", () => {
    for (const v of ["plain", "", "with space", "has#hash", "a # b", '"quoted"', "'single'", " lead", "trail ", 'mid"quote']) {
      const parsed = parseDotEnvText(`X=${formatValue(v)}`).get("X");
      assert.equal(parsed, v, JSON.stringify(v));
    }
    assert.throws(() => formatValue("a\nb"), /line breaks/);
  });

  test("updateSettingsText keeps comments and other lines, replaces in place, drops duplicates, appends new keys", () => {
    const text = "# keep me\nCLAUDE_MODEL=claude-opus-5\nOTHER=1\nCLAUDE_MODEL=dup\n";
    const out = updateSettingsText(text, { CLAUDE_MODEL: "claude-fable-5-1", ANTHROPIC_API_KEY: KEY, CLAUDE_EFFORT: null });
    assert.equal(out, `# keep me\nCLAUDE_MODEL=claude-fable-5-1\nOTHER=1\nANTHROPIC_API_KEY=${KEY}\nCLAUDE_EFFORT=\n`);
    assert.equal(updateSettingsText(out, {}), out, "no updates = unchanged");
  });

  test("writeSettings: header on a new file, atomic (no temp files left), mode 0600, read back", () => {
    withDir((dir) => {
      const path = join(dir, "nested", "settings.env");
      const s = writeSettings(path, { ANTHROPIC_API_KEY: KEY, ENABLE_WEB_SEARCH: "0" });
      assert.deepEqual(s, { ANTHROPIC_API_KEY: KEY, ENABLE_WEB_SEARCH: "0" });
      const text = readFileSync(path, "utf8");
      assert.ok(text.startsWith(SETTINGS_HEADER), "header comment");
      assert.deepEqual(readSettings(path), s);
      assert.deepEqual(readdirSync(join(dir, "nested")), ["settings.env"], "temp file renamed away");
      if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);

      // Clearing writes an empty value (no override) and keeps the comment block.
      writeFileSync(path, `${readFileSync(path, "utf8")}# my own note\n`, { mode: 0o644 });
      const cleared = writeSettings(path, { ANTHROPIC_API_KEY: null });
      assert.deepEqual(cleared, { ENABLE_WEB_SEARCH: "0" });
      const after = readFileSync(path, "utf8");
      assert.match(after, /^ANTHROPIC_API_KEY=$/m);
      assert.match(after, /# my own note/);
      assert.ok(!after.includes(KEY));
      if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600, "mode fixed on rewrite");
    });
  });

  test("readSettings: missing file means no settings", () => {
    withDir((dir) => {
      const p = join(dir, "settings.env");
      assert.equal(existsSync(p), false);
      assert.deepEqual(readSettings(p), {});
    });
  });
});
