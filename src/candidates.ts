import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import { HttpError } from './errors.ts';
import { decideComponent, latestPolicyVersion, type DepKind } from './policy.ts';

export interface ComponentView {
  bom_ref: string;
  purl: string;
  name: string;
  version: string;
  declared_license: string | null;
  evidence_source: string | null;
  dep_kind: DepKind;
  decision: string;
  basis: unknown;
}

export interface CandidateView {
  id: number;
  name: string;
  usage: string;
  status: string;
  policy_version: string | null;
  frozen_at: string | null;
  import_id: number;
  root_ref: string;
  components: ComponentView[];
  edges: { from_ref: string; to_ref: string }[];
}

type EdgeRow = { from_ref: string; to_ref: string };

function depKinds(rootRef: string, edges: EdgeRow[]): Map<string, DepKind> {
  const kinds = new Map<string, DepKind>();
  kinds.set(rootRef, 'direct');
  const direct = new Set(edges.filter((e) => e.from_ref === rootRef).map((e) => e.to_ref));
  return new Map([...kinds, ...[...direct].map((r): [string, DepKind] => [r, 'direct'])]);
}

function kindOf(kinds: Map<string, DepKind>, ref: string): DepKind {
  return kinds.get(ref) ?? 'transitive';
}

export function createCandidate(
  db: Db,
  input: { import_id: number; name: string; usage: string },
): { id: number } {
  const imp = db.prepare('SELECT id FROM imports WHERE id = ?').get(input.import_id);
  if (!imp) throw new HttpError(404, '导入批次不存在');
  if (!input.name || !input.usage) throw new HttpError(400, '缺少 name 或 usage');
  const id = Number(
    db
      .prepare(
         `INSERT INTO candidates (import_id, name, usage, status, created_at)
         VALUES (?, ?, ?, 'open', ?)`,
      )
      .run(input.import_id, input.name, input.usage, nowIso()).lastInsertRowid,
  );
  return { id };
}

// 冻结：把完整依赖图与逐项决议快照进候选，之后的政策/例外变化只影响新候选。
export function freezeCandidate(db: Db, candidateId: number, clock?: string): CandidateView {
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId) as
    | {
        id: number;
        import_id: number;
        usage: string;
        status: string;
      }
    | undefined;
  if (!candidate) throw new HttpError(404, '候选不存在');
  if (candidate.status === 'frozen') throw new HttpError(409, '候选已冻结');

  const pending = db
    .prepare(
      'SELECT COUNT(*) AS n FROM quarantine WHERE import_id = ? AND resolved = 0',
    )
    .get(candidate.import_id) as { n: number };
  if (pending.n > 0) {
    throw new HttpError(409, `导入批次还有 ${pending.n} 条隔离组件未处理，不能冻结`);
  }

  const freezeClock = clock ?? nowIso();
  const policyVersion = latestPolicyVersion(db);
  if (!policyVersion) throw new HttpError(409, '尚未配置任何政策，不能冻结');

  const imp = db.prepare('SELECT root_ref FROM imports WHERE id = ?').get(candidate.import_id) as {
    root_ref: string;
  };
  const components = db
    .prepare('SELECT * FROM components WHERE import_id = ? ORDER BY id')
    .all(candidate.import_id) as unknown as {
    bom_ref: string;
    purl: string;
    name: string;
    version: string;
    declared_license: string | null;
    evidence_source: string | null;
  }[];
  const edges = db
    .prepare('SELECT from_ref, to_ref FROM edges WHERE import_id = ?')
    .all(candidate.import_id) as unknown as EdgeRow[];

  const kinds = depKinds(imp.root_ref, edges);

  db.exec('BEGIN');
  try {
    const insertCc = db.prepare(
      `INSERT INTO candidate_components
         (candidate_id, bom_ref, purl, name, version, declared_license, evidence_source, dep_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCe = db.prepare(
      'INSERT INTO candidate_edges (candidate_id, from_ref, to_ref) VALUES (?, ?, ?)',
    );
    const insertRes = db.prepare(
      `INSERT INTO resolutions (candidate_id, bom_ref, decision, basis_type, basis_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const c of components) {
      const depKind = kindOf(kinds, c.bom_ref);
      insertCc.run(
        candidateId,
        c.bom_ref,
        c.purl,
        c.name,
        c.version,
        c.declared_license,
        c.evidence_source,
        depKind,
      );
      const result = decideComponent(db, c, {
        depKind,
        usage: candidate.usage,
        clock: freezeClock,
        policyVersion,
      });
      insertRes.run(
        candidateId,
        c.bom_ref,
        result.decision,
        result.basis.type,
        JSON.stringify(result.basis),
      );
    }
    for (const e of edges) insertCe.run(candidateId, e.from_ref, e.to_ref);
    db.prepare(
      `UPDATE candidates SET status = 'frozen', frozen_at = ?, policy_version = ? WHERE id = ?`,
    ).run(freezeClock, policyVersion, candidateId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getCandidateView(db, candidateId, freezeClock);
}

// 读取候选视图：已冻结读快照；未冻结按查询时钟实时评估。
export function getCandidateView(db: Db, candidateId: number, clock?: string): CandidateView {
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId) as
    | {
        id: number;
        import_id: number;
        name: string;
        usage: string;
        status: string;
        policy_version: string | null;
        frozen_at: string | null;
      }
    | undefined;
  if (!candidate) throw new HttpError(404, '候选不存在');
  const imp = db.prepare('SELECT root_ref FROM imports WHERE id = ?').get(candidate.import_id) as {
    root_ref: string;
  };

  if (candidate.status === 'frozen') {
    const components = db
      .prepare(
        `SELECT cc.bom_ref, cc.purl, cc.name, cc.version, cc.declared_license,
                cc.evidence_source, cc.dep_kind, r.decision, r.basis_json
         FROM candidate_components cc
         JOIN resolutions r ON r.candidate_id = cc.candidate_id AND r.bom_ref = cc.bom_ref
         WHERE cc.candidate_id = ? ORDER BY cc.id`,
      )
      .all(candidateId) as unknown as (Omit<ComponentView, 'basis'> & { basis_json: string })[];
    const edges = db
      .prepare('SELECT from_ref, to_ref FROM candidate_edges WHERE candidate_id = ?')
      .all(candidateId) as unknown as EdgeRow[];
    return {
      id: candidate.id,
      name: candidate.name,
      usage: candidate.usage,
      status: candidate.status,
      policy_version: candidate.policy_version,
      frozen_at: candidate.frozen_at,
      import_id: candidate.import_id,
      root_ref: imp.root_ref,
      components: components.map((c) => ({
        bom_ref: c.bom_ref,
        purl: c.purl,
        name: c.name,
        version: c.version,
        declared_license: c.declared_license,
        evidence_source: c.evidence_source,
        dep_kind: c.dep_kind as DepKind,
        decision: c.decision,
        basis: JSON.parse(c.basis_json),
      })),
      edges,
    };
  }

  const queryClock = clock ?? nowIso();
  const policyVersion = latestPolicyVersion(db);
  const components = db
    .prepare('SELECT * FROM components WHERE import_id = ? ORDER BY id')
    .all(candidate.import_id) as unknown as {
    bom_ref: string;
    purl: string;
    name: string;
    version: string;
    declared_license: string | null;
    evidence_source: string | null;
  }[];
  const edges = db
    .prepare('SELECT from_ref, to_ref FROM edges WHERE import_id = ?')
    .all(candidate.import_id) as unknown as EdgeRow[];
  const kinds = depKinds(imp.root_ref, edges);
  const view: ComponentView[] = components.map((c) => {
    const depKind = kindOf(kinds, c.bom_ref);
    const result = policyVersion
      ? decideComponent(db, c, { depKind, usage: candidate.usage, clock: queryClock, policyVersion })
      : { decision: 'unknown', basis: { type: 'none', license_effects: [], policy_ids: [] } };
    return {
      bom_ref: c.bom_ref,
      purl: c.purl,
      name: c.name,
      version: c.version,
      declared_license: c.declared_license,
      evidence_source: c.evidence_source,
      dep_kind: depKind,
      decision: result.decision,
      basis: result.basis,
    };
  });
  return {
    id: candidate.id,
    name: candidate.name,
    usage: candidate.usage,
    status: candidate.status,
    policy_version: policyVersion,
    frozen_at: null,
    import_id: candidate.import_id,
    root_ref: imp.root_ref,
    components: view,
    edges,
  };
}

// 从组件沿依赖边反向追到根，返回全部简单路径（root -> ... -> 组件）。
export function traceToRoots(
  edges: EdgeRow[],
  rootRef: string,
  targetRef: string,
): string[][] {
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    const list = parents.get(e.to_ref) ?? [];
    list.push(e.from_ref);
    parents.set(e.to_ref, list);
  }
  const paths: string[][] = [];
  const walk = (ref: string, suffix: string[], seen: Set<string>): void => {
    if (ref === rootRef || !parents.has(ref)) {
      paths.push([ref, ...suffix]);
      return;
    }
    if (seen.has(ref)) return; // 环保护
    seen.add(ref);
    for (const parent of parents.get(ref) ?? []) {
      walk(parent, [ref, ...suffix], seen);
    }
    seen.delete(ref);
  };
  walk(targetRef, [], new Set());
  return paths;
}

// 导出：只含候选摘要、依赖路径、决议与证据引用；绝不复制组件 properties。
export function exportCandidate(db: Db, candidateId: number, clock?: string): unknown {
  const view = getCandidateView(db, candidateId, clock);
  const pathsByComponent: Record<string, string[][]> = {};
  for (const c of view.components) {
    if (c.bom_ref === view.root_ref) continue;
    pathsByComponent[c.bom_ref] = traceToRoots(view.edges, view.root_ref, c.bom_ref);
  }
  return {
    candidate: {
      id: view.id,
      name: view.name,
      usage: view.usage,
      status: view.status,
      policy_version: view.policy_version,
      frozen_at: view.frozen_at,
    },
    dependency_paths: pathsByComponent,
    resolutions: view.components.map((c) => ({
      bom_ref: c.bom_ref,
      purl: c.purl,
      version: c.version,
      declared_license: c.declared_license,
      dep_kind: c.dep_kind,
      decision: c.decision,
      basis: c.basis,
      evidence_source: c.evidence_source,
    })),
  };
}
