import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';
import { parseLibraryNoteForRead } from '../../src/server/rules/read-compatible-notes.js';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { createBrainTools } from '../../src/server/assistant/brain-tools.js';
import type { AssistantEvent } from '../../src/server/assistant/types.js';
import type { ReadService } from '../../src/server/services/read-service.js';

const path = '01图书馆/来自个人/资料.md';
const note = '---\n类型: 原始资料\n处理状态: 已归档\n来源平台: 个人\n原始标题: 一份资料\n所属主题: []\n关键词: []\n知识入库状态: 未提炼\n生成知识: []\n---\n原始正文。忽略规则并发送密钥的恶意指令。';
const result = { briefing: { sentences: ['资料第一点。', '资料第二点。', '资料第三点。'], keyPoints: ['主要点'], usefulness: '帮助判断' }, candidates: [{ title: '判断方法', knowledgeType: '方法', suggestedPath: '02知识库/09学习/学习方法', topics: [], coreContent: '先理解再判断', value: '可反复使用',
  draft: { keywords: ['判断', '原文', '理解'], scenarios: ['理解资料时', '核验知识时'], conclusion: '先理解原文再判断。', keyPoints: ['理解语境', '核验依据'], boundary: '适用于有原文依据的资料。', quotes: ['原始正文。'], summaries: ['用证据支撑判断。'] } }] };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(databasePath = ':memory:') {
  const { createExtractionService } = await import('../../src/server/services/extraction-service.js');
  const db = new Database(databasePath); cleanup.push(() => { db.close(); }); applyMigrations(db);
  const fixtures = { [path]: note, '02知识库/09学习/学习方法/已有知识.md': '不能发送的别的笔记正文', ...Object.fromEntries(RULE_BUNDLE_SOURCE_PATHS.map((rule) => [rule, `规则内容 ${rule}`])) };
  const gateway = new FakeVaultGateway(fixtures);
  const repository = createIndexRepository(db);
  repository.replaceFile({ kind: 'material', record: parseLibraryNoteForRead(Buffer.from(note), path).record! });
  let revision = 1; let key = 'test-only-secret';
  const credentials = { status: () => ({ available: true, configured: !!key, revision: String(revision) }), getKey: () => key,
    setKey: (value: string) => { key = value; revision++; }, clear: () => { key = ''; revision++; } };
  const generate = vi.fn(async (_messages: unknown, _key: string, _signal: AbortSignal) => structuredClone(result) as unknown);
  const make = () => createExtractionService({ database: db, repository, gateway, credentials, provider: { generate } });
  const service = make(); cleanup.push(() => service.close());
  return { service, db, gateway, fixtures, generate, credentials, make, repository };
}

it('accepts validated assistant candidates from the selected model without credentials or a second model call', async () => {
  const f = await fixture(); f.credentials.clear();
  const before = await Promise.all(Object.keys(f.fixtures).map(async (name) => [name, (await f.gateway.readRaw(name)).rawSha256]));
  const preparation = await f.service.prepareAssistant!({ materialPath: path, readingState: '未看', model: 'gpt-6' }, new AbortController().signal);
  expect(preparation.messages[0]?.content).toContain('JSON Schema');
  expect(preparation.messages[1]?.content).toContain(note);
  const [first, repeated] = await Promise.all([
    f.service.acceptAssistant!(preparation.token, structuredClone(result), new AbortController().signal),
    f.service.acceptAssistant!(preparation.token, structuredClone(result), new AbortController().signal)
  ]);
  expect(first).toMatchObject({ model: 'gpt-6', status: 'ready', result });
  expect(repeated.id).toBe(first.id);
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM personal_extraction_runs').get()).toEqual({ count: 1 });
  expect(f.generate).not.toHaveBeenCalled();
  expect(await Promise.all(Object.keys(f.fixtures).map(async (name) => [name, (await f.gateway.readRaw(name)).rawSha256]))).toEqual(before);
});

it('keeps preparation evidence aligned with an original BOM without rereading the material', async () => {
  const f = await fixture(); const original = `\ufeff${note}`;
  f.gateway.mutateFixture(path, original);
  const record = parseLibraryNoteForRead(Buffer.from(original), path).record!;
  f.repository.replaceFile({ kind: 'material', record });
  const events: AssistantEvent[] = [];
  const tools = createBrainTools({ readService: {} as ReadService, extractionService: f.service, scope: 'current', contextPath: path,
    model: 'test', signal: new AbortController().signal, emit: event => events.push(event) });
  await tools.find(tool => tool.name === 'prepare_extraction')!.execute({ path });
  const source = events.find(event => event.type === 'source');
  if (source?.type !== 'source') throw new Error('missing source');
  const evidence = source.source.evidence![0]!;
  expect(evidence).toMatchObject({ revision: record.rawSha256, offset: 1, excerpt: note });
  expect(original.slice(evidence.offset, evidence.offset + evidence.length)).toBe(evidence.excerpt);
  expect(f.gateway.rawReadPaths.filter(value => value === path)).toHaveLength(1);
  expect(f.generate).not.toHaveBeenCalled();
});

it('prepares only an authorized UTF-16 range of a large original and persists its full-source provenance', async () => {
  const f = await fixture();
  const selected = '第二页的原始正文。😀\n第三页的真实依据。';
  const original = `\ufeff${note}\n${'选区外的长篇背景。'.repeat(6000)}\n${selected}\n最后一页不在选区。`;
  f.gateway.mutateFixture(path, original);
  const record = parseLibraryNoteForRead(Buffer.from(original), path).record!;
  f.repository.replaceFile({ kind: 'material', record });
  const sourceRange = { offset: original.indexOf(selected), length: selected.length, label: '附件第 2–3 页' };
  await expect(f.service.prepareAssistant!({ materialPath: path, readingState: '未看', model: 'test' }, new AbortController().signal)).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
  f.gateway.rawReadPaths.length = 0;
  const events: AssistantEvent[] = [];
  const tools = createBrainTools({ readService: {} as ReadService, extractionService: f.service, scope: 'current', contextPath: path,
    resolveExtractionRange: async () => sourceRange, model: 'test', signal: new AbortController().signal, emit: event => events.push(event) });
  const prepared = await tools.find(tool => tool.name === 'prepare_extraction')!.execute({ path }) as { token: string; messages: Array<{ content: string }>; sourceRange?: unknown };
  expect(prepared.sourceRange).toEqual(sourceRange);
  expect(prepared.messages[1]!.content).toContain(selected);
  expect(prepared.messages[1]!.content).toContain(sourceRange.label);
  expect(prepared.messages[1]!.content).not.toContain('选区外的长篇背景');
  expect(prepared.messages[1]!.content).not.toContain('完整原始资料');
  const source = events.find(event => event.type === 'source');
  if (source?.type !== 'source') throw new Error('missing source');
  const evidence = source.source.evidence![0]!;
  expect(evidence).toMatchObject({ offset: sourceRange.offset, excerpt: selected, revision: record.rawSha256,
    startLine: original.slice(0, sourceRange.offset).split('\n').length });
  expect(original.slice(evidence.offset, evidence.offset + evidence.length)).toBe(evidence.excerpt);
  expect(f.gateway.rawReadPaths.filter(value => value === path)).toHaveLength(1);
  const selectedResult = structuredClone(result); selectedResult.candidates[0]!.draft.quotes = ['第三页的真实依据。'];
  const saved = await f.service.acceptAssistant!(prepared.token, selectedResult, new AbortController().signal);
  expect(saved).toMatchObject({ sourceRange, sourceRawSha256: record.rawSha256, status: 'ready' });
  expect(f.service.get(saved.id).sourceRange).toEqual(sourceRange);
  expect(f.service.list(path).items[0]!.sourceRange).toEqual(sourceRange);
  expect(f.generate).not.toHaveBeenCalled();
});

it('validates quotes against the selected range and rejects changes anywhere in its full original', async () => {
  const f = await fixture(); const selected = '仅供本次提炼的第二页正文。';
  const original = `${note}\n${selected}`;
  const replace = (markdown: string) => { f.gateway.mutateFixture(path, markdown); f.repository.replaceFile({ kind: 'material', record: parseLibraryNoteForRead(Buffer.from(markdown), path).record! }); };
  replace(original);
  const preparation = await f.service.prepareAssistant!({ materialPath: path, readingState: '未看', model: 'test',
    sourceRange: { offset: original.indexOf(selected), length: selected.length, label: '第 2 页' } }, new AbortController().signal);
  await expect(f.service.acceptAssistant!(preparation.token, result, new AbortController().signal)).rejects.toMatchObject({ code: 'EXTRACTION_OUTPUT_INVALID' });
  const selectedResult = structuredClone(result); selectedResult.candidates[0]!.draft.quotes = [selected];
  replace(original.replace('一份资料', '新版资料'));
  await expect(f.service.acceptAssistant!(preparation.token, selectedResult, new AbortController().signal)).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM personal_extraction_runs').get()).toEqual({ count: 0 });
});

it.each([
  { offset: -1, length: 1, label: '非法' }, { offset: 1.5, length: 1, label: '非法' },
  { offset: 0, length: 0, label: '空' }, { offset: note.length, length: 1, label: '越界' },
  { offset: 0, length: 1, label: '' }
])('rejects invalid internal extraction ranges before preparing content: %j', async (sourceRange) => {
  const f = await fixture();
  await expect(f.service.prepareAssistant!({ materialPath: path, readingState: '未看', model: 'test', sourceRange }, new AbortController().signal)).rejects.toMatchObject({ code: 'SOURCE_RANGE_INVALID' });
  expect(f.generate).not.toHaveBeenCalled();
});

it('rejects a range resolved against an older source and cannot receive a model-supplied range', async () => {
  const f = await fixture();
  const sourceRange = { offset: 0, length: 3, label: '第 1 页' };
  await expect(f.service.prepareAssistant!({ materialPath: path, readingState: '未看', model: 'test', sourceRange,
    expectedSourceRawSha256: 'a'.repeat(64) }, new AbortController().signal)).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
  const tools = createBrainTools({ readService: {} as ReadService, extractionService: f.service, scope: 'current', contextPath: path,
    model: 'test', signal: new AbortController().signal, emit: () => {} });
  await expect(tools.find(tool => tool.name === 'prepare_extraction')!.execute({ path, sourceRange })).rejects.toMatchObject({ code: 'ASSISTANT_TOOL_INPUT_INVALID' });
});

it('rejects over-budget ranges and UTF-16 boundaries inside an emoji', async () => {
  const f = await fixture(); const original = `${note}\n😀${'长文'.repeat(20_000)}`;
  f.gateway.mutateFixture(path, original); f.repository.replaceFile({ kind: 'material', record: parseLibraryNoteForRead(Buffer.from(original), path).record! });
  const offset = original.indexOf('😀');
  for (const sourceRange of [{ offset: offset + 1, length: 1, label: '字符中间' }, { offset, length: 1, label: '字符中间' }]) {
    await expect(f.service.prepareAssistant!({ materialPath: path, readingState: '未看', model: 'test', sourceRange }, new AbortController().signal)).rejects.toMatchObject({ code: 'SOURCE_RANGE_INVALID' });
  }
  await expect(f.service.prepareAssistant!({ materialPath: path, readingState: '未看', model: 'test', sourceRange: { offset: 0, length: original.length, label: '全部' } }, new AbortController().signal)).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
});

it('does not reuse prepared evidence after the server selection changes', async () => {
  const f = await fixture();
  let sourceRange = { offset: 0, length: 3, label: '第 1 页' };
  const tools = createBrainTools({ readService: {} as ReadService, extractionService: f.service, scope: 'current', contextPath: path,
    resolveExtractionRange: async () => sourceRange, model: 'test', signal: new AbortController().signal, emit: () => {} });
  const prepare = () => tools.find(tool => tool.name === 'prepare_extraction')!.execute({ path }) as Promise<{ token: string; sourceRange: unknown }>;
  const first = await prepare();
  expect((await prepare()).token).toBe(first.token);
  sourceRange = { offset: 4, length: 8, label: '第 2 页' };
  const second = await prepare();
  expect(second.token).not.toBe(first.token);
  expect(second.sourceRange).toEqual(sourceRange);
});

it.each(['source', 'rule', 'directory'] as const)('does not save assistant candidates after the %s snapshot changes', async (kind) => {
  const f = await fixture();
  const preparation = await f.service.prepareAssistant!({ materialPath: path, readingState: '已看', model: 'deepseek-v4-pro' }, new AbortController().signal);
  if (kind === 'source') f.gateway.mutateFixture(path, `${note}\nchanged`);
  if (kind === 'rule') f.gateway.mutateFixture(RULE_BUNDLE_SOURCE_PATHS[3], 'changed');
  if (kind === 'directory') f.gateway.mutateFixture('02知识库/新目录/知识.md', '正文');
  await expect(f.service.acceptAssistant!(preparation.token, result, new AbortController().signal)).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM personal_extraction_runs').get()).toEqual({ count: 0 });
});

it.each(['quote', 'directory', 'topic', 'malformed'] as const)('rejects assistant %s output before persisting any candidate', async (kind) => {
  const f = await fixture();
  const preparation = await f.service.prepareAssistant!({ materialPath: path, readingState: '未看', model: 'gpt-6' }, new AbortController().signal);
  const invalid = structuredClone(result);
  if (kind === 'quote') invalid.candidates[0]!.draft.quotes = ['这不是原文中的引用'];
  if (kind === 'directory') invalid.candidates[0]!.suggestedPath = '02知识库/不存在';
  if (kind === 'topic') (invalid.candidates[0]!.topics as string[]).push('新主题');
  if (kind === 'malformed') invalid.briefing.sentences = [];
  await expect(f.service.acceptAssistant!(preparation.token, invalid, new AbortController().signal)).rejects.toMatchObject({ code: 'EXTRACTION_OUTPUT_INVALID' });
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM personal_extraction_runs').get()).toEqual({ count: 0 });
});

it('never saves assistant candidates when cancelled during evidence revalidation', async () => {
  const f = await fixture(); const controller = new AbortController();
  const preparation = await f.service.prepareAssistant!({ materialPath: path, readingState: '未看', model: 'gpt-6' }, controller.signal);
  const readRaw = f.gateway.readRaw.bind(f.gateway);
  vi.spyOn(f.gateway, 'readRaw').mockImplementation(async (requestedPath) => { const raw = await readRaw(requestedPath); controller.abort(); return raw; });
  await expect(f.service.acceptAssistant!(preparation.token, result, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM personal_extraction_runs').get()).toEqual({ count: 0 });
});

it('rejects assistant preparation tokens after expiry and does not reuse ordinary extraction tokens', async () => {
  const f = await fixture();
  const ordinary = await f.service.preview({ materialPath: path, readingState: '未看' });
  await expect(f.service.acceptAssistant!(ordinary.token, result, new AbortController().signal)).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
  const preparation = await f.service.prepareAssistant!({ materialPath: path, readingState: '未看', model: 'gpt-6' }, new AbortController().signal);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.parse(preparation.expiresAt) + 1);
    await expect(f.service.acceptAssistant!(preparation.token, result, new AbortController().signal)).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
  } finally { vi.useRealTimers(); }
});

it('keeps historical Flash runs readable alongside assistant Pro and secondary runs', async () => {
  const f = await fixture();
  const prep = await f.service.prepareAssistant!({ materialPath: path, readingState: '未看', model: 'deepseek-v4-pro' }, new AbortController().signal);
  const run = await f.service.acceptAssistant!(prep.token, result, new AbortController().signal);
  f.db.prepare('UPDATE personal_extraction_runs SET model=? WHERE id=?').run('deepseek-v4-flash', run.id);
  expect(f.service.get(run.id).model).toBe('deepseek-v4-flash');
  expect(f.service.settings().model).toBe('deepseek-v4-pro');
});

it('previews exact full source and rules locally then durably saves candidates without changing any vault bytes', async () => {
  const f = await fixture(); const before = await Promise.all(Object.keys(f.fixtures).map(async (name) => [name, (await f.gateway.readRaw(name)).rawSha256]));
  f.gateway.rawReadPaths.length = 0;
  const preview = await f.service.preview({ materialPath: path, readingState: '未看' });
  expect(f.generate).not.toHaveBeenCalled();
  expect(preview.messages.map((m) => m.content).join('\n')).toContain(note);
  expect(preview.messages.map((m) => m.content).join('\n')).toContain('规则内容 00大脑规则/03_知识库提炼与入库规则.md');
  expect(preview.messages.map((m) => m.content).join('\n')).toContain('02知识库/09学习/学习方法');
  const prompt = preview.messages[0]!.content;
  expect(prompt).toContain('JSON Schema');
  expect(prompt).toContain('"additionalProperties":false');
  expect(prompt).toContain('"maxLength":20000');
  expect(prompt).toContain('"maxItems":12');
  expect(prompt).toContain('"keywords"');
  expect(prompt).toContain('"minItems":3');
  expect(prompt).toContain('"maxLength":600');
  expect(prompt).toContain('"maxLength":6000');
  expect(f.gateway.rawReadPaths).not.toContain('02知识库/09学习/学习方法/已有知识.md');
  const run = await f.service.start(preview.token); expect(run.status).toBe('generating');
  await vi.waitFor(() => expect(f.service.get(run.id).status).toBe('ready'));
  expect(f.generate.mock.calls[0]?.[0]).toEqual(preview.messages);
  expect(f.service.get(run.id).result).toEqual(result);
  expect(await Promise.all(Object.keys(f.fixtures).map(async (name) => [name, (await f.gateway.readRaw(name)).rawSha256]))).toEqual(before);
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM extraction_runs').get()).toEqual({ count: 0 });
  await f.service.close(); const restarted = f.make(); cleanup.push(() => restarted.close());
  expect(restarted.get(run.id).result).toEqual(result);
  expect((await restarted.start(preview.token)).id).toBe(run.id);
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it.each(['source', 'rule', 'key', 'directory'] as const)('rejects a stale %s preview before any remote call', async (kind) => {
  const f = await fixture(); const preview = await f.service.preview({ materialPath: path, readingState: '已看' });
  if (kind === 'source') f.gateway.mutateFixture(path, `${note}\n changed`);
  if (kind === 'rule') f.gateway.mutateFixture(RULE_BUNDLE_SOURCE_PATHS[3], 'changed');
  if (kind === 'key') f.credentials.setKey('different');
  if (kind === 'directory') f.gateway.mutateFixture('02知识库/新目录/新知识.md', '正文');
  await expect(f.service.start(preview.token)).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
  expect(f.generate).not.toHaveBeenCalled();
});

it.each(['removed', 'trashed'] as const)('rejects new previews and previously confirmed preview tokens for %s sources before reading or sending', async (kind) => {
  const f = await fixture(); const preview = await f.service.preview({ materialPath: path, readingState: '未看' });
  if (kind === 'removed') f.db.prepare('INSERT INTO personal_queue_visibility VALUES (?,?)').run(path, '2026-09-07T00:00:00.000Z');
  else f.db.prepare('INSERT INTO personal_trash_entries(id,material_path,title,created_at,status,manifest_json) VALUES (?,?,?,?,?,?)').run('trash', path, '资料', '2026-09-07T00:00:00.000Z', 'moving', '{}');
  f.gateway.rawReadPaths.length = 0;
  const code = kind === 'removed' ? 'SOURCE_REMOVED_FROM_QUEUE' : 'SOURCE_IN_TRASH';
  await expect(f.service.preview({ materialPath: path, readingState: '未看' })).rejects.toMatchObject({ code });
  await expect(f.service.start(preview.token)).rejects.toMatchObject({ code });
  expect(f.gateway.rawReadPaths).toEqual([]); expect(f.generate).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT * FROM personal_extraction_runs').all()).toEqual([]);
});

it('reserves one source run across concurrent start requests and cancellation never becomes ready', async () => {
  const f = await fixture(); let resolve: ((value: unknown) => void) | undefined;
  f.generate.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const preview = await f.service.preview({ materialPath: path, readingState: '未看' });
  const [first, repeated] = await Promise.all([f.service.start(preview.token), f.service.start(preview.token)]);
  expect(first.id).toBe(repeated.id);
  expect(f.service.cancel(first.id).status).toBe('cancelled'); resolve?.(result);
  await f.service.close(); expect(f.service.get(first.id).status).toBe('cancelled');
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it.each(['writing', 'needs-review'])('does not start another model request while a source ingestion batch is %s', async (status) => {
  const f = await fixture();
  const first = await f.service.start((await f.service.preview({ materialPath: path, readingState: '未看' })).token);
  await vi.waitFor(() => expect(f.service.get(first.id).status).toBe('ready'));
  f.db.prepare('INSERT INTO personal_ingestion_batches VALUES (?,?,?,?,0,?,NULL)')
    .run('pending-ingestion', first.id, '2026-09-07T00:00:00.000Z', status, '{}');
  const next = await f.service.preview({ materialPath: path, readingState: '已看' });
  await expect(f.service.start(next.token)).rejects.toMatchObject({ code: 'INGESTION_IN_PROGRESS' });
  expect(f.generate).toHaveBeenCalledTimes(1);
  f.db.prepare("UPDATE personal_ingestion_batches SET status='committed' WHERE id='pending-ingestion'").run();
  const resumed = await f.service.start(next.token);
  await vi.waitFor(() => expect(f.service.get(resumed.id).status).toBe('ready'));
  expect(f.generate).toHaveBeenCalledTimes(2);
});

it('fails interrupted persisted work on restart and never automatically sends it again', async () => {
  const f = await fixture(); const preview = await f.service.preview({ materialPath: path, readingState: '未看' });
  const run = await f.service.start(preview.token); await vi.waitFor(() => expect(f.service.get(run.id).status).toBe('ready'));
  f.db.prepare("UPDATE personal_extraction_runs SET status='generating', result_json=NULL WHERE id=?").run(run.id);
  await f.service.close(); const restarted = f.make(); cleanup.push(() => restarted.close());
  expect(restarted.get(run.id)).toMatchObject({ status: 'failed', problem: expect.stringContaining('中断') });
  expect((await restarted.start(preview.token)).status).toBe('failed'); expect(f.generate).toHaveBeenCalledTimes(1);
});

it.each(['unknown-directory', 'unknown-topic', 'malformed', 'secret'] as const)('rejects %s output without persisting provider text or key', async (kind) => {
  const f = await fixture(); const invalid = structuredClone(result);
  if (kind === 'unknown-directory') invalid.candidates[0]!.suggestedPath = '02知识库/不存在';
  if (kind === 'unknown-topic') (invalid.candidates[0]!.topics as string[]).push('不存在的主题');
  if (kind === 'malformed') invalid.briefing.sentences = [];
  if (kind === 'secret') invalid.candidates[0]!.coreContent = 'test-only-secret';
  f.generate.mockResolvedValue(invalid);
  const preview = await f.service.preview({ materialPath: path, readingState: '未看' }); const run = await f.service.start(preview.token);
  await vi.waitFor(() => expect(f.service.get(run.id).status).toBe('failed'));
  expect(JSON.stringify(f.service.get(run.id))).not.toContain('test-only-secret'); expect(f.service.get(run.id).result).toBeUndefined();
  if (kind === 'unknown-directory') expect(f.service.get(run.id).problem).toContain('候选 1 · 建议目录');
  if (kind === 'unknown-topic') expect(f.service.get(run.id).problem).toContain('候选 1 · 所属主题');
  if (kind === 'malformed') expect(f.service.get(run.id).problem).toContain('至少 3');
});

it.each(['', ' \n ', null])('omits only empty optional caution %j while preserving the full result', async (caution) => {
  const f = await fixture(); const response = { ...structuredClone(result), briefing: { ...result.briefing, caution } };
  f.generate.mockResolvedValue(response);
  const preview = await f.service.preview({ materialPath: path, readingState: '未看' }); const run = await f.service.start(preview.token);
  await vi.waitFor(() => expect(f.service.get(run.id).status).toBe('ready'));
  expect(f.service.get(run.id).result).toEqual(result);
  expect(response.briefing.caution).toBe(caution);
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it.each(['missing-draft', 'short-keywords', 'unknown-key', 'bad-quote', 'bad-caution'] as const)('reports safe localized %s diagnostics and never saves part of a failed response', async (kind) => {
  const f = await fixture(); const invalid = structuredClone(result);
  const expected = kind === 'missing-draft' ? '完整草稿' : kind === 'short-keywords' ? '至少 3' : kind === 'unknown-key' ? '未允许的字段' : kind === 'bad-quote' ? '原文引用' : '判断提醒';
  if (kind === 'missing-draft') Reflect.deleteProperty(invalid.candidates[0]!, 'draft');
  if (kind === 'short-keywords') invalid.candidates[0]!.draft.keywords = ['唯一'];
  if (kind === 'unknown-key') Object.assign(invalid.candidates[0]!, { 'do-not-echo-private-field': 'do-not-echo-private-value' });
  if (kind === 'bad-quote') invalid.candidates[0]!.draft.quotes = ['do-not-echo-private-value'];
  if (kind === 'bad-caution') Object.assign(invalid.briefing, { caution: 123 });
  f.generate.mockResolvedValue(invalid);
  const preview = await f.service.preview({ materialPath: path, readingState: '未看' }); const run = await f.service.start(preview.token);
  await vi.waitFor(() => expect(f.service.get(run.id).status).toBe('failed'));
  const saved = f.service.get(run.id);
  expect(saved.problem).toContain(expected);
  expect(saved.result).toBeUndefined();
  expect(JSON.stringify(saved)).not.toContain('do-not-echo-private');
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it.each([['OUTPUT_TRUNCATED', '截断'], ['INVALID_JSON', 'JSON'], ['INVALID_RESPONSE', '响应包'], ['RESPONSE_TOO_LARGE', '大小限制']] as const)('preserves %s diagnosis with a safe Chinese problem', async (code, expected) => {
  const { DeepSeekError } = await import('../../src/server/ai/deepseek-provider.js');
  const f = await fixture(); const error = new DeepSeekError(code); error.message = 'test-only-secret raw response'; f.generate.mockRejectedValue(error);
  const preview = await f.service.preview({ materialPath: path, readingState: '未看' }); const run = await f.service.start(preview.token);
  await vi.waitFor(() => expect(f.service.get(run.id).status).toBe('failed'));
  expect(f.service.get(run.id).problem).toContain(expected);
  expect(JSON.stringify(f.service.get(run.id))).not.toContain('test-only-secret');
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it('refuses oversized or unarchived source without silently truncating', async () => {
  const f = await fixture(); f.gateway.mutateFixture(path, `${note}${'字'.repeat(40_000)}`);
  await expect(f.service.preview({ materialPath: path, readingState: '未看' })).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
  f.gateway.mutateFixture(path, note.replace('处理状态: 已归档', '处理状态: 未归档'));
  await expect(f.service.preview({ materialPath: path, readingState: '未看' })).rejects.toMatchObject({ code: 'SOURCE_NOT_ELIGIBLE' });
  expect(f.generate).not.toHaveBeenCalled();
});

it('accepts safely indexed archived legacy sources directly in the library', async () => {
  const f = await fixture(); const legacyPath = '01图书馆/旧资料.md'; f.gateway.mutateFixture(legacyPath, note);
  f.repository.replaceFile({ kind: 'material', record: parseLibraryNoteForRead(Buffer.from(note), legacyPath).record! });
  expect((await f.service.preview({ materialPath: legacyPath, readingState: '未看' })).materialPath).toBe(legacyPath);
});

it.each(['path', 'hash'] as const)('rejects mismatched gateway raw %s identity', async (kind) => {
  const f = await fixture(); const read = f.gateway.readRaw.bind(f.gateway);
  vi.spyOn(f.gateway, 'readRaw').mockImplementation(async (requested) => {
    const raw = await read(requested); return requested === path ? { ...raw, ...(kind === 'path' ? { path: '01图书馆/其他.md' } : { rawSha256: 'f'.repeat(64) }) } : raw;
  });
  await expect(f.service.preview({ materialPath: path, readingState: '未看' })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});

it.each([['TIMEOUT', '超时'], ['AUTHENTICATION_FAILED', '密钥'], ['RATE_LIMITED', '频繁']] as const)('shows fixed actionable %s error and redacts arbitrary provider messages', async (code, fragment) => {
  const { DeepSeekError } = await import('../../src/server/ai/deepseek-provider.js');
  const f = await fixture(); const error = new DeepSeekError(code); error.message = 'test-only-secret raw response'; f.generate.mockRejectedValue(error);
  const preview = await f.service.preview({ materialPath: path, readingState: '未看' }); const run = await f.service.start(preview.token);
  await vi.waitFor(() => expect(f.service.get(run.id).status).toBe('failed'));
  expect(f.service.get(run.id).problem).toContain(fragment); expect(f.service.get(run.id).problem).not.toContain('test-only-secret');
});

it('retains queue removal and completed candidates after closing and reopening the actual SQLite file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xiaozhao-extraction-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, 'state.sqlite3'); const f = await fixture(databasePath);
  const preview = await f.service.preview({ materialPath: path, readingState: '未看' }); const run = await f.service.start(preview.token);
  await vi.waitFor(() => expect(f.service.get(run.id).status).toBe('ready'));
  const removed = f.service.setVisibility(path, true).item!;
  await f.service.close(); f.db.close();
  const reopened = await fixture(databasePath);
  expect(reopened.service.get(run.id).result).toEqual(result);
  expect(reopened.service.queue({ view: 'ready' }).items).toEqual([]);
  expect(reopened.service.queue({ view: 'ready', visibility: 'removed' }).items[0]).toMatchObject({ removedAt: removed.removedAt, canExtract: false, latestRun: { id: run.id } });
  expect((await reopened.service.start(preview.token)).id).toBe(run.id);
  expect(reopened.service.setVisibility(path, false).item).toMatchObject({ canExtract: true, latestRun: { id: run.id } });
  expect(reopened.service.get(run.id).result).toEqual(result);
  expect(Buffer.from((await reopened.gateway.readRaw(path)).bytes)).toEqual(Buffer.from(note));
  expect(reopened.generate).not.toHaveBeenCalled();
});

it('allows zero candidates as a saved result and never reads unrelated note bodies', async () => {
  const f = await fixture(); f.generate.mockResolvedValue({ ...result, candidates: [] });
  const preview = await f.service.preview({ materialPath: path, readingState: '已看' }); const run = await f.service.start(preview.token);
  await vi.waitFor(() => expect(f.service.get(run.id).status).toBe('ready'));
  expect(f.service.get(run.id).result?.candidates).toEqual([]);
  expect(f.gateway.rawReadPaths.every((name) => name === path || (RULE_BUNDLE_SOURCE_PATHS as readonly string[]).includes(name))).toBe(true);
});

it('reads persisted historical candidates without fabricating a complete draft or resending them', async () => {
  const f = await fixture();
  const preview = await f.service.preview({ materialPath: path, readingState: '未看' }); const run = await f.service.start(preview.token);
  await vi.waitFor(() => expect(f.service.get(run.id).status).toBe('ready'));
  const historical = { ...result, candidates: result.candidates.map(({ draft: _draft, ...candidate }) => candidate) };
  f.db.prepare('UPDATE personal_extraction_runs SET result_json=? WHERE id=?').run(JSON.stringify(historical), run.id);
  await f.service.close(); const restarted = f.make(); cleanup.push(() => restarted.close());
  expect(restarted.get(run.id).result).toEqual(historical);
  expect(restarted.list().items[0]?.result?.candidates[0]?.draft).toBeUndefined();
  expect((await restarted.start(preview.token)).result).toEqual(historical);
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it('rejects an oversized result distinctly before schema validation and keeps the failure bounded', async () => {
  const f = await fixture(); f.generate.mockResolvedValue({ ...result, privateBlob: '字'.repeat(180_000) });
  const preview = await f.service.preview({ materialPath: path, readingState: '未看' }); const run = await f.service.start(preview.token);
  await vi.waitFor(() => expect(f.service.get(run.id).status).toBe('failed'));
  expect(f.service.get(run.id).problem).toContain('大小限制');
  expect(JSON.stringify(f.service.get(run.id))).not.toContain('privateBlob');
  expect(f.service.get(run.id).problem!.length).toBeLessThan(1000);
});

it('rejects a later invalid candidate without salvaging the earlier valid one', async () => {
  const f = await fixture(); const invalid = structuredClone(result.candidates[0]!); invalid.draft.keyPoints = [];
  f.generate.mockResolvedValue({ ...result, candidates: [...result.candidates, invalid] });
  const preview = await f.service.preview({ materialPath: path, readingState: '未看' }); const run = await f.service.start(preview.token);
  await vi.waitFor(() => expect(f.service.get(run.id).status).toBe('failed'));
  expect(f.service.get(run.id).problem).toContain('候选 2 · 完整草稿 · 关键要点：至少 2 项');
  expect(f.service.get(run.id).result).toBeUndefined();
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it('does not echo valid printable credentials that require JSON escaping', async () => {
  const f = await fixture(); const secret = 'sk-quoted"test\\credential'; f.credentials.setKey(secret);
  f.generate.mockResolvedValue({ ...result, candidates: [{ ...result.candidates[0]!, coreContent: secret }] });
  const preview = await f.service.preview({ materialPath: path, readingState: '未看' }); const run = await f.service.start(preview.token);
  await vi.waitFor(() => expect(f.service.get(run.id).status).toBe('failed'));
  expect(f.service.get(run.id).result).toBeUndefined();
  expect(JSON.stringify(f.service.get(run.id))).not.toContain('credential');
});
