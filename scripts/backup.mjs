#!/usr/bin/env node
/**
 * Consistent backup of the SQLite database while the server is running (WAL-safe, no sqlite3 CLI needed):
 *
 *   node scripts/backup.mjs [destination]      default: backups/hvac-YYYY-MM-DD-HHMM.sqlite
 *
 * Reads DB_PATH from .env (or the environment); the copy is a complete single-file database.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(ROOT, "dist", "config.js"))) {
  console.error("dist/ is missing — run: npm run build   (or node scripts/setup.mjs) first.");
  process.exit(1);
}
const { loadConfig, loadDotEnv } = await import("../dist/config.js");
loadDotEnv(resolve(ROOT, ".env"));
const { dbPath } = loadConfig();
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath} (nothing to back up yet).`);
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
const dest = resolve(ROOT, process.argv[2] || `backups/hvac-${stamp.slice(0, 8)}-${stamp.slice(9, 13)}.sqlite`);
if (existsSync(dest)) {
  console.error(`${dest} already exists; choose another name.`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
} finally {
  db.close();
}
try {
  chmodSync(dest, 0o600);
} catch {
  /* Windows */
}
console.log(`Backup written to ${dest}`);
