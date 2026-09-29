import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { testDb, seedPolicies } from './helpers.ts';
import { createApp } from '../src/server.ts';
import { createException } from '../src/exceptions.ts';
import type { Db } from '../src/db.ts';

let db: Db;
let server: Server;
let base: string;

beforeEach(async () => {
  db = testDb();
  seedPolicies(db);
  server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function makeException() {
  return createException(db, {
    component_purl: 'pkg:npm/lgpl-lib@2.0.0',
    component_version: '2.0.0',
    policy_version: 'v1',
    usage: 'runtime',
    reason: 'r',
    approver: 'a',
    expires_at: '2026-06-01T00:00:00Z',
  });
}

describe('HTTP 接口', () => {
  it('例外到期状态端点按查询时钟推导', async () => {
    const { id } = makeException();
    const before = await fetch(`${base}/api/exceptions/${id}/status?at=2026-05-01T00:00:00Z`);
    expect((await before.json()).state).toBe('active');
    const after = await fetch(`${base}/api/exceptions/${id}/status?at=2026-07-01T00:00:00Z`);
    expect((await after.json()).state).toBe('expired');
    // 数据库中的到期时刻不被查询改写
    const row = db.prepare('SELECT expires_at, status FROM exceptions WHERE id = ?').get(id) as {
      expires_at: string;
      status: string;
    };
    expect(row.expires_at).toBe('2026-06-01T00:00:00Z');
    expect(row.status).toBe('approved');
  });

  it('两个用户同时处理同一例外产生版本冲突', async () => {
    const { id, version } = makeException();
    const put = (v: number, note: string) =>
      fetch(`${base}/api/exceptions/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: v, reason: note }),
      });
    const [first, second] = await Promise.all([put(version, '用户A'), put(version, '用户B')]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const row = db.prepare('SELECT reason, version FROM exceptions WHERE id = ?').get(id) as {
      reason: string;
      version: number;
    };
    expect(row.version).toBe(2);
  });

  it('页面包含“依赖许可例外台”', async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(html).toContain('依赖许可例外台');
  });
});
