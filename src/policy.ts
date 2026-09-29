import type { Db } from './db.ts';
import {
  evaluateExpression,
  licenseIds,
  parseSpdx,
  rankOf,
  worstOf,
  type Effect,
  type LicenseNode,
} from './spdx.ts';

export type DepKind = 'direct' | 'transitive';

export interface PolicyRow {
  id: number;
  version: string;
  license_id: string;
  source: string;
  dep_kind: string;
  usage: string;
  effect: Effect;
  effective_from: string;
  effective_to: string | null;
}

export interface DecisionBasis {
  type: 'policy' | 'exception' | 'none';
  license_effects: { license: string; effect: Effect; policy_ids: number[] }[];
  policy_ids: number[];
  exception_id?: number;
  note?: string;
}

export interface Decision {
  decision: Effect | 'allow_exception';
  basis: DecisionBasis;
}

export function purlSource(purl: string): string {
  const m = /^pkg:([^/]+)\//.exec(purl);
  return m ? m[1] : 'unknown';
}

export function latestPolicyVersion(db: Db): string | null {
  const row = db
    .prepare('SELECT version FROM policies ORDER BY id DESC LIMIT 1')
    .get() as { version: string } | undefined;
  return row ? row.version : null;
}

function matchingPolicies(
  db: Db,
  opts: {
    licenseId: string;
    source: string;
    depKind: DepKind;
    usage: string;
    clock: string;
    policyVersion: string;
  },
): PolicyRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM policies
       WHERE version = ? AND license_id = ?
         AND (source = '*' OR source = ?)
         AND (dep_kind = 'any' OR dep_kind = ?)
         AND (usage = '*' OR usage = ?)
         AND effective_from <= ?
         AND (effective_to IS NULL OR effective_to > ?)`,
    )
    .all(
      opts.policyVersion,
      opts.licenseId,
      opts.source,
      opts.depKind,
      opts.usage,
      opts.clock,
      opts.clock,
    ) as unknown as PolicyRow[];
  return rows;
}

export function findActiveException(
  db: Db,
  opts: { purl: string; version: string; usage: string; clock: string; policyVersion: string },
): { id: number } | undefined {
  return db
    .prepare(
      `SELECT id FROM exceptions
       WHERE component_purl = ? AND component_version = ?
         AND policy_version = ? AND usage = ?
         AND status = 'approved' AND expires_at > ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(opts.purl, opts.version, opts.policyVersion, opts.usage, opts.clock) as
    | { id: number }
    | undefined;
}

// 对单个组件做政策判定。clock 由调用方传入（冻结时刻或查询时刻），到期状态完全由时钟推导。
export function decideComponent(
  db: Db,
  component: { purl: string; version: string; declared_license: string | null },
  opts: { depKind: DepKind; usage: string; clock: string; policyVersion: string },
): Decision {
  const source = purlSource(component.purl);
  const licenseEffects: DecisionBasis['license_effects'] = [];
  const policyIds = new Set<number>();

  let tree: LicenseNode | null = null;
  let parseError: string | null = null;
  if (component.declared_license && component.declared_license.trim() !== '') {
    try {
      tree = parseSpdx(component.declared_license);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }

  let base: Effect;
  if (tree) {
    for (const id of licenseIds(tree)) {
      const matches = matchingPolicies(db, {
        licenseId: id,
        source,
        depKind: opts.depKind,
        usage: opts.usage,
        clock: opts.clock,
        policyVersion: opts.policyVersion,
      });
      let effect: Effect = matches.length === 0 ? 'unknown' : 'allow';
      for (const p of matches) {
        effect = worstOf(effect, p.effect);
        policyIds.add(p.id);
      }
      licenseEffects.push({ license: id, effect, policy_ids: matches.map((p) => p.id) });
    }
    base = evaluateExpression(tree, (id) => {
      const entry = licenseEffects.find((e) => e.license === id);
      return entry ? entry.effect : 'unknown';
    });
  } else {
    base = 'unknown';
  }

  const basis: DecisionBasis = {
    type: policyIds.size > 0 ? 'policy' : 'none',
    license_effects: licenseEffects,
    policy_ids: [...policyIds],
  };
  if (parseError) basis.note = `许可表达式无法解析: ${parseError}`;
  if (!component.declared_license) basis.note = '组件未声明许可';

  if (rankOf(base) >= rankOf('needs_exception')) {
    const exception = findActiveException(db, {
      purl: component.purl,
      version: component.version,
      usage: opts.usage,
      clock: opts.clock,
      policyVersion: opts.policyVersion,
    });
    if (exception) {
      basis.type = 'exception';
      basis.exception_id = exception.id;
      return { decision: 'allow_exception', basis };
    }
  }
  return { decision: base, basis };
}
