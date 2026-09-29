// Repository: persistence operations over node:sqlite.

import type { DB } from './db.ts';
import type {
  BomSummary,
  Component,
  Edge,
  ExceptionRecord,
  PolicyRule,
} from '../src/shared/types.ts';
import type { ParseResult } from './cdx.ts';

export interface ImportRow {
  id: number;
  importKey: string;
  contentHash: string;
  createdAt: string;
  summary: BomSummary;
  warnings: string[];
}

export class IdempotencyConflict extends Error {
  constructor(public existingId: number, public existingHash: string) {
    super('import key already used with different content');
  }
}

interface ImportDeps {
  parseResult: ParseResult;
  importKey: string;
  createdAt: string;
}

export function persistImport(db: DB, deps: ImportDeps): ImportRow {
  const { imported, warnings } = deps.parseResult;
  return db.tx(() => {
    const existing = db.raw
      .prepare('SELECT id, content_hash FROM imports WHERE import_key = ?')
      .get(deps.importKey) as { id: number; content_hash: string } | undefined;

    if (existing) {
      if (existing.content_hash !== imported.summary.contentHash) {
        throw new IdempotencyConflict(existing.id, existing.content_hash);
      }
      return loadImportRow(db, existing.id);
    }

    const ins = db.raw.prepare(
      `INSERT INTO imports (import_key, content_hash, created_at, summary, warnings)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const info = ins.run(
      deps.importKey,
      imported.summary.contentHash,
      deps.createdAt,
      JSON.stringify(imported.summary),
      JSON.stringify(warnings),
    );
    const importId = Number(info.lastInsertRowid);

    const compStmt = db.raw.prepare(
      `INSERT INTO components
        (import_id, bom_ref, name, version, purl, declared_licenses,
         declared_license_raw, origin, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of imported.components) {
      compStmt.run(
        importId,
        c.bomRef,
        c.name,
        c.version,
        c.purl,
        JSON.stringify(c.declaredLicenses),
        JSON.stringify(c.declaredLicenseRaw),
        c.origin,
        JSON.stringify(c.evidence),
      );
    }

    const edgeStmt = db.raw.prepare(
      'INSERT INTO edges (import_id, parent_ref, child_ref) VALUES (?, ?, ?)',
    );
    for (const e of imported.edges) {
      edgeStmt.run(importId, e.parentRef, e.childRef);
    }

    const qStmt = db.raw.prepare(
      `INSERT INTO quarantine (import_id, ref, name, reason, raw)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const q of imported.quarantined) {
      qStmt.run(importId, q.ref, q.name, q.reason, JSON.stringify(q.raw));
    }
    return loadImportRow(db, importId);
  });
}

function parseImportRow(r: Record<string, unknown>): ImportRow {
  return {
    id: Number(r.id),
    importKey: String(r.import_key),
    contentHash: String(r.content_hash),
    createdAt: String(r.created_at),
    summary: JSON.parse(String(r.summary)) as BomSummary,
    warnings: JSON.parse(String(r.warnings)) as string[],
  };
}

export function loadImportRow(db: DB, importId: number): ImportRow {
  const row = db.raw.prepare('SELECT * FROM imports WHERE id = ?').get(importId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`import ${importId} not found`);
  return parseImportRow(row);
}

export function findImportByKey(db: DB, key: string): ImportRow | null {
  const row = db.raw
    .prepare('SELECT * FROM imports WHERE import_key = ?')
    .get(key) as Record<string, unknown> | undefined;
  return row ? parseImportRow(row) : null;
}

export function listComponents(db: DB, importId: number): Component[] {
  const rows = db.raw
    .prepare('SELECT * FROM components WHERE import_id = ?')
    .all(importId) as Record<string, unknown>[];
  return rows.map((r) => ({
    bomRef: String(r.bom_ref),
    name: String(r.name),
    version: (r.version as string | null) ?? null,
    purl: String(r.purl),
    declaredLicenses: JSON.parse(String(r.declared_licenses)) as string[],
    declaredLicenseRaw: JSON.parse(String(r.declared_license_raw)) as string[],
    origin: r.origin === 'internal' ? 'internal' : 'external',
    evidence: JSON.parse(String(r.evidence)) as Component['evidence'],
  }));
}

export function listEdges(db: DB, importId: number): Edge[] {
  const rows = db.raw
    .prepare('SELECT parent_ref, child_ref FROM edges WHERE import_id = ?')
    .all(importId) as Record<string, unknown>[];
  return rows.map((r) => ({
    parentRef: String(r.parent_ref),
    childRef: String(r.child_ref),
  }));
}

export interface QuarantineRow {
  id: number;
  importId: number;
  ref: string;
  name: string | null;
  reason: string;
  raw: unknown;
  status: 'open' | 'resolved' | 'rejected';
  resolution: string | null;
}

export function listQuarantine(db: DB): QuarantineRow[] {
  const rows = db.raw
    .prepare('SELECT * FROM quarantine ORDER BY id')
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    importId: Number(r.import_id),
    ref: String(r.ref),
    name: (r.name as string | null) ?? null,
    reason: String(r.reason),
    raw: JSON.parse(String(r.raw)),
    status: String(r.status) as QuarantineRow['status'],
    resolution: (r.resolution as string | null) ?? null,
  }));
}

export function resolveQuarantine(
  db: DB,
  id: number,
  resolution: 'resolved' | 'rejected',
  note: string,
  now: string,
): void {
  db.tx(() => {
    const info = db.raw
      .prepare(
        `UPDATE quarantine SET status = ?, resolution = ?, resolved_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(resolution, note, now, id);
    if (Number(info.changes) === 0) throw new Error(`quarantine ${id} not open`);
  });
}

export function openQuarantineCount(db: DB): number {
  const row = db.raw
    .prepare(
      `SELECT COUNT(*) AS n FROM quarantine
        WHERE status = 'open' AND import_id IN (SELECT import_id FROM candidates WHERE status='draft')`,
    )
    .get() as { n: number };
  return Number(row.n);
}

export function openQuarantineForImport(db: DB, importId: number): number {
  const row = db.raw
    .prepare(
      `SELECT COUNT(*) AS n FROM quarantine WHERE import_id = ? AND status = 'open'`,
    )
    .get(importId) as { n: number };
  return Number(row.n);
}

// ---- policies -------------------------------------------------------------

export function activePolicyVersion(db: DB, at: string): number {
  const row = db.raw
    .prepare('SELECT MAX(policy_version) AS v FROM policies WHERE effective_from <= ?')
    .get(at) as { v: number | null };
  return row.v ?? 0;
}

export function listPolicyRules(db: DB, version?: number): PolicyRule[] {
  const rows = (
    version == null
      ? db.raw.prepare('SELECT * FROM policies ORDER BY policy_version, priority').all()
      : db.raw
          .prepare('SELECT * FROM policies WHERE policy_version = ? ORDER BY priority')
          .all(version)
  ) as Record<string, unknown>[];
  return rows.map(mapPolicy);
}

function mapPolicy(r: Record<string, unknown>): PolicyRule {
  return {
    id: String(r.rule_id),
    policyVersion: Number(r.policy_version),
    licenseExpression: String(r.license_expression),
    origin: String(r.origin) as PolicyRule['origin'],
    depKind: (r.dep_kind as PolicyRule['depKind']) ?? null,
    purpose: (r.purpose as string | null) ?? null,
    effect: String(r.effect) as PolicyRule['effect'],
    priority: Number(r.priority),
    effectiveFrom: (r.effective_from as string | null) ?? null,
    effectiveTo: (r.effective_to as string | null) ?? null,
  };
}

export function insertPolicy(db: DB, rule: PolicyRule): void {
  db.raw
    .prepare(
      `INSERT INTO policies
        (rule_id, policy_version, license_expression, origin, dep_kind, purpose,
         effect, priority, effective_from, effective_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(rule_id, policy_version) DO UPDATE SET
         license_expression=excluded.license_expression,
         origin=excluded.origin, dep_kind=excluded.dep_kind,
         purpose=excluded.purpose, effect=excluded.effect,
         priority=excluded.priority, effective_from=excluded.effective_from,
         effective_to=excluded.effective_to`,
    )
    .run(
      rule.id,
      rule.policyVersion,
      rule.licenseExpression,
      rule.origin,
      rule.depKind,
      rule.purpose,
      rule.effect,
      rule.priority,
      rule.effectiveFrom,
      rule.effectiveTo,
    );
}

// ---- exceptions (optimistic concurrency) ----------------------------------

export class ConcurrencyConflict extends Error {}
export class NotFound extends Error {}

function mapException(r: Record<string, unknown>): ExceptionRecord {
  return {
    id: Number(r.id),
    componentPurl: String(r.component_purl),
    componentVersion: (r.component_version as string | null) ?? null,
    policyVersion: Number(r.policy_version),
    purpose: (r.purpose as string | null) ?? null,
    reason: String(r.reason),
    approver: String(r.approver),
    expiresAt: String(r.expires_at),
    createdAt: String(r.created_at),
    rowVersion: Number(r.row_version),
    status: 'active',
  };
}

export interface NewException {
  componentPurl: string;
  componentVersion: string | null;
  policyVersion: number;
  purpose: string | null;
  reason: string;
  approver: string;
  expiresAt: string;
  createdAt: string;
}

export function upsertException(db: DB, input: NewException): ExceptionRecord {
  return db.tx(() => {
    const info = db.raw
      .prepare(
        `INSERT INTO exceptions
          (component_purl, component_version, policy_version, purpose, reason,
           approver, expires_at, created_at, row_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(component_purl, component_version, purpose) DO UPDATE SET
           policy_version=excluded.policy_version,
           reason=excluded.reason,
           approver=excluded.approver,
           expires_at=excluded.expires_at,
           row_version=exceptions.row_version + 1
         RETURNING *`,
      )
      .run(
        input.componentPurl,
        input.componentVersion,
        input.policyVersion,
        input.purpose,
        input.reason,
        input.approver,
        input.expiresAt,
        input.createdAt,
      );
    const row =
      info.lastInsertRowid != null && Number(info.lastInsertRowid) > 0
        ? (db.raw.prepare('SELECT * FROM exceptions WHERE id = ?').get(
            Number(info.lastInsertRowid),
          ) as Record<string, unknown>)
        : null;
    if (row) return mapException(row);
    const found = db.raw
      .prepare(
        'SELECT * FROM exceptions WHERE component_purl = ? AND IFNULL(component_version,?) IS ? AND IFNULL(purpose,?) IS ?',
      )
      .get(
        input.componentPurl,
        input.componentVersion,
        input.componentVersion,
        input.purpose,
        input.purpose,
      ) as Record<string, unknown> | undefined;
    return mapException(found!);
  });
}

export function listExceptions(db: DB, nowIso: string): ExceptionRecord[] {
  const rows = db.raw
    .prepare('SELECT * FROM exceptions ORDER BY id')
    .all() as Record<string, unknown>[];
  return rows.map((r) => {
    const e = mapException(r);
    e.status = new Date(e.expiresAt).getTime() > new Date(nowIso).getTime()
      ? 'active'
      : 'expired';
    return e;
  });
}

export interface ExceptionPatch {
  id: number;
  expectedRowVersion: number;
  reason?: string;
  approver?: string;
  expiresAt?: string;
}

/** Optimistic update: fails if another writer already bumped row_version. */
export function updateException(db: DB, patch: ExceptionPatch): ExceptionRecord {
  return db.tx(() => {
    const current = db.raw
      .prepare('SELECT * FROM exceptions WHERE id = ?')
      .get(patch.id) as Record<string, unknown> | undefined;
    if (!current) throw new NotFound(`exception ${patch.id} not found`);
    if (Number(current.row_version) !== patch.expectedRowVersion) {
      throw new ConcurrencyConflict(
        `exception ${patch.id} was modified concurrently (expected v${patch.expectedRowVersion}, found v${current.row_version})`,
      );
    }
    db.raw
      .prepare(
        `UPDATE exceptions SET
           reason = COALESCE(?, reason),
           approver = COALESCE(?, approver),
           expires_at = COALESCE(?, expires_at),
           row_version = row_version + 1
         WHERE id = ?`,
      )
      .run(patch.reason ?? null, patch.approver ?? null, patch.expiresAt ?? null, patch.id);
    return mapException(
      db.raw.prepare('SELECT * FROM exceptions WHERE id = ?').get(patch.id) as Record<
        string,
        unknown
      >,
    );
  });
}

// ---- candidates -----------------------------------------------------------

export interface CandidateRow {
  id: number;
  importId: number;
  name: string;
  purpose: string | null;
  rootPurl: string;
  status: 'draft' | 'frozen';
  clockAt: string | null;
  policyVersion: number | null;
  overallVerdict: string | null;
  createdAt: string;
  frozenAt: string | null;
}

function mapCandidate(r: Record<string, unknown>): CandidateRow {
  return {
    id: Number(r.id),
    importId: Number(r.import_id),
    name: String(r.name),
    purpose: (r.purpose as string | null) ?? null,
    rootPurl: String(r.root_purl),
    status: String(r.status) as CandidateRow['status'],
    clockAt: (r.clock_at as string | null) ?? null,
    policyVersion: r.policy_version == null ? null : Number(r.policy_version),
    overallVerdict: (r.overall_verdict as string | null) ?? null,
    createdAt: String(r.created_at),
    frozenAt: (r.frozen_at as string | null) ?? null,
  };
}

export function createCandidate(
  db: DB,
  input: { importId: number; name: string; purpose: string | null; rootPurl: string; createdAt: string },
): CandidateRow {
  const info = db.raw
    .prepare(
      `INSERT INTO candidates (import_id, name, purpose, root_purl, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.importId, input.name, input.purpose, input.rootPurl, input.createdAt);
  return getCandidate(db, Number(info.lastInsertRowid));
}

export function getCandidate(db: DB, id: number): CandidateRow {
  const row = db.raw.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new NotFound(`candidate ${id} not found`);
  return mapCandidate(row);
}

export function listCandidates(db: DB): CandidateRow[] {
  const rows = db.raw
    .prepare('SELECT * FROM candidates ORDER BY id')
    .all() as Record<string, unknown>[];
  return rows.map(mapCandidate);
}

export interface FrozenGraph {
  components: Component[];
  edges: Edge[];
  rootRefs: string[];
}

export function saveFrozenGraph(db: DB, candidateId: number, graph: FrozenGraph): void {
  db.raw
    .prepare(
      `INSERT INTO candidate_graph (candidate_id, components, edges, root_refs)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      candidateId,
      JSON.stringify(graph.components),
      JSON.stringify(graph.edges),
      JSON.stringify(graph.rootRefs),
    );
}

export function loadFrozenGraph(db: DB, candidateId: number): FrozenGraph {
  const row = db.raw
    .prepare('SELECT * FROM candidate_graph WHERE candidate_id = ?')
    .get(candidateId) as Record<string, unknown> | undefined;
  if (!row) throw new NotFound(`frozen graph for candidate ${candidateId} not found`);
  return {
    components: JSON.parse(String(row.components)) as Component[],
    edges: JSON.parse(String(row.edges)) as Edge[],
    rootRefs: JSON.parse(String(row.root_refs)) as string[],
  };
}

export function saveDecisions(
  db: DB,
  candidateId: number,
  decisions: import('../src/shared/types.ts').Decision[],
): void {
  const stmt = db.raw.prepare(
    `INSERT INTO candidate_decisions
      (candidate_id, purl, version, dep_kind, verdict, policy_rule_id,
       policy_version, effect, exception_id, reason, detail, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of decisions) {
    stmt.run(
      candidateId,
      d.purl,
      d.version,
      d.depKind,
      d.verdict,
      d.policyHit?.ruleId ?? null,
      d.policyHit?.policyVersion ?? null,
      d.policyHit?.effect ?? null,
      d.exception?.id ?? null,
      d.exception?.reason ?? null,
      d.detail,
      d.at,
    );
  }
}

export type StoredDecision = import('../src/shared/types.ts').Decision;

export function loadDecisions(db: DB, candidateId: number): StoredDecision[] {
  const rows = db.raw
    .prepare(
      `SELECT d.*, e.approver AS ex_approver, e.expires_at AS ex_expires
       FROM candidate_decisions d
       LEFT JOIN exceptions e ON e.id = d.exception_id
       WHERE d.candidate_id = ? ORDER BY d.id`,
    )
    .all(candidateId) as Record<string, unknown>[];
  return rows.map((r) => ({
    purl: String(r.purl),
    version: (r.version as string | null) ?? null,
    verdict: String(r.verdict) as import('../src/shared/types.ts').Verdict,
    depKind: String(r.dep_kind) as 'direct' | 'transitive',
    purpose: null,
    at: String(r.at),
    detail: String(r.detail),
    policyHit: r.policy_rule_id
      ? {
          ruleId: String(r.policy_rule_id),
          policyVersion: Number(r.policy_version),
          effect: String(r.effect) as import('../src/shared/types.ts').PolicyEffect,
        }
      : null,
    exception: r.exception_id
      ? {
          id: Number(r.exception_id),
          policyVersion: Number(r.policy_version ?? 0),
          reason: String(r.reason ?? ''),
          approver: String(r.ex_approver ?? ''),
          expiresAt: String(r.ex_expires ?? ''),
        }
      : null,
  }));
}

export function finalizeFreeze(
  db: DB,
  candidateId: number,
  overallVerdict: string,
  policyVersion: number,
  frozenAt: string,
  clockAt: string,
): void {
  db.raw
    .prepare(
      `UPDATE candidates SET status='frozen', overall_verdict=?, policy_version=?,
         frozen_at=?, clock_at=? WHERE id=? AND status='draft'`,
    )
    .run(overallVerdict, policyVersion, frozenAt, clockAt, candidateId);
}

/**
 * Effective rule set at time `at`: among rules inside their [from,to)
 * window, pick the highest policy_version row per rule_id. The returned
 * set's version is the max policy_version present (used for snapshots and
 * exception binding).
 */
export function rulesAtTime(db: DB, at: string): { version: number; rules: PolicyRule[] } {
  const t = new Date(at).getTime();
  const all = listPolicyRules(db).filter((r) => {
    if (r.effectiveFrom && t < new Date(r.effectiveFrom).getTime()) return false;
    if (r.effectiveTo && t >= new Date(r.effectiveTo).getTime()) return false;
    return true;
  });
  const best = new Map<string, PolicyRule>();
  for (const r of all) {
    const cur = best.get(r.id);
    if (!cur || r.policyVersion > cur.policyVersion) best.set(r.id, r);
  }
  const rules = [...best.values()];
  const version = rules.reduce((m, r) => Math.max(m, r.policyVersion), 0);
  return { version: version || 1, rules };
}
