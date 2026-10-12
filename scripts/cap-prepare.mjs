#!/usr/bin/env node
// Prepare the static client for a Capacitor bundle, or print the one-time Capacitor setup commands.
//
//   npm run cap:init      prints the commands to install Capacitor and add the iOS/Android projects (runs nothing)
//   npm run cap:prepare   writes web/config.js from web/config.capacitor.js with the version from package.json
//
// The Node server generates /config.js per request; a native bundle has no server, so the file must exist
// on disk before `npx cap sync` copies web/ into the native projects. web/config.js is git-ignored.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "0.0.0";

const COMMANDS = [
  "npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android",
  "npx cap add ios",
  "npx cap add android",
  "npm run cap:prepare",
  "npx cap sync",
  "npx cap open ios        # or: npx cap open android",
];

if (process.argv.includes("--commands")) {
  console.log("Capacitor setup (nothing is run for you; capacitor.config.json is already in the repository):\n");
  for (const c of COMMANDS) console.log(`  ${c}`);
  console.log(`
Before building: set ALLOW_ORIGINS=capacitor://localhost,https://localhost,http://localhost on the server,
then enter the server URL and access password in the app under Settings → Server.`);
  process.exit(0);
}

const template = readFileSync(join(root, "web", "config.capacitor.js"), "utf8");
if (!template.includes("__VERSION__")) {
  console.error("web/config.capacitor.js has no __VERSION__ placeholder.");
  process.exit(1);
}
const out = template.replace("__VERSION__", version);
const target = join(root, "web", "config.js");
writeFileSync(target, out);
console.log(`Wrote web/config.js for the Capacitor bundle (apiBase "", version ${version}, bundled: true).`);
console.log("Next: npx cap sync   (then npx cap open ios / android). Delete web/config.js again to serve the client from Node.");
