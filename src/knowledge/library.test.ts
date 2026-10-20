import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualLibrary, chunkManual, chunkNotes, queryTerms, resolveLibraryManufacturers, setManualLibrary } from "./library.ts";
import { executeTool } from "../agent/tools.ts";

const root = mkdtempSync(join(tmpdir(), "hvac-lib-"));
after(() => rmSync(root, { recursive: true, force: true }));

function makeBundle(dir: string): void {
  mkdirSync(join(dir, "stulz", "text"), { recursive: true });
  mkdirSync(join(dir, "trane", "text"), { recursive: true });
  writeFileSync(
    join(dir, "stulz", "text", "c7000.txt"),
    "C7000 Operating Instructions\nIntroduction page\f8.4 Alarm texts\nLOW PRESSURE 1        LP switch circuit 1      Compressor 1 off\nReset the alarm with the RESET key after the cause is cleared.\f",
  );
  writeFileSync(join(dir, "trane", "text", "rtac.txt"), "RTAC chiller IOM\fLow Evaporator Refrigerant Temperature diagnostic. Check the EXV and charge.\f");
  writeFileSync(join(dir, "stulz", "sequences.md"), "# STULZ sequences\n\n## Dehumidification\nCompressor runs with reduced fan speed; electric reheat holds return temperature.\n");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      version: 1,
      built: "2026-10-20",
      manufacturers: { stulz: "STULZ", trane: "Trane" },
      documents: [
        { file: "stulz/text/c7000.txt", manufacturer: "stulz", kind: "manual", title: "C7000 Original instructions", docNo: "G57", url: "https://example.com/c7000.pdf" },
        { file: "trane/text/rtac.txt", manufacturer: "trane", kind: "manual", title: "RTAC IOM", docNo: "RTAC-SVX01", url: "" },
        { file: "stulz/sequences.md", manufacturer: "stulz", kind: "notes", title: "STULZ sequences" },
        { file: "stulz/text/missing.txt", manufacturer: "stulz", kind: "manual", title: "Missing file" },
      ],
    }),
  );
}

describe("library helpers", () => {
  test("queryTerms drops stopwords and keeps codes", () => {
    assert.deepEqual(queryTerms("What is the LOW PRESSURE 1 alarm on A140?"), ["low", "pressure", "1", "alarm", "a140"]);
    assert.deepEqual(queryTerms("\"; DROP TABLE x --"), ["drop", "table"]);
  });
  test("resolveLibraryManufacturers maps brands to library folders", () => {
    const known = ["stulz", "liebert-vertiv", "carrier", "goodman-daikin", "trane"];
    assert.deepEqual(resolveLibraryManufacturers("Vertiv", known), ["liebert-vertiv"]);
    assert.deepEqual(resolveLibraryManufacturers("Bryant", known), ["carrier"]);
    assert.deepEqual(resolveLibraryManufacturers("American Standard", known), ["trane"]);
    assert.deepEqual(resolveLibraryManufacturers("STULZ", known), ["stulz"]);
    assert.deepEqual(resolveLibraryManufacturers("", known), []);
  });
  test("chunkManual tags pages and turns column gaps into separators", () => {
    const c = chunkManual("first page text here that is long enough to keep\fsecond    column    layout line that is long enough");
    assert.equal(c.length, 2);
    assert.equal(c[0]!.location, "page 1");
    assert.equal(c[1]!.location, "page 2");
    assert.match(c[1]!.text, /second \| column \| layout/);
  });
  test("chunkNotes tags sections by heading", () => {
    const c = chunkNotes("# Title\n\n## Alarms\nHigh pressure lockout needs a manual reset at the switch.\n");
    assert.ok(c.some((x) => x.location === "Alarms" && /manual reset/.test(x.text)));
  });
});

describe("ManualLibrary", () => {
  const dir = join(root, "library");
  makeBundle(dir);
  const lib = new ManualLibrary({ dir, indexPath: join(root, "data", "library-index.sqlite") });

  test("builds an index and reports status (missing files skipped)", () => {
    const st = lib.status();
    assert.equal(st.available, true);
    assert.equal(st.documents, 3);
    assert.equal(st.manuals, 2);
    assert.ok(st.chunks >= 3);
    assert.equal(st.built, "2026-10-20");
  });

  test("finds alarm text with page and URL, filtered by brand", () => {
    const r = lib.search("LOW PRESSURE 1 reset", { manufacturer: "Stulz" });
    assert.equal(r.match, "all");
    assert.deepEqual(r.manufacturerFilter, ["stulz"]);
    assert.equal(r.hits[0]!.title, "C7000 Original instructions");
    assert.equal(r.hits[0]!.location, "page 2");
    assert.equal(r.hits[0]!.url, "https://example.com/c7000.pdf");
  });

  test("stems words and searches notes", () => {
    const r = lib.search("dehumidification reheat");
    assert.equal(r.hits[0]!.kind, "notes");
    assert.equal(r.hits[0]!.location, "Dehumidification");
  });

  test("falls back to any-word matching, and returns nothing for unknown words", () => {
    const r = lib.search("evaporator zzzzunknown");
    assert.equal(r.match, "any");
    assert.equal(r.hits[0]!.manufacturer, "trane");
    const none = lib.search("qqqq zzzz");
    assert.equal(none.match, "none");
    assert.equal(none.hits.length, 0);
  });

  test("brand filter excludes other manufacturers", () => {
    const r = lib.search("evaporator", { manufacturer: "Stulz" });
    assert.equal(r.hits.length, 0);
  });

  test("query text with FTS syntax is treated as words", () => {
    assert.doesNotThrow(() => lib.search('pressure" OR NEAR(x) * -- ^'));
  });

  test("rebuilds when the manifest changes", () => {
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "manifest.json"), later, later);
    const fresh = new ManualLibrary({ dir, indexPath: join(root, "data", "library-index.sqlite") });
    assert.equal(fresh.status().documents, 3);
    fresh.close();
  });

  test("reports a missing library", () => {
    const none = new ManualLibrary({ dir: join(root, "nope"), indexPath: join(root, "data", "none.sqlite") });
    const st = none.status();
    assert.equal(st.available, false);
    assert.match(st.reason ?? "", /no manual library installed/);
    assert.deepEqual(none.search("anything").hits, []);
  });

  test("search_manuals tool returns cited passages, or says the library is missing", async () => {
    const ctx = { kb: {} as never, repos: {} as never, conversationId: "c", unitId: null };
    setManualLibrary(lib);
    const r = await executeTool("search_manuals", { query: "LOW PRESSURE 1", manufacturer: "STULZ" }, ctx);
    assert.equal(r.isError, undefined);
    const out = JSON.parse(r.content) as { passages: { document: string; location: string; url?: string; docNo?: string }[] };
    assert.equal(out.passages[0]!.document, "C7000 Original instructions");
    assert.equal(out.passages[0]!.location, "page 2");
    assert.equal(out.passages[0]!.docNo, "G57");
    assert.match(r.summary, /1 passage/);

    setManualLibrary(null);
    const missing = await executeTool("search_manuals", { query: "LOW PRESSURE 1" }, ctx);
    assert.match(missing.content, /"available":false/);
    assert.match(missing.summary, /not installed/);
  });
});
