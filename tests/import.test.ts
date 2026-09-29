import { describe, expect, it } from 'vitest';
import { testDb, bomJson, comp } from './helpers.ts';
import { importBom } from '../src/importer.ts';
import { HttpError } from '../src/errors.ts';

describe('CycloneDX 导入', () => {
  it('相同幂等键相同内容返回原结果，不同内容冲突', () => {
    const db = testDb();
    const raw = bomJson([comp('a', 'pkg:npm/a@1.0.0', 'MIT')], [
      { ref: 'root', dependsOn: ['a'] },
    ]);
    const first = importBom(db, raw, 'key-1');
    expect(first.replayed).toBe(false);
    const second = importBom(db, raw, 'key-1');
    expect(second.replayed).toBe(true);
    expect(second.import_id).toBe(first.import_id);

    const other = bomJson([comp('b', 'pkg:npm/b@1.0.0', 'MIT')], [
      { ref: 'root', dependsOn: ['b'] },
    ]);
    expect(() => importBom(db, other, 'key-1')).toThrowError(HttpError);
    try {
      importBom(db, other, 'key-1');
    } catch (err) {
      expect((err as HttpError).status).toBe(409);
    }
  });

  it('格式错误的组件进入隔离，合法组件正常入库', () => {
    const db = testDb();
    const raw = bomJson(
      [
        comp('good', 'pkg:npm/good@1.0.0', 'MIT'),
        { 'bom-ref': 'bad', name: 'bad-lib', version: '1.0.0' }, // 缺 purl
      ],
      [{ ref: 'root', dependsOn: ['good', 'bad'] }],
    );
    const result = importBom(db, raw, 'key-q');
    expect(result.components).toBe(2); // root + good
    expect(result.quarantined).toBe(1);
    const q = db.prepare('SELECT * FROM quarantine WHERE import_id = ?').all(result.import_id);
    expect(q).toHaveLength(1);
    const good = db
      .prepare("SELECT * FROM components WHERE import_id = ? AND bom_ref = 'good'")
      .get(result.import_id) as { purl: string; evidence_source: string };
    expect(good.purl).toBe('pkg:npm/good@1.0.0');
    expect(good.evidence_source).toBe('vendor/good');
  });

  it('写组件与边之间失败时整个导入回滚，不留半张图', () => {
    const db = testDb();
    const raw = bomJson(
      [comp('a', 'pkg:npm/a@1.0.0', 'MIT')],
      [{ ref: 'root', dependsOn: ['a', 'ghost'] }], // ghost 不存在 -> 边阶段失败
    );
    expect(() => importBom(db, raw, 'key-r')).toThrowError(/未知组件 ref/);
    const counts = {
      imports: db.prepare('SELECT COUNT(*) AS n FROM imports').get() as { n: number },
      components: db.prepare('SELECT COUNT(*) AS n FROM components').get() as { n: number },
      edges: db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number },
    };
    expect(counts.imports.n).toBe(0);
    expect(counts.components.n).toBe(0);
    expect(counts.edges.n).toBe(0);
  });
});
