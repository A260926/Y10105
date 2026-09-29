import { openDatabase, type DB } from '../server/db.ts';
import { seedPolicies } from '../server/seed.ts';
import {
  BOM_GOOD,
  BOM_GOOD_REPLAY,
  BOM_GOOD_CONFLICT,
  BOM_QUARANTINE,
  BOM_SAMENAME,
} from '../server/seed-fixtures.ts';
import { parseCycloneDx } from '../server/cdx.ts';
import { persistImport } from '../server/repo.ts';

export function freshDb(seed = true): DB {
  const db = openDatabase(':memory:');
  if (seed) seedPolicies(db);
  return db;
}

export function importBom(db: DB, bom: unknown, key?: string) {
  const payload = JSON.stringify(bom);
  const parsed = parseCycloneDx(payload, key ?? null);
  const row = persistImport(db, {
    parseResult: parsed,
    importKey: parsed.imported.importKey,
    createdAt: '2026-02-01T00:00:00Z',
  });
  return { parsed, row };
}

export const fixtures = {
  BOM_GOOD,
  BOM_GOOD_REPLAY,
  BOM_GOOD_CONFLICT,
  BOM_QUARANTINE,
  BOM_SAMENAME,
};

// Build a minimal custom BOM for focused policy tests.
export function makeBom(opts: {
  serial: string;
  rootName?: string;
  rootPurl?: string;
  components: {
    ref: string;
    name: string;
    version: string;
    purl: string;
    licenses?: string[]; // SPDX expressions
    origin?: 'external' | 'internal';
  }[];
  deps?: { ref: string; dependsOn: string[] }[];
}): unknown {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${opts.serial}`,
    version: 1,
    metadata: {
      component: {
        'bom-ref': 'root',
        type: 'application',
        name: opts.rootName ?? 'root-app',
        version: '1.0.0',
        purl: opts.rootPurl ?? 'pkg:internal/root-app@1.0.0',
      },
    },
    components: opts.components.map((c) => ({
      'bom-ref': c.ref,
      type: 'library',
      name: c.name,
      version: c.version,
      purl: c.purl,
      ...(c.licenses ? { licenses: c.licenses.map((l) => ({ expression: l })) } : {}),
    })),
    dependencies: [
      { ref: 'root', dependsOn: opts.components.map((c) => c.ref).filter((_, i) => i === 0) },
      ...(opts.deps ?? []),
    ],
  };
}
