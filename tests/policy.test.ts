import { describe, expect, it } from 'vitest';
import { testDb, seedPolicies } from './helpers.ts';
import { decideComponent } from '../src/policy.ts';
import { createException } from '../src/exceptions.ts';

const CLOCK = '2026-03-01T00:00:00Z';

describe('政策判定', () => {
  it('例外绑定组件身份：同名不同 purl / 不同版本不生效', () => {
    const db = testDb();
    seedPolicies(db);
    createException(db, {
      component_purl: 'pkg:npm/widget@2.0.5',
      component_version: '2.0.5',
      policy_version: 'v1',
      usage: 'runtime',
      reason: 'r',
      approver: 'a',
      expires_at: '2027-01-01T00:00:00Z',
    });
    const opts = { depKind: 'direct' as const, usage: 'runtime', clock: CLOCK, policyVersion: 'v1' };

    const npmHit = decideComponent(
      db,
      { purl: 'pkg:npm/widget@2.0.5', version: '2.0.5', declared_license: 'LGPL-3.0-only' },
      opts,
    );
    expect(npmHit.decision).toBe('allow_exception');

    // 同名但不同生态（purl 不同）-> 不命中例外
    const mavenMiss = decideComponent(
      db,
      { purl: 'pkg:maven/widget@2.0.5', version: '2.0.5', declared_license: 'LGPL-3.0-only' },
      opts,
    );
    expect(mavenMiss.decision).toBe('needs_exception');

    // 同 purl 前缀但版本不同 -> 不命中例外
    const versionMiss = decideComponent(
      db,
      { purl: 'pkg:npm/widget@2.0.6', version: '2.0.6', declared_license: 'LGPL-3.0-only' },
      opts,
    );
    expect(versionMiss.decision).toBe('needs_exception');
  });

  it('政策可按直接/传递依赖区分', () => {
    const db = testDb();
    db.prepare(
      `INSERT INTO policies (version, license_id, source, dep_kind, usage, effect, effective_from)
       VALUES ('v1', 'MIT', '*', 'direct', '*', 'allow', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO policies (version, license_id, source, dep_kind, usage, effect, effective_from)
       VALUES ('v1', 'MIT', '*', 'transitive', '*', 'deny', '2026-01-01T00:00:00Z')`,
    ).run();
    const c = { purl: 'pkg:npm/x@1.0.0', version: '1.0.0', declared_license: 'MIT' };
    const direct = decideComponent(db, c, {
      depKind: 'direct', usage: 'runtime', clock: CLOCK, policyVersion: 'v1',
    });
    const transitive = decideComponent(db, c, {
      depKind: 'transitive', usage: 'runtime', clock: CLOCK, policyVersion: 'v1',
    });
    expect(direct.decision).toBe('allow');
    expect(transitive.decision).toBe('deny');
  });

  it('政策生效区间之外不生效', () => {
    const db = testDb();
    db.prepare(
      `INSERT INTO policies (version, license_id, source, dep_kind, usage, effect, effective_from, effective_to)
       VALUES ('v1', 'MIT', '*', 'any', '*', 'deny', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
    ).run();
    const c = { purl: 'pkg:npm/x@1.0.0', version: '1.0.0', declared_license: 'MIT' };
    const inside = decideComponent(db, c, {
      depKind: 'direct', usage: 'runtime', clock: '2026-01-15T00:00:00Z', policyVersion: 'v1',
    });
    const outside = decideComponent(db, c, {
      depKind: 'direct', usage: 'runtime', clock: CLOCK, policyVersion: 'v1',
    });
    expect(inside.decision).toBe('deny');
    expect(outside.decision).toBe('unknown');
  });
});
