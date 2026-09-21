import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantDraftService } from '../../src/server/assistant/draft-service.js';
import { listAssistantHistory } from '../../src/server/assistant/history.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';
import type { AssistantRunInput } from '../../src/server/assistant/types.js';
import type { SkillCatalogService } from '../../src/server/services/skill-catalog.js';
import { assistantActionSchema, assistantConversationSchema, assistantHistoryQuerySchema, assistantSendSchema } from '../../src/shared/api/assistant.js';
import { assistantDraftFieldsSchema, assistantDraftSaveSchema } from '../../src/shared/api/assistant-drafts.js';
import { projectFileDetailSchema, projectFileSchema, projectWriteActionSchema } from '../../src/shared/api/projects.js';

const host = '127.0.0.1:4317'; const origin = `http://${host}`;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(closeKernel = false, skillCatalog?: SkillCatalogService) {
  const database = new Database(':memory:'); applyMigrations(database);
  const run = vi.fn(async (input: AssistantRunInput) => { input.emit({ type: 'text', text: '连接成功' }); });
  const gateway = Object.assign(new FakeVaultGateway({}), { openInObsidian: async () => {} });
  const finalStates: string[] = [];
  const app = buildServer({ assistantAdapters: [{ id: 'test', describe: async () => ({ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'pro', name: 'Pro', reasoningEfforts: [] }] }), run }],
    ...(skillCatalog ? { skillCatalog } : {}),
    ...(closeKernel ? { onClose: () => { for (const row of database.prepare('SELECT payload FROM assistant_conversations').all() as Array<{payload:string}>) finalStates.push(JSON.parse(row.payload).status); database.close(); } } : {}),
    readApi: { database, gateway, repository: createIndexRepository(database), currentIndexVersion: () => 1, indexScheduler: {
      requestFocusRefresh: async () => ({ generation: 1, outcome: 'succeeded', refresh: { status: 'ready', checked: 0, total: 0, version: 1 } }),
      snapshot: () => ({ state: { status: 'ready', version: 1, refreshedAt: '2026-09-09T00:00:00Z' }, refresh: { status: 'ready', checked: 0, total: 0, version: 1 } })
    } } });
  cleanup.push(async () => { await app.close(); if (database.open) database.close(); });
  const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { host } });
  const headers = { host, origin, cookie: bootstrap.cookies[0]!.name + '=' + bootstrap.cookies[0]!.value, 'x-csrf-token': bootstrap.json().data.csrfToken };
  return { app, headers, run, finalStates };
}

it('accepts project-scoped assistant payloads while keeping legacy scopes and paths isolated', () => {
  const projectId = randomUUID();
  const base = { clientRequestId: randomUUID(), message: '评估下周选题', providerId: 'test', model: 'pro' };
  expect(assistantSendSchema.safeParse({ ...base, scope: 'project', projectId, projectRevision: 3 }).success).toBe(true);
  expect(assistantSendSchema.safeParse({ ...base, scope: 'project', projectId }).success).toBe(false);
  expect(assistantSendSchema.safeParse({ ...base, scope: 'project', projectId, projectRevision: 3, contextPath: '01图书馆/a.md' }).success).toBe(false);
  expect(assistantSendSchema.safeParse({ ...base, scope: 'brain', projectId, projectRevision: 3 }).success).toBe(false);
  expect(assistantSendSchema.safeParse({ ...base, scope: 'brain' }).success).toBe(true);
  expect(assistantSendSchema.safeParse({ ...base, scope: 'current', contextPath: '01图书馆/a.md' }).success).toBe(true);
  expect(assistantHistoryQuerySchema.safeParse({ projectId }).success).toBe(true);
  expect(assistantHistoryQuerySchema.safeParse({ path: '/private/project' }).success).toBe(false);
});

it('keeps project write actions and file payloads relative-path only', () => {
  const projectId = randomUUID();
  const action = projectWriteActionSchema.parse({
    id: randomUUID(), type: 'project-write', label: '保存项目草稿', status: 'pending',
    projectId, projectName: '项目 A', category: '内容草稿', targetPath: 'AI工作区/内容草稿/稿件.md',
    contentSha256: 'a'.repeat(64), sourceRevision: 1, summary: '摘要', createdAt: '2026-09-22T00:00:00.000Z', expiresAt: '2026-09-23T00:00:00.000Z'
  });
  expect(assistantActionSchema.parse(action)).toMatchObject({ type: 'project-write', projectId });
  expect(projectWriteActionSchema.safeParse({ ...action, targetPath: '/tmp/escape.md' }).success).toBe(false);
  expect(projectWriteActionSchema.safeParse({ ...action, targetPath: 'AI工作区\\稿件.md' }).success).toBe(false);
  expect(projectFileSchema.safeParse({ relativePath: '资料.md', kind: 'file', origin: 'source', parseStatus: 'readable' }).success).toBe(true);
  expect(projectFileSchema.safeParse({ relativePath: '/tmp/资料.md', kind: 'file', origin: 'source', parseStatus: 'readable' }).success).toBe(false);
  for (const unsafePath of ['C:/tmp/资料.md', '../资料.md', 'a/../资料.md', 'a\\资料.md', `a\u0000.md`, `a\u0001.md`]) {
    expect(projectFileSchema.safeParse({ relativePath: unsafePath, kind: 'file', origin: 'source', parseStatus: 'readable' }).success).toBe(false);
  }
  expect(projectFileDetailSchema.safeParse({ relativePath: '资料.md', kind: 'file', origin: 'source', parseStatus: 'readable', content: '正文', totalCharacters: 2, truncated: false }).success).toBe(true);
});

it('applies project isolation rules to assistant drafts', () => {
  const projectId = randomUUID();
  expect(assistantDraftFieldsSchema.safeParse({ text: '', attachments: [], groupId: randomUUID(), scope: 'project', projectId, projectRevision: 2 }).success).toBe(true);
  expect(assistantDraftSaveSchema.safeParse({ expectedRevision: 0, active: true, text: '', attachments: [], groupId: randomUUID(), scope: 'project', projectId }).success).toBe(false);
  expect(assistantDraftFieldsSchema.safeParse({ text: '', attachments: [], groupId: randomUUID(), scope: 'project', projectId, projectRevision: 2, contextPath: '01图书馆/a.md' }).success).toBe(false);
  expect(assistantDraftFieldsSchema.safeParse({ text: '', attachments: [], groupId: randomUUID(), scope: 'brain', projectId, projectRevision: 2 }).success).toBe(false);
  expect(assistantDraftFieldsSchema.safeParse({ text: '', attachments: [], groupId: randomUUID(), scope: 'brain' }).success).toBe(true);
  expect(assistantConversationSchema.safeParse({ id: randomUUID(), title: '项目', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z', status: 'idle', providerId: 'test', model: 'pro', scope: 'project', projectId, projectRevision: 2, messages: [] }).success).toBe(true);
});

it('lists global drafts separately from a requested project and validates project existence', () => {
  const database = new Database(':memory:');
  try {
    applyMigrations(database);
    const projectId = randomUUID();
    const service = createAssistantDraftService({ database, projectExists: id => id === projectId });
    const base = { expectedRevision: 0, active: true as const, text: '', attachments: [], groupId: randomUUID(), scope: 'brain' as const };
    service.save(randomUUID(), base);
    service.save(randomUUID(), { ...base, scope: 'project', projectId, projectRevision: 1 });
    expect(service.list().drafts).toHaveLength(1);
    expect(service.list({ projectId }).drafts).toHaveLength(1);
    expect(service.list({ projectId }).drafts[0]?.projectId).toBe(projectId);
    expect(() => service.save(randomUUID(), { ...base, scope: 'project', projectId: randomUUID(), projectRevision: 1 })).toThrow(/项目/);
  } finally {
    database.close();
  }
});

it('filters assistant history by projectId without accepting a path selector', () => {
  const database = new Database(':memory:');
  try {
    applyMigrations(database);
    const projectId = randomUUID();
    const now = '2026-09-22T00:00:00.000Z';
    const insert = database.prepare('INSERT INTO assistant_conversations (id, updated_at, payload) VALUES (?, ?, ?)');
    const conversation = (id: string, scope: 'brain' | 'project', project?: string) => ({ id, title: scope, createdAt: now, updatedAt: now, status: 'idle' as const, providerId: 'test', model: 'pro', scope, ...(project ? { projectId: project, projectRevision: 1 } : {}), messages: [] });
    insert.run(randomUUID(), now, JSON.stringify(conversation(randomUUID(), 'brain')));
    insert.run(randomUUID(), now, JSON.stringify(conversation(randomUUID(), 'project', projectId)));
    expect(listAssistantHistory(database).conversations).toHaveLength(2);
    expect(listAssistantHistory(database, { projectId }).conversations).toHaveLength(1);
    expect(() => listAssistantHistory(database, { path: '/private/project' } as never)).toThrow();
  } finally {
    database.close();
  }
});

it('protects AI calls with the existing origin/session/CSRF contract and validates messages', async () => {
  const f = await fixture(); const payload = { clientRequestId: randomUUID(), message: '只回复连接成功', providerId: 'test', model: 'pro', scope: 'brain' };
  expect((await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: { host, origin }, payload })).statusCode).toBe(401);
  expect((await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: { ...f.headers, 'x-csrf-token': 'bad' }, payload })).statusCode).toBe(403);
  expect((await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: f.headers, payload: { ...payload, unrestricted: true } })).statusCode).toBe(400);
  expect(f.run).not.toHaveBeenCalled();
  const response = await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: f.headers, payload });
  expect(response.statusCode).toBe(200);
  const id = response.json().data.id;
  await vi.waitFor(async () => { const result = await f.app.inject({ method: 'GET', url: `/api/v1/assistant/conversations/${id}`, headers: { host } }); expect(result.json().data.status).toBe('idle'); });
  expect(f.run).toHaveBeenCalledTimes(1);
  const history = await f.app.inject({ method: 'GET', url: '/api/v1/assistant/conversations', headers: { host } });
  expect(history.json().data.conversations).toHaveLength(1);
  const found = await f.app.inject({ method: 'GET', url: `/api/v1/assistant/conversations?${new URLSearchParams({ search: '连接成功', limit: '1' })}`, headers: { host } });
  expect(found.json().data).toMatchObject({ hasMore: false, conversations: [{ id }] });
  expect((await f.app.inject({ method: 'GET', url: '/api/v1/assistant/conversations?limit=101', headers: { host } })).statusCode).toBe(400);
  expect((await f.app.inject({ method: 'GET', url: '/api/v1/assistant/conversations?cursor=invalid', headers: { host } })).statusCode).toBe(400);
});

it('rejects unregistered project scope instead of routing it through global tools', async () => {
  const f = await fixture();
  const projectId = randomUUID();
  const response = await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: f.headers, payload: {
    clientRequestId: randomUUID(), message: '项目任务', providerId: 'test', model: 'pro', scope: 'project', projectId, projectRevision: 4
  } });
  expect(response.statusCode).toBe(404);
  expect(response.json().error.code).toBe('ASSISTANT_PROJECT_NOT_FOUND');
});

it('keeps skill fields strict and rejects stale confirmed skills before provider calls', async () => {
  const skillId = 'a'.repeat(64);
  const catalog = { get: vi.fn(async () => ({
    id: skillId,
    name: '公众号写作',
    description: '写作',
    revision: 'b'.repeat(64),
    folderId: null,
    folderName: null,
    markdown: '方法说明',
    references: []
  })) } as unknown as SkillCatalogService;
  const f = await fixture(false, catalog);
  const base = { clientRequestId: randomUUID(), message: 'test', providerId: 'test', model: 'pro', scope: 'brain' };

  expect((await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: f.headers, payload: { ...base, skillId } })).statusCode).toBe(400);
  expect((await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: f.headers, payload: {
    ...base, clientRequestId: randomUUID(), skillId, skillRevision: 'c'.repeat(64)
  } })).statusCode).toBe(409);
  expect(f.run).not.toHaveBeenCalled();
  expect(catalog.get).toHaveBeenCalledTimes(1);
});
it('exposes provider choices without starting inference and returns unavailable cleanly without services', async () => {
  const f = await fixture();
  const response = await f.app.inject({ method: 'GET', url: '/api/v1/assistant/providers', headers: { host } });
  expect(response.json().data.providers[0]).toMatchObject({ id: 'test', status: 'ready' }); expect(f.run).not.toHaveBeenCalled();
  const empty = buildServer();
  expect((await empty.inject({ method: 'GET', url: '/api/v1/assistant/providers', headers: { host } })).statusCode).toBe(503);
  await empty.close();
});

it('protects action-plan confirmation with the existing CSRF contract and strict UUID bodies', async () => {
  const f = await fixture();
  const planId = randomUUID();
  const clientRequestId = randomUUID();
  expect((await f.app.inject({ method: 'POST', url: `/api/v1/assistant/action-plans/${planId}/confirm`, headers: { host, origin }, payload: { clientRequestId } })).statusCode).toBe(401);
  expect((await f.app.inject({ method: 'POST', url: `/api/v1/assistant/action-plans/${planId}/confirm`, headers: { ...f.headers, 'x-csrf-token': 'bad' }, payload: { clientRequestId } })).statusCode).toBe(403);
  expect((await f.app.inject({ method: 'POST', url: `/api/v1/assistant/action-plans/${planId}/confirm`, headers: f.headers, payload: { clientRequestId, extra: true } })).statusCode).toBe(400);
  const unavailable = await f.app.inject({ method: 'POST', url: `/api/v1/assistant/action-plans/${planId}/confirm`, headers: f.headers, payload: { clientRequestId } });
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json().error.code).toBe('ASSISTANT_ACTION_UNAVAILABLE');
});

it('stops and persists the active answer before closing the state kernel', async () => {
  const f = await fixture(true); f.run.mockImplementation(() => new Promise(() => {}));
  const response = await f.app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers: f.headers,
    payload: { clientRequestId: randomUUID(), message: 'test', providerId: 'test', model: 'pro', scope: 'brain' } });
  expect(response.statusCode).toBe(200);
  await f.app.close();
  expect(f.finalStates).toEqual(['stopped']);
  expect(f.run.mock.calls[0]?.[0].signal.aborted).toBe(true);
});
