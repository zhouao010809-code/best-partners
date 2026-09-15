export type CompanyProjectId = string;

export interface CompanyProjectConfig {
  readonly id: CompanyProjectId;
  readonly clientName?: string;
  readonly name: string;
  readonly status: 'draft' | 'active' | 'acceptance' | 'completed' | 'paused' | 'archived';
  readonly serviceStart?: string;
  readonly serviceEnd?: string;
  readonly sourceRoot: string;
  readonly projectRoot: string;
  readonly selectedSkillIds: readonly string[];
  readonly platformAccountRefs: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProjectFieldEvidence =
  | {
      readonly value?: string;
      readonly confidence: 'confirmed' | 'inferred';
      readonly evidencePaths: readonly string[];
    }
  | {
      readonly value?: never;
      readonly confidence: 'unknown';
      readonly evidencePaths: readonly string[];
    };

export function assertProjectFieldEvidence(value: unknown): asserts value is ProjectFieldEvidence {
  if (value === null || typeof value !== 'object') throw new Error('Invalid project field evidence');
  const candidate = value as { confidence?: unknown; value?: unknown; evidencePaths?: unknown };
  if (!['confirmed', 'inferred', 'unknown'].includes(String(candidate.confidence)) || !Array.isArray(candidate.evidencePaths)) {
    throw new Error('Invalid project field evidence');
  }
  if (candidate.confidence === 'unknown' && 'value' in candidate) throw new Error('Unknown evidence cannot contain a value');
  if (candidate.value !== undefined && typeof candidate.value !== 'string') throw new Error('Invalid project field evidence value');
}
