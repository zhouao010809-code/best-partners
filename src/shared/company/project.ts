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

export interface ProjectFieldEvidence {
  readonly value?: string;
  readonly confidence: 'confirmed' | 'inferred' | 'unknown';
  readonly evidencePaths: readonly string[];
}
