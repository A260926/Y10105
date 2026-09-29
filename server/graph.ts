// Dependency-graph analysis over an imported BOM.

import type { Component, DependencyPath, Edge } from '../src/shared/types.ts';

export interface IndexedGraph {
  byRef: Map<string, Component>;
  parents: Map<string, Set<string>>;
  children: Map<string, Set<string>>;
  rootRefs: string[];
}

export function indexGraph(
  components: Component[],
  edges: Edge[],
  rootRefs: string[],
): IndexedGraph {
  const byRef = new Map<string, Component>();
  for (const c of components) byRef.set(c.bomRef, c);

  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!byRef.has(e.parentRef) || !byRef.has(e.childRef)) continue;
    if (!parents.has(e.childRef)) parents.set(e.childRef, new Set());
    if (!children.has(e.parentRef)) children.set(e.parentRef, new Set());
    parents.get(e.childRef)!.add(e.parentRef);
    children.get(e.parentRef)!.add(e.childRef);
  }

  // Roots: provided root refs that exist, otherwise nodes with no parents.
  let roots = rootRefs.filter((r) => byRef.has(r));
  if (roots.length === 0) {
    roots = components.filter((c) => !parents.has(c.bomRef)).map((c) => c.bomRef);
  }
  return { byRef, parents, children, rootRefs: roots };
}

/** BFS depth from any root. Direct deps are children of the metadata root. */
export function depKinds(graph: IndexedGraph): Map<string, 'direct' | 'transitive'> {
  const kinds = new Map<string, 'direct' | 'transitive'>();
  for (const root of graph.rootRefs) {
    for (const child of graph.children.get(root) ?? []) {
      if (!kinds.has(child)) kinds.set(child, 'direct');
    }
  }
  // BFS from roots to mark everything reachable.
  const queue: string[] = [...graph.rootRefs];
  const depth = new Map<string, number>(graph.rootRefs.map((r) => [r, 0]));
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur) ?? 0;
    for (const child of graph.children.get(cur) ?? []) {
      if (!depth.has(child)) {
        depth.set(child, d + 1);
        queue.push(child);
      }
    }
  }
  for (const ref of graph.byRef.keys()) {
    if (graph.rootRefs.includes(ref)) continue;
    if (!kinds.has(ref)) kinds.set(ref, (depth.get(ref) ?? 2) <= 1 ? 'direct' : 'transitive');
  }
  return kinds;
}

/**
 * Every root -> component path that reaches `targetRef`. Cycles are cut by
 * the visited set so traversal always terminates.
 */
export function pathsToRoot(
  graph: IndexedGraph,
  targetRef: string,
): DependencyPath[] {
  const results: DependencyPath[] = [];

  const walk = (ref: string, trail: string[], seen: Set<string>) => {
    const comp = graph.byRef.get(ref);
    if (!comp) return;
    const nextTrail = [...trail, ref];
    if (graph.rootRefs.includes(ref)) {
      results.push(toPath(graph, nextTrail));
      return;
    }
    const up = graph.parents.get(ref);
    if (!up || up.size === 0) {
      results.push(toPath(graph, nextTrail));
      return;
    }
    for (const parent of up) {
      if (seen.has(parent)) continue;
      walk(parent, nextTrail, new Set(seen).add(parent));
    }
  };

  walk(targetRef, [], new Set([targetRef]));
  return dedupePaths(results);
}

function toPath(graph: IndexedGraph, refsFromChild: string[]): DependencyPath {
  const refs = [...refsFromChild].reverse();
  const path = refs.map((ref) => {
    const c = graph.byRef.get(ref)!;
    return { purl: c.purl, name: c.name, version: c.version };
  });
  const root = graph.byRef.get(refs[0])!;
  return { rootPurl: root.purl, rootName: root.name, path };
}

function dedupePaths(paths: DependencyPath[]): DependencyPath[] {
  const seen = new Set<string>();
  return paths.filter((p) => {
    const key = p.path.map((n) => n.purl).join('>');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Flagged components (everything not allowed), each with paths to roots. */
export function flaggedPathSet(
  graph: IndexedGraph,
  flaggedPurls: Set<string>,
): DependencyPath[] {
  const all: DependencyPath[] = [];
  for (const [ref, comp] of graph.byRef) {
    if (!flaggedPurls.has(comp.purl)) continue;
    all.push(...pathsToRoot(graph, ref));
  }
  return dedupePaths(all);
}
