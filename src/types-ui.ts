export type {
  CandidateExport,
  Decision,
  DependencyPath,
  ExceptionRecord,
  PolicyRule,
  Verdict,
} from './shared/types.ts';

export interface QuarantineEntryLike {
  id: number;
  importId: number;
  ref: string;
  name: string | null;
  reason: string;
  raw: unknown;
  status: 'open' | 'resolved' | 'rejected';
  resolution: string | null;
}
