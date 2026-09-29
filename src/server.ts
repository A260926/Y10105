import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, nowIso, type Db } from './db.ts';
import { HttpError } from './errors.ts';
import { importBom, resolveQuarantine } from './importer.ts';
import { createException, exceptionStatusAt, updateException } from './exceptions.ts';
import {
  createCandidate,
  exportCandidate,
  freezeCandidate,
  getCandidateView,
  traceToRoots,
} from './candidates.ts';
import { seedIfEmpty } from './seed.ts';

const here = dirname(fileURLToPath(import.meta.url));

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 20 * 1024 * 1024) throw new HttpError(413, '请求体过大');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

export function createApp(db: Db) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    try {
      if (path === '/' && method === 'GET') {
        const html = readFileSync(join(here, '..', 'public', 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (path === '/api/imports' && method === 'POST') {
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || key === '') {
          throw new HttpError(400, '缺少 Idempotency-Key 请求头');
        }
        const raw = await readBody(req);
        sendJson(res, 201, importBom(db, raw, key));
        return;
      }
      if (path === '/api/imports' && method === 'GET') {
        sendJson(
          res,
          200,
          db.prepare('SELECT * FROM imports ORDER BY id DESC').all(),
        );
        return;
      }
      let m = /^\/api\/imports\/(\d+)$/.exec(path);
      if (m && method === 'GET') {
        const id = Number(m[1]);
        const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(id);
        if (!imp) throw new HttpError(404, '导入批次不存在');
        sendJson(res, 200, {
          import: imp,
          components: db
            .prepare(
              `SELECT id, bom_ref, purl, name, version, declared_license, evidence_source
               FROM components WHERE import_id = ? ORDER BY id`,
            )
            .all(id),
          edges: db.prepare('SELECT from_ref, to_ref FROM edges WHERE import_id = ?').all(id),
          quarantine: db
            .prepare('SELECT id, bom_ref, reason, resolved, resolution_note FROM quarantine WHERE import_id = ?')
            .all(id),
        });
        return;
      }
      m = /^\/api\/quarantine\/(\d+)\/resolve$/.exec(path);
      if (m && method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}') as { note?: string };
        sendJson(res, 200, resolveQuarantine(db, Number(m[1]), body.note ?? '已处理'));
        return;
      }

      if (path === '/api/policies' && method === 'GET') {
        sendJson(res, 200, db.prepare('SELECT * FROM policies ORDER BY id').all());
        return;
      }
      if (path === '/api/policies' && method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}') as Record<string, string>;
        for (const key of ['version', 'license_id', 'effect', 'effective_from']) {
          if (!body[key]) throw new HttpError(400, `缺少字段: ${key}`);
        }
        const id = Number(
          db
            .prepare(
              `INSERT INTO policies (version, license_id, source, dep_kind, usage, effect, effective_from, effective_to)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              body.version,
              body.license_id,
              body.source ?? '*',
              body.dep_kind ?? 'any',
              body.usage ?? '*',
              body.effect,
              body.effective_from,
              body.effective_to ?? null,
            ).lastInsertRowid,
        );
        sendJson(res, 201, { id });
        return;
      }

      if (path === '/api/exceptions' && method === 'GET') {
        const clock = url.searchParams.get('at') ?? nowIso();
        const rows = db.prepare('SELECT * FROM exceptions ORDER BY id').all() as unknown as {
          id: number;
          status: string;
          expires_at: string;
        }[];
        sendJson(
          res,
          200,
          rows.map((r) => ({ ...r, derived_state: exceptionStatusAt(db, r.id, clock).state })),
        );
        return;
      }
      if (path === '/api/exceptions' && method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        sendJson(res, 201, createException(db, body));
        return;
      }
      m = /^\/api\/exceptions\/(\d+)$/.exec(path);
      if (m && method === 'PUT') {
        const body = JSON.parse(await readBody(req) || '{}') as { version?: number };
        if (typeof body.version !== 'number') {
          throw new HttpError(400, '缺少乐观锁版本号 version');
        }
        const { version, ...patch } = body;
        sendJson(res, 200, updateException(db, Number(m[1]), version, patch));
        return;
      }
      m = /^\/api\/exceptions\/(\d+)\/status$/.exec(path);
      if (m && method === 'GET') {
        const clock = url.searchParams.get('at') ?? nowIso();
        sendJson(res, 200, exceptionStatusAt(db, Number(m[1]), clock));
        return;
      }

      if (path === '/api/candidates' && method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        sendJson(res, 201, createCandidate(db, body));
        return;
      }
      if (path === '/api/candidates' && method === 'GET') {
        sendJson(res, 200, db.prepare('SELECT * FROM candidates ORDER BY id').all());
        return;
      }
      m = /^\/api\/candidates\/(\d+)$/.exec(path);
      if (m && method === 'GET') {
        const clock = url.searchParams.get('at') ?? undefined;
        sendJson(res, 200, getCandidateView(db, Number(m[1]), clock));
        return;
      }
      m = /^\/api\/candidates\/(\d+)\/freeze$/.exec(path);
      if (m && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { at?: string };
        sendJson(res, 200, freezeCandidate(db, Number(m[1]), body.at));
        return;
      }
      m = /^\/api\/candidates\/(\d+)\/trace\/(.+)$/.exec(path);
      if (m && method === 'GET') {
        const view = getCandidateView(db, Number(m[1]), url.searchParams.get('at') ?? undefined);
        const ref = decodeURIComponent(m[2]);
        const component = view.components.find((c) => c.bom_ref === ref);
        if (!component) throw new HttpError(404, '组件不在该候选中');
        sendJson(res, 200, {
          component,
          paths: traceToRoots(view.edges, view.root_ref, ref),
        });
        return;
      }
      m = /^\/api\/candidates\/(\d+)\/export$/.exec(path);
      if (m && method === 'GET') {
        sendJson(res, 200, exportCandidate(db, Number(m[1]), url.searchParams.get('at') ?? undefined));
        return;
      }

      throw new HttpError(404, '接口不存在');
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else if (err instanceof SyntaxError) {
        sendJson(res, 400, { error: '请求体不是合法 JSON' });
      } else {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const host = argValue('--host') ?? '127.0.0.1';
  const port = Number(argValue('--port') ?? '5235');
  const db = createDb(process.env.DB_PATH ?? 'data.sqlite');
  if (seedIfEmpty(db)) {
    console.log('已写入演示数据（fixture 导入 + 政策 v1 + 例外 + 两个候选）');
  }
  const server = createServer(createApp(db));
  server.listen(port, host, () => {
    console.log(`依赖许可例外台: http://${host}:${port}/`);
  });
}
