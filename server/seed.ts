// Demo seed: idempotently loads policies, fixture BOMs, an exception and
// preset candidates. Uses fixed timestamps so the demo is reproducible.

import type { DB } from './db.ts';
import {
  activePolicyVersion,
  createCandidate,
  findImportByKey,
  insertPolicy,
  listExceptions,
  persistImport,
  resolveQuarantine,
  upsertException,
} from './repo.ts';
import { parseCycloneDx } from './cdx.ts';
import { BOM_GOOD, BOM_QUARANTINE, BOM_SAMENAME } from './seed-fixtures.ts';
import { freezeCandidate } from './candidates.ts';
import { listQuarantine } from './repo.ts';
import type { PolicyRule } from '../src/shared/types.ts';

// Demo timeline (fixed, deterministic):
//   2026-01-01  policy v1 effective
//   2026-02-01  import BOMs
//   2026-03-01  freeze candidate "payments-rc1" (transitive GPL denied)
//   2026-04-01  exception for the AND-licensed component starts, candidate frozen "allow"
//   2026-06-01  exception expires (half-open endpoint)
//   2026-07-01  policy v2: LGPL-3.0-only becomes needs_exception
//   "now"       = 2026-09-30 (expired state visible on a new draft)
export const CLOCK_NOW = '2026-09-30T00:00:00Z';
export const CLOCK_BEFORE_EXPIRY = '2026-05-15T00:00:00Z';
export const EXCEPTION_EXPIRES = '2026-06-01T00:00:00Z';

const POLICIES_V1: PolicyRule[] = [
  {
    id: 'P-PERMISSIVE',
    policyVersion: 1,
    licenseExpression: '(MIT OR Apache-2.0 OR BSD-2-Clause OR BSD-3-Clause OR ISC OR 0BSD OR Zlib)',
    origin: 'any',
    depKind: null,
    purpose: null,
    effect: 'allow',
    priority: 100,
    effectiveFrom: '2026-01-01T00:00:00Z',
    effectiveTo: null,
  },
  {
    id: 'P-DUAL-PERMISSIVE',
    policyVersion: 1,
    licenseExpression: '(MIT OR Apache-2.0)',
    origin: 'external',
    depKind: null,
    purpose: null,
    effect: 'allow',
    priority: 120,
    effectiveFrom: '2026-01-01T00:00:00Z',
    effectiveTo: null,
  },
  {
    id: 'P-GPL',
    policyVersion: 1,
    licenseExpression: 'GPL-3.0-only',
    origin: 'external',
    depKind: null,
    purpose: null,
    effect: 'deny',
    priority: 200,
    effectiveFrom: '2026-01-01T00:00:00Z',
    effectiveTo: null,
  },
  {
    id: 'P-GPL-CLASSPATH',
    policyVersion: 1,
    licenseExpression: '(GPL-3.0-only AND Classpath-exception-2.0)',
    origin: 'external',
    depKind: null,
    purpose: null,
    effect: 'allow',
    priority: 50,
    effectiveFrom: '2026-01-01T00:00:00Z',
    effectiveTo: null,
  },
  {
    id: 'P-LGPL',
    policyVersion: 1,
    licenseExpression: 'LGPL-3.0-only',
    origin: 'external',
    depKind: null,
    purpose: null,
    effect: 'deny',
    priority: 210,
    effectiveFrom: '2026-01-01T00:00:00Z',
    effectiveTo: '2026-07-01T00:00:00Z',
  },
];

const POLICIES_V2: PolicyRule[] = [
  {
    id: 'P-LGPL',
    policyVersion: 2,
    licenseExpression: 'LGPL-3.0-only',
    origin: 'external',
    depKind: null,
    purpose: null,
    effect: 'needs_exception',
    priority: 210,
    effectiveFrom: '2026-07-01T00:00:00Z',
    effectiveTo: null,
  },
];

export function seedPolicies(db: DB): void {
  for (const rule of [...POLICIES_V1, ...POLICIES_V2]) insertPolicy(db, rule);
}

export function isSeeded(db: DB): boolean {
  const row = db.raw.prepare('SELECT COUNT(*) AS n FROM policies').get() as { n: number };
  return Number(row.n) > 0;
}

export function seedDemo(db: DB): {
  goodCandidateId: number;
  expiredFrozenId: number;
  expiredDraftId: number;
  quarantineCandidateId: number;
  samenameCandidateId: number;
} {
  seedPolicies(db);

  // Import fixtures (idempotent via import key).
  const goodKey = ensureImport(db, JSON.stringify(BOM_GOOD));
  const qKey = ensureImport(db, JSON.stringify(BOM_QUARANTINE));
  const snKey = ensureImport(db, JSON.stringify(BOM_SAMENAME));

  // Resolve quarantine only for the shipping BOM? No: the demo intentionally
  // leaves ONE candidate blocked by open quarantine to showcase the gate.
  // We resolve nothing, so shipping candidate stays freeze-blocked.
  void listQuarantine(db);

  const existing = listCandidateNames(db);

  // 1) Frozen candidate before the exception existed => transitive deny path.
  let goodId = existing.get('payments-rc1');
  if (goodId == null) {
    const cand = createCandidate(db, {
      importId: goodKey,
      name: 'payments-rc1',
      purpose: null,
      rootPurl: 'pkg:internal/payments-app@4.2.0',
      createdAt: '2026-02-05T00:00:00Z',
    });
    freezeCandidate(db, cand.id, '2026-03-01T00:00:00Z');
    goodId = cand.id;
  }

  // The exception is granted AFTER rc1 was frozen, so the rc1 snapshot keeps
  // its denial. rc2 is frozen while the exception is still active.
  ensureException(db, {
    componentPurl: 'pkg:maven/com.example/readline-gpl',
    componentVersion: '1.3.0',
    policyVersion: 1,
    purpose: null,
    reason: 'Static linking replaced with dynamic loading; legal sign-off for v1 policy.',
    approver: 'legal@example.com',
    expiresAt: EXCEPTION_EXPIRES,
    createdAt: '2026-04-01T00:00:00Z',
  });

  // 2) Frozen candidate while the exception was active => allow snapshot.
  let expiredFrozenId = existing.get('payments-rc2-exception');
  if (expiredFrozenId == null) {
    const cand = createCandidate(db, {
      importId: goodKey,
      name: 'payments-rc2-exception',
      purpose: null,
      rootPurl: 'pkg:internal/payments-app@4.2.0',
      createdAt: '2026-04-05T00:00:00Z',
    });
    freezeCandidate(db, cand.id, CLOCK_BEFORE_EXPIRY);
    expiredFrozenId = cand.id;
  }

  // 3) Draft evaluated now (exception expired) => new conclusion differs.
  let expiredDraftId = existing.get('payments-rc3-after-expiry');
  if (expiredDraftId == null) {
    const cand = createCandidate(db, {
      importId: goodKey,
      name: 'payments-rc3-after-expiry',
      purpose: null,
      rootPurl: 'pkg:internal/payments-app@4.2.0',
      createdAt: '2026-09-30T00:00:00Z',
    });
    expiredDraftId = cand.id;
  }

  // 4) Quarantine-blocked candidate (freeze must fail).
  let quarantineCandidateId = existing.get('shipping-blocked');
  if (quarantineCandidateId == null) {
    const cand = createCandidate(db, {
      importId: qKey,
      name: 'shipping-blocked',
      purpose: null,
      rootPurl: 'pkg:internal/shipping-svc@0.3.1',
      createdAt: '2026-09-30T00:00:00Z',
    });
    quarantineCandidateId = cand.id;
  }

  // 5) Same name, different purls: one allow one deny.
  let samenameCandidateId = existing.get('gateway-samename');
  if (samenameCandidateId == null) {
    const cand = createCandidate(db, {
      importId: snKey,
      name: 'gateway-samename',
      purpose: null,
      rootPurl: 'pkg:internal/gateway@7.0.0',
      createdAt: '2026-09-30T00:00:00Z',
    });
    samenameCandidateId = cand.id;
  }

  void resolveQuarantine;
  return {
    goodCandidateId: goodId,
    expiredFrozenId,
    expiredDraftId,
    quarantineCandidateId,
    samenameCandidateId,
  };
}

function ensureImport(db: DB, payload: string): number {
  const parsed = parseCycloneDx(payload);
  const existing = findImportByKey(db, parsed.imported.importKey);
  if (existing) return existing.id;
  const row = persistImport(db, {
    parseResult: parsed,
    importKey: parsed.imported.importKey,
    createdAt: '2026-02-01T00:00:00Z',
  });
  return row.id;
}

function ensureException(
  db: DB,
  input: Parameters<typeof upsertException>[1],
): void {
  const found = listExceptions(db, '9999-01-01T00:00:00Z').find(
    (e) =>
      e.componentPurl === input.componentPurl &&
      e.componentVersion === input.componentVersion &&
      (e.purpose ?? null) === (input.purpose ?? null),
  );
  if (!found) upsertException(db, input);
}

function listCandidateNames(db: DB): Map<string, number> {
  const rows = db.raw.prepare('SELECT id, name FROM candidates').all() as {
    id: number;
    name: string;
  }[];
  return new Map(rows.map((r) => [r.name, r.id]));
}

export { activePolicyVersion };
