import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantActionPlanStore } from '../../src/server/assistant/action-plan-store.js';
import { createAssistantActionPlanService } from '../../src/server/assistant/action-plan-service.js';
import type { Attachment, AttachmentArchiveResult, AttachmentPages } from '../../src/shared/api/attachments.js';
import { PublicApiError } from '../../src/shared/api/errors.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new Database(':memory:'); databases.push(db); applyMigrations(db);
  const conversationId = randomUUID(); const messageId = randomUUID(); const attachmentId = randomUUID();
  db.prepare('INSERT INTO assistant_conversations(id,updated_at,payload) VALUES(?,?,?)').run(conversationId, new Date().toISOString(), '{}');
  let now = new Date('2026-09-15T00:00:00.000Z');
  const attachment: Attachment = { id: attachmentId, name: '资料.txt', mediaType: 'text/plain', size: 12, sha256: 'a'.repeat(64), status: 'ready', pageCount: 2, textBytes: 12, createdAt: now.toISOString(), updatedAt: now.toISOString() };
  const pages: AttachmentPages = { id: attachmentId, sha256: attachment.sha256, textRevision: 'r1', pages: [{ page: 1, text: 'one' }, { page: 2, text: 'two' }], startPage: 1, endPage: 2, totalPages: 2, truncated: false };
  const preview = { attachmentId, attachmentSha256: attachment.sha256, attachmentName: attachment.name, archiveFields: { platform: '个人' as const, title: '资料', collectedAt: '2026-09-15' }, textRevision: 'r1', target: '01图书馆/来自个人/2026-09/资料', mainName: '原文.md', mainSha256: 'b'.repeat(64), duplicate: false };
  const result: AttachmentArchiveResult = { id: attachmentId, state: 'archived', operationId: randomUUID(), materialPath: `${preview.target}/${preview.mainName}`, target: preview.target, indexed: true, duplicate: false };
  const archive = vi.fn(async () => result);
  const get = vi.fn(() => attachment);
  const readPages = vi.fn(() => pages);
  const attachmentService = { get, readPages, preview: vi.fn(async () => preview), archive };
  const store = createAssistantActionPlanStore(db, () => new Date(now));
  const service = createAssistantActionPlanService({ store, attachmentService, now: () => new Date(now) });
  return { db, conversationId, messageId, attachmentId, attachment, pages, preview, result, archive, get, readPages, attachmentService, store, service, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe('assistant action plan service', () => {
  it('previews and persists a server-owned pending plan without archiving', async () => {
    const f = fixture();
    const action = await f.service.proposeArchive({ conversationId: f.conversationId, messageId: f.messageId, attachmentId: f.attachmentId, selection: { id: f.attachmentId, startPage: 1, endPage: 2 } });
    expect(action).toMatchObject({ type: 'plan', status: 'pending', targetPath: f.preview.target });
    expect(action).not.toHaveProperty('mainSha256');
    expect(f.archive).not.toHaveBeenCalled();
    const record = f.service.getRecord(action.id, f.conversationId);
    expect(record.payload).toMatchObject({ attachmentSha256: f.attachment.sha256, sourceRange: { startPage: 1, endPage: 2 }, targetPath: f.preview.target });
  });

  it('confirms once, returns the receipt on same-request retry, and does not archive twice', async () => {
    const f = fixture();
    const action = await f.service.proposeArchive({ conversationId: f.conversationId, messageId: f.messageId, attachmentId: f.attachmentId, selection: { id: f.attachmentId, startPage: 1, endPage: 2 } });
    const requestId = randomUUID();
    const first = await f.service.confirm({ planId: action.id, conversationId: f.conversationId, clientRequestId: requestId });
    const second = await f.service.confirm({ planId: action.id, conversationId: f.conversationId, clientRequestId: requestId });
    expect(f.archive).toHaveBeenCalledOnce();
    expect(first.result).toEqual(f.result); expect(second.result).toEqual(f.result); expect(second.plan.status).toBe('completed');
  });

  it('marks the plan stale when the selected text revision changes', async () => {
    const f = fixture();
    const action = await f.service.proposeArchive({ conversationId: f.conversationId, messageId: f.messageId, attachmentId: f.attachmentId, selection: { id: f.attachmentId, startPage: 1, endPage: 2 } });
    f.readPages.mockReturnValue({ ...f.pages, textRevision: 'changed' });
    await expect(f.service.confirm({ planId: action.id, conversationId: f.conversationId, clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'ASSISTANT_ACTION_STALE' });
    expect(f.archive).not.toHaveBeenCalled(); expect(f.service.get(action.id, f.conversationId).status).toBe('stale');
  });

  it('marks the plan stale when the original hash changes before confirmation', async () => {
    const f = fixture();
    const action = await f.service.proposeArchive({ conversationId: f.conversationId, messageId: f.messageId, attachmentId: f.attachmentId, selection: { id: f.attachmentId, startPage: 1, endPage: 2 } });
    f.get.mockReturnValue({ ...f.attachment, sha256: 'c'.repeat(64) });
    await expect(f.service.confirm({ planId: action.id, conversationId: f.conversationId, clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'ASSISTANT_ACTION_STALE' });
    expect(f.archive).not.toHaveBeenCalled();
  });

  it('closes the running-to-stale race when archive revalidation rejects a changed plan', async () => {
    const f = fixture();
    const action = await f.service.proposeArchive({ conversationId: f.conversationId, messageId: f.messageId, attachmentId: f.attachmentId, selection: { id: f.attachmentId, startPage: 1, endPage: 2 } });
    f.archive.mockRejectedValueOnce(new PublicApiError('ATTACHMENT_ARCHIVE_PLAN_CHANGED', 'changed', 409));
    await expect(f.service.confirm({ planId: action.id, conversationId: f.conversationId, clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'ASSISTANT_ACTION_STALE' });
    expect(f.service.getRecord(action.id, f.conversationId).status).toBe('stale');
  });

  it('expires pending plans without calling preview again or writing the attachment', async () => {
    const f = fixture();
    const action = await f.service.proposeArchive({ conversationId: f.conversationId, messageId: f.messageId, attachmentId: f.attachmentId, selection: { id: f.attachmentId, startPage: 1, endPage: 2 } });
    f.advance(31 * 60 * 1000);
    await expect(f.service.confirm({ planId: action.id, conversationId: f.conversationId, clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'ASSISTANT_ACTION_EXPIRED' });
    expect(f.archive).not.toHaveBeenCalled(); expect(f.service.get(action.id, f.conversationId).status).toBe('stale');
  });

  it('cancels without touching the attachment and enforces conversation ownership', async () => {
    const f = fixture();
    const action = await f.service.proposeArchive({ conversationId: f.conversationId, messageId: f.messageId, attachmentId: f.attachmentId, selection: { id: f.attachmentId, startPage: 1, endPage: 2 } });
    expect(() => f.service.cancel({ planId: action.id, conversationId: randomUUID(), clientRequestId: randomUUID() })).toThrowError(expect.objectContaining({ code: 'ASSISTANT_ACTION_NOT_FOUND' }));
    const cancelled = f.service.cancel({ planId: action.id, conversationId: f.conversationId, clientRequestId: randomUUID() });
    expect(cancelled.plan.status).toBe('cancelled'); expect(f.archive).not.toHaveBeenCalled();
  });

  it('returns the durable cancelled result on an idempotent retry', async () => {
    const f = fixture();
    const action = await f.service.proposeArchive({ conversationId: f.conversationId, messageId: f.messageId, attachmentId: f.attachmentId, selection: { id: f.attachmentId, startPage: 1, endPage: 2 } });
    const requestId = randomUUID();
    const first = f.service.cancel({ planId: action.id, conversationId: f.conversationId, clientRequestId: requestId });
    const second = f.service.cancel({ planId: action.id, conversationId: f.conversationId, clientRequestId: requestId });
    expect(first.plan.status).toBe('cancelled'); expect(second.plan.status).toBe('cancelled');
  });
});
