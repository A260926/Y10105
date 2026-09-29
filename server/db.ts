// SQLite persistence layer (node:sqlite). The whole BOM import runs inside
// one transaction so a crash between component and edge writes rolls back.

import { createRequire } from 'node:module';

// Loaded at runtime so bundlers (Vite/Vitest transform pipeline) do not try
// to resolve the experimental builtin themselves.
const require = createRequire(import.meta.url);
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
type DatabaseSyncCtor = typeof import('node:sqlite').DatabaseSync;
const sqliteModule = require('node:sqlite') as typeof import('node:sqlite');
const DatabaseSync: DatabaseSyncCtor = sqliteModule.DatabaseSync;
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DB {
  raw: DatabaseSyncType;
  close(): void;
  tx<T>(fn: () => T): T;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]'
);
-- idempotency: same key can only ever map to one content hash
CREATE UNIQUE INDEX IF NOT EXISTS ux_imports_key ON imports(import_key);
CREATE UNIQUE INDEX IF NOT EXISTS ux_imports_key_hash ON imports(import_key, content_hash);

CREATE TABLE IF NOT EXISTS components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  bom_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  purl TEXT NOT NULL,
  declared_licenses TEXT NOT NULL,
  declared_license_raw TEXT NOT NULL,
  origin TEXT NOT NULL,
  evidence TEXT NOT NULL,
  UNIQUE(import_id, bom_ref)
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  parent_ref TEXT NOT NULL,
  child_ref TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_edges_child ON edges(import_id, child_ref);
CREATE INDEX IF NOT EXISTS ix_edges_parent ON edges(import_id, parent_ref);

CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  name TEXT,
  reason TEXT NOT NULL,
  raw TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS ix_quarantine_status ON quarantine(status);

CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  license_expression TEXT NOT NULL,
  origin TEXT NOT NULL,
  dep_kind TEXT,
  purpose TEXT,
  effect TEXT NOT NULL,
  priority INTEGER NOT NULL,
  effective_from TEXT,
  effective_to TEXT,
  UNIQUE(rule_id, policy_version)
);

CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_purl TEXT NOT NULL,
  component_version TEXT,
  policy_version INTEGER NOT NULL,
  purpose TEXT,
  reason TEXT NOT NULL,
  approver TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(component_purl, component_version, purpose)
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id),
  name TEXT NOT NULL,
  purpose TEXT,
  root_purl TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  clock_at TEXT,
  policy_version INTEGER,
  overall_verdict TEXT,
  created_at TEXT NOT NULL,
  frozen_at TEXT
);

CREATE TABLE IF NOT EXISTS candidate_graph (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  components TEXT NOT NULL,
  edges TEXT NOT NULL,
  root_refs TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidate_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  purl TEXT NOT NULL,
  version TEXT,
  dep_kind TEXT NOT NULL,
  verdict TEXT NOT NULL,
  policy_rule_id TEXT,
  policy_version INTEGER,
  effect TEXT,
  exception_id INTEGER,
  reason TEXT,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_decisions_candidate ON candidate_decisions(candidate_id);
`;

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA);
  return {
    raw,
    close() {
      raw.close();
    },
    tx<T>(fn: () => T): T {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
