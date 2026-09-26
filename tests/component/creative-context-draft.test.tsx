import { expect, it } from 'vitest';
import { draftFingerprint, editable } from '../../src/client/components/projects/useCreationDraft.js';

const draft = {
  id: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222',
  kind: 'script' as const, title: '测试稿件', brief: '', body: '尚未修改的正文', audience: '', angle: '', rationale: '',
  sources: [], revision: 1, createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z'
};

it('retains selected references in autosave and copy fields', () => {
  const scoped = { ...draft, referenceSelection: { mode: 'selected' as const, paths: ['采访/本次采访.md'] } };
  expect(editable(scoped)).toHaveProperty('referenceSelection', scoped.referenceSelection);
});

it('invalidates pending AI suggestions when references change without changing the manuscript', () => {
  const first = { ...draft, referenceSelection: { mode: 'selected' as const, paths: ['采访一.md'] } };
  const second = { ...draft, referenceSelection: { mode: 'selected' as const, paths: ['采访二.md'] } };
  expect(draftFingerprint(first)).not.toBe(draftFingerprint(second));
});

it('normalizes legacy drafts and explicitly automatic references to the same fingerprint', () => {
  expect(draftFingerprint(draft)).toBe(draftFingerprint({ ...draft, referenceSelection: { mode: 'auto' as const, paths: [] } }));
});
