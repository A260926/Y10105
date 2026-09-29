import { describe, expect, it } from 'vitest';
import { testDb, seedPolicies, bomJson, comp } from './helpers.ts';
import { importBom, resolveQuarantine } from '../src/importer.ts';
import { createCandidate, freezeCandidate, getCandidateView, traceToRoots, exportCandidate } from '../src/candidates.ts';
import { createException } from '../src/exceptions.ts';
import { HttpError } from '../src/errors.ts';

function fixture(db: ReturnType<typeof testDb>) {
  seedPolicies(db);
  const raw = bomJson(
    [
      comp('mid', 'pkg:npm/mid@1.0.0', 'MIT'),
      comp('gpl', 'pkg:npm/gpl-lib@3.0.0', 'GPL-3.0-only'),
      comp('lgpl', 'pkg:npm/lgpl-lib@2.0.0', 'LGPL-3.0-only'),
    ],
    [
      { ref: 'root', dependsOn: ['mid', 'lgpl'] },
      { ref: 'mid', dependsOn: ['gpl'] },
    ],
  );
  return importBom(db, raw, 'fixture');
}

describe('发布候选', () => {
  it('传递依赖路径可从被拒组件追到根', () => {
    const db = testDb();
    const imp = fixture(db);
    const cand = createCandidate(db, { import_id: imp.import_id, name: 'rc-1', usage: 'runtime' });
    freezeCandidate(db, cand.id, '2026-03-01T00:00:00Z');
    const view = getCandidateView(db, cand.id);
    const gpl = view.components.find((c) => c.bom_ref === 'gpl')!;
    expect(gpl.decision).toBe('deny');
    expect(gpl.dep_kind).toBe('transitive');
    const paths = traceToRoots(view.edges, view.root_ref, 'gpl');
    expect(paths).toEqual([['root', 'mid', 'gpl']]);
  });

  it('隔离未处理不能冻结，处理后可冻结', () => {
    const db = testDb();
    seedPolicies(db);
    const raw = bomJson(
      [comp('ok', 'pkg:npm/ok@1.0.0', 'MIT'), { 'bom-ref': 'bad', name: 'bad', version: '1' }],
      [{ ref: 'root', dependsOn: ['ok'] }],
    );
    const imp = importBom(db, raw, 'q-fixture');
    const cand = createCandidate(db, { import_id: imp.import_id, name: 'rc-q', usage: 'runtime' });
    try {
      freezeCandidate(db, cand.id);
      expect.unreachable();
    } catch (err) {
      expect((err as HttpError).status).toBe(409);
    }
    const q = db.prepare('SELECT id FROM quarantine WHERE import_id = ?').get(imp.import_id) as {
      id: number;
    };
    resolveQuarantine(db, q.id, '确认丢弃');
    const view = freezeCandidate(db, cand.id, '2026-03-01T00:00:00Z');
    expect(view.status).toBe('frozen');
  });

  it('冻结保存快照：之后政策/例外变化只影响新候选', () => {
    const db = testDb();
    const imp = fixture(db);
    createException(db, {
      component_purl: 'pkg:npm/lgpl-lib@2.0.0',
      component_version: '2.0.0',
      policy_version: 'v1',
      usage: 'runtime',
      reason: 'r',
      approver: 'a',
      expires_at: '2027-01-01T00:00:00Z',
    });
    const oldCand = createCandidate(db, { import_id: imp.import_id, name: 'rc-old', usage: 'runtime' });
    freezeCandidate(db, oldCand.id, '2026-03-01T00:00:00Z');

    // 冻结后撤销例外
    db.prepare("UPDATE exceptions SET status = 'revoked'").run();

    const frozen = getCandidateView(db, oldCand.id);
    expect(frozen.components.find((c) => c.bom_ref === 'lgpl')!.decision).toBe('allow_exception');

    const newCand = createCandidate(db, { import_id: imp.import_id, name: 'rc-new', usage: 'runtime' });
    const live = getCandidateView(db, newCand.id, '2026-03-02T00:00:00Z');
    expect(live.components.find((c) => c.bom_ref === 'lgpl')!.decision).toBe('needs_exception');
  });

  it('例外到期时刻决定新旧结论（时钟推导，不改历史）', () => {
    const db = testDb();
    const imp = fixture(db);
    createException(db, {
      component_purl: 'pkg:npm/lgpl-lib@2.0.0',
      component_version: '2.0.0',
      policy_version: 'v1',
      usage: 'runtime',
      reason: 'r',
      approver: 'a',
      expires_at: '2026-06-01T00:00:00Z',
    });
    const before = createCandidate(db, { import_id: imp.import_id, name: 'rc-before', usage: 'runtime' });
    freezeCandidate(db, before.id, '2026-05-15T00:00:00Z');
    const after = createCandidate(db, { import_id: imp.import_id, name: 'rc-after', usage: 'runtime' });
    freezeCandidate(db, after.id, '2026-09-01T00:00:00Z');

    expect(
      getCandidateView(db, before.id).components.find((c) => c.bom_ref === 'lgpl')!.decision,
    ).toBe('allow_exception');
    expect(
      getCandidateView(db, after.id).components.find((c) => c.bom_ref === 'lgpl')!.decision,
    ).toBe('needs_exception');
  });

  it('导出不包含组件 properties 等可能含秘密的原文', () => {
    const db = testDb();
    seedPolicies(db);
    const raw = bomJson(
      [
        {
          ...comp('a', 'pkg:npm/a@1.0.0', 'MIT'),
          properties: [{ name: 'internal:token', value: 'SUPER-SECRET-VALUE' }],
        },
      ],
      [{ ref: 'root', dependsOn: ['a'] }],
    );
    const imp = importBom(db, raw, 'secret-fixture');
    const cand = createCandidate(db, { import_id: imp.import_id, name: 'rc-s', usage: 'runtime' });
    freezeCandidate(db, cand.id, '2026-03-01T00:00:00Z');
    const exported = JSON.stringify(exportCandidate(db, cand.id));
    expect(exported).not.toContain('SUPER-SECRET-VALUE');
    expect(exported).not.toContain('properties');
    expect(exported).toContain('pkg:npm/a@1.0.0');
    expect(exported).toContain('vendor/a'); // 证据引用保留
  });
});
