#!/usr/bin/env node
/**
 * library-index: build (or confirm) the full-text index of the private manual library so the server does
 * not have to do it on its first start. Exit 0 when the index is ready or no library is installed.
 *
 *   node --disable-warning=ExperimentalWarning scripts/library-index.ts
 */
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { ManualLibrary } from "../src/knowledge/library.ts";

loadDotEnv();
const config = loadConfig();
const lib = new ManualLibrary({ dir: config.libraryDir, indexPath: config.libraryIndexPath, log: (m) => console.log(m) });
try {
  const st = lib.status();
  if (!st.available) {
    console.log(`Manual library not installed: ${st.reason ?? "unknown"}`);
    process.exit(0);
  }
  console.log(`Manual library ready: ${st.manuals} manuals + ${st.documents - st.manuals} note files, ${st.chunks} passages (built ${st.built ?? "?"}).`);
  console.log(`  library: ${config.libraryDir}`);
  console.log(`  index:   ${config.libraryIndexPath}`);
} catch (err) {
  console.error(`Manual library index failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  lib.close();
}
