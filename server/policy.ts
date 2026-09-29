// Policy evaluation: license expression + origin + dependency kind +
// purpose + effective window => allow / deny / needs_exception / unknown.

import {
  componentAst,
  known as isKnown,
  parseSpdx,
  satisfies,
  type SpdxNode,
  type Tri,
} from './spdx.ts';
import type {
  Component,
  Decision,
  PolicyRule,
  ExceptionRecord,
} from '../src/shared/types.ts';

export interface EvaluateInput {
  component: Component;
  depKind: 'direct' | 'transitive';
  purpose: string | null;
  at: string;
  rules: PolicyRule[];
  exceptions: ExceptionRecord[];
}

/** Half-open interval: [effectiveFrom, effectiveTo). */
function inWindow(rule: PolicyRule, at: string): boolean {
  const t = new Date(at).getTime();
  if (rule.effectiveFrom && t < new Date(rule.effectiveFrom).getTime()) return false;
  if (rule.effectiveTo && t >= new Date(rule.effectiveTo).getTime()) return false;
  return true;
}

function dimensionsMatch(
  rule: PolicyRule,
  component: Component,
  depKind: 'direct' | 'transitive',
  purpose: string | null,
): boolean {
  if (rule.origin !== 'any' && rule.origin !== component.origin) return false;
  if (rule.depKind && rule.depKind !== depKind) return false;
  if (rule.purpose && rule.purpose !== purpose) return false;
  return true;
}

function hasUnknownAtom(node: SpdxNode): boolean {
  if (node.kind === 'license') return !isKnown(node.plus ? `${node.id}+` : node.id);
  return hasUnknownAtom(node.left) || hasUnknownAtom(node.right);
}

function findException(
  component: Component,
  purpose: string | null,
  at: string,
  exceptions: ExceptionRecord[],
): ExceptionRecord | null {
  const t = new Date(at).getTime();
  const namePurl = stripVersion(component.purl);
  const matches = exceptions.filter((e) => {
    // Identity match accepts either an exact purl (with version) or the
    // versionless purl; componentVersion then constrains the version.
    if (e.componentPurl !== component.purl && e.componentPurl !== namePurl) return false;
    if (e.componentVersion !== null && e.componentVersion !== component.version) return false;
    if ((e.purpose ?? null) !== (purpose ?? null)) return false;
    // half-open: at === expiresAt already counts as expired
    return t < new Date(e.expiresAt).getTime();
  });
  if (matches.length === 0) return null;
  return [...matches].sort(
    (a, b) => new Date(b.expiresAt).getTime() - new Date(a.expiresAt).getTime(),
  )[0];
}

/** Evaluate one component against the rule set + exceptions valid at `at`. */
export function evaluate(input: EvaluateInput): Decision {
  const { component, depKind, purpose, at, rules, exceptions } = input;
  const base = {
    purl: component.purl,
    version: component.version,
    depKind,
    purpose,
    at,
  };

  const { node } = componentAst(component.declaredLicenseRaw);
  const unknownLicense =
    component.declaredLicenseRaw.length === 0 || node == null || hasUnknownAtom(node);

  const exception = findException(component, purpose, at, exceptions);

  // Collect every rule whose license expression the component AST could
  // satisfy (true or unknown); highest priority (smallest number) wins.
  const covering: { rule: PolicyRule; tri: Tri }[] = [];
  for (const rule of rules) {
    if (!inWindow(rule, at) || !dimensionsMatch(rule, component, depKind, purpose)) continue;
    let tri: Tri;
    if (node == null) {
      tri = 'unknown';
    } else {
      try {
        tri = satisfies(node, parseSpdx(rule.licenseExpression));
      } catch {
        tri = 'unknown';
      }
    }
    if (tri !== false) covering.push({ rule, tri });
  }
  // 'unknown' only counts as coverage when at least one atom of the
  // component license could identify the rule; a purely unknown license
  // (e.g. LicenseRef-Proprietary) is not silently pulled into a deny rule.
  const definite = covering.filter((c) => c.tri === true);
  const candidateList = definite.length > 0 ? definite : covering;
  candidateList.sort((a, b) => a.rule.priority - b.rule.priority);
  const chosen = candidateList[0] ?? null;
  const onlyUnknown = definite.length === 0 && covering.length > 0;

  if (exception) {
    return {
      ...base,
      verdict: 'allow',
      policyHit: chosen
        ? {
            ruleId: chosen.rule.id,
            policyVersion: chosen.rule.policyVersion,
            effect: chosen.rule.effect,
          }
        : null,
      exception: {
        id: exception.id ?? 0,
        policyVersion: exception.policyVersion,
        reason: exception.reason,
        approver: exception.approver,
        expiresAt: exception.expiresAt,
      },
      detail: `allowed by exception #${exception.id} bound to policy v${exception.policyVersion} (approver: ${exception.approver}; expires ${exception.expiresAt})`,
    };
  }

  if (chosen && chosen.tri === true) {
    return {
      ...base,
      verdict: chosen.rule.effect,
      policyHit: {
        ruleId: chosen.rule.id,
        policyVersion: chosen.rule.policyVersion,
        effect: chosen.rule.effect,
      },
      exception: null,
      detail: `policy ${chosen.rule.id} v${chosen.rule.policyVersion} [${chosen.rule.licenseExpression}] => ${chosen.rule.effect}`,
    };
  }

  if (chosen && chosen.tri === 'unknown' && !onlyUnknown) {
    return {
      ...base,
      verdict: 'needs_exception',
      policyHit: {
        ruleId: chosen.rule.id,
        policyVersion: chosen.rule.policyVersion,
        effect: chosen.rule.effect,
      },
      exception: null,
      detail: `license not fully recognized for policy ${chosen.rule.id}; exception required`,
    };
  }

  if (unknownLicense) {
    return {
      ...base,
      verdict: 'unknown',
      policyHit: null,
      exception: null,
      detail:
        component.declaredLicenseRaw.length === 0
          ? 'no license declared; remains unknown'
          : `unresolved license (${component.declaredLicenseRaw.join(', ')}); remains unknown`,
    };
  }

  return {
    ...base,
    verdict: 'deny',
    policyHit: null,
    exception: null,
    detail: `license ${component.declaredLicenses.join(', ')} matched no applicable policy rule`,
  };
}

function stripVersion(purl: string): string {
  // pkg:type/namespace/name@version?query -> pkg:type/namespace/name
  const q = purl.split('?')[0]!;
  const at = q.lastIndexOf('@');
  if (at <= 4) return q; // no version ('@' could only appear in scheme)
  return q.slice(0, at);
}
