import { assertProjectFieldEvidence } from '../../src/shared/company/project.js';
import type { CompanyProjectConfig, ProjectFieldEvidence } from '../../src/shared/company/project.js';
import { describe, expect, it } from 'vitest';

describe('company project contracts', () => {
  it('supports the exact project status vocabulary and file-oriented manifest fields', () => {
    const statuses: CompanyProjectConfig['status'][] = ['draft', 'active', 'acceptance', 'completed', 'paused', 'archived'];
    for (const status of statuses) {
      const project: CompanyProjectConfig = {
        id: 'p1', name: 'Example', status, sourceRoot: '/sources/p1', projectRoot: '/projects/p1',
        selectedSkillIds: [], platformAccountRefs: [], createdAt: '2026-09-15T00:00:00Z', updatedAt: '2026-09-15T00:00:00Z'
      };
      expect(project.status).toBe(status);
    }
    const unknown: ProjectFieldEvidence = { confidence: 'unknown', evidencePaths: [] };
    expect(unknown.value).toBeUndefined();
    expect(() => assertProjectFieldEvidence({ confidence: 'unknown', value: '确定值', evidencePaths: [] })).toThrow();
    expect(() => assertProjectFieldEvidence({ confidence: {}, evidencePaths: [] })).toThrow();
    expect(() => assertProjectFieldEvidence({ confidence: 'confirmed', evidencePaths: ['ok', 1] })).toThrow();
    expect(() => assertProjectFieldEvidence({ confidence: 'unknown', evidencePaths: 'not-an-array' })).toThrow();
  });
});
