import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.ts';
import { importBom, resolveQuarantine } from './importer.ts';
import { createException } from './exceptions.ts';
import { createCandidate, freezeCandidate } from './candidates.ts';

const here = dirname(fileURLToPath(import.meta.url));

const POLICIES_V1 = [
  { license_id: 'MIT', effect: 'allow' },
  { license_id: 'Apache-2.0', effect: 'allow' },
  { license_id: 'BSD-3-Clause', effect: 'allow' },
  { license_id: 'GPL-3.0-only', effect: 'deny' },
  { license_id: 'AGPL-3.0-only', effect: 'deny' },
  { license_id: 'LGPL-3.0-only', effect: 'needs_exception' },
] as const;

export function seedIfEmpty(db: Db): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM imports').get() as { n: number };
  if (row.n > 0) return false;

  const insertPolicy = db.prepare(
    `INSERT INTO policies (version, license_id, source, dep_kind, usage, effect, effective_from, effective_to)
     VALUES ('v1', ?, '*', 'any', '*', ?, '2026-01-01T00:00:00Z', NULL)`,
  );
  for (const p of POLICIES_V1) insertPolicy.run(p.license_id, p.effect);

  const raw = readFileSync(join(here, '..', 'fixtures', 'bom.json'), 'utf8');
  const imported = importBom(db, raw, 'fixture-demo-v1');

  // 演示隔离流程：fixture 里有一个缺 purl 的组件，确认丢弃后候选才能冻结。
  const pending = db
    .prepare('SELECT id FROM quarantine WHERE import_id = ? AND resolved = 0')
    .all(imported.import_id) as unknown as { id: number }[];
  for (const q of pending) {
    resolveQuarantine(db, q.id, '缺少 purl，确认不随发布分发，予以丢弃');
  }

  // 例外绑定组件身份（purl + 版本）、政策版本、用途、理由、批准人、到期时刻。
  createException(db, {
    component_purl: 'pkg:npm/lgpl-widget@2.0.5',
    component_version: '2.0.5',
    policy_version: 'v1',
    usage: 'runtime',
    reason: '仅动态链接且不分发修改后的源码，法务确认合规',
    approver: 'compliance-lead@example.com',
    expires_at: '2026-06-01T00:00:00Z',
  });

  // 旧候选：例外仍有效时冻结 -> lgpl-widget 记为 allow_exception。
  const oldCandidate = createCandidate(db, {
    import_id: imported.import_id,
    name: 'rc-2026.05',
    usage: 'runtime',
  });
  freezeCandidate(db, oldCandidate.id, '2026-05-15T00:00:00Z');

  // 新候选：例外到期后冻结 -> 同一组件变为 needs_exception，形成新旧结论差异。
  const newCandidate = createCandidate(db, {
    import_id: imported.import_id,
    name: 'rc-2026.09',
    usage: 'runtime',
  });
  freezeCandidate(db, newCandidate.id, '2026-09-01T00:00:00Z');

  return true;
}
