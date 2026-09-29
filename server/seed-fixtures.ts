// CycloneDX JSON fixtures used by tests and the demo seed.

export const BOM_GOOD: unknown = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: 'urn:uuid:0000-demo-good',
  version: 1,
  metadata: {
    timestamp: '2026-09-01T08:00:00Z',
    component: {
      'bom-ref': 'root-app',
      type: 'application',
      name: 'payments-app',
      version: '4.2.0',
      purl: 'pkg:internal/payments-app@4.2.0',
    },
  },
  components: [
    {
      'bom-ref': 'comp-express',
      type: 'library',
      name: 'express',
      version: '4.19.2',
      purl: 'pkg:npm/express@4.19.2',
      licenses: [{ license: { id: 'MIT' } }],
      properties: [{ name: 'internal:registry-token', value: 's3cr3t-should-not-export' }],
    },
    {
      'bom-ref': 'comp-loglib',
      type: 'library',
      name: 'loglib',
      version: '2.0.0',
      purl: 'pkg:npm/loglib@2.0.0',
      licenses: [{ license: { id: 'Apache-2.0' } }],
    },
    {
      'bom-ref': 'comp-gpltrans',
      type: 'library',
      name: 'readline-gpl',
      version: '1.3.0',
      purl: 'pkg:maven/com.example/readline-gpl@1.3.0',
      licenses: [{ license: { id: 'GPL-3.0-only' } }],
    },
    {
      'bom-ref': 'comp-dual',
      type: 'library',
      name: 'dual-lib',
      version: '0.9.0',
      purl: 'pkg:npm/dual-lib@0.9.0',
      licenses: [{ expression: '(MIT OR Apache-2.0)' }],
    },
    {
      'bom-ref': 'comp-withplus',
      type: 'library',
      name: 'old-mit',
      version: '1.0.0',
      purl: 'pkg:npm/old-mit@1.0.0',
      licenses: [{ license: { id: 'MIT' } }],
    },
  ],
  dependencies: [
    { ref: 'root-app', dependsOn: ['comp-express', 'comp-dual'] },
    { ref: 'comp-express', dependsOn: ['comp-loglib'] },
    { ref: 'comp-loglib', dependsOn: ['comp-gpltrans'] },
    { ref: 'comp-dual', dependsOn: ['comp-withplus'] },
  ],
};

// Same import key as BOM_GOOD but different content => idempotency conflict.
function cloneGood(): Record<string, unknown> {
  return structuredClone(BOM_GOOD) as Record<string, unknown>;
}

export const BOM_GOOD_CONFLICT: unknown = {
  ...cloneGood(),
  components: ((cloneGood().components as unknown[]) ?? []).slice(0, 2),
};

// Identical content => same hash => idempotent replay returns first import.
export const BOM_GOOD_REPLAY: unknown = structuredClone(BOM_GOOD);

export const BOM_QUARANTINE: unknown = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: 'urn:uuid:0000-demo-quarantine',
  version: 1,
  metadata: {
    timestamp: '2026-09-02T08:00:00Z',
    component: {
      'bom-ref': 'qroot',
      type: 'application',
      name: 'shipping-svc',
      version: '0.3.1',
      purl: 'pkg:internal/shipping-svc@0.3.1',
    },
  },
  components: [
    {
      'bom-ref': 'q-ok',
      type: 'library',
      name: 'tiny-util',
      version: '1.0.0',
      purl: 'pkg:npm/tiny-util@1.0.0',
      licenses: [{ license: { id: 'ISC' } }],
    },
    {
      // malformed: purl missing
      'bom-ref': 'q-bad-purl',
      type: 'library',
      name: 'no-purl-lib',
      version: '9.9.9',
      licenses: [{ license: { id: 'MIT' } }],
    },
    {
      // malformed license expression syntax
      'bom-ref': 'q-bad-license',
      type: 'library',
      name: 'broken-expr',
      version: '0.0.1',
      purl: 'pkg:npm/broken-expr@0.0.1',
      licenses: [{ expression: 'MIT OR' }],
    },
  ],
  dependencies: [{ ref: 'qroot', dependsOn: ['q-ok', 'q-bad-purl'] }],
};

// Two components with the same name but different purl+version.
export const BOM_SAMENAME: unknown = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: 'urn:uuid:0000-demo-samename',
  version: 1,
  metadata: {
    component: {
      'bom-ref': 'snroot',
      type: 'application',
      name: 'gateway',
      version: '7.0.0',
      purl: 'pkg:internal/gateway@7.0.0',
    },
  },
  components: [
    {
      'bom-ref': 'sn-a',
      type: 'library',
      name: 'widget',
      version: '1.0.0',
      purl: 'pkg:npm/widget@1.0.0',
      licenses: [{ license: { id: 'MIT' } }],
    },
    {
      'bom-ref': 'sn-b',
      type: 'library',
      name: 'widget',
      version: '2.0.0',
      purl: 'pkg:maven/com.vendor/widget@2.0.0',
      licenses: [{ license: { id: 'GPL-3.0-only' } }],
    },
  ],
  dependencies: [
    { ref: 'snroot', dependsOn: ['sn-a', 'sn-b'] },
  ],
};
