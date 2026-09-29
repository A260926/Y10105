import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import { HttpError } from './errors.ts';

export interface ExceptionInput {
  component_purl: string;
  component_version: string;
  policy_version: string;
  usage: string;
  reason: string;
  approver: string;
  expires_at: string;
}

export function createException(db: Db, input: ExceptionInput): { id: number; version: number } {
  for (const key of [
    'component_purl',
    'component_version',
    'policy_version',
    'usage',
    'reason',
    'approver',
    'expires_at',
  ] as const) {
    if (typeof input[key] !== 'string' || input[key] === '') {
      throw new HttpError(400, `缺少字段: ${key}`);
    }
  }
  const now = nowIso();
  const id = Number(
    db
      .prepare(
        `INSERT INTO exceptions
           (component_purl, component_version, policy_version, usage, reason, approver, expires_at,
            status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', 1, ?, ?)`,
      )
      .run(
        input.component_purl,
        input.component_version,
        input.policy_version,
        input.usage,
        input.reason,
        input.approver,
        input.expires_at,
        now,
        now,
      ).lastInsertRowid,
  );
  return { id, version: 1 };
}

// 乐观并发：客户端必须携带读到的 version；不匹配说明有人先改了，返回 409。
export function updateException(
  db: Db,
  id: number,
  expectedVersion: number,
  patch: Partial<ExceptionInput> & { status?: 'approved' | 'revoked' },
): { id: number; version: number } {
  const current = db.prepare('SELECT * FROM exceptions WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!current) throw new HttpError(404, '例外不存在');

  const next = {
    component_purl: patch.component_purl ?? (current.component_purl as string),
    component_version: patch.component_version ?? (current.component_version as string),
    policy_version: patch.policy_version ?? (current.policy_version as string),
    usage: patch.usage ?? (current.usage as string),
    reason: patch.reason ?? (current.reason as string),
    approver: patch.approver ?? (current.approver as string),
    expires_at: patch.expires_at ?? (current.expires_at as string),
    status: patch.status ?? (current.status as string),
  };
  const result = db
    .prepare(
      `UPDATE exceptions SET
         component_purl = ?, component_version = ?, policy_version = ?, usage = ?,
         reason = ?, approver = ?, expires_at = ?, status = ?,
         version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .run(
      next.component_purl,
      next.component_version,
      next.policy_version,
      next.usage,
      next.reason,
      next.approver,
      next.expires_at,
      next.status,
      nowIso(),
      id,
      expectedVersion,
    );
  if (Number(result.changes) === 0) {
    throw new HttpError(409, '版本冲突：该例外已被其他人修改，请刷新后重试');
  }
  return { id, version: expectedVersion + 1 };
}

// 到期状态由查询时钟推导，不做后台改写。
export function exceptionStatusAt(
  db: Db,
  id: number,
  clock: string,
): { id: number; state: 'active' | 'expired' | 'revoked'; expires_at: string } {
  const row = db
    .prepare('SELECT id, status, expires_at FROM exceptions WHERE id = ?')
    .get(id) as { id: number; status: string; expires_at: string } | undefined;
  if (!row) throw new HttpError(404, '例外不存在');
  const state = row.status === 'revoked' ? 'revoked' : row.expires_at > clock ? 'active' : 'expired';
  return { id: row.id, state, expires_at: row.expires_at };
}
