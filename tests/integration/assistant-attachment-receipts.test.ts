import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantActionPlanStore } from '../../src/server/assistant/action-plan-store.js';
import { createAssistantActionPlanService } from '../../src/server/assistant/action-plan-service.js';
import { createAssistantService } from '../../src/server/assistant/service.js';
import { createAssistantTools } from '../../src/server/assistant/attachment-tools.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';
import type { Attachment, AttachmentArchiveResult, AttachmentPages } from '../../src/shared/api/attachments.js';
import type { ReadService } from '../../src/server/services/read-service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

function fixture() {
  const database = new Database(':memory:'); applyMigrations(database);
  const id = randomUUID(); const operationId = randomUUID();
  const baseAttachment: Attachment = { id, name: '合成附件.txt', mediaType: 'text/plain', size: 12, sha256: 'a'.repeat(64), status: 'ready', pageCount: 1, textBytes: 12, createdAt: '2026-09-10', updatedAt: '2026-09-10' };
  const makeAttachment = (requestedId: string): Attachment => ({ ...structuredClone(baseAttachment), id: requestedId, ...(requestedId === id ? {} : { duplicateOf: id }) });
  const makePages = (requestedId: string): AttachmentPages => ({ id: requestedId, sha256: baseAttachment.sha256, textRevision: 'revision-1', pages: [{ page: 1, text: '附件正文' }], startPage: 1, endPage: 1, totalPages: 1, truncated: false });
  const makePreview = (requestedId: string) => ({ attachmentId: requestedId, attachmentSha256: baseAttachment.sha256, attachmentName: baseAttachment.name, archiveFields: { platform: '个人' as const, title: '合成附件', collectedAt: '2026-09-10' }, textRevision: 'revision-1', target: '01图书馆/来自个人/合成附件', mainName: '原文.md', mainSha256: 'b'.repeat(64), duplicate: requestedId !== id });
  let blocked = false;
  let release = () => {};
  let released = Promise.resolve();
  const blockArchive = () => { blocked = true; released = new Promise<void>(resolve => { release = resolve; }); };
  const port = {
    get: vi.fn((requestedId = id) => makeAttachment(requestedId)),
    readPages: vi.fn((selection: { id: string }) => makePages(selection.id)),
    preview: vi.fn(async (request: { id: string }) => makePreview(request.id)),
    archive: vi.fn(async (request: { id: string }) => {
      if (blocked) await released;
      const requestedId = request.id; const preview = makePreview(requestedId);
      return { id: requestedId, state: 'archived' as const, operationId: requestedId === id ? operationId : randomUUID(), materialPath: `${preview.target}/${preview.mainName}`, target: preview.target, indexed: true, duplicate: requestedId !== id } satisfies AttachmentArchiveResult;
    })
  };
  const store = createAssistantActionPlanStore(database);
  const actionPlans = createAssistantActionPlanService({ store, attachmentService: port });
  const run = vi.fn(async (input: AssistantRunInput) => {
    if (/归档/u.test(input.messages.at(-1)?.content ?? '')) await input.tools.find(tool => tool.name === 'archive_attachment')!.execute({ id });
    else input.emit({ type: 'text', text: '合成回答' });
  });
  const adapter: AssistantAdapter = { id: 'test', run, describe: async () => ({ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'test', name: 'Test', reasoningEfforts: [] }] }) };
  const service = createAssistantService({ database, adapters: [adapter], actionPlans, resolveAttachment: port.get,
    createTools: context => createAssistantTools({ ...context, readService: {} as ReadService, attachmentService: port }) });
  cleanups.push(async () => { release(); await service.close(); database.close(); });
  const request = (message = '请归档这个附件') => ({ clientRequestId: randomUUID(), message, providerId: 'test', model: 'test', scope: 'current' as const, attachments: [{ id }] });
  const settled = async (conversationId: string) => { await vi.waitFor(() => expect(service.get(conversationId).status).not.toBe('running')); return service.get(conversationId); };
  return { id, baseAttachment, database, port, service, run, request, settled, blockArchive, releaseArchive: () => release() };
}

it('requires confirmation before archive and projects one real receipt after confirmation', async () => {
  const f = fixture(); f.blockArchive();
  const start = await f.service.send(f.request()); const pending = await f.settled(start.id);
  const plan = pending.messages[1]!.actions.find(action => action.type === 'plan')!;
  expect(f.port.archive).not.toHaveBeenCalled();
  const confirmation = f.service.confirmAction(plan.id, randomUUID());
  await vi.waitFor(() => expect(f.port.archive).toHaveBeenCalledOnce());
  f.releaseArchive();
  const confirmed = await confirmation;
  expect(confirmed.messages[1]?.actions).toContainEqual(expect.objectContaining({ type: 'archive', status: 'archived', attachmentId: f.id }));
  expect(confirmed.messages[1]?.actions.filter(action => action.type === 'archive')).toHaveLength(1);
});

it('does not attribute a later confirmed archive to an earlier reading turn', async () => {
  const f = fixture();
  const first = await f.service.send({ ...f.request(), message: '请总结这个附件' }); await f.settled(first.id);
  const second = await f.service.send({ ...f.request(), conversationId: first.id }); const pending = await f.settled(first.id);
  const plan = pending.messages[3]!.actions.find(action => action.type === 'plan')!;
  const current = await f.service.confirmAction(plan.id, randomUUID());
  expect(current.messages[1]?.actions).toEqual([]);
  expect(current.messages[3]?.actions).toContainEqual(expect.objectContaining({ type: 'archive', attachmentId: f.id }));
  expect(second.id).toBe(first.id);
});

it('keeps attachment selections in request identity and never repeats an accepted archive on retry', async () => {
  const f = fixture();
  const request = f.request(); const start = await f.service.send(request); await f.settled(start.id);
  expect((await f.service.send(request)).id).toBe(start.id);
  expect(f.run).toHaveBeenCalledOnce();
  const plan = f.service.get(start.id).messages[1]!.actions.find(action => action.type === 'plan')!;
  await f.service.confirmAction(plan.id, randomUUID());
  expect(f.port.archive).toHaveBeenCalledOnce();
  await expect(f.service.send({ ...request, attachments: [{ id: f.id, startPage: 1, endPage: 1 }] })).rejects.toMatchObject({ code: 'ASSISTANT_REQUEST_CONFLICT' });
});

it('gives duplicate attachments distinct plan and receipt IDs', async () => {
  const f = fixture(); const duplicateId = randomUUID();
  f.run.mockImplementationOnce(async input => {
    const archive = input.tools.find(tool => tool.name === 'archive_attachment')!;
    await archive.execute({ id: f.id }); await archive.execute({ id: duplicateId });
  });
  const start = await f.service.send({ ...f.request(), attachments: [{ id: f.id }, { id: duplicateId }] });
  const pending = await f.settled(start.id); const plans = pending.messages[1]!.actions.filter(action => action.type === 'plan');
  expect(plans).toHaveLength(2); expect(new Set(plans.map(action => action.id)).size).toBe(2);
  for (const plan of plans) await f.service.confirmAction(plan.id, randomUUID());
  const receipts = f.service.get(start.id).messages[1]!.actions.filter(action => action.type === 'archive');
  expect(receipts).toHaveLength(2); expect(new Set(receipts.map(action => action.id)).size).toBe(2);
});

it('rejects a selection exceeding 16 MiB before starting a model or persisting a conversation', async () => {
  const f = fixture(); f.baseAttachment.size = 9 * 1024 * 1024;
  await expect(f.service.send({ ...f.request(), attachments: [{ id: f.id }, { id: randomUUID() }] })).rejects.toMatchObject({ code: 'ATTACHMENT_GROUP_TOO_LARGE', statusCode: 413 });
  expect(f.run).not.toHaveBeenCalled(); expect(f.port.archive).not.toHaveBeenCalled();
  expect(f.database.prepare('SELECT COUNT(*) AS count FROM assistant_conversations').get()).toEqual({ count: 0 });
  expect(f.database.prepare('SELECT COUNT(*) AS count FROM assistant_requests').get()).toEqual({ count: 0 });
});

it('allows an attachment selection exactly at the 16 MiB limit', async () => {
  const f = fixture(); f.baseAttachment.size = 8 * 1024 * 1024;
  const conversation = await f.service.send({ ...f.request(), message: '总结附件', attachments: [{ id: f.id }, { id: randomUUID() }] });
  expect((await f.settled(conversation.id)).status).toBe('idle');
  expect(f.run).toHaveBeenCalledOnce();
});
