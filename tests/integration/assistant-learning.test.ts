import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { assistantSendSchema } from '../../src/shared/api/assistant.js';
import { assistantDraftSaveSchema } from '../../src/shared/api/assistant-drafts.js';
import { buildServer } from '../../src/server/app.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantService } from '../../src/server/assistant/service.js';
import { createAssistantTools, type AssistantToolContext } from '../../src/server/assistant/tool-factory.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';
import { parseLibraryNoteForRead, parseKnowledgeNoteForRead } from '../../src/server/rules/read-compatible-notes.js';
import { readFileSync } from 'node:fs';
import { createAssistantDraftService } from '../../src/server/assistant/draft-service.js';
import { createReadService } from '../../src/server/services/read-service.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';

const path = '01图书馆/个人/原始资料.md';
const note = '---\n类型: 原始资料\n处理状态: 已归档\n来源平台: 个人\n原始标题: 原始资料\n所属主题: []\n关键词: []\n知识入库状态: 未提炼\n生成知识: []\n---\n第一段真实证据。\n第二段真实证据。';
const selection = { path, title: '原始资料', revision: createHash('sha256').update(note).digest('hex'), text: '第一段真实证据。' };
const request = () => ({ clientRequestId: randomUUID(), message: '请解释这段', providerId: 'test', model: 'test', scope: 'current' as const, contextPath: path, purpose: 'learning' as const, selection });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

it('accepts a trimmed learning snapshot and counts Unicode code points without truncation', () => {
  const parsed = assistantSendSchema.safeParse({ ...request(), selection: { ...selection, text: ` ${'😀'.repeat(6000)} ` } });
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data).toMatchObject({ selection: { text: '😀'.repeat(6000) } });
  expect(assistantSendSchema.safeParse({ ...request(), selection: { ...selection, text: '😀'.repeat(6001) } }).success).toBe(false);
  expect(assistantSendSchema.safeParse({ ...request(), selection: { ...selection, text: '   ' } }).success).toBe(false);
});

it('allows an unsent learning draft after removing its selection', () => {
  expect(assistantDraftSaveSchema.safeParse({ text: '', purpose: 'learning', scope: 'current', contextPath: path, attachments: [], groupId: randomUUID(), expectedRevision: 0, active: true }).success).toBe(true);
});

function fixture() {
  const database = new Database(':memory:'); applyMigrations(database);
  const gateway = new FakeVaultGateway({ [path]: note });
  const repository = createIndexRepository(database);
  repository.replaceFile({ kind: 'material', record: parseLibraryNoteForRead(Buffer.from(note), path).record! });
  const readService = createReadService({ database, repository, gateway, currentIndexVersion: () => 1, cursorSecret: Buffer.alloc(32, 1) });
  const run = vi.fn(async (input: AssistantRunInput) => { input.emit({ type: 'text', text: '这是解释。' }); });
  const adapter: AssistantAdapter = { id: 'test', describe: async () => ({ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'test', name: 'Test', reasoningEfforts: [] }] }), run };
  const createTools = vi.fn((context: AssistantToolContext) => createAssistantTools({ ...context, readService }));
  const options = { database, adapters: [adapter], readService, createTools };
  const service = createAssistantService(options);
  cleanup.push(async () => { await service.close(); database.close(); });
  return { database, gateway, service, run, createTools, readService, repository, options };
}
async function settled(service: ReturnType<typeof createAssistantService>, id: string) {
  await vi.waitFor(() => expect(service.get(id).status).not.toBe('running'));
  return service.get(id);
}

it('persists learning snapshots per message, injects only this selection, and restricts tools to the current document', async () => {
  const f = fixture();
  f.run.mockImplementation(async input => {
    expect(input.tools.map(tool => tool.name)).toEqual(['search_knowledge', 'search_materials', 'read_document']);
    await expect(input.tools.find(tool => tool.name === 'read_document')!.execute({ path: '02知识库/其他.md' })).rejects.toMatchObject({ code: 'ASSISTANT_SCOPE_LIMIT' });
    const read = await input.tools.find(tool => tool.name === 'read_document')!.execute({ path, length: 12 });
    expect(read).toMatchObject({ rawSha256: selection.revision });
    input.emit({ type: 'text', text: '这是解释 [S1]。' });
  });
  const start = await f.service.send(request()); const first = await settled(f.service, start.id);
  expect(first.status).toBe('idle');
  expect(first).toMatchObject({ purpose: 'learning', scope: 'current', contextPath: path, selection });
  expect(first.messages.every(message => message.purpose === 'learning' && message.selection?.revision === selection.revision)).toBe(true);
  expect(first.messages[0]?.sources).toEqual([]);
  expect(first.messages[1]?.sources[0]?.evidence?.[0]).toMatchObject({ revision: selection.revision, offset: 0, length: 12 });
  expect(f.run.mock.calls[0]![0].system).toContain(selection.text);
  expect(f.run.mock.calls[0]![0].system).toContain('通识');
  expect(f.run.mock.calls[0]![0].system).toContain('不是已核实的原文位置');
  expect(f.service.list().conversations[0]).toMatchObject({ purpose: 'learning', selection });
});

it('inherits learning purpose and source when follow-up omits selection and cannot unlock tools by omission', async () => {
  const f = fixture(); const start = await f.service.send(request()); await settled(f.service, start.id);
  const { purpose: _purpose, selection: _selection, contextPath: _contextPath, ...followup } = request();
  await f.service.send({ ...followup, conversationId: start.id, message: '说简单点' });
  const result = await settled(f.service, start.id);
  expect(result.messages[3]).toMatchObject({ purpose: 'learning', selection });
  expect(f.run.mock.calls[1]![0].tools.map(tool => tool.name)).toEqual(['search_knowledge', 'search_materials', 'read_document']);
  expect(f.run.mock.calls[1]![0].system).toContain(selection.text);
});

it('allows another selection only in the same document revision and preserves old message snapshots', async () => {
  const f = fixture(); const start = await f.service.send(request()); await settled(f.service, start.id);
  const nextSelection = { ...selection, text: '第二段真实证据。' };
  await f.service.send({ ...request(), conversationId: start.id, selection: nextSelection });
  const result = await settled(f.service, start.id);
  expect(result.selection).toEqual(nextSelection);
  expect(result.messages[1]?.selection).toEqual(selection);
  expect(result.messages[3]?.selection).toEqual(nextSelection);
  expect(f.run.mock.calls[1]![0].messages[0]?.content).toContain(selection.text);
  expect(f.run.mock.calls[1]![0].system).toContain(nextSelection.text);
  for (const changed of [{ scope: 'brain' as const }, { contextPath: '01图书馆/另一篇.md' }, { selection: { ...selection, revision: 'b'.repeat(64) } }]) {
    await expect(f.service.send({ ...request(), conversationId: start.id, ...changed })).rejects.toMatchObject({ code: 'ASSISTANT_LEARNING_CONFLICT' });
  }
});

it('refuses to mix an existing ordinary conversation into a new learning conversation', async () => {
  const f = fixture(); const { purpose: _purpose, selection: _selection, ...ordinary } = request();
  const start = await f.service.send(ordinary); await settled(f.service, start.id);
  await expect(f.service.send({ ...request(), conversationId: start.id })).rejects.toMatchObject({ code: 'ASSISTANT_LEARNING_CONFLICT' });
  expect(f.run).toHaveBeenCalledTimes(1);
});

it('rejects missing new selection, unbound snapshots, skills, attachments, and project scope', async () => {
  const f = fixture();
  const { selection: _selection, ...missing } = request();
  await expect(f.service.send(missing)).rejects.toMatchObject({ code: 'ASSISTANT_LEARNING_SELECTION_REQUIRED' });
  for (const changed of [{ purpose: undefined }, { scope: 'brain' as const }, { contextPath: '01图书馆/另一篇.md' }, { attachments: [{ id: randomUUID() }] }, { skillId: 'a'.repeat(64), skillRevision: 'b'.repeat(64) }, { scope: 'project' as const, contextPath: undefined, projectId: randomUUID(), projectRevision: 1 }]) {
    await expect(f.service.send({ ...request(), ...changed })).rejects.toMatchObject({ code: 'ASSISTANT_LEARNING_CONFLICT' });
  }
  expect(f.run).not.toHaveBeenCalled();
});

it.each(['changed', 'trashed', 'missing'])('fails before invoking the model when the selected source is %s and keeps the question retryable', async state => {
  const f = fixture();
  if (state === 'changed') f.gateway.mutateFixture(path, note + '\n已修改');
  else if (state === 'missing') f.gateway.deleteFixture(path);
  else f.database.prepare('INSERT INTO personal_trash_entries(id,material_path,title,created_at,status,manifest_json) VALUES (?,?,?,?,?,?)').run('trash', path, '资料', '2026-09-09T00:00:00.000Z', 'trashed', '{}');
  const start = await f.service.send(request()); const result = await settled(f.service, start.id);
  expect(result.status).toBe('failed'); expect(result.problem).toMatch(/重新打开|重新选择/u);
  if (state === 'changed') expect(result.problem).toContain('原文已更新');
  expect(result.messages[0]).toMatchObject({ text: '请解释这段', purpose: 'learning', selection });
  expect(f.run).not.toHaveBeenCalled(); expect(f.createTools).not.toHaveBeenCalled();
});

it('rechecks document versions on each read and current-document search without emitting stale evidence', async () => {
  const f = fixture();
  f.run.mockImplementation(async input => {
    f.gateway.mutateFixture(path, note + '\nNEW_PRIVATE_TEXT');
    for (const [name, args] of [['read_document', { path }], ['search_materials', { query: '原始资料' }]] as const) {
      await expect(input.tools.find(tool => tool.name === name)!.execute(args)).rejects.toMatchObject({ code: 'ASSISTANT_LEARNING_STALE' });
    }
    input.emit({ type: 'text', text: '请重新打开原文。' });
  });
  const start = await f.service.send(request()); const result = await settled(f.service, start.id);
  expect(result.status).toBe('idle');
  expect(result.messages[1]?.sources).toEqual([]);
});

it('keeps the original request fingerprint when resolving inherited learning context', async () => {
  const f = fixture(); const initial = request();
  const start = await f.service.send(initial); await settled(f.service, start.id);
  const { purpose: _purpose, selection: _selection, contextPath: _contextPath, ...base } = request();
  const followup = { ...base, conversationId: start.id };
  const a = await f.service.send(followup); await settled(f.service, a.id);
  expect((await f.service.send(followup)).id).toBe(a.id);
  expect(f.run).toHaveBeenCalledTimes(2);
  expect((await f.service.send(initial)).id).toBe(a.id);
});


it.each(['../secret.md', '/tmp/file.md', '00大脑规则/SKILL.md', '01图书馆/../secret.md', '01图书馆/.hidden.md', '02知识库/a.txt', '01图书馆/a\\b.md'])('rejects an invalid learning source path: %s', invalidPath => {
  expect(assistantSendSchema.safeParse({ ...request(), selection: { ...selection, path: invalidPath } }).success).toBe(false);
});

it('keeps learning draft snapshots across restart and removes only the pending selection when requested', () => {
  const f = fixture();
  const service = createAssistantDraftService({ database: f.database, projectExists: () => false });
  const id = randomUUID();
  const fields = { purpose: 'learning' as const, selection, text: '先保留我的问题', attachments: [], groupId: randomUUID(), scope: 'current' as const, contextPath: path, expectedRevision: 0, active: true as const };
  expect(service.save(id, fields).draft).toMatchObject({ purpose: 'learning', selection });
  const reopened = createAssistantDraftService({ database: f.database, projectExists: () => false });
  expect(reopened.list().drafts[0]).toMatchObject({ purpose: 'learning', selection, text: fields.text });
  const { selection: _selection, ...withoutSelection } = fields;
  expect(reopened.save(id, { ...withoutSelection, expectedRevision: 1 }).draft).not.toHaveProperty('selection');
  expect(reopened.list().drafts[0]?.text).toBe(fields.text);
});

it('retains the learning binding after service restart, including a follow-up that omits purpose', async () => {
  const f = fixture(); const start = await f.service.send(request()); await settled(f.service, start.id);
  await f.service.close();
  const reopened = createAssistantService(f.options);
  try {
    expect(reopened.get(start.id).messages[1]).toMatchObject({ purpose: 'learning', selection });
    const { purpose: _purpose, selection: _selection, contextPath: _path, ...base } = request();
    await reopened.send({ ...base, conversationId: start.id });
    expect((await settled(reopened, start.id)).messages[3]).toMatchObject({ purpose: 'learning', selection });
    await expect(reopened.send({ ...base, clientRequestId: randomUUID(), scope: 'brain', conversationId: start.id })).rejects.toMatchObject({ code: 'ASSISTANT_LEARNING_CONFLICT' });
    await expect(reopened.send({ ...base, clientRequestId: randomUUID(), conversationId: start.id, attachments: [{ id: randomUUID() }] })).rejects.toMatchObject({ code: 'ASSISTANT_LEARNING_CONFLICT' });
    await expect(reopened.send({ ...base, clientRequestId: randomUUID(), conversationId: start.id, skillId: 'a'.repeat(64), skillRevision: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'ASSISTANT_LEARNING_CONFLICT' });
  } finally { await reopened.close(); }
});

it('verifies indexed knowledge at send time and checks both knowledge tools against later version changes', async () => {
  const f = fixture(); const knowledgePath = '02知识库/学习/知识.md';
  const knowledge = readFileSync(new URL('../fixtures/knowledge-valid.md', import.meta.url), 'utf8');
  f.gateway.mutateFixture(knowledgePath, knowledge);
  f.repository.replaceFile({ kind: 'knowledge', record: parseKnowledgeNoteForRead(Buffer.from(knowledge), knowledgePath).record! });
  const snapshot = { path: knowledgePath, title: '知识', revision: createHash('sha256').update(knowledge).digest('hex'), text: '先用召回字段筛选，再按需读取正文。' };
  f.run.mockImplementation(async input => {
    const lookup = input.tools.find(tool => tool.name === 'search_knowledge')!;
    const read = input.tools.find(tool => tool.name === 'read_document')!;
    await expect(lookup.execute({ query: '召回' })).resolves.toMatchObject({ items: [{ path: knowledgePath }] });
    await expect(read.execute({ path: knowledgePath })).resolves.toMatchObject({ rawSha256: snapshot.revision });
    const changed = knowledge + '\n知识修改';
    f.gateway.mutateFixture(knowledgePath, changed);
    f.repository.replaceFile({ kind: 'knowledge', record: parseKnowledgeNoteForRead(Buffer.from(changed), knowledgePath).record! });
    await expect(lookup.execute({ query: '召回' })).rejects.toMatchObject({ code: 'ASSISTANT_LEARNING_STALE' });
    await expect(read.execute({ path: knowledgePath })).rejects.toMatchObject({ code: 'ASSISTANT_LEARNING_STALE' });
    input.emit({ type: 'text', text: '资料已变化，请重新选择。' });
  });
  const start = await f.service.send({ ...request(), contextPath: knowledgePath, selection: snapshot });
  const result = await settled(f.service, start.id);
  expect(result.status).toBe('idle');
  expect(result.messages[1]?.sources[0]?.evidence?.every(item => item.revision === snapshot.revision)).toBe(true);
});

it('stops while validating the source without making a model request or losing the selected text', async () => {
  const f = fixture();
  let release!: () => void;
  const realRead = f.readService.getDocumentDetail.bind(f.readService);
  vi.spyOn(f.readService, 'getDocumentDetail').mockImplementation(async requested => { await new Promise<void>(resolve => { release = resolve; }); return realRead(requested); });
  const start = await f.service.send(request());
  f.service.stop(start.id);
  const stopped = await settled(f.service, start.id);
  expect(stopped.status).toBe('stopped');
  expect(stopped.messages[0]).toMatchObject({ purpose: 'learning', selection });
  expect(f.run).not.toHaveBeenCalled();
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.run).not.toHaveBeenCalled();
});


it('wires learning source validation through the real HTTP application composition', async () => {
  const f = fixture();
  const app = buildServer({ assistantAdapters: f.options.adapters,
    readApi: { database: f.database, gateway: f.gateway, repository: f.repository, currentIndexVersion: () => 1,
      indexScheduler: {
        requestFocusRefresh: async () => ({ generation: 1, outcome: 'succeeded', refresh: { status: 'ready', checked: 0, total: 0, version: 1 } }),
        snapshot: () => ({ state: { status: 'ready', version: 1, refreshedAt: '2026-10-12T00:00:00Z' }, refresh: { status: 'ready', checked: 0, total: 0, version: 1 } })
      } }
  });
  try {
    const host = '127.0.0.1:4317'; const origin = `http://${host}`;
    const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { host } });
    const headers = { host, origin, cookie: `${bootstrap.cookies[0]!.name}=${bootstrap.cookies[0]!.value}`, 'x-csrf-token': bootstrap.json().data.csrfToken };
    const sent = await app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers, payload: request() });
    expect(sent.statusCode).toBe(200);
    const id = sent.json().data.id;
    await vi.waitFor(() => expect(f.service.get(id).status).toBe('idle'));
    expect(f.service.get(id).messages[1]).toMatchObject({ purpose: 'learning', selection });
    expect(f.run).toHaveBeenCalledOnce();
    f.gateway.deleteFixture(path);
    const unavailable = await app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers, payload: { ...request(), conversationId: id } });
    expect(unavailable.statusCode).toBe(200);
    await vi.waitFor(() => expect(f.service.get(id).status).toBe('failed'));
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.service.get(id).problem).toContain('重新打开');
  } finally { await app.close(); }
});
