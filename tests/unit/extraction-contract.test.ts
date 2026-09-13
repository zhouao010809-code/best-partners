import { expect, it } from 'vitest';

it('keeps incomplete editable knowledge drafts separate from complete reusable knowledge', async () => {
  const { knowledgeContentDraftSchema, knowledgeContentSchema } = await import('../../src/shared/api/knowledge-content.js');
  const empty = { keywords: [], scenarios: [], conclusion: '', keyPoints: [], boundary: '', quotes: [], summaries: [] };
  expect(knowledgeContentDraftSchema.parse(empty)).toEqual(empty);
  expect(knowledgeContentSchema.safeParse(empty).success).toBe(false);
  const complete = { keywords: ['理解', '判断', '证据'], scenarios: ['阅读资料', '整理知识'], conclusion: '先核对证据再做判断。',
    keyPoints: ['明确来源', '确认边界'], boundary: '只适用于有证据的资料。', quotes: [], summaries: ['判断之前核对来源。'] };
  expect(knowledgeContentSchema.parse(complete)).toEqual(complete);
  for (const change of [{ keywords: ['一个'] }, { scenarios: ['一个'] }, { keyPoints: ['一个'] }, { summaries: [] }, { conclusion: ' ' }, { boundary: '字'.repeat(601) }, { secret: 'unknown' }]) {
    expect(knowledgeContentSchema.safeParse({ ...complete, ...change }).success).toBe(false);
  }
});

it('accepts historical candidates while requiring complete drafts for fresh generation', async () => {
  const contract = await import('../../src/shared/api/extraction.js');
  const candidate = { title: '知识', knowledgeType: '方法', suggestedPath: '02知识库/09学习', topics: [], coreContent: '内容', value: '价值' };
  const result = { briefing: { sentences: ['一句', '二句', '三句'], keyPoints: [], usefulness: '用途' }, candidates: [candidate] };
  expect(contract.extractionResultSchema.safeParse(result).success).toBe(true);
  expect(contract.extractionGenerationResultSchema.safeParse(result).success).toBe(false);
  const draft = { keywords: ['知识', '判断', '证据'], scenarios: ['判断时', '学习时'], conclusion: '先理解。', keyPoints: ['理解', '核验'], boundary: '只用于学习。', quotes: [], summaries: ['先核验，再判断。'] };
  expect(contract.extractionGenerationResultSchema.parse({ ...result, candidates: [{ ...candidate, draft }] }).candidates[0]!.draft).toEqual(draft);
  expect(contract.extractionResultSchema.safeParse({ ...result, candidates: [{ ...candidate, draft: { ...draft, unknown: 'private' } }] }).success).toBe(false);
});

it('exposes strict bounded preview, candidate and settings contracts without a returned secret', async () => {
  const contract = await import('../../src/shared/api/extraction.js');
  expect(contract.extractionPreviewRequestSchema.parse({ materialPath: '01图书馆/来自个人/资料.md', readingState: '未看' })).toEqual({ materialPath: '01图书馆/来自个人/资料.md', readingState: '未看' });
  expect(contract.extractionPreviewRequestSchema.safeParse({ materialPath: 'x', readingState: '未看', content: 'override' }).success).toBe(false);
  const settings = { available: true, configured: false, providerHost: 'api.deepseek.com', model: 'deepseek-v4-flash' };
  expect(contract.deepSeekSettingsResponseSchema.safeParse({ data: settings, version: 1 }).success).toBe(true);
  expect(contract.deepSeekSettingsResponseSchema.safeParse({ data: { ...settings, apiKey: 'secret' }, version: 1 }).success).toBe(false);
  const verification = { status: 'verified', checkedAt: '2026-09-09T03:00:00.000Z', message: '连接成功。' };
  expect(contract.deepSeekSettingsResponseSchema.safeParse({ data: { ...settings, configured: true, verification }, version: 1 }).success).toBe(true);
  for (const change of [{ status: 'pending' }, { checkedAt: 'yesterday' }, { message: 'x'.repeat(1001) }, { apiKey: 'secret' }]) {
    expect(contract.deepSeekSettingsResponseSchema.safeParse({ data: { ...settings, verification: { ...verification, ...change } }, version: 1 }).success).toBe(false);
  }
  const result = { briefing: { sentences: ['一句', '二句', '三句'], keyPoints: ['要点'], usefulness: '帮助判断' }, candidates: [] };
  expect(contract.extractionResultSchema.safeParse(result).success).toBe(true);
  expect(contract.extractionResultSchema.safeParse({ ...result, briefing: { ...result.briefing, sentences: [] } }).success).toBe(false);
  expect(contract.extractionResultSchema.safeParse({ ...result, candidates: [{ title: '知识', knowledgeType: '方法', suggestedPath: '../../文件', topics: [], coreContent: '内容', value: '价值' }] }).success).toBe(false);
  const run = { id: '11111111-1111-4111-8111-111111111111', materialPath: '01图书馆/来自个人/资料.md', title: '资料', readingState: '未看', sourceRawSha256: 'a'.repeat(64), ruleFingerprint: 'b'.repeat(64), model: 'deepseek-v4-flash', createdAt: '2026-09-06T00:00:00.000Z', status: 'ready' };
  expect(contract.extractionRunSchema.safeParse(run).success).toBe(false);
  expect(contract.extractionRunSchema.safeParse({ ...run, result }).success).toBe(true);
  expect(contract.extractionRunSchema.safeParse({ ...run, status: 'failed', result }).success).toBe(false);
});
