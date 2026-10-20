/**
 * Manual library: full-text search over the manufacturer manuals and research notes that live OUTSIDE the
 * repository (LIBRARY_DIR, default `<project>/library`). The repo is public and the manuals are the
 * manufacturers' copyright, so only this code ships; the text bundle is copied onto the server privately.
 *
 * Bundle layout (built by the research pipeline):
 *   library/manifest.json            { version, built, manufacturers: {id: label}, documents: LibraryDocument[] }
 *   library/<mfr>/text/<doc>.txt      pdftotext -layout output, pages separated by form feeds (\f)
 *   library/<mfr>/<notes>.md          curated research notes (alarm tables, nomenclature, troubleshooting)
 *
 * The index is a SQLite FTS5 table (bm25 ranking, porter stemming) in its own file beside the job database.
 * It is rebuilt when the manifest changes; building is synchronous (tens of seconds for ~400 manuals), so
 * `npm run library:index` / setup.mjs builds it ahead of time and the server only builds on first use.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LibraryDocument {
  /** Path relative to the library dir, forward slashes ("stulz/text/foo.txt"). */
  file: string;
  manufacturer: string;
  kind: "manual" | "notes";
  title: string;
  docNo?: string;
  url?: string;
}

export interface LibraryManifest {
  version: number;
  built?: string;
  manufacturers: Record<string, string>;
  documents: LibraryDocument[];
}

export interface LibraryHit {
  title: string;
  manufacturer: string;
  manufacturerLabel: string;
  kind: "manual" | "notes";
  docNo: string | null;
  url: string | null;
  /** "page 12" for manuals, the section heading for notes. */
  location: string;
  text: string;
  file: string;
}

export interface LibrarySearchResult {
  hits: LibraryHit[];
  /** "all" = every term matched; "any" = fallback where at least one term matched. */
  match: "all" | "any" | "none";
  manufacturerFilter: string[] | null;
}

export interface LibraryStatus {
  available: boolean;
  dir: string;
  documents: number;
  manuals: number;
  chunks: number;
  built: string | null;
  reason?: string;
}

/** Target chunk size (characters) and overlap carried into the next chunk. */
const CHUNK_CHARS = 1600;
const CHUNK_OVERLAP_LINES = 3;
const INDEX_SCHEMA_VERSION = 1;

/** Brand words → library manufacturer ids. Matched on lowercase alphanumerics. */
const BRAND_ALIASES: Record<string, string[]> = {
  stulz: ["stulz", "ats", "airtechnologysystems", "cyberair", "cyberrow", "minispace", "cyberone", "ceilair", "cyberwall", "cyberhandler", "cybercool", "desicair"],
  "liebert-vertiv": ["liebert", "vertiv", "emerson", "emersonnetworkpower", "icom", "minimate", "challenger", "deluxe", "datamate"],
  trane: ["trane", "americanstandard", "amstd", "tracer", "centravac"],
  carrier: ["carrier", "bryant", "payne", "icp", "heil", "tempstar", "comfortmaker", "arcoaire", "keeprite", "dayandnight", "dayampnight", "infinity"],
  "goodman-daikin": ["goodman", "amana", "daikin", "mcquay", "daikinapplied", "comfortnet", "comfortbridge"],
  lennox: ["lennox", "allied", "armstrong", "ducane", "icomfort", "surelight"],
  "york-jci": ["york", "jci", "johnsoncontrols", "coleman", "luxaire", "optiview"],
  "rheem-ruud": ["rheem", "ruud", "econet", "weatherking"],
  "data-aire": ["dataaire", "dataair", "dap4", "gforce"],
  "schneider-uniflair": ["uniflair", "schneider", "schneiderelectric", "leonardo"],
  "precision-cooling-others": ["apc", "inrow", "rittal", "lcp", "airedale", "denco", "motivair", "coolcentric"],
};

const STOPWORDS = new Set(
  "a an and are as at be by for from has have how i in is it its of on or that the this to was what when where which why with does do my unit".split(" "),
);

function looseKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Library manufacturer ids a free-text hint refers to (empty = no filter / unknown brand). */
export function resolveLibraryManufacturers(hint: string | undefined, known: Iterable<string>): string[] {
  const h = looseKey(hint ?? "");
  if (!h) return [];
  const knownSet = new Set(known);
  const out = new Set<string>();
  for (const id of knownSet) if (looseKey(id) === h || (h.length >= 4 && looseKey(id).includes(h))) out.add(id);
  for (const [id, words] of Object.entries(BRAND_ALIASES)) {
    if (!knownSet.has(id)) continue;
    if (words.some((w) => w === h || (h.length >= 4 && (w.includes(h) || h.includes(w))))) out.add(id);
  }
  return [...out];
}

/** Query terms: lowercase alphanumeric tokens (the same split the FTS tokenizer makes), stopwords dropped, deduped, at most 12. */
export function queryTerms(query: string): string[] {
  const out: string[] = [];
  for (const t of query.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOPWORDS.has(t) || (t.length < 2 && !/\d/.test(t)) || out.includes(t)) continue;
    out.push(t);
  }
  return out.slice(0, 12);
}

/** FTS5 MATCH expression: every term quoted (no operator injection), joined by AND or OR. */
function matchExpression(terms: string[], op: "AND" | "OR"): string {
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(` ${op} `);
}

/** Tidy a pdftotext -layout line: trim, and turn wide column gaps into " | " so tables stay readable. */
function tidyLine(line: string): string {
  return line.replace(/\s+$/, "").replace(/^\s+/, "").replace(/ {3,}/g, " | ");
}

interface Chunk {
  location: string;
  text: string;
}

/** Split text into ~CHUNK_CHARS pieces on line boundaries, carrying a few lines of overlap. */
function chunkLines(lines: string[], location: string, out: Chunk[]): void {
  let buf: string[] = [];
  let size = 0;
  let fresh = 0; // lines in buf not yet emitted in an earlier chunk (the rest is overlap)
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text.length >= 40) out.push({ location, text });
  };
  for (const line of lines) {
    buf.push(line);
    fresh++;
    size += line.length + 1;
    if (size >= CHUNK_CHARS) {
      flush();
      buf = buf.slice(-CHUNK_OVERLAP_LINES);
      size = buf.reduce((n, l) => n + l.length + 1, 0);
      fresh = 0;
    }
  }
  if (fresh > 0) flush();
}

/** Manual text → chunks tagged with their page number (pages are separated by \f). */
export function chunkManual(text: string): Chunk[] {
  const out: Chunk[] = [];
  text.split("\f").forEach((page, i) => {
    const lines = page.split(/\r?\n/).map(tidyLine).filter((l) => l.length > 0);
    if (lines.length) chunkLines(lines, `page ${i + 1}`, out);
  });
  return out;
}

/** Markdown notes → chunks tagged with the nearest heading. */
export function chunkNotes(text: string): Chunk[] {
  const out: Chunk[] = [];
  let heading = "top";
  let lines: string[] = [];
  const flushSection = () => {
    if (lines.length) chunkLines(lines, heading, out);
    lines = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const m = /^#{1,4}\s+(.*)$/.exec(raw);
    if (m) {
      flushSection();
      heading = m[1]!.trim().slice(0, 120);
      lines.push(raw.trim());
      continue;
    }
    if (raw.trim()) lines.push(raw.trimEnd());
  }
  flushSection();
  return out;
}

function readManifest(dir: string): LibraryManifest | null {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return null;
  const m = JSON.parse(readFileSync(path, "utf8")) as LibraryManifest;
  if (!m || !Array.isArray(m.documents)) throw new Error("library manifest.json has no documents[]");
  return m;
}

function manifestSignature(dir: string): string {
  const st = statSync(join(dir, "manifest.json"));
  return `v${INDEX_SCHEMA_VERSION}:${st.size}:${Math.floor(st.mtimeMs)}`;
}

export class ManualLibrary {
  readonly dir: string;
  readonly indexPath: string;
  private db: DatabaseSync | null = null;
  private manifest: LibraryManifest | null = null;
  private unavailableReason: string | null = null;
  private log: (msg: string) => void;

  constructor(opts: { dir: string; indexPath: string; log?: (msg: string) => void }) {
    this.dir = opts.dir;
    this.indexPath = opts.indexPath;
    this.log = opts.log ?? (() => {});
  }

  /** Open the index, building or rebuilding it when the manifest changed. Returns false when no library is installed. */
  ensureReady(): boolean {
    if (this.db) return true;
    try {
      this.manifest = readManifest(this.dir);
    } catch (e) {
      this.unavailableReason = `library manifest unreadable: ${(e as Error).message}`;
      return false;
    }
    if (!this.manifest) {
      this.unavailableReason = `no manual library installed (expected ${join(this.dir, "manifest.json")})`;
      return false;
    }
    mkdirSync(dirname(this.indexPath), { recursive: true });
    const db = new DatabaseSync(this.indexPath);
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const sig = manifestSignature(this.dir);
    const have = (db.prepare("SELECT value FROM meta WHERE key = 'signature'").get() as { value?: string } | undefined)?.value;
    if (have !== sig) this.build(db, sig);
    this.db = db;
    this.unavailableReason = null;
    return true;
  }

  private build(db: DatabaseSync, sig: string): void {
    const manifest = this.manifest!;
    const started = Date.now();
    this.log(`manual library: indexing ${manifest.documents.length} documents from ${this.dir} …`);
    db.exec("DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS docs;");
    db.exec("CREATE TABLE docs (id INTEGER PRIMARY KEY, file TEXT NOT NULL, manufacturer TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, doc_no TEXT, url TEXT)");
    db.exec("CREATE VIRTUAL TABLE chunks USING fts5(text, title, manufacturer UNINDEXED, doc_id UNINDEXED, location UNINDEXED, tokenize = 'porter unicode61')");
    const insDoc = db.prepare("INSERT INTO docs (file, manufacturer, kind, title, doc_no, url) VALUES (?, ?, ?, ?, ?, ?)");
    const insChunk = db.prepare("INSERT INTO chunks (text, title, manufacturer, doc_id, location) VALUES (?, ?, ?, ?, ?)");
    let chunks = 0;
    let skipped = 0;
    db.exec("BEGIN");
    try {
      for (const doc of manifest.documents) {
        const path = join(this.dir, ...doc.file.split("/"));
        if (!existsSync(path)) {
          skipped++;
          continue;
        }
        const text = readFileSync(path, "utf8");
        const pieces = doc.kind === "notes" ? chunkNotes(text) : chunkManual(text);
        const r = insDoc.run(doc.file, doc.manufacturer, doc.kind, doc.title || doc.file, doc.docNo || null, doc.url || null);
        const docId = Number(r.lastInsertRowid);
        const searchTitle = `${doc.title} ${doc.docNo ?? ""}`;
        for (const c of pieces) {
          insChunk.run(c.text, searchTitle, doc.manufacturer, docId, c.location);
          chunks++;
        }
      }
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('signature', ?)").run(sig);
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('built', ?)").run(manifest.built ?? new Date().toISOString().slice(0, 10));
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    db.exec("INSERT INTO chunks(chunks) VALUES ('optimize')");
    this.log(`manual library: ${chunks} passages indexed in ${((Date.now() - started) / 1000).toFixed(1)} s${skipped ? ` (${skipped} missing files skipped)` : ""}`);
  }

  status(): LibraryStatus {
    const base = { dir: this.dir, documents: 0, manuals: 0, chunks: 0, built: null as string | null };
    if (!this.ensureReady()) return { available: false, ...base, reason: this.unavailableReason ?? undefined };
    const db = this.db!;
    const documents = (db.prepare("SELECT COUNT(*) AS n FROM docs").get() as { n: number }).n;
    const manuals = (db.prepare("SELECT COUNT(*) AS n FROM docs WHERE kind = 'manual'").get() as { n: number }).n;
    const chunks = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    const built = (db.prepare("SELECT value FROM meta WHERE key = 'built'").get() as { value?: string } | undefined)?.value ?? null;
    return { available: true, ...base, documents, manuals, chunks, built };
  }

  /** Why the library is unavailable (null when it is ready). */
  unavailable(): string | null {
    return this.ensureReady() ? null : this.unavailableReason;
  }

  search(query: string, opts: { manufacturer?: string; limit?: number } = {}): LibrarySearchResult {
    if (!this.ensureReady()) return { hits: [], match: "none", manufacturerFilter: null };
    const db = this.db!;
    const manifest = this.manifest!;
    const limit = Math.min(Math.max(opts.limit ?? 4, 1), 8);
    const terms = queryTerms(query);
    const filter = opts.manufacturer ? resolveLibraryManufacturers(opts.manufacturer, Object.keys(manifest.manufacturers ?? {})) : [];
    if (terms.length === 0) return { hits: [], match: "none", manufacturerFilter: filter.length ? filter : null };

    const run = (op: "AND" | "OR") => {
      const where = filter.length ? ` AND manufacturer IN (${filter.map(() => "?").join(", ")})` : "";
      // Fetch extra rows so one long manual cannot fill every slot.
      const sql = `SELECT rowid, text, doc_id, location, manufacturer, bm25(chunks, 1.0, 2.0) AS score FROM chunks WHERE chunks MATCH ?${where} ORDER BY score LIMIT ?`;
      return db.prepare(sql).all(matchExpression(terms, op), ...filter, limit * 6) as {
        text: string;
        doc_id: number;
        location: string;
        manufacturer: string;
      }[];
    };
    let match: LibrarySearchResult["match"] = "all";
    let rows = run("AND");
    if (rows.length === 0 && terms.length > 1) {
      rows = run("OR");
      match = rows.length ? "any" : "none";
    } else if (rows.length === 0) match = "none";

    const perDoc = new Map<number, number>();
    const getDoc = db.prepare("SELECT file, kind, title, doc_no, url FROM docs WHERE id = ?");
    const hits: LibraryHit[] = [];
    for (const row of rows) {
      const n = perDoc.get(row.doc_id) ?? 0;
      if (n >= 2) continue;
      perDoc.set(row.doc_id, n + 1);
      const d = getDoc.get(row.doc_id) as { file: string; kind: "manual" | "notes"; title: string; doc_no: string | null; url: string | null };
      hits.push({
        title: d.title,
        manufacturer: row.manufacturer,
        manufacturerLabel: manifest.manufacturers?.[row.manufacturer] ?? row.manufacturer,
        kind: d.kind,
        docNo: d.doc_no,
        url: d.url,
        location: row.location,
        text: row.text,
        file: d.file,
      });
      if (hits.length >= limit) break;
    }
    return { hits, match, manufacturerFilter: filter.length ? filter : null };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

// ---------------------------------------------------------------------------
// Process-wide instance (set by server.ts; tools read it). Null = no library configured.
// ---------------------------------------------------------------------------

let current: ManualLibrary | null = null;

export function setManualLibrary(lib: ManualLibrary | null): void {
  current = lib;
}

export function getManualLibrary(): ManualLibrary | null {
  return current;
}
