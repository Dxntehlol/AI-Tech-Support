/** SQLite schema (idempotent). Kept as a TS constant so dist/ is self-contained. */
export const SCHEMA_SQL = `
-- HVAC Field Assistant schema (idempotent)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  manufacturer TEXT,
  brand TEXT,
  model TEXT NOT NULL,
  serial TEXT,
  nickname TEXT,
  site TEXT,
  customer TEXT,
  location_note TEXT,
  refrigerant TEXT,
  tonnage REAL,
  voltage TEXT,
  phase TEXT,
  decoded_json TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New conversation',
  unit_id TEXT REFERENCES units(id) ON DELETE SET NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_unit ON conversations(unit_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content_json TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  unit_id TEXT REFERENCES units(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  symptom TEXT NOT NULL,
  cause TEXT,
  resolution TEXT,
  measurements_json TEXT,
  parts_json TEXT,
  tags TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_unit ON findings(unit_id);

-- Full-text search (external content tables kept in sync by triggers)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS findings_fts USING fts5(
  symptom, cause, resolution, tags, content='findings', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS findings_ai AFTER INSERT ON findings BEGIN
  INSERT INTO findings_fts(rowid, symptom, cause, resolution, tags)
  VALUES (new.rowid, new.symptom, new.cause, new.resolution, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS findings_ad AFTER DELETE ON findings BEGIN
  INSERT INTO findings_fts(findings_fts, rowid, symptom, cause, resolution, tags)
  VALUES ('delete', old.rowid, old.symptom, old.cause, old.resolution, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS findings_au AFTER UPDATE ON findings BEGIN
  INSERT INTO findings_fts(findings_fts, rowid, symptom, cause, resolution, tags)
  VALUES ('delete', old.rowid, old.symptom, old.cause, old.resolution, old.tags);
  INSERT INTO findings_fts(rowid, symptom, cause, resolution, tags)
  VALUES (new.rowid, new.symptom, new.cause, new.resolution, new.tags);
END;
`;
