import { expect, it, vi } from 'vitest';
import { createBrainTools } from '../../src/server/assistant/brain-tools.js';
import type { ReadService } from '../../src/server/services/read-service.js';
import type { ExtractionService } from '../../src/server/services/extraction-service.js';
import type { AssistantEvent } from '../../src/server/assistant/types.js';
import { randomUUID } from 'node:crypto';
import { PublicApiError } from '../../src/shared/api/errors.js';
import type { AssistantExtractionPreparation } from '../../src/server/services/extraction-service.js';

const material = '01图书馆/个人/资料.md';
const knowledge = '02知识库/学习/知识.md';
function fixture(options: { scope?: 'brain' | 'current'; contextPath?: string } = {}) {
  const read = { listKnowledge: vi.fn(() => ({ items: [] })), listMaterials: vi.fn(() => ({ items: [] })),
    getKnowledgeDetail: vi.fn(async (path) => ({ path, title: '知识', markdown: '知识正文', versionMarker: { rawSha256: 'a'.repeat(64) } })),
    getDocumentDetail: vi.fn(async (path) => ({ path, title: '资料', markdown: '证据'.repeat(15_000), versionMarker: { rawSha256: 'a'.repeat(64) } })) };
  const controller = new AbortController(); const events: AssistantEvent[] = [];
  const tools = createBrainTools({ readService: read as unknown as ReadService, scope: options.scope ?? 'brain',
    ...(options.contextPath ? { contextPath: options.contextPath } : {}), model: 'gpt-6', signal: controller.signal, emit: (event) => events.push(event) });
  return { read, tools, controller, events, execute: (name: string, input: unknown) => tools.find((tool) => tool.name === name)!.execute(input) };
}

it.each(['../secrets.md', '/tmp/secrets.md', '00大脑规则/SKILL.md', '01图书馆/../知识.md', '01图书馆/.hidden.md', '01图书馆/file.txt'])('rejects forbidden path %s before reading', async (path) => {
  const f = fixture();
  await expect(f.execute('read_document', { path })).rejects.toMatchObject({ code: 'ASSISTANT_PATH_NOT_ALLOWED' });
  expect(f.read.getDocumentDetail).not.toHaveBeenCalled();
});

it('restricts the current scope on the server and never searches other documents', async () => {
  const f = fixture({ scope: 'current', contextPath: material });
  await expect(f.execute('read_document', { path: knowledge })).rejects.toMatchObject({ code: 'ASSISTANT_SCOPE_LIMIT' });
  expect(await f.execute('search_knowledge', { query: '所有知识' })).toEqual({ items: [], scope: 'current' });
  expect(f.read.listKnowledge).not.toHaveBeenCalled();
  expect(f.read.listMaterials).not.toHaveBeenCalled();
  expect(f.read.getKnowledgeDetail).not.toHaveBeenCalled();
});

it('bounds fragments, reports truncation, deduplicates sources and limits document count', async () => {
  const f = fixture();
  const result = await f.execute('read_document', { path: material, length: 100 });
  expect(result).toMatchObject({ sourceId: 'S1', markdown: '证据'.repeat(50), truncated: true, nextOffset: 100 });
  await f.execute('read_document', { path: material, offset: 100, length: 50 });
  const sourceUpdates = f.events.filter((event) => event.type === 'source');
  expect(new Set(sourceUpdates.map(event => event.source.id)).size).toBe(1);
  expect(sourceUpdates.at(-1)?.source.evidence).toHaveLength(2);
  for (let i = 0; i < 9; i++) await f.execute('read_document', { path: `01图书馆/资料${i}.md`, length: 1 });
  await expect(f.execute('read_document', { path: '01图书馆/第十一篇.md' })).rejects.toMatchObject({ code: 'ASSISTANT_READ_LIMIT' });
  await expect(f.execute('read_document', { path: material, length: 12_001 })).rejects.toMatchObject({ code: 'ASSISTANT_TOOL_INPUT_INVALID' });
});

it('searches all library states and excludes obsolete knowledge in the query', async () => {
  const f = fixture();
  await f.execute('search_knowledge', { query: '方法', limit: 3 });
  expect(f.read.listKnowledge).toHaveBeenCalledWith({ search: '方法', includeObsolete: false, limit: 3 });
  await f.execute('search_materials', { query: '资料', limit: 3 });
  expect(f.read.listMaterials.mock.calls).toEqual([
    [{ title: '资料', status: '未提炼', limit: 3 }], [{ title: '资料', status: '部分入库', limit: 3 }], [{ title: '资料', status: '已入库', limit: 3 }]
  ]);
});

it('upgrades a search citation with exact read fragments and original markdown positions', async () => {
  const f = fixture({ scope: 'current', contextPath: material });
  const markdown = '# 资料\n第一行😀\n第二行证据\n末行';
  f.read.getDocumentDetail.mockImplementation(async path => ({ path, title: '资料', markdown, versionMarker: { rawSha256: 'b'.repeat(64) } }));
  await f.execute('search_materials', { query: '资料' });
  expect(f.events.find(event => event.type === 'source')).toMatchObject({ source: { id: 'S1', kind: 'search' } });
  const offset = markdown.indexOf('第二行');
  await f.execute('read_document', { path: material, offset, length: 5 });
  expect(f.events.filter(event => event.type === 'source').at(-1)).toMatchObject({ source: { id: 'S1', kind: 'read', evidence: [{ excerpt: markdown.slice(offset, offset + 5), revision: 'b'.repeat(64), offset, length: 5, startLine: 3, endLine: 3 }] } });
  await f.execute('search_materials', { query: '资料' });
  expect(f.events.filter(event => event.type === 'source').at(-1)).toMatchObject({ source: { kind: 'read' } });
});

it('does no reading or preparation after cancellation', async () => {
  const f = fixture(); f.controller.abort();
  await expect(f.execute('read_document', { path: material })).rejects.toMatchObject({ name: 'AbortError' });
  await expect(f.execute('prepare_extraction', { path: material })).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.read.getDocumentDetail).not.toHaveBeenCalled();
});

it('passes the selected model into candidate preparation without calling another provider', async () => {
  const preparation = { token: 'c2cc4b8d-68a8-4710-b0c4-7fba35b3f3d8', materialPath: material, title: '资料', model: 'gpt-6', messages: [{ role: 'user', content: '资料' }] };
  const prepareAssistant = vi.fn(async () => preparation); const acceptAssistant = vi.fn();
  const tools = createBrainTools({ readService: {} as ReadService, extractionService: { prepareAssistant, acceptAssistant } as unknown as ExtractionService,
    scope: 'current', contextPath: material, model: 'gpt-6', signal: new AbortController().signal, emit: vi.fn() });
  expect(await tools.find((tool) => tool.name === 'prepare_extraction')!.execute({ path: material })).toEqual({ ...preparation, sourceId: 'S1' });
  expect(prepareAssistant).toHaveBeenCalledWith({ materialPath: material, readingState: '未看', model: 'gpt-6' }, expect.any(AbortSignal));
  expect(acceptAssistant).not.toHaveBeenCalled();
});

it('uses the exact preparation snapshot for a read preview without another document read', async () => {
  const preparation = { token: 'c2cc4b8d-68a8-4710-b0c4-7fba35b3f3d8', materialPath: material, title: '资料', model: 'gpt-6', messages: [{ role: 'user', content: '原文已在这个提示中' }], sourceEvidence: { markdown: '# 原文\n真实内容', revision: 'c'.repeat(64) } };
  const emit = vi.fn();
  const tools = createBrainTools({ readService: {} as ReadService, extractionService: { prepareAssistant: async () => preparation, acceptAssistant: vi.fn() } as unknown as ExtractionService,
    scope: 'current', contextPath: material, model: 'gpt-6', signal: new AbortController().signal, emit });
  const result = await tools.find(tool => tool.name === 'prepare_extraction')!.execute({ path: material });
  expect(result).not.toHaveProperty('sourceEvidence');
  expect(emit).toHaveBeenCalledWith({ type: 'source', source: { id: 'S1', path: material, title: '资料', kind: 'read', evidence: [{ excerpt: '# 原文\n真实内容', revision: 'c'.repeat(64), offset: 0, length: 9, startLine: 1, endLine: 2 }] } });
});


it('never returns a source identifier beyond the visible citation budget', async () => {
  const f = fixture();
  let batch = 0;
  f.read.listMaterials.mockImplementation(((query: { status: string }) => ({ items: query.status !== '未提炼' ? [] : Array.from({ length: 10 }, (_, i) => ({
    path: `01图书馆/资料${batch * 10 + i}.md`, title: `资料${batch * 10 + i}`, sourcePlatform: '本地', knowledgeStatus: '未提炼'
  })) })) as never);
  for (batch = 0; batch < 5; batch++) await f.execute('search_materials', { query: '资料', limit: 10 });
  expect(new Set(f.events.filter(event => event.type === 'source').map(event => event.source.id)).size).toBe(50);
  await expect(f.execute('search_materials', { query: '资料', limit: 10 })).rejects.toMatchObject({ code: 'ASSISTANT_SOURCE_LIMIT' });
  await expect(f.execute('read_document', { path: '01图书馆/未注册.md', length: 1 })).rejects.toMatchObject({ code: 'ASSISTANT_SOURCE_LIMIT' });
  expect(await f.execute('read_document', { path: '01图书馆/资料0.md', length: 1 })).toMatchObject({ sourceId: 'S1' });
  expect(new Set(f.events.filter(event => event.type === 'source').map(event => event.source.id)).size).toBe(50);
});

function extractionFixture() {
  const result = { briefing: { sentences: ['证据说明一', '证据说明二', '证据说明三'], keyPoints: [], usefulness: '本次没有可复用知识' }, candidates: [] };
  const prepareAssistant = vi.fn(async ({ materialPath, readingState, model }: { materialPath: string; readingState: '未看' | '已看'; model: string }): Promise<AssistantExtractionPreparation> => ({
    token: randomUUID(), materialPath, readingState, model, title: '资料', sourceRawSha256: 'a'.repeat(64), ruleFingerprint: 'b'.repeat(64),
    messages: [{ role: 'user', content: '完整证据' }], directories: ['02知识库/学习'], expiresAt: new Date(Date.now() + 600_000).toISOString()
  }));
  const acceptAssistant = vi.fn(async () => ({ id: randomUUID(), materialPath: material, title: '资料', model: 'test', result }));
  const events: AssistantEvent[] = [];
  const tools = createBrainTools({ readService: {} as ReadService, extractionService: { prepareAssistant, acceptAssistant } as unknown as ExtractionService,
    scope: 'brain', model: 'test', signal: new AbortController().signal, emit: event => events.push(event) });
  return { result, prepareAssistant, acceptAssistant, events, execute: (name: string, value: unknown) => tools.find(tool => tool.name === name)!.execute(value) };
}

it('refreshes the source preparation after PREVIEW_STALE and retires its old token', async () => {
  const f = extractionFixture();
  const first = await f.execute('prepare_extraction', { path: material }) as { token: string };
  f.acceptAssistant.mockRejectedValueOnce(new PublicApiError('PREVIEW_STALE', '原文已变化，请重新准备。', 409));
  await expect(f.execute('submit_candidates', { token: first.token, result: f.result })).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
  const refreshed = await f.execute('prepare_extraction', { path: material }) as { token: string };
  expect(f.prepareAssistant).toHaveBeenCalledTimes(2);
  expect(refreshed.token).not.toBe(first.token);
  await expect(f.execute('submit_candidates', { token: first.token, result: f.result })).rejects.toMatchObject({ code: 'ASSISTANT_PREPARATION_REQUIRED' });
  await expect(f.execute('submit_candidates', { token: refreshed.token, result: f.result })).resolves.toMatchObject({ candidateCount: 0 });
});

it('caches a preparation by reading state and retains valid evidence after a result validation error', async () => {
  const f = extractionFixture();
  const unread = await f.execute('prepare_extraction', { path: material, readingState: '未看' }) as { token: string };
  const read = await f.execute('prepare_extraction', { path: material, readingState: '已看' }) as { token: string; readingState: string };
  expect(read.token).not.toBe(unread.token);
  expect(read.readingState).toBe('已看');
  expect(f.prepareAssistant).toHaveBeenCalledTimes(2);
  f.acceptAssistant.mockRejectedValueOnce(new PublicApiError('EXTRACTION_RESULT_INVALID', '请修正候选字段。', 400));
  await expect(f.execute('submit_candidates', { token: read.token, result: f.result })).rejects.toMatchObject({ code: 'EXTRACTION_RESULT_INVALID' });
  expect(await f.execute('prepare_extraction', { path: material, readingState: '已看' })).toMatchObject({ token: read.token });
  expect(f.prepareAssistant).toHaveBeenCalledTimes(2);
});

it('emits an empty completion with a briefing link when no candidates were saved', async () => {
  const f = extractionFixture();
  const preparation = await f.execute('prepare_extraction', { path: material }) as { token: string };
  const saved = await f.execute('submit_candidates', { token: preparation.token, result: f.result });
  expect(saved).toMatchObject({ candidateCount: 0, action: { status: 'empty', candidateCount: 0, label: '查看导读' } });
  expect(f.events.find(event => event.type === 'action')).toMatchObject({ action: { status: 'empty', label: '查看导读', committedCount: 0, discardedCount: 0 } });
});
