import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantActionPlanStore } from '../../src/server/assistant/action-plan-store.js';
import { createAssistantActionPlanService, sha256 } from '../../src/server/assistant/action-plan-service.js';
import { createAssistantService } from '../../src/server/assistant/service.js';
import { createAssistantTools } from '../../src/server/assistant/attachment-tools.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';
import type { Attachment, AttachmentArchiveResult, AttachmentPages } from '../../src/shared/api/attachments.js';
import { PublicApiError } from '../../src/shared/api/errors.js';
import type { ReadService } from '../../src/server/services/read-service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

function fixture() {
  const database = new Database(':memory:');
  applyMigrations(database);
  const id = randomUUID();
  const operationId = randomUUID();
  const attachment: Attachment = {
    id, name: '合成附件.txt', mediaType: 'text/plain', size: 12, sha256: 'a'.repeat(64), status: 'ready',
    pageCount: 2, textBytes: 12, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z'
  };
  const pages: AttachmentPages = {
    id, sha256: attachment.sha256, textRevision: 'revision-1',
    pages: [{ page: 1, text: '第一页' }, { page: 2, text: '第二页' }], startPage: 1, endPage: 2, totalPages: 2, truncated: false
  };
  const preview = {
    attachmentId: id, attachmentSha256: attachment.sha256, attachmentName: attachment.name,
    archiveFields: { platform: '个人' as const, title: '合成附件', collectedAt: '2026-09-15' },
    textRevision: pages.textRevision, target: '01图书馆/来自个人/2026-09/合成附件', mainName: '原文.md',
    mainSha256: 'b'.repeat(64), duplicate: false
  };
  const result: AttachmentArchiveResult = {
    id, state: 'archived', operationId, materialPath: `${preview.target}/${preview.mainName}`,
    target: preview.target, indexed: true, duplicate: false
  };
  const port = {
    get: vi.fn(() => structuredClone(attachment)),
    readPages: vi.fn(() => structuredClone(pages)),
    preview: vi.fn(async () => structuredClone(preview)),
    archive: vi.fn(async () => structuredClone(result))
  };
  const store = createAssistantActionPlanStore(database);
  const actionPlans = createAssistantActionPlanService({ store, attachmentService: port });
  const run = vi.fn(async (input: AssistantRunInput) => {
    if (/归档/u.test(input.messages.at(-1)?.content ?? '')) {
      const archive = input.tools.find(tool => tool.name === 'archive_attachment');
      if (!archive) throw new Error('archive tool missing');
      await archive.execute({ id });
      return;
    }
    input.emit({ type: 'text', text: '这是普通总结。' });
  });
  const adapter: AssistantAdapter = {
    id: 'test', run,
    describe: async () => ({ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'test', name: 'Test', reasoningEfforts: [] }] })
  };
  const service = createAssistantService({
    database, adapters: [adapter], actionPlans, resolveAttachment: port.get,
    createTools: context => createAssistantTools({ ...context, readService: {} as ReadService, attachmentService: port })
  });
  cleanups.push(async () => { await service.close(); database.close(); });
  const request = (message = '请归档这个附件') => ({
    clientRequestId: randomUUID(), message, providerId: 'test', model: 'test', scope: 'current' as const, attachments: [{ id }]
  });
  const settled = async (conversationId: string) => {
    await vi.waitFor(() => expect(service.get(conversationId).status).not.toBe('running'));
    return service.get(conversationId);
  };
  return { database, id, attachment, pages, preview, result, port, store, actionPlans, service, run, request, settled };
}

describe('assistant archive action plan lifecycle', () => {
  it('creates a pending plan without calling archive during the model turn', async () => {
    const f = fixture();
    const started = await f.service.send(f.request());
    const result = await f.settled(started.id);
    expect(f.port.preview).toHaveBeenCalledOnce();
    expect(f.port.archive).not.toHaveBeenCalled();
    expect(result.messages[1]?.actions).toContainEqual(expect.objectContaining({ type: 'plan', kind: 'archive', status: 'pending' }));
  });

  it('confirms once and projects the real archive receipt', async () => {
    const f = fixture();
    const started = await f.service.send(f.request());
    const pending = await f.settled(started.id);
    const plan = pending.messages[1]?.actions.find(action => action.type === 'plan');
    expect(plan).toBeDefined();
    const requestId = randomUUID();
    const confirmed = await f.service.confirmAction(plan!.id, requestId);
    expect(f.port.archive).toHaveBeenCalledOnce();
    expect(confirmed.messages[1]?.actions).toContainEqual(expect.objectContaining({ type: 'archive', status: 'archived', operationId: f.result.operationId }));
    const retried = await f.service.confirmAction(plan!.id, requestId);
    expect(f.port.archive).toHaveBeenCalledOnce();
    expect(retried.messages[1]?.actions.filter(action => action.type === 'archive')).toHaveLength(1);
    await expect(f.service.confirmAction(plan!.id, randomUUID())).rejects.toMatchObject({ code: 'ASSISTANT_ACTION_ALREADY_RESOLVED' });
  });

  it('marks a plan stale and never writes when the source hash changes', async () => {
    const f = fixture();
    const started = await f.service.send(f.request());
    const pending = await f.settled(started.id);
    f.port.get.mockReturnValue({ ...f.attachment, sha256: 'd'.repeat(64) });
    const plan = pending.messages[1]?.actions.find(action => action.type === 'plan');
    await expect(f.service.confirmAction(plan!.id, randomUUID())).rejects.toMatchObject({ code: 'ASSISTANT_ACTION_STALE' });
    expect(f.port.archive).not.toHaveBeenCalled();
    expect(f.service.get(started.id).messages[1]?.actions).toContainEqual(expect.objectContaining({ type: 'plan', status: 'stale' }));
  });

  it('cancels a pending plan without touching the attachment', async () => {
    const f = fixture();
    const started = await f.service.send(f.request());
    const pending = await f.settled(started.id);
    const plan = pending.messages[1]?.actions.find(action => action.type === 'plan');
    const cancelled = f.service.cancelAction(plan!.id, randomUUID());
    expect(cancelled.messages[1]?.actions).toContainEqual(expect.objectContaining({ type: 'plan', status: 'cancelled' }));
    expect(f.port.archive).not.toHaveBeenCalled();
  });

  it('does not create a plan for an ordinary summary', async () => {
    const f = fixture();
    const started = await f.service.send(f.request('请总结这个附件'));
    const result = await f.settled(started.id);
    expect(result.messages[1]?.actions).toEqual([]);
    expect(f.port.preview).not.toHaveBeenCalled();
    expect(f.port.archive).not.toHaveBeenCalled();
  });

  it('recovers an interrupted running plan as failed without retrying archive', async () => {
    const f = fixture();
    const conversationId = randomUUID();
    f.database.prepare('INSERT INTO assistant_conversations(id,updated_at,payload) VALUES(?,?,?)').run(conversationId, new Date().toISOString(), '{}');
    const action = await f.actionPlans.proposeArchive({ conversationId, messageId: randomUUID(), attachmentId: f.id, selection: { id: f.id, startPage: 1, endPage: 2 } });
    const requestId = randomUUID();
    const fingerprint = sha256(JSON.stringify({ planId: action.id, action: 'confirm' }));
    f.store.markRunning(action.id, requestId, fingerprint);
    const restarted = createAssistantActionPlanService({ store: f.store, attachmentService: f.port });
    restarted.recover();
    expect(restarted.get(action.id).status).toBe('failed');
    expect(f.port.archive).not.toHaveBeenCalled();
  });

  it('reconciles an archived attachment receipt after restart without archiving again', async () => {
    const f = fixture();
    const conversationId = randomUUID();
    f.database.prepare('INSERT INTO assistant_conversations(id,updated_at,payload) VALUES(?,?,?)').run(conversationId, new Date().toISOString(), '{}');
    const action = await f.actionPlans.proposeArchive({ conversationId, messageId: randomUUID(), attachmentId: f.id, selection: { id: f.id, startPage: 1, endPage: 2 } });
    const requestId = randomUUID();
    f.store.markRunning(action.id, requestId, sha256(JSON.stringify({ planId: action.id, action: 'confirm' })));
    f.port.get.mockReturnValue({ ...f.attachment, archive: { state: 'archived', operationId: f.result.operationId, materialPath: f.result.materialPath, target: f.result.target, indexed: true } });
    const restarted = createAssistantActionPlanService({ store: f.store, attachmentService: f.port });
    restarted.recover();
    expect(restarted.getRecord(action.id, conversationId)).toMatchObject({ status: 'completed', resultActionId: `archive:${f.result.operationId}:${f.id}` });
    expect(restarted.project(action.id, conversationId)).toMatchObject({ type: 'archive', operationId: f.result.operationId, status: 'archived' });
    expect(f.port.archive).not.toHaveBeenCalled();
  });

  it('keeps a needs-review receipt on the failed recovery plan', async () => {
    const f = fixture();
    const conversationId = randomUUID();
    f.database.prepare('INSERT INTO assistant_conversations(id,updated_at,payload) VALUES(?,?,?)').run(conversationId, new Date().toISOString(), '{}');
    const action = await f.actionPlans.proposeArchive({ conversationId, messageId: randomUUID(), attachmentId: f.id, selection: { id: f.id, startPage: 1, endPage: 2 } });
    const needsReview: AttachmentArchiveResult = { ...f.result, state: 'needs-review' };
    f.port.archive.mockResolvedValueOnce(needsReview);
    await expect(f.actionPlans.confirm({ planId: action.id, conversationId, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_ARCHIVE_REVIEW' });
    const failed = f.actionPlans.getRecord(action.id);
    expect(failed).toMatchObject({ status: 'failed', recoveryRequired: true, resultActionId: `archive:${needsReview.operationId}:${f.id}`, resultPayload: needsReview });
    f.port.get.mockReturnValue({ ...f.attachment, archive: { state: 'needs-review', operationId: needsReview.operationId, materialPath: needsReview.materialPath, target: needsReview.target, indexed: false } });
    const restarted = createAssistantActionPlanService({ store: f.store, attachmentService: f.port });
    restarted.recover();
    expect(restarted.getRecord(action.id, conversationId)).toMatchObject({ status: 'failed', recoveryRequired: true, resultPayload: expect.objectContaining({ state: 'needs-review', operationId: needsReview.operationId }) });

    const crashed = await f.actionPlans.proposeArchive({ conversationId, messageId: randomUUID(), attachmentId: f.id, selection: { id: f.id, startPage: 1, endPage: 2 } });
    f.store.markRunning(crashed.id, randomUUID(), sha256(JSON.stringify({ planId: crashed.id, action: 'confirm' })));
    const restartedAfterCrash = createAssistantActionPlanService({ store: f.store, attachmentService: f.port });
    restartedAfterCrash.recover();
    expect(restartedAfterCrash.getRecord(crashed.id, conversationId)).toMatchObject({ status: 'failed', recoveryRequired: true, resultPayload: expect.objectContaining({ state: 'needs-review', operationId: needsReview.operationId }) });
  });

  it('marks a plan stale when preview reports a changed archive plan', async () => {
    const f = fixture();
    const conversationId = randomUUID();
    f.database.prepare('INSERT INTO assistant_conversations(id,updated_at,payload) VALUES(?,?,?)').run(conversationId, new Date().toISOString(), '{}');
    const action = await f.actionPlans.proposeArchive({ conversationId, messageId: randomUUID(), attachmentId: f.id, selection: { id: f.id, startPage: 1, endPage: 2 } });
    f.port.preview.mockRejectedValueOnce(new PublicApiError('ATTACHMENT_ARCHIVE_PLAN_CHANGED', 'changed', 409));
    await expect(f.actionPlans.confirm({ planId: action.id, conversationId, clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'ASSISTANT_ACTION_STALE' });
    expect(f.actionPlans.getRecord(action.id).status).toBe('stale');
  });

  it('marks unknown archive errors as recovery-required', async () => {
    const f = fixture();
    const conversationId = randomUUID();
    f.database.prepare('INSERT INTO assistant_conversations(id,updated_at,payload) VALUES(?,?,?)').run(conversationId, new Date().toISOString(), '{}');
    const action = await f.actionPlans.proposeArchive({ conversationId, messageId: randomUUID(), attachmentId: f.id, selection: { id: f.id, startPage: 1, endPage: 2 } });
    f.port.archive.mockRejectedValueOnce(new PublicApiError('ATTACHMENT_ARCHIVE_UNKNOWN', 'native failure', 409));
    await expect(f.actionPlans.confirm({ planId: action.id, conversationId, clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'ATTACHMENT_ARCHIVE_UNKNOWN' });
    expect(f.actionPlans.getRecord(action.id)).toMatchObject({ status: 'failed', recoveryRequired: true });
  });

  it('keeps a post-commit original verification failure recoverable', async () => {
    const f = fixture();
    const conversationId = randomUUID();
    f.database.prepare('INSERT INTO assistant_conversations(id,updated_at,payload) VALUES(?,?,?)').run(conversationId, new Date().toISOString(), '{}');
    const action = await f.actionPlans.proposeArchive({ conversationId, messageId: randomUUID(), attachmentId: f.id, selection: { id: f.id, startPage: 1, endPage: 2 } });
    f.port.archive.mockRejectedValueOnce(new PublicApiError('ATTACHMENT_ARCHIVE_COMMITTED_ORIGINAL_CHANGED', 'committed', 409));
    await expect(f.actionPlans.confirm({ planId: action.id, conversationId, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_ARCHIVE_COMMITTED_ORIGINAL_CHANGED' });
    expect(f.actionPlans.getRecord(action.id)).toMatchObject({ status: 'failed', recoveryRequired: true, problem: expect.stringContaining('恢复记录') });
  });
});
