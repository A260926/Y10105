// HTTP API: pure Node request handler used both by the Vite dev plugin and
// a standalone server entry point.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DB } from './db.ts';
import { parseCycloneDx } from './cdx.ts';
import {
  ConcurrencyConflict,
  IdempotencyConflict,
  findImportByKey,
  listComponents,
  listEdges,
  listExceptions,
  listPolicyRules,
  listQuarantine,
  persistImport,
  resolveQuarantine,
  updateException,
  upsertException,
  NotFound,
  listCandidates,
} from './repo.ts';
import {
  QuarantineBlockingError,
  buildCandidateView,
  exportCandidate,
  freezeCandidate,
  makeCandidate,
} from './candidates.ts';
import { isSeeded, seedDemo, CLOCK_NOW } from './seed.ts';

export interface ApiContext {
  db: DB;
  seeded: () => boolean;
}

function nowIso(url: URL): string {
  return url.searchParams.get('clock') ?? CLOCK_NOW;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

export function createApiHandler(ctx: ApiContext) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      send(res, 404, { error: 'not an API route' });
      return;
    }
    try {
      await route(ctx, req, res, url, req.method ?? 'GET');
    } catch (err) {
      if (err instanceof IdempotencyConflict) {
        send(res, 409, {
          error: err.message,
          existingImportId: err.existingId,
          existingHash: err.existingHash,
        });
        return;
      }
      if (err instanceof ConcurrencyConflict) {
        send(res, 409, { error: err.message, kind: 'version_conflict' });
        return;
      }
      if (err instanceof QuarantineBlockingError) {
        send(res, 409, { error: err.message, kind: 'quarantine_blocking' });
        return;
      }
      if (err instanceof NotFound) {
        send(res, 404, { error: err.message });
        return;
      }
      send(res, 400, { error: (err as Error).message ?? String(err) });
    }
  };
}

async function route(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<void> {
  const { db } = ctx;

  if (method === 'POST' && url.pathname === '/api/seed') {
    if (!isSeeded(db)) {
      const ids = seedDemo(db);
      send(res, 200, { ok: true, seeded: true, ids });
    } else {
      send(res, 200, { ok: true, seeded: false, note: 'already seeded' });
    }
    return;
  }

  if (method === 'GET' && url.pathname === '/api/clock') {
    send(res, 200, { clock: nowIso(url) });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/policies') {
    send(res, 200, { rules: listPolicyRules(db) });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/exceptions') {
    send(res, 200, { exceptions: listExceptions(db, nowIso(url)) });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/exceptions') {
    const body = JSON.parse(await readBody(req)) as {
      componentPurl: string;
      componentVersion?: string | null;
      policyVersion: number;
      purpose?: string | null;
      reason: string;
      approver: string;
      expiresAt: string;
    };
    const rec = upsertException(db, {
      componentPurl: body.componentPurl,
      componentVersion: body.componentVersion ?? null,
      policyVersion: body.policyVersion,
      purpose: body.purpose ?? null,
      reason: body.reason,
      approver: body.approver,
      expiresAt: body.expiresAt,
      createdAt: new Date().toISOString(),
    });
    send(res, 201, { exception: rec });
    return;
  }

  const excPatch = url.pathname.match(/^\/api\/exceptions\/(\d+)$/);
  if (excPatch && method === 'PATCH') {
    const body = JSON.parse(await readBody(req)) as {
      expectedRowVersion: number;
      reason?: string;
      approver?: string;
      expiresAt?: string;
    };
    const rec = updateException(db, {
      id: Number(excPatch[1]),
      expectedRowVersion: body.expectedRowVersion,
      reason: body.reason,
      approver: body.approver,
      expiresAt: body.expiresAt,
    });
    send(res, 200, { exception: rec });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/quarantine') {
    send(res, 200, { quarantine: listQuarantine(db) });
    return;
  }

  const qResolve = url.pathname.match(/^\/api\/quarantine\/(\d+)\/resolve$/);
  if (qResolve && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      resolution?: 'resolved' | 'rejected';
      note?: string;
    };
    resolveQuarantine(
      db,
      Number(qResolve[1]),
      body.resolution ?? 'resolved',
      body.note ?? 'reviewed during compliance triage',
      nowIso(url),
    );
    send(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/imports') {
    const explicit = url.searchParams.get('key');
    const payload = await readBody(req);
    const parsed = parseCycloneDx(payload, explicit);
    const row = persistImport(db, {
      parseResult: parsed,
      importKey: parsed.imported.importKey,
      createdAt: new Date().toISOString(),
    });
    send(res, 200, {
      import: row,
      imported: parsed.imported,
      warnings: parsed.warnings,
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/imports') {
    const rows = db.raw
      .prepare('SELECT id, import_key, content_hash, created_at, summary FROM imports ORDER BY id')
      .all();
    send(res, 200, { imports: rows });
    return;
  }

  const importDetail = url.pathname.match(/^\/api\/imports\/(\d+)$/);
  if (importDetail && method === 'GET') {
    const id = Number(importDetail[1]);
    const row = findImportByKey(
      db,
      String((db.raw.prepare('SELECT import_key FROM imports WHERE id=?').get(id) as { import_key: string }).import_key),
    );
    if (!row) {
      send(res, 404, { error: 'import not found' });
      return;
    }
    send(res, 200, {
      import: row,
      components: listComponents(db, id),
      edges: listEdges(db, id),
      quarantine: listQuarantine(db).filter((q) => q.importId === id),
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/candidates') {
    send(res, 200, { candidates: listCandidates(db) });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/candidates') {
    const body = JSON.parse(await readBody(req)) as {
      importId: number;
      name: string;
      purpose?: string | null;
      rootPurl: string;
    };
    const cand = makeCandidate(db, {
      importId: body.importId,
      name: body.name,
      purpose: body.purpose ?? null,
      rootPurl: body.rootPurl,
      createdAt: new Date().toISOString(),
    });
    send(res, 201, { candidate: cand });
    return;
  }

  const candDetail = url.pathname.match(/^\/api\/candidates\/(\d+)$/);
  if (candDetail && method === 'GET') {
    send(res, 200, buildCandidateView(db, Number(candDetail[1]), nowIso(url)));
    return;
  }

  const candFreeze = url.pathname.match(/^\/api\/candidates\/(\d+)\/freeze$/);
  if (candFreeze && method === 'POST') {
    send(res, 200, freezeCandidate(db, Number(candFreeze[1]), nowIso(url)));
    return;
  }

  const candExport = url.pathname.match(/^\/api\/candidates\/(\d+)\/export$/);
  if (candExport && method === 'GET') {
    send(res, 200, exportCandidate(db, Number(candExport[1]), nowIso(url)));
    return;
  }

  send(res, 404, { error: `no route for ${method} ${url.pathname}` });
}
