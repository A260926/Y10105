import { describe, expect, it } from 'vitest';
import { freshDb, fixtures, importBom } from './helpers.ts';
import { IdempotencyConflict, listComponents, listEdges, listQuarantine } from '../server/repo.ts';
import { parseCycloneDx } from '../server/cdx.ts';

describe('CycloneDX import', () => {
  it('keeps summary, purl identity, declared licenses, evidence and edges', () => {
    const db = freshDb(false);
    const { row, parsed } = importBom(db, fixtures.BOM_GOOD);
    expect(parsed.imported.summary.bomFormat).toBe('CycloneDX');
    expect(parsed.imported.summary.componentPurl).toBe('pkg:internal/payments-app@4.2.0');
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const comps = listComponents(db, row.id);
    const express = comps.find((c) => c.purl === 'pkg:npm/express@4.19.2');
    expect(express?.declaredLicenses).toContain('MIT');
    expect(express?.evidence.licenseSource).toMatch(/license\.id/);
    const edges = listEdges(db, row.id);
    expect(edges).toContainEqual({
      parentRef: 'comp-loglib',
      childRef: 'comp-gpltrans',
    });
  });

  it('sends malformed components to quarantine while valid components still persist', () => {
    const db = freshDb(false);
    const { row } = importBom(db, fixtures.BOM_QUARANTINE);
    const comps = listComponents(db, row.id);
    expect(comps.map((c) => c.name)).toContain('tiny-util');
    const q = listQuarantine(db);
    const reasons = q.map((x) => x.reason).join(' | ');
    expect(reasons).toMatch(/missing purl/);
    expect(reasons).toMatch(/invalid license expression/);
    expect(q.every((x) => x.status === 'open')).toBe(true);
  });

  it('rejects documents that are not CycloneDX', () => {
    expect(() => parseCycloneDx(JSON.stringify({ bomFormat: 'SPDX' }))).toThrow(/CycloneDX/);
    expect(() => parseCycloneDx('{not json')).toThrow(/JSON/);
  });

  it('same key + same content is idempotent and returns the original import', () => {
    const db = freshDb(false);
    const first = importBom(db, fixtures.BOM_GOOD);
    const again = importBom(db, fixtures.BOM_GOOD_REPLAY);
    expect(again.row.id).toBe(first.row.id);
    expect(again.row.contentHash).toBe(first.row.contentHash);
  });

  it('same key + different content conflicts (409 semantics)', () => {
    const db = freshDb(false);
    importBom(db, fixtures.BOM_GOOD);
    expect(() => importBom(db, fixtures.BOM_GOOD_CONFLICT)).toThrow(IdempotencyConflict);
  });

  it('explicit keys collide when reused with changed payload', () => {
    const db = freshDb(false);
    const base = {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      metadata: {
        component: {
          'bom-ref': 'r', type: 'application', name: 'a', version: '1',
          purl: 'pkg:internal/a@1',
        },
      },
      components: [
        { 'bom-ref': 'c', type: 'library', name: 'c', version: '1', purl: 'pkg:npm/c@1',
          licenses: [{ license: { id: 'MIT' } }] },
      ],
      dependencies: [],
    };
    importBom(db, base, 'team/release-9');
    const changed = {
      ...base,
      components: [
        ...base.components,
        { 'bom-ref': 'd', type: 'library', name: 'd', version: '2', purl: 'pkg:npm/d@2',
          licenses: [{ license: { id: 'ISC' } }] },
      ],
    };
    expect(() => importBom(db, changed, 'team/release-9')).toThrow(IdempotencyConflict);
  });
});
