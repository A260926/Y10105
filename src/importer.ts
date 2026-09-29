import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import { HttpError } from './errors.ts';

export interface ImportResult {
  import_id: number;
  root_ref: string;
  components: number;
  edges: number;
  quarantined: number;
  replayed: boolean;
}

interface BomComponent {
  'bom-ref'?: string;
  purl?: string;
  name?: string;
  version?: string;
  licenses?: unknown;
  evidence?: { occurrences?: { location?: string }[] };
  externalReferences?: { url?: string }[];
  [key: string]: unknown;
}

function contentHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function declaredLicenseOf(c: BomComponent): string | null {
  if (!Array.isArray(c.licenses) || c.licenses.length === 0) return null;
  const ids: string[] = [];
  for (const entry of c.licenses as Record<string, unknown>[]) {
    if (typeof entry.expression === 'string') return entry.expression;
    const lic = entry.license as { id?: string; name?: string } | undefined;
    if (lic?.id) ids.push(lic.id);
  }
  return ids.length > 0 ? ids.join(' OR ') : null;
}

function evidenceSourceOf(c: BomComponent): string | null {
  const occ = c.evidence?.occurrences?.[0]?.location;
  if (occ) return occ;
  const ref = c.externalReferences?.[0]?.url;
  return ref ?? null;
}

function validateComponent(c: BomComponent): string | null {
  if (typeof c['bom-ref'] !== 'string' || c['bom-ref'] === '') return '缺少 bom-ref';
  if (typeof c.name !== 'string' || c.name === '') return '缺少 name';
  if (typeof c.purl !== 'string' || !c.purl.startsWith('pkg:')) return '缺少或非法 purl';
  if (typeof c.version !== 'string' || c.version === '') return '缺少 version';
  return null;
}

export function importBom(db: Db, rawBody: string, idempotencyKey: string): ImportResult {
  const hash = contentHash(rawBody);
  const existing = db
    .prepare('SELECT * FROM imports WHERE idempotency_key = ?')
    .get(idempotencyKey) as
    | {
        id: number;
        content_hash: string;
        root_ref: string;
        component_count: number;
        edge_count: number;
        quarantine_count: number;
      }
    | undefined;
  if (existing) {
    if (existing.content_hash !== hash) {
      throw new HttpError(409, '幂等键相同但内容不同，导入冲突');
    }
    return {
      import_id: existing.id,
      root_ref: existing.root_ref,
      components: existing.component_count,
      edges: existing.edge_count,
      quarantined: existing.quarantine_count,
      replayed: true,
    };
  }

  let bom: Record<string, unknown>;
  try {
    bom = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  if (bom.bomFormat !== 'CycloneDX') {
    throw new HttpError(400, '不是 CycloneDX BOM（缺少 bomFormat: CycloneDX）');
  }

  const metadata = (bom.metadata ?? {}) as { component?: BomComponent };
  const rootRaw = metadata.component ?? {};
  const rootRef =
    typeof rootRaw['bom-ref'] === 'string' && rootRaw['bom-ref'] !== ''
      ? rootRaw['bom-ref']
      : 'root';
  const rootName = typeof rootRaw.name === 'string' ? rootRaw.name : 'application';
  const rootVersion = typeof rootRaw.version === 'string' ? rootRaw.version : '0.0.0';
  const rootPurl =
    typeof rootRaw.purl === 'string' && rootRaw.purl.startsWith('pkg:')
      ? rootRaw.purl
      : `pkg:generic/${rootName}@${rootVersion}`;

  const components = Array.isArray(bom.components) ? (bom.components as BomComponent[]) : [];
  const dependencies = Array.isArray(bom.dependencies)
    ? (bom.dependencies as { ref?: string; dependsOn?: string[] }[])
    : [];

  // 整个导入在一个事务里：组件与边之间崩溃则整体回滚，不留半张图。
  db.exec('BEGIN');
  try {
    const createdAt = nowIso();
    const importId = Number(
      db
        .prepare(
          `INSERT INTO imports (idempotency_key, content_hash, bom_serial, bom_version, root_ref,
                                component_count, edge_count, quarantine_count, created_at)
           VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)`,
        )
        .run(
          idempotencyKey,
          hash,
          typeof bom.serialNumber === 'string' ? bom.serialNumber : null,
          typeof bom.version === 'number' ? bom.version : null,
          rootRef,
          createdAt,
        ).lastInsertRowid,
    );

    const insertComponent = db.prepare(
      `INSERT INTO components (import_id, bom_ref, purl, name, version, declared_license, evidence_source, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertQuarantine = db.prepare(
      `INSERT INTO quarantine (import_id, bom_ref, reason, raw_json) VALUES (?, ?, ?, ?)`,
    );

    insertComponent.run(
      importId,
      rootRef,
      rootPurl,
      rootName,
      rootVersion,
      declaredLicenseOf(rootRaw),
      evidenceSourceOf(rootRaw),
      JSON.stringify(rootRaw),
    );

    const knownRefs = new Set<string>([rootRef]);
    const quarantinedRefs = new Set<string>();
    let componentCount = 1;
    let quarantineCount = 0;

    for (const c of components) {
      const problem = validateComponent(c);
      if (problem !== null) {
        insertQuarantine.run(importId, c['bom-ref'] ?? null, problem, JSON.stringify(c));
        if (typeof c['bom-ref'] === 'string') quarantinedRefs.add(c['bom-ref']);
        quarantineCount += 1;
        continue;
      }
      insertComponent.run(
        importId,
        c['bom-ref'] as string,
        c.purl as string,
        c.name as string,
        c.version as string,
        declaredLicenseOf(c),
        evidenceSourceOf(c),
        JSON.stringify(c),
      );
      knownRefs.add(c['bom-ref'] as string);
      componentCount += 1;
    }

    let edgeCount = 0;
    const insertEdge = db.prepare(
      'INSERT INTO edges (import_id, from_ref, to_ref) VALUES (?, ?, ?)',
    );
    for (const dep of dependencies) {
      if (typeof dep.ref !== 'string') {
        throw new HttpError(400, 'dependencies 中存在缺少 ref 的条目');
      }
      const from = dep.ref;
      if (!knownRefs.has(from) && !quarantinedRefs.has(from)) {
        throw new HttpError(400, `依赖边引用了未知组件 ref: ${from}`);
      }
      const targets = Array.isArray(dep.dependsOn) ? dep.dependsOn : [];
      for (const to of targets) {
        if (!knownRefs.has(to)) {
          if (quarantinedRefs.has(to)) continue; // 指向隔离组件的边跳过
          throw new HttpError(400, `依赖边引用了未知组件 ref: ${to}`);
        }
        if (!knownRefs.has(from)) continue; // 来自隔离组件的边跳过
        insertEdge.run(importId, from, to);
        edgeCount += 1;
      }
    }

    db.prepare(
      'UPDATE imports SET component_count = ?, edge_count = ?, quarantine_count = ? WHERE id = ?',
    ).run(componentCount, edgeCount, quarantineCount, importId);

    db.exec('COMMIT');
    return {
      import_id: importId,
      root_ref: rootRef,
      components: componentCount,
      edges: edgeCount,
      quarantined: quarantineCount,
      replayed: false,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function resolveQuarantine(
  db: Db,
  quarantineId: number,
  note: string,
): { id: number; resolved: number } {
  const row = db.prepare('SELECT id FROM quarantine WHERE id = ?').get(quarantineId);
  if (!row) throw new HttpError(404, '隔离条目不存在');
  db.prepare('UPDATE quarantine SET resolved = 1, resolution_note = ? WHERE id = ?').run(
    note,
    quarantineId,
  );
  return { id: quarantineId, resolved: 1 };
}
