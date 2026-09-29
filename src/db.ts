import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export function createDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    bom_serial TEXT,
    bom_version INTEGER,
    root_ref TEXT,
    component_count INTEGER NOT NULL,
    edge_count INTEGER NOT NULL,
    quarantine_count INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS components (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES imports(id),
    bom_ref TEXT NOT NULL,
    purl TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    declared_license TEXT,
    evidence_source TEXT,
    raw_json TEXT NOT NULL,
    UNIQUE (import_id, bom_ref)
  );

  CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES imports(id),
    from_ref TEXT NOT NULL,
    to_ref TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_edges_import_from ON edges(import_id, from_ref);
  CREATE INDEX IF NOT EXISTS idx_edges_import_to ON edges(import_id, to_ref);

  CREATE TABLE IF NOT EXISTS quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES imports(id),
    bom_ref TEXT,
    reason TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    resolution_note TEXT
  );

  CREATE TABLE IF NOT EXISTS policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    license_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '*',
    dep_kind TEXT NOT NULL DEFAULT 'any',
    usage TEXT NOT NULL DEFAULT '*',
    effect TEXT NOT NULL CHECK (effect IN ('allow','deny','needs_exception')),
    effective_from TEXT NOT NULL,
    effective_to TEXT
  );

  CREATE TABLE IF NOT EXISTS exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    component_purl TEXT NOT NULL,
    component_version TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    usage TEXT NOT NULL,
    reason TEXT NOT NULL,
    approver TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','revoked')),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES imports(id),
    name TEXT NOT NULL,
    usage TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','frozen')),
    policy_version TEXT,
    frozen_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS candidate_components (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id),
    bom_ref TEXT NOT NULL,
    purl TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    declared_license TEXT,
    evidence_source TEXT,
    dep_kind TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS candidate_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id),
    from_ref TEXT NOT NULL,
    to_ref TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS resolutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id),
    bom_ref TEXT NOT NULL,
    decision TEXT NOT NULL,
    basis_type TEXT NOT NULL,
    basis_json TEXT NOT NULL
  );
  `);
}

export function nowIso(): string {
  return new Date().toISOString();
}
