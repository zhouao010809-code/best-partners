import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantDraftService } from '../../src/server/assistant/draft-service.js';
import Fastify from 'fastify';
import { registerAssistantDraftRoutes } from '../../src/server/api/routes/assistant-drafts.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() { const database = new Database(':memory:'); databases.push(database); applyMigrations(database); return { database, service: createAssistantDraftService({ database }) }; }
const content = () => ({ expectedRevision: 0, active: true as const, text: '尚未发出的想法', attachments: [{ id: randomUUID(), startPage: 2, endPage: 4 }], groupId: randomUUID(), scope: 'brain' as const });
it('restores text, selected page ranges and the active draft independently of a browser origin', () => {
  const { service, database } = fixture(); const id = randomUUID(); const input = content();
  const first = service.save(id, input).draft;
  const next = service.save(randomUUID(), { ...content(), text: '', attachments: [] }).draft;
  const reopened = createAssistantDraftService({ database }).list();
  expect(reopened.activeId).toBe(next.id); expect(reopened.drafts).toHaveLength(2);
  expect(reopened.drafts.find(draft => draft.id === id)).toEqual(first);
  expect(first).toMatchObject({ text: input.text, attachments: input.attachments, revision: 1 });
});
it('accepts a repeated uncertain save, rejects older or conflicting writes, and preserves both windows', () => {
  const { service } = fixture(); const id = randomUUID(); const input = content();
  const first = service.save(id, input).draft;
  expect(service.save(id, input).draft).toEqual(first);
  service.save(id, { ...input, expectedRevision: 1, text: '窗口 A 的新版' });
  expect(() => service.save(id, { ...input, expectedRevision: 1, text: '窗口 B 的编辑' })).toThrow('其他窗口');
  expect(() => service.save(id, input)).toThrow('其他窗口');
  const fork = service.save(randomUUID(), { ...input, text: '窗口 B 的编辑' }).draft;
  expect(service.list().drafts.map(draft => draft.text)).toEqual([fork.text, '窗口 A 的新版']);
});
it('never resurrects an explicitly cleared draft from a delayed request', () => {
  const { service } = fixture(); const id = randomUUID(); const input = content(); service.save(id, input);
  expect(service.delete(id, 1)).toEqual({ deleted: true }); expect(service.delete(id, 1)).toEqual({ deleted: true });
  expect(() => service.save(id, input)).toThrow('其他窗口');
  expect(() => service.save(id, { ...input, expectedRevision: 2 })).toThrow('其他窗口');
  expect(service.list()).toEqual({ drafts: [] });
});

it('serves persisted drafts and revision-bearing writes through the registered routes', async () => {
  const { service } = fixture(); const app = Fastify(); registerAssistantDraftRoutes(app, { assistantDrafts: service });
  const id = randomUUID();
  try {
    const saved = await app.inject({ method: 'PUT', url: `/api/v1/assistant/drafts/${id}`, payload: content() });
    expect(saved.statusCode).toBe(200); expect(saved.json().data.draft.revision).toBe(1);
    const list = await app.inject({ method: 'GET', url: '/api/v1/assistant/drafts' }); expect(list.json().data.activeId).toBe(id);
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/assistant/drafts/${id}?revision=1` }); expect(deleted.statusCode).toBe(200); expect(deleted.json().data).toEqual({ deleted: true });
  } finally { await app.close(); }
});
