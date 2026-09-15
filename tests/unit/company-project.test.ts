import type { CompanyProjectConfig, ProjectFieldEvidence } from '../../src/shared/company/project.js';
import { describe, expect, it } from 'vitest';

describe('company project contracts', () => {
  it('supports the exact project status vocabulary and file-oriented manifest fields', () => {
    const project: CompanyProjectConfig = {
      id: 'p1', name: 'Example', status: 'draft', sourceRoot: '/sources/p1', projectRoot: '/projects/p1',
      selectedSkillIds: [], platformAccountRefs: [], createdAt: '2026-09-15T00:00:00Z', updatedAt: '2026-09-15T00:00:00Z'
    };
    expect(project.status).toBe('draft');
    const unknown: ProjectFieldEvidence = { confidence: 'unknown', evidencePaths: [] };
    expect(unknown.value).toBeUndefined();
    expect(unknown.confidence).not.toBe('confirmed');
  });
});
