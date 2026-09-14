import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';
import type { Attachment, AttachmentArchiveResult, AttachmentPages } from '../../src/shared/api/attachments.js';
import type { AttachmentService } from '../../src/server/attachments/service.js';

const host = '127.0.0.1:4317';
const origin = `http://${host}`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

it('wires the durable action plan service into the application and confirmation routes', async () => {
  const database = new Database(':memory:'); applyMigrations(database);
  const attachmentId = randomUUID();
  const attachment: Attachment = { id: attachmentId, name: '应用附件.txt', mediaType: 'text/plain', size: 12, sha256: 'a'.repeat(64), status: 'ready', pageCount: 1, textBytes: 12, createdAt: '2026-09-15', updatedAt: '2026-09-15' };
  const pages: AttachmentPages = { id: attachmentId, sha256: attachment.sha256, textRevision: 'r1', pages: [{ page: 1, text: '正文' }], startPage: 1, endPage: 1, totalPages: 1, truncated: false };
  const preview = { attachmentId, attachmentSha256: attachment.sha256, attachmentName: attachment.name, archiveFields: { platform: '个人' as const, title: '应用附件', collectedAt: '2026-09-15' }, textRevision: 'r1', target: '01图书馆/来自个人/应用附件', mainName: '原文.md', mainSha256: 'b'.repeat(64), duplicate: false };
  const archiveResult: AttachmentArchiveResult = { id: attachmentId, state: 'archived', operationId: randomUUID(), materialPath: `${preview.target}/${preview.mainName}`, target: preview.target, indexed: true, duplicate: false };
  const port = {
    get: vi.fn(() => structuredClone(attachment)),
    readPages: vi.fn(() => structuredClone(pages)),
    preview: vi.fn(async () => structuredClone(preview)),
    archive: vi.fn(async () => structuredClone(archiveResult)),
    close: vi.fn(async () => {})
  } as unknown as AttachmentService;
  const run = vi.fn(async (input: AssistantRunInput) => { await input.tools.find(tool => tool.name === 'archive_attachment')!.execute({ id: attachmentId }); });
  const adapter: AssistantAdapter = { id: 'test', run, describe: async () => ({ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'test', name: 'Test', reasoningEfforts: [] }] }) };
  const gateway = Object.assign(new FakeVaultGateway({}), { openInObsidian: async () => {} });
  const app = buildServer({ assistantAdapters: [adapter], attachmentService: port, readApi: {
    database, gateway, repository: createIndexRepository(database), currentIndexVersion: () => 1,
    indexScheduler: { requestFocusRefresh: async () => ({ generation: 1, outcome: 'succeeded' as const, refresh: { status: 'ready' as const, checked: 0, total: 0, version: 1 } }), snapshot: () => ({ state: { status: 'ready' as const, version: 1, refreshedAt: '2026-09-15T00:00:00Z' }, refresh: { status: 'ready' as const, checked: 0, total: 0, version: 1 } }) }
  } });
  cleanups.push(async () => { await app.close(); if (database.open) database.close(); });
  const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { host } });
  const headers = { host, origin, cookie: `${bootstrap.cookies[0]!.name}=${bootstrap.cookies[0]!.value}`, 'x-csrf-token': bootstrap.json().data.csrfToken as string };
  const started = await app.inject({ method: 'POST', url: '/api/v1/assistant/messages', headers, payload: { clientRequestId: randomUUID(), message: '请归档这个附件', providerId: 'test', model: 'test', scope: 'current', attachments: [{ id: attachmentId }] } });
  expect(started.statusCode).toBe(200);
  const conversationId = started.json().data.id as string;
  let conversation: { status: string; messages: Array<{ actions: Array<{ type: string; id: string }> }> } | undefined;
  await vi.waitFor(async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/assistant/conversations/${conversationId}`, headers: { host } });
    const body = response.json() as { data: { status: string; messages: Array<{ actions: Array<{ type: string; id: string }> }> } };
    conversation = body.data;
    expect(conversation.status).toBe('idle');
  });
  const plan = conversation!.messages[1]!.actions.find((action: { type: string }) => action.type === 'plan');
  expect(plan).toBeDefined(); expect(port.archive).not.toHaveBeenCalled();
  const confirmed = await app.inject({ method: 'POST', url: `/api/v1/assistant/action-plans/${plan!.id}/confirm`, headers, payload: { clientRequestId: randomUUID() } });
  expect(confirmed.statusCode).toBe(200); expect(port.archive).toHaveBeenCalledOnce();
  expect(confirmed.json().data.messages[1].actions).toContainEqual(expect.objectContaining({ type: 'archive', status: 'archived' }));
});
