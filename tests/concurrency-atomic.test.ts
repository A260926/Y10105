import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, importBom, fixtures } from './helpers.ts';
import {
  ConcurrencyConflict,
  listComponents,
  listEdges,
  upsertException,
  updateException,
} from '../server/repo.ts';
import { persistImport } from '../server/repo.ts';
import { parseCycloneDx } from '../server/cdx.ts';
import { openDatabase } from '../server/db.ts';

describe('concurrent exception editing uses optimistic version conflict', () => {
  it('two writers starting at row v1: first update succeeds, second gets 409', () => {
    const db = freshDb(false);
    const created = upsertException(db, {
      componentPurl: 'pkg:npm/thing',
      componentVersion: '1.0.0',
      policyVersion: 1,
      purpose: 'prod',
      reason: 'initial',
      approver: 'alice',
      expiresAt: '2027-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
    });
    const id = created.id!;

    // Both users loaded version 1.
    updateException(db, { id, expectedRowVersion: 1, reason: 'alice edit' });

    expect(() =>
      updateException(db, { id, expectedRowVersion: 1, reason: 'bob stale edit' }),
    ).toThrow(ConcurrencyConflict);

    // After refreshing, bob can apply on the new version.
    const ok = updateException(db, { id, expectedRowVersion: 2, approver: 'bob' });
    expect(ok.rowVersion).toBe(3);
    expect(ok.reason).toBe('alice edit');
    expect(ok.approver).toBe('bob');
  });
});

describe('atomic import rollback', () => {
  it('an in-transaction failure leaves no components or edges behind', () => {
    const db = freshDb(false);
    const parsed = parseCycloneDx(JSON.stringify(fixtures.BOM_GOOD));
    expect(() =>
      db.tx(() => {
        const info = db.raw
          .prepare(
            `INSERT INTO imports (import_key, content_hash, created_at, summary, warnings)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            'rollback-key',
            parsed.imported.summary.contentHash,
            '2026-02-01T00:00:00Z',
            JSON.stringify(parsed.imported.summary),
            '[]',
          );
        const importId = Number(info.lastInsertRowid);
        const stmt = db.raw.prepare(
          `INSERT INTO components (import_id, bom_ref, name, version, purl,
             declared_licenses, declared_license_raw, origin, evidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const c of parsed.imported.components.slice(0, 2)) {
          stmt.run(importId, c.bomRef, c.name, c.version, c.purl,
            JSON.stringify(c.declaredLicenses), JSON.stringify(c.declaredLicenseRaw),
            c.origin, JSON.stringify(c.evidence));
        }
        // Simulate the process dying between component and edge writes.
        throw new Error('simulated crash before edges');
      }),
    ).toThrow(/simulated crash/);

    const imports = db.raw.prepare('SELECT COUNT(*) AS n FROM imports').get() as { n: number };
    const comps = db.raw.prepare('SELECT COUNT(*) AS n FROM components').get() as { n: number };
    const edges = db.raw.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number };
    expect(Number(imports.n)).toBe(0);
    expect(Number(comps.n)).toBe(0);
    expect(Number(edges.n)).toBe(0);
  });

  it('real process exit between components and edges rolls back on disk (no half graph)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'led-crash-'));
    const dbPath = join(dir, 'crash.sqlite');
    const bomPath = join(dir, 'bom.json');
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(bomPath, JSON.stringify(fixtures.BOM_GOOD));

    // Child opens its own tx, inserts import+components, then hard-exits
    // before inserting edges / COMMIT.
    const child = `
      const { DatabaseSync } = require('node:sqlite');
      const fs = require('node:fs');
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec(${JSON.stringify(SCHEMA_SQL)});
      const bom = JSON.parse(fs.readFileSync(${JSON.stringify(bomPath)}, 'utf8'));
      db.exec('BEGIN IMMEDIATE');
      db.prepare("INSERT INTO imports (import_key, content_hash, created_at, summary, warnings) VALUES (?,?,?,?,?)")
        .run('crash-key', 'x', '2026-02-01T00:00:00Z', JSON.stringify({}), '[]');
      db.prepare("INSERT INTO components (import_id,bom_ref,name,version,purl,declared_licenses,declared_license_raw,origin,evidence) VALUES (1,'a','a','1','pkg:npm/a@1','[]','[]','external','{}')").run();
      process.exit(7);
    `;
    try {
      execFileSync(process.execPath, ['-e', child], { stdio: 'pipe' });
      throw new Error('child should have exited non-zero');
    } catch (err) {
      expect((err as { status?: number }).status).toBe(7);
    }

    // WAL is checkpointed on open; assert the tables are empty.
    const check = openDatabase(dbPath);
    const n = (sql: string) =>
      Number((check.raw.prepare(sql).get() as { n: number }).n);
    expect(n('SELECT COUNT(*) AS n FROM imports')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM components')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM edges')).toBe(0);
    check.close();
    expect(existsSync(dbPath)).toBe(true);
  });
});

// Minimal schema string for the crash child.
const SCHEMA_SQL = readFileSync(new URL('../server/db.ts', import.meta.url), 'utf8')
  .split('const SCHEMA = `')[1]
  .split('`;')[0];
