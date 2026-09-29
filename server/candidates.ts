// Candidate lifecycle: draft evaluation, quarantine-gated freeze, and
// export. Freeze stores a full snapshot so later policy/exception changes
// only affect new candidates.

import type { DB } from './db.ts';
import {
  createCandidate,
  finalizeFreeze,
  getCandidate,
  listComponents,
  listEdges,
  listExceptions,
  listPolicyRules,
  rulesAtTime,
  loadDecisions,
  loadFrozenGraph,
  openQuarantineForImport,
  saveDecisions,
  saveFrozenGraph,
  type CandidateRow,
} from './repo.ts';
import { evaluate } from './policy.ts';
import { depKinds, flaggedPathSet, indexGraph } from './graph.ts';
import type {
  CandidateExport,
  Decision,
  DependencyPath,
  Verdict,
} from '../src/shared/types.ts';

export class QuarantineBlockingError extends Error {}

export interface CandidateView {
  candidate: CandidateRow;
  quarantineOpen: number;
  decisions: Decision[];
  flaggedPaths: DependencyPath[];
  frozen: boolean;
  evaluationClock: string | null;
}

function evaluateDraft(
  db: DB,
  candidateId: number,
  at: string,
): { decisions: Decision[]; flaggedPaths: DependencyPath[] } {
  const cand = getCandidate(db, candidateId);
  if (cand.status === 'frozen') {
    const graph = loadFrozenGraph(db, candidateId);
    const decisions = loadDecisions(db, candidateId);
    const flagged = new Set(
      decisions.filter((d) => d.verdict !== 'allow').map((d) => d.purl),
    );
    return {
      decisions,
      flaggedPaths: flaggedPathSet(
        indexGraph(graph.components, graph.edges, graph.rootRefs),
        flagged,
      ),
    };
  }
  const components = listComponents(db, cand.importId);
  const edges = listEdges(db, cand.importId);
  const graph = indexGraph(components, edges, deriveRoots(components, edges, cand.rootPurl));
  const kinds = depKinds(graph);
  const { rules } = rulesAtTime(db, at);
  const exceptions = listExceptions(db, at);

  const decisions: Decision[] = [];
  for (const comp of components) {
    if (graph.rootRefs.includes(comp.bomRef)) continue;
    decisions.push(
      evaluate({
        component: comp,
        depKind: kinds.get(comp.bomRef) ?? 'transitive',
        purpose: cand.purpose,
        at,
        rules,
        exceptions,
      }),
    );
  }
  const flagged = new Set(decisions.filter((d) => d.verdict !== 'allow').map((d) => d.purl));
  return { decisions, flaggedPaths: flaggedPathSet(graph, flagged) };
}

function deriveRoots(
  components: ReturnType<typeof listComponents>,
  edges: ReturnType<typeof listEdges>,
  rootPurl: string,
): string[] {
  const byPurl = new Map(components.map((c) => [c.purl, c.bomRef]));
  const explicit = byPurl.get(rootPurl);
  if (explicit) return [explicit];
  // fall back to nodes without parents
  const children = new Set(edges.map((e) => e.childRef));
  return components.filter((c) => !children.has(c.bomRef)).map((c) => c.bomRef);
}

function currentVersion(db: DB, at: string): number {
  const row = db.raw
    .prepare(
      'SELECT MAX(policy_version) AS v FROM policies WHERE (effective_from IS NULL OR effective_from <= ?)',
    )
    .get(at) as { v: number | null };
  return row.v ?? 1;
}

export function buildCandidateView(db: DB, candidateId: number, at: string): CandidateView {
  const cand = getCandidate(db, candidateId);
  const { decisions, flaggedPaths } =
    cand.status === 'frozen'
      ? frozenView(db, candidateId)
      : evaluateDraft(db, candidateId, at);
  return {
    candidate: cand,
    quarantineOpen: cand.status === 'draft' ? openQuarantineForImport(db, cand.importId) : 0,
    decisions,
    flaggedPaths,
    frozen: cand.status === 'frozen',
    evaluationClock: at,
  };
}

function frozenView(db: DB, candidateId: number): {
  decisions: Decision[];
  flaggedPaths: DependencyPath[];
} {
  const graph = loadFrozenGraph(db, candidateId);
  const decisions = loadDecisions(db, candidateId);
  const flagged = new Set(decisions.filter((d) => d.verdict !== 'allow').map((d) => d.purl));
  return { decisions, flaggedPaths: flaggedPathSet(indexGraph(graph.components, graph.edges, graph.rootRefs), flagged) };
}

export function makeCandidate(
  db: DB,
  input: { importId: number; name: string; purpose: string | null; rootPurl: string; createdAt: string },
): CandidateRow {
  return createCandidate(db, input);
}

/**
 * Freeze a candidate. Refuses while quarantine for its import is open.
 * Persists the graph + per-component decisions + clock so the snapshot is
 * immune to later policy/exception edits.
 */
export function freezeCandidate(db: DB, candidateId: number, at: string): CandidateView {
  const cand = getCandidate(db, candidateId);
  if (cand.status === 'frozen') return buildCandidateView(db, candidateId, cand.clockAt ?? at);

  const open = openQuarantineForImport(db, cand.importId);
  if (open > 0) {
    throw new QuarantineBlockingError(
      `cannot freeze: ${open} quarantined component(s) still open for this import`,
    );
  }

  const components = listComponents(db, cand.importId);
  const edges = listEdges(db, cand.importId);
  const rootRefs = deriveRoots(components, edges, cand.rootPurl);
  const graph = indexGraph(components, edges, rootRefs);
  const kinds = depKinds(graph);
  const { version, rules } = rulesAtTime(db, at);
  const exceptions = listExceptions(db, at);

  const decisions: Decision[] = [];
  for (const comp of components) {
    if (graph.rootRefs.includes(comp.bomRef)) continue;
    decisions.push(
      evaluate({
        component: comp,
        depKind: kinds.get(comp.bomRef) ?? 'transitive',
        purpose: cand.purpose,
        at,
        rules,
        exceptions,
      }),
    );
  }

  const order: Verdict[] = ['allow', 'unknown', 'needs_exception', 'deny'];
  const overall =
    decisions.length === 0
      ? 'allow'
      : decisions
          .map((d) => d.verdict)
          .sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];

  db.tx(() => {
    saveFrozenGraph(db, candidateId, { components, edges, rootRefs });
    saveDecisions(db, candidateId, decisions);
    finalizeFreeze(db, candidateId, overall, version, at, at);
  });

  return buildCandidateView(db, candidateId, at);
}

/**
 * Export bundle. Deliberately excludes component.properties (may contain
 * secrets): only summary, dependency paths, decisions and evidence refs.
 */
export function exportCandidate(
  db: DB,
  candidateId: number,
  at: string,
): CandidateExport {
  const cand = getCandidate(db, candidateId);
  const view = buildCandidateView(db, candidateId, at);
  const graph =
    cand.status === 'frozen'
      ? loadFrozenGraph(db, candidateId)
      : {
          components: listComponents(db, cand.importId),
          edges: listEdges(db, cand.importId),
          rootRefs: deriveRoots(
            listComponents(db, cand.importId),
            listEdges(db, cand.importId),
            cand.rootPurl,
          ),
        };
  const evidenceRefs = graph.components
    .filter((c) => c.purl !== cand.rootPurl)
    .map((c) => ({ purl: c.purl, evidence: c.evidence }));

  return {
    candidateId: cand.id,
    name: cand.name,
    createdAt: cand.createdAt,
    frozenAt: cand.frozenAt,
    status: cand.status,
    summary: ((): import('../src/shared/types.ts').BomSummary => {
      const row = db.raw
        .prepare('SELECT summary FROM imports WHERE id = ?')
        .get(cand.importId) as { summary: string };
      return JSON.parse(row.summary);
    })(),
    purpose: cand.purpose,
    rootPurl: cand.rootPurl,
    overallVerdict: cand.overallVerdict
      ? (cand.overallVerdict as Verdict)
      : (view.decisions
          .map((d) => d.verdict)
          .sort((a, b) => orderIndex(b) - orderIndex(a))[0] ?? null),
    decisions: view.decisions,
    flaggedPaths: view.flaggedPaths,
    evidenceRefs,
  };
}

function orderIndex(v: Verdict): number {
  return ['allow', 'unknown', 'needs_exception', 'deny'].indexOf(v);
}
