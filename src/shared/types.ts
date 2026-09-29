// Shared domain types for the License Exception Desk.

export type Verdict = 'allow' | 'deny' | 'needs_exception' | 'unknown';

/** Component identity is purl + version (name alone is never enough). */
export interface Component {
  bomRef: string;
  name: string;
  version: string | null;
  purl: string;
  /** normalized SPDX ids declared on the component; [] => unknown */
  declaredLicenses: string[];
  /** raw declared license expressions as seen in the BOM */
  declaredLicenseRaw: string[];
  origin: 'external' | 'internal';
  evidence: ComponentEvidence;
}

export interface ComponentEvidence {
  licenseSource: string;
  /** e.g. ["component.licenses", "component.evidence.licenses"] */
  fields: string[];
  /** CycloneDX component type */
  componentType?: string;
}

export interface Edge {
  parentRef: string;
  childRef: string;
}

export interface ImportedBom {
  importKey: string;
  summary: BomSummary;
  components: Component[];
  edges: Edge[];
  /** direct dependency purls (referenced by the top-level metadata/component roots) */
  rootRefs: string[];
  quarantined: QuarantineEntry[];
}

export interface BomSummary {
  bomFormat: string;
  specVersion: string;
  serialNumber: string | null;
  version: number | null;
  componentName: string | null;
  componentVersion: string | null;
  componentPurl: string | null;
  componentCount: number;
  /** sha256 of the canonicalized payload */
  contentHash: string;
  rawDigest: string;
}

export interface QuarantineEntry {
  ref: string;
  name: string | null;
  reason: string;
  raw: unknown;
}

export type PolicyEffect = 'allow' | 'deny' | 'needs_exception';

export interface PolicyRule {
  id: string;
  policyVersion: number;
  /** SPDX license expression, e.g. "MIT", "(MIT OR Apache-2.0)", "GPL-3.0-only AND Classpath-exception-2.0" */
  licenseExpression: string;
  origin: 'external' | 'internal' | 'any';
  /** null => both direct & transitive */
  depKind: 'direct' | 'transitive' | null;
  /** null => any purpose */
  purpose: string | null;
  effect: PolicyEffect;
  priority: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface ExceptionRecord {
  id: number | null;
  componentPurl: string;
  componentVersion: string | null;
  policyVersion: number;
  purpose: string | null;
  reason: string;
  approver: string;
  expiresAt: string;
  createdAt: string;
  rowVersion: number;
  status: 'active' | 'expired';
}

export interface DecisionInput {
  component: Component;
  depKind: 'direct' | 'transitive';
  purpose: string | null;
  at: string;
}

export interface PolicyHit {
  ruleId: string;
  policyVersion: number;
  effect: PolicyEffect;
}

export interface ExceptionHit {
  id: number;
  policyVersion: number;
  reason: string;
  approver: string;
  expiresAt: string;
}

export interface Decision {
  purl: string;
  version: string | null;
  verdict: Verdict;
  policyHit: PolicyHit | null;
  exception: ExceptionHit | null;
  depKind: 'direct' | 'transitive';
  purpose: string | null;
  at: string;
  detail: string;
}

export interface DependencyPath {
  rootPurl: string;
  rootName: string;
  path: { purl: string; name: string; version: string | null }[];
}

export interface CandidateExport {
  candidateId: number;
  name: string;
  createdAt: string;
  frozenAt: string | null;
  status: 'draft' | 'frozen';
  summary: BomSummary;
  purpose: string | null;
  rootPurl: string;
  overallVerdict: Verdict | null;
  decisions: Decision[];
  /** only paths that terminate in a non-allowing component */
  flaggedPaths: DependencyPath[];
  evidenceRefs: { purl: string; evidence: ComponentEvidence }[];
}
