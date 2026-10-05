#!/usr/bin/env node
/**
 * One-command setup for the shop machine (macOS, Linux, Windows; needs only Node 22.18+):
 *
 *   node scripts/setup.mjs            install, build, write .env (generated password), (re)start the server
 *                                     under pm2, publish over Tailscale when the tailscale CLI is present,
 *                                     print what to enter on the phone
 *   node scripts/setup.mjs --check    doctor mode: report the state of every step, change nothing
 *
 * Flags: --port <n> | --port=<n>   port to serve on (written to .env; default 8787)
 *        --no-service                do not install/start pm2 (run "npm start" yourself)
 *        --no-tailscale              do not touch "tailscale serve"
 *
 * The Anthropic key is taken from the ANTHROPIC_API_KEY environment variable when the script runs (it is
 * written into .env, mode 600) or added to .env by hand afterwards; it is never a command-line argument.
 * The server is always started with a scrubbed environment so it reads .env and nothing else: editing
 * .env and re-running this script (or "pm2 restart hvac") is how settings change. The exception is the AI
 * connection (key, model, effort, web search): the app's Settings → AI connection saves it to settings.env
 * next to the database (data/settings.env), which wins over .env and applies without a restart.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const NO_SERVICE = args.includes("--no-service");
const NO_TAILSCALE = args.includes("--no-tailscale");
const MIN_NODE = [22, 18, 0];
const IS_WIN = process.platform === "win32";
const IS_ROOT = !IS_WIN && typeof process.getuid === "function" && process.getuid() === 0;
const SERVICE_NAME = "hvac";
const DEFAULT_PORT = 8787;
/** Settings the server must read from .env, never inherit from the shell that ran this script. */
const SCRUB = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_MODEL", "CLAUDE_EFFORT", "CLAUDE_FALLBACKS", "CLAUDE_FAKE", "ENABLE_WEB_SEARCH", "MAX_TOOL_ITERATIONS", "REPLAY_IMAGE_WINDOW", "PORT", "HOST", "DB_PATH", "APP_PASSWORD", "ALLOW_ORIGINS"];

const results = [];
const ok = (step, detail) => results.push({ step, state: "ok", detail });
const warn = (step, detail) => results.push({ step, state: "warn", detail });
const fail = (step, detail) => results.push({ step, state: "fail", detail });
const note = (line) => console.log(line);

// --port parsing (accepts --port N and --port=N; a bad value is an error, not silently ignored)
let portGiven = false;
let PORT = DEFAULT_PORT;
{
  const i = args.findIndex((a) => a === "--port" || a.startsWith("--port="));
  if (i >= 0) {
    portGiven = true;
    const raw = args[i].startsWith("--port=") ? args[i].slice(7) : args[i + 1];
    PORT = Number(raw);
    if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
      console.error(`--port must be a whole number between 1 and 65535 (got "${raw}")`);
      process.exit(2);
    }
  }
}

/** Run a command. On Windows spawnSync needs a shell for .cmd shims, so every argument is quoted there. */
function run(cmd, cmdArgs, opts = {}) {
  const quote = (s) => (IS_WIN && /[\s&|<>^"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const r = spawnSync(IS_WIN ? quote(cmd) : cmd, IS_WIN ? cmdArgs.map(quote) : cmdArgs, { cwd: ROOT, encoding: "utf8", shell: IS_WIN, ...opts });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "", error: r.error };
}
function scrubbedEnv() {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  return env;
}
function has(cmd) {
  const probe = IS_WIN ? run("where", [cmd]) : run("sh", ["-c", `command -v ${cmd}`]);
  return probe.code === 0;
}
/** pm2 binary: on PATH, else under the global npm prefix (a fresh "npm install -g" is often not on PATH yet). */
function pm2Bin() {
  if (has("pm2")) return "pm2";
  const prefix = run("npm", ["prefix", "-g"]).stdout.trim();
  if (!prefix) return null;
  const candidates = IS_WIN ? [join(prefix, "pm2.cmd")] : [join(prefix, "bin", "pm2")];
  return candidates.find((p) => existsSync(p)) ?? null;
}
function tailscaleBin() {
  if (has("tailscale")) return "tailscale";
  const candidates = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"];
  return candidates.find((p) => existsSync(p)) ?? null;
}
function unixUser() {
  return process.env.USER || process.env.LOGNAME || run("id", ["-un"]).stdout.trim() || (IS_ROOT ? "root" : "");
}
/** systemd: is the pm2 boot unit enabled? null when that cannot be determined (macOS, no systemctl). */
function bootEnabled() {
  if (IS_WIN || !has("systemctl")) return null;
  const user = unixUser();
  if (!user) return null;
  return run("systemctl", ["is-enabled", `pm2-${user}`]).code === 0;
}
function existingBootOk() {
  return bootEnabled() === true;
}
function pm2Process(pm2) {
  const list = run(pm2, ["jlist"], { env: scrubbedEnv() });
  try {
    const raw = list.stdout || "";
    const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1) || "[]"; // pm2 prints a banner before the JSON on its first spawn
    const procs = JSON.parse(json);
    return Array.isArray(procs) ? procs.find((p) => p && p.name === SERVICE_NAME) ?? null : null;
  } catch {
    return null;
  }
}
function portFree(port) {
  return new Promise((resolveFree) => {
    const srv = net.createServer();
    srv.once("error", () => resolveFree(false));
    srv.listen({ port, host: "127.0.0.1" }, () => srv.close(() => resolveFree(true)));
  });
}

// ---------------------------------------------------------------- 1. Node version
{
  const v = process.versions.node.split(".").map(Number);
  const enough = v[0] > MIN_NODE[0] || (v[0] === MIN_NODE[0] && (v[1] > MIN_NODE[1] || (v[1] === MIN_NODE[1] && v[2] >= MIN_NODE[2])));
  if (enough) ok("Node.js", `v${process.versions.node}`);
  else {
    fail("Node.js", `v${process.versions.node} is too old; install ${MIN_NODE.join(".")} or newer from https://nodejs.org`);
    report();
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 2. dependencies + build
let built = existsSync(join(ROOT, "dist", "server.js"));
if (!CHECK) {
  note("Installing dependencies…");
  const i = run("npm", ["install", "--no-audit", "--no-fund"], { stdio: "inherit" });
  if (i.code !== 0) fail("npm install", "failed; see the output above");
  else ok("npm install", "done");
  if (i.code === 0) {
    note("Building…");
    const b = run("npm", ["run", "build"], { stdio: "inherit" });
    built = b.code === 0 && existsSync(join(ROOT, "dist", "server.js"));
    if (!built) fail("npm run build", "failed; see the output above");
    else ok("npm run build", "dist/ is up to date");
  }
} else {
  if (existsSync(join(ROOT, "node_modules"))) ok("Dependencies", "node_modules present");
  else warn("Dependencies", "node_modules missing — run: node scripts/setup.mjs");
  if (built) ok("Build", "dist/server.js present");
  else warn("Build", "dist/server.js missing — run: node scripts/setup.mjs");
}

// ---------------------------------------------------------------- 3. .env
const envPath = join(ROOT, ".env");
const env = readEnv(envPath);
const previousPort = Number.parseInt(env.PORT ?? "", 10) || DEFAULT_PORT;
let passwordGenerated = false;
if (!CHECK) {
  const created = !existsSync(envPath);
  let text = created ? readFileSync(join(ROOT, ".env.example"), "utf8") : readFileSync(envPath, "utf8");
  const changes = [];
  if (!(env.APP_PASSWORD || "").trim()) {
    text = setEnv(text, "APP_PASSWORD", randomBytes(12).toString("base64url"));
    changes.push("generated APP_PASSWORD");
    passwordGenerated = true;
  }
  const envKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (envKey && envKey !== env.ANTHROPIC_API_KEY) {
    text = setEnv(text, "ANTHROPIC_API_KEY", envKey);
    changes.push(env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY replaced from the environment" : "ANTHROPIC_API_KEY taken from the environment");
  }
  if (portGiven && env.PORT !== String(PORT)) {
    text = setEnv(text, "PORT", String(PORT));
    changes.push(`PORT=${PORT}`);
  }
  if (created || changes.length) {
    writeFileSync(envPath, text, { mode: 0o600 });
    if (!IS_WIN) chmodSync(envPath, 0o600);
  }
  Object.assign(env, readEnv(envPath));
  ok(".env", created ? `created from .env.example (${changes.join(", ")})` : changes.length ? `updated (${changes.join(", ")})` : "kept as is");
  if (passwordGenerated && !created) warn("Access password", "a NEW password was generated because APP_PASSWORD was empty — re-enter it on every phone");
} else if (!existsSync(envPath)) warn(".env", "missing — run: node scripts/setup.mjs");
else ok(".env", "present");
// settings.env (saved from the app's Settings → AI connection) sits next to the database and wins over .env.
const settingsEnvPath = join(dirname(resolve(ROOT, (env.DB_PATH || "").trim() || "./data/hvac.sqlite")), "settings.env");
const uiSettings = readEnv(settingsEnvPath);
const uiKey = (uiSettings.ANTHROPIC_API_KEY || "").trim();
if (uiKey) ok("Anthropic API key", "set (saved from the app's Settings)");
else if (env.ANTHROPIC_API_KEY) ok("Anthropic API key", "set in .env");
else warn("Anthropic API key", "not set — the assistant runs in DEMO MODE until ANTHROPIC_API_KEY is in .env (then re-run this script) or paste it in the app under Settings → AI connection");
if (env.APP_PASSWORD) ok("Access password", CHECK ? "set in .env (APP_PASSWORD)" : "set (printed at the end)");
else warn("Access password", "APP_PASSWORD is empty — required for phone access; re-run this script to generate one");
const port = Number.parseInt(env.PORT ?? "", 10) || (portGiven ? PORT : DEFAULT_PORT);

// ---------------------------------------------------------------- 4. service (pm2)
let serviceRunning = false;
let pm2 = null;
if (NO_SERVICE) warn("Service", "--no-service: start it yourself with: npm start");
else {
  pm2 = pm2Bin();
  if (!CHECK && !pm2) {
    note("Installing pm2 (keeps the server running and restarts it on reboot)…");
    const g = run("npm", ["install", "-g", "pm2", "--no-audit", "--no-fund"], { stdio: "inherit" });
    pm2 = g.code === 0 ? pm2Bin() : null;
  }
  if (!pm2) {
    (CHECK ? warn : fail)("Service", CHECK ? "pm2 not installed — run: node scripts/setup.mjs" : "pm2 could not be installed or found (on Linux/macOS: sudo npm install -g pm2, or set an npm prefix in your home directory) — meanwhile run: npm start");
  } else if (CHECK) {
    const mine = pm2Process(pm2);
    if (!mine) warn("Service", `pm2 has no "${SERVICE_NAME}" process — run: node scripts/setup.mjs`);
    else {
      const status = mine.pm2_env ? mine.pm2_env.status : "unknown";
      serviceRunning = status === "online";
      const restarts = mine.pm2_env ? Number(mine.pm2_env.restart_time || 0) : 0;
      const execPath = mine.pm2_env ? String(mine.pm2_env.pm_exec_path || "") : "";
      const foreign = execPath && resolve(execPath) !== resolve(join(ROOT, "dist", "server.js"));
      (serviceRunning && !foreign ? ok : warn)("Service", `pm2 "${SERVICE_NAME}" is ${status}${restarts ? ` (${restarts} restarts — check: pm2 logs ${SERVICE_NAME})` : ""}${foreign ? ` but runs ${execPath}, not this checkout — run: node scripts/setup.mjs` : ""}`);
      const stored = mine.pm2_env && mine.pm2_env.ANTHROPIC_API_KEY;
      if (stored) warn("Service env", "pm2 holds an ANTHROPIC_API_KEY from an old start; .env is what counts — run: node scripts/setup.mjs");
    }
  } else if (!built) fail("Service", "not started because the build failed");
  else {
    // Always start fresh from THIS checkout with a scrubbed environment: a stale process from another
    // checkout, or settings inherited from the shell that ran a previous setup, would otherwise win.
    const existing = pm2Process(pm2);
    const existingOnline = Boolean(existing && existing.pm2_env && existing.pm2_env.status === "online");
    // Probe the port BEFORE touching a running service: when the port is taken by something else, keep the
    // old server running and put the previous port back so nothing the phones rely on goes away.
    const portHeldByUs = existingOnline && port === previousPort;
    if (!portHeldByUs && !(await portFree(port))) {
      if (portGiven && env.PORT !== String(previousPort)) {
        writeFileSync(envPath, setEnv(readFileSync(envPath, "utf8"), "PORT", String(previousPort)), { mode: 0o600 });
        env.PORT = String(previousPort);
      }
      fail("Service", `port ${port} is already in use by another program — ${existingOnline ? `the current server on port ${previousPort} was left running (PORT in .env restored)` : "stop it"}; try: node scripts/setup.mjs --port <other>`);
      serviceRunning = existingOnline;
    } else {
      if (existing) {
        run(pm2, ["delete", SERVICE_NAME], { env: scrubbedEnv() });
        for (let i = 0; i < 20 && !(await portFree(previousPort)); i++) await new Promise((r) => setTimeout(r, 250));
      }
      const s = run(pm2, ["start", join(ROOT, "dist", "server.js"), "--name", SERVICE_NAME, "--cwd", ROOT, "--time", "--node-args=--disable-warning=ExperimentalWarning"], { stdio: "inherit", env: scrubbedEnv() });
      await new Promise((r) => setTimeout(r, 2500));
      const mine = s.code === 0 ? pm2Process(pm2) : null;
      const status = mine && mine.pm2_env ? mine.pm2_env.status : "missing";
      const restarts = mine && mine.pm2_env ? Number(mine.pm2_env.restart_time || 0) : 0;
      if (status === "online" && restarts === 0) {
        run(pm2, ["save"], { env: scrubbedEnv() });
        serviceRunning = true;
        ok("Service", `pm2 process "${SERVICE_NAME}" ${existing ? "restarted" : "started"} from this checkout and saved`);
      } else {
        run(pm2, ["delete", SERVICE_NAME], { env: scrubbedEnv() });
        run(pm2, ["save", "--force"], { env: scrubbedEnv() });
        fail("Service", `the server ${status === "online" ? "keeps restarting" : `is ${status}`} — run: npm start   to see the error (a wrong .env value is the usual cause)`);
      }
    }
    // Start on boot
    if (serviceRunning && !existingBootOk()) {
      if (IS_WIN) warn("Start on boot", "Windows: run once  npm install -g pm2-windows-startup && pm2-startup install");
      else if (IS_ROOT) {
        const su = run(pm2, ["startup", "-u", unixUser(), "--hp", process.env.HOME || "/root"], { env: { ...scrubbedEnv(), USER: unixUser() } });
        const enabled = su.code === 0 && (bootEnabled() ?? true);
        (enabled ? ok : warn)("Start on boot", enabled ? `pm2 startup installed for ${unixUser()}` : "pm2 startup did not install — run: pm2 startup   and check the message");
      } else {
        const su = run(pm2, ["startup"], { env: scrubbedEnv() });
        const cmd = (su.out.match(/^\s*(sudo .*)$/m) || [])[1];
        warn("Start on boot", cmd ? `run once: ${cmd.trim()}` : "run once: pm2 startup   (then the sudo command it prints)");
      }
    } else if (serviceRunning) ok("Start on boot", `systemd unit pm2-${unixUser()} enabled`);
  }
}
if (CHECK && !NO_SERVICE && !IS_WIN && pm2) {
  const en = bootEnabled();
  if (en !== null) (en ? ok : warn)("Start on boot", en ? `systemd unit pm2-${unixUser()} enabled` : `not enabled — run: ${IS_ROOT ? "node scripts/setup.mjs" : "pm2 startup   (then the sudo command it prints)"}`);
}

// ---------------------------------------------------------------- 5. health
{
  const h = await waitForHealth(`http://127.0.0.1:${port}/api/health`, CHECK || !serviceRunning ? 2 : 20);
  if (h.body && h.body.ok === true && Number(h.body.packs) > 0) {
    ok("Server", `answering on http://127.0.0.1:${port} — ${h.body.demo ? "DEMO MODE (no API key)" : `model ${h.body.model}, effort ${h.body.effort}`}; ${h.body.packs} manufacturer packs, ${h.body.refrigerants} refrigerants`);
  } else if (h.answered) fail("Server", `something else answers on port ${port} (not this app) — pick another port: node scripts/setup.mjs --port <n>`);
  else if (serviceRunning || CHECK) (CHECK && NO_SERVICE ? warn : fail)("Server", `no answer on http://127.0.0.1:${port}/api/health${pm2 ? ` — run: pm2 logs ${SERVICE_NAME}` : " — run: npm start"}`);
  else warn("Server", "not running — run: npm start");
}

// ---------------------------------------------------------------- 6. tailscale
let tailnetUrl = null;
{
  const ts = NO_TAILSCALE ? null : tailscaleBin();
  if (!ts) warn("Tailscale", NO_TAILSCALE ? "skipped (--no-tailscale): phones need HTTPS, see SETUP.md" : "not installed — install from https://tailscale.com/download, sign in, then re-run this script");
  else {
    const st = run(ts, ["status", "--json"]);
    let dns = null;
    let backend = null;
    try {
      const j = JSON.parse(st.stdout || "{}");
      backend = j.BackendState;
      dns = j.Self && j.Self.DNSName ? String(j.Self.DNSName).replace(/\.$/, "") : null;
    } catch {
      dns = null;
    }
    if (backend !== "Running" || !dns) warn("Tailscale", `installed but not connected (state ${backend ?? "unknown"}) — sign in (tailscale up / the Tailscale app), then re-run this script`);
    else {
      const serve = run(ts, ["serve", "status"]);
      const already = serve.out.includes(`127.0.0.1:${port}`) || serve.out.includes(`localhost:${port}`);
      if (already) {
        tailnetUrl = `https://${dns}`;
        ok("Tailscale", `serving https://${dns} → port ${port}`);
      } else if (CHECK) warn("Tailscale", `connected as ${dns} but not serving port ${port} — run: ${ts} serve --bg ${port}`);
      else {
        const s = run(ts, ["serve", "--bg", String(port)]);
        if (s.code === 0) {
          tailnetUrl = `https://${dns}`;
          ok("Tailscale", `now serving https://${dns} → port ${port}`);
        } else {
          const last = s.out.trim().split("\n").pop() || "";
          const hint = /denied|permission|operator|access/i.test(last)
            ? `run it with admin rights (sudo ${ts} serve --bg ${port}, or: sudo tailscale set --operator=$USER)`
            : /https|cert|magicdns|dns/i.test(last)
              ? "enable MagicDNS and HTTPS Certificates under DNS in the Tailscale admin console, then re-run"
              : `run manually: ${ts} serve --bg ${port}`;
          warn("Tailscale", `"tailscale serve" failed (${last}) — ${hint}`);
        }
      }
    }
  }
}

report();
note("");
if (results.some((r) => r.state === "fail")) {
  note("Fix the FAIL line(s) above, then run again:   node scripts/setup.mjs");
  process.exit(1);
}
note("Next steps");
note(`  1. Local check:   open http://127.0.0.1:${port} on this machine. The browser asks for a username and`);
note(`                    password first: type anything as the username and the access password ${CHECK ? "(APP_PASSWORD in .env)" : "below"}.`);
if (tailnetUrl) note(`  2. On the phone:  install Tailscale, sign in to the same account, open ${tailnetUrl} (same login prompt).`);
else note("  2. On the phone:  install Tailscale on this machine and the phone (same account); re-run this script to publish the app over HTTPS.");
note(`  3. In the app:    Settings → Access password → ${CHECK ? "the APP_PASSWORD value in .env" : env.APP_PASSWORD || "(set APP_PASSWORD in .env)"}   (keeps the installed app signed in)`);
note("  4. Install it:    iOS: Share → Add to Home Screen.   Android: browser menu → Install app.");
if (!env.ANTHROPIC_API_KEY && !uiKey) note("  5. Real model:    paste your Anthropic API key in the app under Settings → AI connection, or put ANTHROPIC_API_KEY in .env and re-run: node scripts/setup.mjs   (until then it runs in demo mode).");
note("  Anytime:          node scripts/setup.mjs --check      after editing .env: node scripts/setup.mjs");
process.exit(results.some((r) => r.state === "fail") ? 1 : 0);

// ---------------------------------------------------------------- helpers
/** Same rules as the server's loader (src/config.ts): first occurrence wins, unquoted `#` comments dropped. */
function readEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!/^["']/.test(value)) {
      if (value.startsWith("#")) value = "";
      else {
        const hash = value.search(/\s#/);
        if (hash >= 0) value = value.slice(0, hash).trim();
      }
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in out)) out[key] = value;
  }
  return out;
}
/** Replace the first `KEY=` line (or append one). Values written here never contain spaces, `#` or quotes. */
function setEnv(text, key, value) {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m");
  const line = `${key}=${value}`;
  return re.test(text) ? text.replace(re, () => line) : `${text.replace(/\s*$/, "")}\n${line}\n`;
}
async function waitForHealth(url, attempts) {
  let answered = false;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      answered = true;
      if (res.ok) {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("json")) return { answered, body: await res.json() };
      }
    } catch {
      /* not up yet */
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500));
  }
  return { answered, body: null };
}
function report() {
  note("");
  const width = Math.max(...results.map((r) => r.step.length));
  for (const r of results) {
    const mark = r.state === "ok" ? "  OK " : r.state === "warn" ? " TODO" : " FAIL";
    note(`${mark}  ${r.step.padEnd(width)}  ${r.detail}`);
  }
}
