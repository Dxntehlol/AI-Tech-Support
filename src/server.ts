import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, loadDotEnv } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { createRepos } from "./db/repos.ts";
import { loadKnowledge } from "./knowledge/loader.ts";
import { createAnthropicClient } from "./agent/client.ts";
import { createApp } from "./app.ts";

loadDotEnv();
const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openDatabase(config.dbPath);
const repos = createRepos(db);
const kb = loadKnowledge(config.knowledgeDir);
const client = createAnthropicClient(config);
const app = createApp({ client, config, kb, repos, log: (m) => console.log(m) });

const server = app.listen(config.port, config.host, () => {
  console.log(`HVAC Field Assistant listening on http://${config.host}:${config.port}`);
  console.log(`  model=${config.claudeModel} effort=${config.claudeEffort} fallbacks=${config.claudeFallbacks} webSearch=${config.enableWebSearch ? "on" : "off"}`);
  console.log(`  knowledge: ${kb.manufacturers.length} manufacturer packs, ${kb.refrigerants.tables.size} refrigerants, ${kb.diagnostics.rules.rules.length} diagnostic rules`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
