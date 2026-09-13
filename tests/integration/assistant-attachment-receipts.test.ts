import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantService } from '../../src/server/assistant/service.js';
import { createAssistantTools } from '../../src/server/assistant/attachment-tools.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';
import type { Attachment } from '../../src/shared/api/attachments.js';
import type { ReadService } from '../../src/server/services/read-service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function fixture() {
  const database = new Database(':memory:'); applyMigrations(database);
  const id = randomUUID(), operationId = randomUUID(), materialPath = '01图书馆/来自个人/合成附件/原文.md';
  const attachment: Attachment = { id, name: '合成附件.txt', mediaType: 'text/plain', size: 12, sha256: 'a'.repeat(64), status: 'ready', pageCount: 1, textBytes: 12, createdAt: '2026-09-10', updatedAt: '2026-09-10' };
  let release = () => {};
  const deferred = new Promise<void>(resolve => { release = resolve; });
  const port = {
    get: vi.fn((requestedId = id) => ({ ...structuredClone(attachment), id: requestedId, ...(requestedId !== id ? { duplicateOf: id } : {}) })), readPages: vi.fn(),
    archive: vi.fn(async () => {
      // Simulate an irreversible archive rename followed by a slow index refresh.
      await deferred;
      attachment.archive = { state: 'archived', operationId, materialPath, target: '01图书馆/来自个人/合成附件', indexed: true };
      return { id, ...attachment.archive, state: 'archived' as const, operationId, materialPath, target: '01图书馆/来自个人/合成附件', indexed: true, duplicate: false };
    })
  };
  let finished = false;
  const run = vi.fn(async (input: AssistantRunInput) => { input.emit({ type: 'text', text: '合成回答' }); });
  const adapter: AssistantAdapter = { id: 'test', run, describe: async () => ({ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'test', name: 'Test', reasoningEfforts: [] }] }) };
  const service = createAssistantService({ database, adapters: [adapter], resolveAttachment: port.get,
    createTools: context => createAssistantTools({ ...context, readService: {} as ReadService, attachmentService: port }) });
  cleanups.push(async () => { release(); await service.close(); database.close(); });
  function archiveRun(failEarly: boolean) {
    run.mockImplementation(async input => {
      const pending = input.tools.find(tool => tool.name === 'archive_attachment')!.execute({ id });
      const observed = pending.finally(() => { finished = true; });
      if (failEarly) { void observed.catch(() => {}); throw new Error('synthetic SDK failure'); }
      await observed;
    });
  }
  const request = () => ({ clientRequestId: randomUUID(), message: '请归档这个附件', providerId: 'test', model: 'test', scope: 'current' as const, attachments: [{ id }] });
  const settled = async (conversationId: string) => { await vi.waitFor(() => expect(service.get(conversationId).status).not.toBe('running')); return service.get(conversationId); };
  return { id, operationId, materialPath, attachment, database, port, run, service, request, settled, archiveRun, release,
    toolFinished: async () => vi.waitFor(() => expect(finished).toBe(true)) };
}

it.each(['stop', 'failed'] as const)('recovers an archive receipt that finishes after the assistant is %s without accepting late model output', async status => {
  const f = fixture(); f.archiveRun(status === 'failed');
  const start = await f.service.send(f.request());
  await vi.waitFor(() => expect(f.port.archive).toHaveBeenCalledOnce());
  if (status === 'stop') f.service.stop(start.id);
  await f.settled(start.id);
  f.release(); await f.toolFinished();
  const before = f.database.prepare('SELECT updated_at,payload FROM assistant_conversations WHERE id=?').get(start.id);
  const conversation = f.service.get(start.id);
  expect(conversation.status).toBe(status === 'stop' ? 'stopped' : 'failed');
  expect(conversation.messages[1]?.actions).toContainEqual(expect.objectContaining({ type: 'archive', attachmentId: f.id, operationId: f.operationId, materialPath: f.materialPath, status: 'archived' }));
  expect(conversation.messages[0]?.attachments?.[0]?.archive).toMatchObject({ state: 'archived', operationId: f.operationId });
  expect(conversation.messages[1]?.text).toBe('');
  expect(f.database.prepare('SELECT updated_at,payload FROM assistant_conversations WHERE id=?').get(start.id)).toEqual(before);
});

it('does not attribute a later archive to an earlier reading turn and tolerates unavailable attachment metadata', async () => {
  const f = fixture();
  const first = await f.service.send({ ...f.request(), message: '请总结这个附件' }); await f.settled(first.id);
  f.archiveRun(false); f.release();
  await f.service.send({ ...f.request(), conversationId: first.id }); await f.settled(first.id);
  const current = f.service.get(first.id);
  expect(current.messages[1]?.actions).toEqual([]);
  expect(current.messages[0]?.attachments?.[0]).not.toHaveProperty('archive');
  expect(current.messages[3]?.actions).toContainEqual(expect.objectContaining({ type: 'archive', attachmentId: f.id }));
  f.port.get.mockImplementation(() => { throw new Error('synthetic attachment unavailable'); });
  expect(() => f.service.get(first.id)).not.toThrow();
  expect(f.service.get(first.id).messages[3]?.actions).toContainEqual(expect.objectContaining({ type: 'archive', attachmentId: f.id }));
});

it('keeps attachment selections in request identity and never repeats an accepted archive on retry', async () => {
  const f = fixture(); f.archiveRun(false); f.release();
  const request = f.request(); const start = await f.service.send(request); await f.settled(start.id);
  expect((await f.service.send(request)).id).toBe(start.id);
  expect(f.port.archive).toHaveBeenCalledOnce();
  await expect(f.service.send({ ...request, attachments: [{ id: f.id, startPage: 1, endPage: 1 }] })).rejects.toMatchObject({ code: 'ASSISTANT_REQUEST_CONFLICT' });
});

it('gives duplicate attachments distinct receipt IDs when they share one archive operation', async () => {
  const f = fixture(); const duplicateId = randomUUID(); f.release();
  f.run.mockImplementation(async input => {
    const archive = input.tools.find(tool => tool.name === 'archive_attachment')!;
    await archive.execute({ id: f.id }); await archive.execute({ id: duplicateId });
  });
  const start = await f.service.send({ ...f.request(), attachments: [{ id: f.id }, { id: duplicateId }] });
  const result = await f.settled(start.id);
  const actions = result.messages[1]!.actions;
  expect(actions).toHaveLength(2);
  expect(new Set(actions.map(action => action.id)).size).toBe(2);
});

it('rejects a selection exceeding 16 MiB before starting a model or persisting a conversation', async () => {
  const f = fixture(); f.attachment.size = 9 * 1024 * 1024;
  await expect(f.service.send({ ...f.request(), attachments: [{ id: f.id }, { id: randomUUID() }] })).rejects.toMatchObject({ code: 'ATTACHMENT_GROUP_TOO_LARGE', statusCode: 413 });
  expect(f.run).not.toHaveBeenCalled(); expect(f.port.archive).not.toHaveBeenCalled();
  expect(f.database.prepare('SELECT COUNT(*) AS count FROM assistant_conversations').get()).toEqual({ count: 0 });
  expect(f.database.prepare('SELECT COUNT(*) AS count FROM assistant_requests').get()).toEqual({ count: 0 });
});

it('allows an attachment selection exactly at the 16 MiB limit', async () => {
  const f = fixture(); f.attachment.size = 8 * 1024 * 1024;
  const conversation = await f.service.send({ ...f.request(), message: '总结附件', attachments: [{ id: f.id }, { id: randomUUID() }] });
  expect((await f.settled(conversation.id)).status).toBe('idle');
  expect(f.run).toHaveBeenCalledOnce();
});
