import { describe, expect, it } from 'vitest';
import { freshDb, fixtures, importBom, makeBom } from './helpers.ts';
import {
  listComponents,
  listEdges,
  upsertException,
  listPolicyRules,
  rulesAtTime,
} from '../server/repo.ts';
import { indexGraph, depKinds, pathsToRoot } from '../server/graph.ts';
import { evaluate } from '../server/policy.ts';
import {
  buildCandidateView,
  exportCandidate,
  freezeCandidate,
  makeCandidate,
  QuarantineBlockingError,
} from '../server/candidates.ts';
import { seedDemo, CLOCK_NOW, CLOCK_BEFORE_EXPIRY, EXCEPTION_EXPIRES } from '../server/seed.ts';

function graphFor(db: ReturnType<typeof freshDb>, importId: number, rootPurl: string) {
  const comps = listComponents(db, importId);
  const edges = listEdges(db, importId);
  const byPurl = new Map(comps.map((c) => [c.purl, c.bomRef]));
  return indexGraph(comps, edges, [byPurl.get(rootPurl)!]);
}

describe('policy decisions', () => {
  it('allows permissive, denies GPL, flags AND dual licensing structurally', () => {
    const db = freshDb();
    const { row } = importBom(db, fixtures.BOM_GOOD);
    const g = graphFor(db, row.id, 'pkg:internal/payments-app@4.2.0');
    const kinds = depKinds(g);
    const { rules } = rulesAtTime(db, '2026-03-01T00:00:00Z');
    const byPurl = new Map([...g.byRef.values()].map((c) => [c.purl, c] as const));

    const express = evaluate({
      component: byPurl.get('pkg:npm/express@4.19.2')!,
      depKind: kinds.get(byPurl.get('pkg:npm/express@4.19.2')!.bomRef)!,
      purpose: null, at: '2026-03-01T00:00:00Z', rules, exceptions: [],
    });
    expect(express.verdict).toBe('allow');
    expect(express.policyHit?.ruleId).toBe('P-PERMISSIVE');

    const gpl = evaluate({
      component: byPurl.get('pkg:maven/com.example/readline-gpl@1.3.0')!,
      depKind: 'transitive', purpose: null, at: '2026-03-01T00:00:00Z',
      rules, exceptions: [],
    });
    expect(gpl.verdict).toBe('deny');
    expect(gpl.policyHit?.ruleId).toBe('P-GPL');

    const dual = evaluate({
      component: byPurl.get('pkg:npm/dual-lib@0.9.0')!,
      depKind: 'direct', purpose: null, at: '2026-03-01T00:00:00Z',
      rules, exceptions: [],
    });
    // (MIT OR Apache-2.0) structurally satisfies a permissive OR rule.
    expect(dual.verdict).toBe('allow');
    expect(['P-PERMISSIVE', 'P-DUAL-PERMISSIVE']).toContain(dual.policyHit?.ruleId);
  });

  it('unknown declared license stays unknown and needs an exception', () => {
    const db = freshDb();
    const bom = makeBom({
      serial: 'unknown-case',
      components: [
        { ref: 'm', name: 'mystery', version: '1.0', purl: 'pkg:npm/mystery@1.0',
          licenses: ['LicenseRef-Proprietary-X'] },
      ],
    });
    const { row } = importBom(db, bom);
    const comps = listComponents(db, row.id);
    const dec = evaluate({
      component: comps[0], depKind: 'direct', purpose: null,
      at: '2026-03-01T00:00:00Z',
      rules: rulesAtTime(db, '2026-03-01T00:00:00Z').rules, exceptions: [],
    });
    expect(dec.verdict).toBe('unknown');
  });

  it('components with the same name but different purl get separate decisions', () => {
    const db = freshDb();
    const { row } = importBom(db, fixtures.BOM_SAMENAME);
    const comps = listComponents(db, row.id);
    const rules = rulesAtTime(db, CLOCK_NOW).rules;
    const decs = comps
      .filter((c) => c.purl.startsWith('pkg:'))
      .filter((c) => !c.purl.startsWith('pkg:internal/'))
      .map((c) =>
        evaluate({ component: c, depKind: 'direct', purpose: null, at: CLOCK_NOW, rules, exceptions: [] }),
      );
    const byPurl = new Map(decs.map((d) => [d.purl, d.verdict]));
    expect(byPurl.get('pkg:npm/widget@1.0.0')).toBe('allow');
    expect(byPurl.get('pkg:maven/com.vendor/widget@2.0.0')).toBe('deny');
  });

  it('transitive path from denied GPL component reaches the root', () => {
    const db = freshDb();
    const { row } = importBom(db, fixtures.BOM_GOOD);
    const g = graphFor(db, row.id, 'pkg:internal/payments-app@4.2.0');
    const gplRef = [...g.byRef.values()].find(
      (c) => c.purl === 'pkg:maven/com.example/readline-gpl@1.3.0',
    )!.bomRef;
    const paths = pathsToRoot(g, gplRef);
    expect(paths.length).toBeGreaterThan(0);
    const flat = paths[0].path.map((n) => n.purl);
    expect(flat[0]).toBe('pkg:internal/payments-app@4.2.0');
    expect(flat[flat.length - 1]).toBe('pkg:maven/com.example/readline-gpl@1.3.0');
    expect(flat).toContain('pkg:npm/express@4.19.2');
    expect(flat).toContain('pkg:npm/loglib@2.0.0');
  });

  it('direct vs transitive classification', () => {
    const db = freshDb();
    const { row } = importBom(db, fixtures.BOM_GOOD);
    const g = graphFor(db, row.id, 'pkg:internal/payments-app@4.2.0');
    const kinds = depKinds(g);
    const refOf = (purl: string) =>
      [...g.byRef.values()].find((c) => c.purl === purl)!.bomRef;
    expect(kinds.get(refOf('pkg:npm/express@4.19.2'))).toBe('direct');
    expect(kinds.get(refOf('pkg:maven/com.example/readline-gpl@1.3.0'))).toBe('transitive');
  });
});

describe('exceptions and expiry endpoint', () => {
  it('exception bound to identity+version+purpose changes the verdict while active', () => {
    const db = freshDb();
    const { row } = importBom(db, fixtures.BOM_GOOD);
    const comps = listComponents(db, row.id);
    const gpl = comps.find((c) => c.purl === 'pkg:maven/com.example/readline-gpl@1.3.0')!;
    const rules = rulesAtTime(db, CLOCK_BEFORE_EXPIRY).rules;
    upsertException(db, {
      componentPurl: gpl.purl, componentVersion: gpl.version, policyVersion: 1,
      purpose: null, reason: 'dynamic loading', approver: 'legal@corp',
      expiresAt: EXCEPTION_EXPIRES, createdAt: '2026-04-01T00:00:00Z',
    });
    const active = evaluate({
      component: gpl, depKind: 'transitive', purpose: null,
      at: CLOCK_BEFORE_EXPIRY, rules,
      exceptions: listExceptionsShim(db, CLOCK_BEFORE_EXPIRY),
    });
    expect(active.verdict).toBe('allow');
    expect(active.exception?.reason).toBe('dynamic loading');
  });

  it('the exact expiry instant is expired (half-open endpoint)', () => {
    const db = freshDb();
    const { row } = importBom(db, fixtures.BOM_GOOD);
    const comps = listComponents(db, row.id);
    const gpl = comps.find((c) => c.purl === 'pkg:maven/com.example/readline-gpl@1.3.0')!;
    const rules = rulesAtTime(db, EXCEPTION_EXPIRES).rules;
    upsertException(db, {
      componentPurl: gpl.purl, componentVersion: gpl.version, policyVersion: 1,
      purpose: null, reason: 'x', approver: 'legal', expiresAt: EXCEPTION_EXPIRES,
      createdAt: '2026-04-01T00:00:00Z',
    });
    const atInstant = evaluate({
      component: gpl, depKind: 'transitive', purpose: null,
      at: EXCEPTION_EXPIRES, rules,
      exceptions: listExceptionsShim(db, EXCEPTION_EXPIRES),
    });
    expect(atInstant.verdict).toBe('deny');
    // one millisecond before expiry it is still active
    const before = new Date(new Date(EXCEPTION_EXPIRES).getTime() - 1).toISOString();
    const decBefore = evaluate({
      component: gpl, depKind: 'transitive', purpose: null, at: before,
      rules, exceptions: listExceptionsShim(db, before),
    });
    expect(decBefore.verdict).toBe('allow');
  });

  it('exception does not match the same name with a different purl', () => {
    const db = freshDb();
    importBom(db, fixtures.BOM_SAMENAME);
    const maven = listAllComponents(db).find(
      (c) => c.purl === 'pkg:maven/com.vendor/widget@2.0.0',
    )!;
    upsertException(db, {
      componentPurl: 'pkg:npm/widget', componentVersion: '1.0.0', policyVersion: 1,
      purpose: null, reason: 'npm only', approver: 'legal',
      expiresAt: '2027-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
    });
    const dec = evaluate({
      component: maven, depKind: 'direct', purpose: null, at: CLOCK_NOW,
      rules: rulesAtTime(db, CLOCK_NOW).rules,
      exceptions: listExceptionsShim(db, CLOCK_NOW),
    });
    expect(dec.verdict).toBe('deny');
  });
});

// local re-export to keep imports short
import { listExceptions as listExceptionsShim } from '../server/repo.ts';
function listAllComponents(db: ReturnType<typeof freshDb>) {
  const ids = db.raw.prepare('SELECT id FROM imports').all() as { id: number }[];
  return ids.flatMap((i) => listComponents(db, i.id));
}

describe('freeze, quarantine gate and snapshot immutability', () => {
  it('refuses to freeze while quarantine entries are open', () => {
    const db = freshDb();
    const { row } = importBom(db, fixtures.BOM_QUARANTINE);
    const cand = makeCandidate(db, {
      importId: row.id, name: 'blocked', purpose: null,
      rootPurl: 'pkg:internal/shipping-svc@0.3.1', createdAt: CLOCK_NOW,
    });
    expect(() => freezeCandidate(db, cand.id, CLOCK_NOW)).toThrow(QuarantineBlockingError);
  });

  it('freezes graph+decisions and later policy changes do not alter the snapshot', () => {
    const db = freshDb();
    seedDemo(db);
    const before = buildCandidateView(db, 1, '2026-03-01T00:00:00Z');
    expect(before.frozen).toBe(true);
    // candidate #1 was frozen before the exception existed: stays denied
    const gplDec = before.decisions.find(
      (d) => d.purl === 'pkg:maven/com.example/readline-gpl@1.3.0',
    )!;
    expect(gplDec.verdict).toBe('deny');
    expect(gplDec.exception).toBeNull();
  });

  it('preset demo: expired-frozen candidate differs from new draft at the same clock', () => {
    const db = freshDb();
    seedDemo(db);
    // frozen while exception active
    const frozenSnap = buildCandidateView(db, 2, CLOCK_NOW);
    const frozenGpl = frozenSnap.decisions.find(
      (d) => d.purl === 'pkg:maven/com.example/readline-gpl@1.3.0',
    )!;
    expect(frozenGpl.verdict).toBe('allow');
    expect(frozenGpl.exception).not.toBeNull();
    // new draft evaluated now: exception has expired -> deny again
    const draftNow = buildCandidateView(db, 3, CLOCK_NOW);
    const draftGpl = draftNow.decisions.find(
      (d) => d.purl === 'pkg:maven/com.example/readline-gpl@1.3.0',
    )!;
    expect(draftGpl.verdict).toBe('deny');
    expect(draftGpl.exception).toBeNull();
  });

  it('export contains decisions, paths and evidence refs but never component properties', () => {
    const db = freshDb();
    seedDemo(db);
    const bundle = exportCandidate(db, 1, CLOCK_NOW) as unknown as Record<string, unknown>;
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('s3cr3t');
    expect(serialized).not.toContain('registry-token');
    expect(serialized).not.toContain('"properties"');
    expect(Array.isArray(bundle.decisions)).toBe(true);
    expect(Array.isArray(bundle.flaggedPaths)).toBe(true);
    expect(Array.isArray(bundle.evidenceRefs)).toBe(true);
  });
});

void listPolicyRules;
