import { createDb, type Db } from '../src/db.ts';

export function testDb(): Db {
  return createDb(':memory:');
}

export function seedPolicies(db: Db, version = 'v1'): void {
  const insert = db.prepare(
    `INSERT INTO policies (version, license_id, source, dep_kind, usage, effect, effective_from, effective_to)
     VALUES (?, ?, '*', 'any', '*', ?, '2026-01-01T00:00:00Z', NULL)`,
  );
  insert.run(version, 'MIT', 'allow');
  insert.run(version, 'Apache-2.0', 'allow');
  insert.run(version, 'GPL-3.0-only', 'deny');
  insert.run(version, 'LGPL-3.0-only', 'needs_exception');
}

export function bomJson(
  components: unknown[],
  dependencies: unknown[],
  rootRef = 'root',
): string {
  return JSON.stringify({
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: { 'bom-ref': rootRef, name: 'app', version: '1.0.0', purl: 'pkg:generic/app@1.0.0' },
    },
    components,
    dependencies,
  });
}

export function comp(
  ref: string,
  purl: string,
  license: string | null,
): Record<string, unknown> {
  return {
    'bom-ref': ref,
    name: purl,
    version: purl.split('@').pop(),
    purl,
    licenses: license ? [{ license: { id: license } }] : [],
    evidence: { occurrences: [{ location: `vendor/${ref}` }] },
  };
}
