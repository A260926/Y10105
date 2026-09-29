// CycloneDX JSON ingestion.
// Legal components are kept; structurally broken components go to
// quarantine. A content hash powers idempotent imports.

import { createHash } from 'node:crypto';
import type {
  BomSummary,
  Component,
  ComponentEvidence,
  Edge,
  ImportedBom,
  QuarantineEntry,
} from '../src/shared/types.ts';
import { parseSpdx, SpdxError, stripKnownIds } from './spdx.ts';

interface CdxLicense {
  license?: { id?: string; name?: string; expression?: string };
  expression?: string;
}

interface CdxComponent {
  'bom-ref'?: string;
  type?: string;
  name?: unknown;
  version?: unknown;
  purl?: unknown;
  licenses?: CdxLicense[];
  evidence?: { licenses?: CdxLicense[] };
  properties?: unknown;
}

interface CdxDependency {
  ref?: unknown;
  dependsOn?: unknown;
}

interface CdxBom {
  bomFormat?: unknown;
  specVersion?: unknown;
  serialNumber?: unknown;
  version?: unknown;
  metadata?: {
    component?: CdxComponent;
    timestamp?: unknown;
  };
  components?: unknown;
  dependencies?: unknown;
}

export class CdxFormatError extends Error {}

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

export function contentHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Import key: stable identity of a BOM series. CycloneDX serialNumber +
 * version identify a specific document; callers may also supply an explicit
 * key. Content hash alone is the fallback.
 */
export function deriveImportKey(
  bom: CdxBom,
  hash: string,
  explicitKey?: string | null,
): string {
  if (explicitKey && explicitKey.trim()) return explicitKey.trim();
  const serial = str(bom.serialNumber);
  const ver = typeof bom.version === 'number' ? bom.version : null;
  if (serial) return ver != null ? `${serial}@${ver}` : serial;
  return `hash:${hash.slice(0, 24)}`;
}

function extractLicenseExprs(licenses: CdxLicense[] | undefined): {
  raws: string[];
  fields: string[];
} {
  const raws: string[] = [];
  const fields: string[] = [];
  if (!Array.isArray(licenses)) return { raws, fields };
  for (const entry of licenses) {
    if (entry && typeof entry.expression === 'string') {
      raws.push(entry.expression.trim());
      fields.push('expression');
    } else if (entry?.license) {
      const lic = entry.license;
      const id = str(lic.id);
      const name = str(lic.name);
      const expr = str(lic.expression);
      if (expr) {
        raws.push(expr);
        fields.push('license.expression');
      } else if (id) {
        raws.push(id);
        fields.push('license.id');
      } else if (name) {
        raws.push(name);
        fields.push('license.name');
      }
    }
  }
  return { raws, fields };
}

function originOf(c: CdxComponent): 'external' | 'internal' {
  const purl = str(c.purl);
  if (purl) {
    const m = purl.match(/^pkg:([^/]+)\//);
    if (m && /internal|corp|acme/i.test(m[1])) return 'internal';
  }
  if (c.type === 'framework' || c.type === 'container' || c.type === 'device') {
    return 'internal';
  }
  return 'external';
}

function validateComponent(raw: unknown): { comp?: Component; err?: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { err: 'component is not an object' };
  }
  const c = raw as CdxComponent;
  const name = str(c.name);
  if (!name) return { err: 'missing component.name' };
  const purl = str(c.purl);
  if (!purl) return { err: `component "${name}" missing purl` };
  if (!/^pkg:[A-Za-z0-9][A-Za-z0-9.+-]*/.test(purl)) {
    return { err: `component "${name}" has malformed purl: ${purl}` };
  }
  const version = str(c.version);
  const bomRef = str(c['bom-ref']) ?? purl;

  const declared = extractLicenseExprs(c.licenses);
  const evidenceLicenses = extractLicenseExprs(c.evidence?.licenses);
  const raws = [...declared.raws, ...evidenceLicenses.raws];
  const fields = [
    ...declared.fields.map((f) => `component.licenses.${f}`),
    ...evidenceLicenses.fields.map((f) => `component.evidence.licenses.${f}`),
  ];

  // Validate license syntax where present. A syntactically broken
  // expression quarantines that component so the error is visible.
  for (const rawExpr of raws) {
    try {
      parseSpdx(rawExpr);
    } catch (e) {
      return { err: `invalid license expression "${rawExpr}": ${(e as SpdxError).message}` };
    }
  }

  const declaredLicenses = stripKnownIds(raws);
  const evidence: ComponentEvidence = {
    licenseSource: raws.length ? fields[0] : 'none',
    fields: fields.length ? fields : ['none'],
    componentType: str(c.type) ?? undefined,
  };
  return {
    comp: {
      bomRef,
      name,
      version,
      purl,
      declaredLicenses,
      declaredLicenseRaw: raws,
      origin: originOf(c),
      evidence,
    },
  };
}

export interface ParseResult {
  imported: ImportedBom;
  warnings: string[];
}

export function parseCycloneDx(payload: string, explicitKey?: string | null): ParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(payload);
  } catch (e) {
    throw new CdxFormatError(`payload is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof doc !== 'object' || doc === null) {
    throw new CdxFormatError('BOM document is not an object');
  }
  const bom = doc as CdxBom;
  if (str(bom.bomFormat) !== 'CycloneDX') {
    throw new CdxFormatError('bomFormat must be "CycloneDX"');
  }
  const specVersion = str(bom.specVersion);
  if (!specVersion) throw new CdxFormatError('missing specVersion');

  const warnings: string[] = [];
  const hash = contentHash(payload);
  const importKey = deriveImportKey(bom, hash, explicitKey);

  const components: Component[] = [];
  const quarantined: QuarantineEntry[] = [];
  const seenRefs = new Set<string>();
  const rawComponents = Array.isArray(bom.components) ? bom.components : [];

  for (const rawComp of rawComponents) {
    const result = validateComponent(rawComp);
    if (result.err || !result.comp) {
      const c = (rawComp ?? {}) as CdxComponent;
      quarantined.push({
        ref: str(c['bom-ref']) ?? `index:${quarantined.length}`,
        name: str(c.name),
        reason: result.err ?? 'invalid component',
        raw: rawComp,
      });
      continue;
    }
    if (seenRefs.has(result.comp.bomRef)) {
      quarantined.push({
        ref: result.comp.bomRef,
        name: result.comp.name,
        reason: `duplicate bom-ref ${result.comp.bomRef}`,
        raw: rawComp,
      });
      continue;
    }
    seenRefs.add(result.comp.bomRef);
    components.push(result.comp);
  }

  // Edges: unknown endpoints are tolerated but recorded as warnings; a
  // dependency entry with non-array dependsOn is malformed and quarantines
  // nothing by itself (edges never carry secret properties).
  const edges: Edge[] = [];
  const rawDeps = Array.isArray(bom.dependencies) ? bom.dependencies : [];
  for (const rawDep of rawDeps) {
    const dep = rawDep as CdxDependency;
    const parentRef = str(dep.ref);
    if (!parentRef) {
      warnings.push('dependency entry without ref ignored');
      continue;
    }
    if (dep.dependsOn !== undefined && !Array.isArray(dep.dependsOn)) {
      quarantined.push({
        ref: parentRef,
        name: null,
        reason: 'dependency.dependsOn must be an array',
        raw: rawDep,
      });
      continue;
    }
    for (const child of (dep.dependsOn ?? []) as unknown[]) {
      const childRef = str(child);
      if (!childRef) {
        warnings.push('dependency target is not a string; ignored');
        continue;
      }
      edges.push({ parentRef, childRef });
      if (!seenRefs.has(childRef)) {
        warnings.push(`dependency target ${childRef} not among components`);
      }
    }
  }

  // Roots: the metadata component plus any component never depended upon.
  const metaComp = bom.metadata?.component;
  let rootPurl: string | null = null;
  let rootName: string | null = null;
  let rootVersion: string | null = null;
  if (metaComp) {
    const meta = validateComponent(metaComp);
    if (meta.comp) {
      rootPurl = meta.comp.purl;
      rootName = meta.comp.name;
      rootVersion = meta.comp.version;
      if (!seenRefs.has(meta.comp.bomRef)) {
        seenRefs.add(meta.comp.bomRef);
        components.push(meta.comp);
      }
    } else {
      warnings.push(`metadata.component invalid: ${meta.err}`);
    }
  }

  const childSet = new Set(edges.map((e) => e.childRef));
  const rootRefs = components
    .filter((c) => !childSet.has(c.bomRef))
    .map((c) => c.bomRef);

  const summary: BomSummary = {
    bomFormat: 'CycloneDX',
    specVersion,
    serialNumber: str(bom.serialNumber),
    version: typeof bom.version === 'number' ? bom.version : null,
    componentName: rootName,
    componentVersion: rootVersion,
    componentPurl: rootPurl,
    componentCount: components.length,
    contentHash: hash,
    rawDigest: hash,
  };

  return {
    imported: { importKey, summary, components, edges, rootRefs, quarantined },
    warnings,
  };
}
