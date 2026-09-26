import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT } from "./config.ts";

/**
 * src/server.ts wires the process up on import (listen, signal handlers), so it is exercised as a child
 * process: a loopback bind on a free port, an in-temp SQLite file, and the SDK's config dir pointed at a
 * scratch folder so the machine's real `ant auth login` profile (if any) never leaks into the test.
 */

const STARTUP_TIMEOUT_MS = 30_000;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

interface Running {
  child: ChildProcess;
  port: number;
  output: () => string;
}

async function startServer(extraEnv: Record<string, string | undefined>, configDir: string, dataDir: string): Promise<Running> {
  const port = await freePort();
  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    DB_PATH: join(dataDir, "hvac.sqlite"),
    APP_PASSWORD: "",
    // Empty strings (not unset) so a developer's .env cannot fill them back in via loadDotEnv().
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_FAKE: "",
    ANTHROPIC_PROFILE: "",
    ANTHROPIC_FEDERATION_RULE_ID: "",
    ANTHROPIC_ORGANIZATION_ID: "",
    ANTHROPIC_CONFIG_DIR: configDir,
    ...extraEnv,
  };
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(PROJECT_ROOT, "src", "server.ts")], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => (out += d));
  child.stderr!.on("data", (d: string) => (out += d));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start within ${STARTUP_TIMEOUT_MS} ms:\n${out}`)), STARTUP_TIMEOUT_MS);
    const check = (): void => {
      if (out.includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout!.on("data", check);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}:\n${out}`));
    });
  });
  return { child, port, output: () => out };
}

async function stopServer(r: Running): Promise<void> {
  if (r.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => r.child.once("exit", () => resolve()));
  r.child.kill("SIGTERM");
  const killer = setTimeout(() => r.child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(killer);
}

async function withScratch(fn: (configDir: string, dataDir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "hvac-server-"));
  try {
    const configDir = join(root, "anthropic");
    const dataDir = join(root, "data");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    await fn(configDir, dataDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function health(port: number): Promise<{ ok: boolean; demo: boolean }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(res.status, 200);
  return (await res.json()) as { ok: boolean; demo: boolean };
}

describe("server startup: demo mode vs stored credentials", () => {
  test("no env credentials and no stored profile → demo mode, and the log says how to fix it", async () => {
    await withScratch(async (configDir, dataDir) => {
      const r = await startServer({}, configDir, dataDir);
      try {
        const h = await health(r.port);
        assert.equal(h.ok, true);
        assert.equal(h.demo, true);
        assert.match(r.output(), /DEMO MODE: no ANTHROPIC_API_KEY/);
        assert.match(r.output(), /ant auth login/);
      } finally {
        await stopServer(r);
      }
    });
  });

  test("an `ant auth login` profile (no env vars) is real credentials, not demo mode", async () => {
    await withScratch(async (configDir, dataDir) => {
      // The profile layout the SDK's default credential chain reads: <config_dir>/configs/<profile>.json.
      mkdirSync(join(configDir, "configs"), { recursive: true });
      writeFileSync(join(configDir, "configs", "default.json"), JSON.stringify({ version: "1.0", authentication: { type: "user_oauth", client_id: "test" } }));
      const r = await startServer({}, configDir, dataDir);
      try {
        const h = await health(r.port);
        assert.equal(h.ok, true);
        assert.equal(h.demo, false);
        assert.doesNotMatch(r.output(), /DEMO MODE/);
      } finally {
        await stopServer(r);
      }
    });
  });

  test("a stored profile the SDK cannot use falls back to demo mode with the reason logged", async () => {
    await withScratch(async (configDir, dataDir) => {
      mkdirSync(join(configDir, "configs"), { recursive: true });
      writeFileSync(join(configDir, "configs", "default.json"), JSON.stringify({ authentication: { type: "something_else" } }));
      const r = await startServer({}, configDir, dataDir);
      try {
        assert.equal((await health(r.port)).demo, true);
        assert.match(r.output(), /Stored Anthropic profile could not be read/);
      } finally {
        await stopServer(r);
      }
    });
  });

  test("CLAUDE_FAKE=1 forces demo mode even with a stored profile", async () => {
    await withScratch(async (configDir, dataDir) => {
      mkdirSync(join(configDir, "configs"), { recursive: true });
      writeFileSync(join(configDir, "configs", "default.json"), JSON.stringify({ authentication: { type: "user_oauth" } }));
      const r = await startServer({ CLAUDE_FAKE: "1" }, configDir, dataDir);
      try {
        assert.equal((await health(r.port)).demo, true);
        assert.match(r.output(), /DEMO MODE: CLAUDE_FAKE=1/);
      } finally {
        await stopServer(r);
      }
    });
  });
});
