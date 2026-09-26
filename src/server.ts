import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, loadDotEnv } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { createRepos } from "./db/repos.ts";
import { loadKnowledge } from "./knowledge/loader.ts";
import { createAnthropicClient, hasApiCredentialsInEnv, type MessagesStreamer } from "./agent/client.ts";
import { createFakeClient } from "./agent/fakeClient.ts";
import { turnsInFlight } from "./agent/chat.ts";
import { abortOpenStreams } from "./routes/conversations.ts";
import { createApp } from "./app.ts";

const SHUTDOWN_WAIT_MS = 30_000;
const SHUTDOWN_POLL_MS = 250;
const SHUTDOWN_HARD_EXIT_MS = SHUTDOWN_WAIT_MS + 5_000;

loadDotEnv();
const config = loadConfig();

/** Loopback hosts may run without a password; anything else must set APP_PASSWORD. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1" || /^127(\.\d{1,3}){3}$/.test(h) || h === "::ffff:127.0.0.1";
}

if (!isLoopbackHost(config.host) && !config.appPassword) {
  console.error(
    `Refusing to start: HOST=${config.host} is not a loopback address and APP_PASSWORD is empty.\n` +
      "Set APP_PASSWORD in .env (HTTP basic auth, any username) or bind to HOST=127.0.0.1.",
  );
  process.exit(1);
}

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openDatabase(config.dbPath);
const repos = createRepos(db);
const kb = loadKnowledge(config.knowledgeDir);

const fakeRequested = /^(1|true|yes)$/i.test(process.env.CLAUDE_FAKE ?? "");
const demo = fakeRequested || !hasApiCredentialsInEnv();
let client: MessagesStreamer;
if (demo) {
  console.log("=".repeat(72));
  console.log(
    fakeRequested
      ? "  DEMO MODE: CLAUDE_FAKE=1 — the assistant runs on canned responses (no API calls)."
      : "  DEMO MODE: no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the environment.\n  The assistant runs on canned responses. Set ANTHROPIC_API_KEY in .env for the real model.",
  );
  console.log("=".repeat(72));
  client = createFakeClient();
} else {
  client = createAnthropicClient(config);
}

const allowOrigins = (process.env.ALLOW_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = createApp({ client, config, kb, repos, demo, allowOrigins, log: (m) => console.log(`[${new Date().toISOString()}] ${m}`) });

const server = app.listen(config.port, config.host, () => {
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  console.log(`HVAC Field Assistant listening on http://${host}:${config.port}`);
  console.log(`  model=${config.claudeModel} effort=${config.claudeEffort} fallbacks=${config.claudeFallbacks} webSearch=${config.enableWebSearch ? "on" : "off"}${demo ? " demo=on" : ""}`);
  console.log(`  knowledge: ${kb.manufacturers.length} manufacturer packs, ${kb.refrigerants.tables.size} refrigerants, ${kb.diagnostics.rules.rules.length} diagnostic rules, ${kb.electrical.components.length} electrical components, ${kb.electrical.procedures.length} procedures`);
  console.log(`  db=${config.dbPath}${config.appPassword ? " auth=basic" : " auth=none (loopback only)"}${allowOrigins.length ? ` cors=${allowOrigins.join(",")}` : ""}`);
});
server.on("error", (err) => {
  console.error(`Failed to listen on ${config.host}:${config.port}: ${err.message}`);
  process.exit(1);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: shutting down — no longer accepting connections`);
  const hardExit = setTimeout(() => {
    console.error("Shutdown timed out; exiting.");
    process.exit(1);
  }, SHUTDOWN_HARD_EXIT_MS);
  hardExit.unref();

  server.close();
  const deadline = Date.now() + SHUTDOWN_WAIT_MS;
  if (turnsInFlight() > 0) console.log(`  waiting up to ${SHUTDOWN_WAIT_MS / 1000}s for ${turnsInFlight()} in-flight turn(s)`);
  while (turnsInFlight() > 0 && Date.now() < deadline) await sleep(SHUTDOWN_POLL_MS);
  if (turnsInFlight() > 0) console.log(`  ${turnsInFlight()} turn(s) still running after ${SHUTDOWN_WAIT_MS / 1000}s — aborting`);
  const aborted = abortOpenStreams();
  if (aborted) console.log(`  closed ${aborted} open stream(s)`);
  // Give aborted turns a moment to unwind before the DB goes away.
  const settle = Date.now() + 2_000;
  while (turnsInFlight() > 0 && Date.now() < settle) await sleep(50);
  try {
    db.close();
  } catch (err) {
    console.error(`  db close failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  server.closeAllConnections();
  console.log("Bye.");
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void shutdown(sig);
  });
}
