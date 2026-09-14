import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantActionPlanStore, type ArchivePlanPayload } from '../../src/server/assistant/action-plan-store.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const sha = 'a'.repeat(64);
function fixture() {
  const db = new Database(':memory:'); databases.push(db); applyMigrations(db);
  const conversationId = randomUUID(); const messageId = randomUUID();
  db.prepare('INSERT INTO assistant_conversations(id,updated_at,payload) VALUES(?,?,?)').run(conversationId, new Date().toISOString(), '{}');
  let clock = new Date('2026-09-14T00:00:00.000Z');
  const payload: ArchivePlanPayload = { attachmentId: randomUUID(), attachmentName: '原文.md', attachmentSha256: sha, archiveFields: { platform: '个人', title: '原文', collectedAt: '2026-09-14' }, targetPath: '01图书馆/来自个人/2026-09/原文.md', mainName: '原文.md', mainSha256: sha };
  return { db, conversationId, messageId, payload, now: () => new Date(clock), advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, store: createAssistantActionPlanStore(db, () => new Date(clock)) };
}
function create(f = fixture()) { return { f, plan: f.store.create({ conversationId: f.conversationId, messageId: f.messageId, label: '归档资料', sourceTitle: '原文.md', summary: '将资料归档到个人资料库。', payload: f.payload, expiresAt: '2026-09-14T01:00:00.000Z' }) }; }

describe('assistant action plan store', () => {
  it('creates a pending plan while keeping the archive payload server-owned', () => {
    const { f, plan } = create();
    expect(plan).toMatchObject({ type: 'plan', kind: 'archive', status: 'pending', attachmentId: f.payload.attachmentId, sourceSha256: sha });
    const row = f.db.prepare('SELECT payload,status FROM assistant_action_plans').get() as { payload: string; status: string };
    expect(row.status).toBe('pending'); expect(JSON.parse(row.payload)).toMatchObject({ archivePayload: f.payload });
    expect(plan).not.toHaveProperty('payload');
  });

  it('runs one confirmation, completes it, and rejects a different request', () => {
    const { f, plan } = create();
    const running = f.store.markRunning(plan.id, 'request-1', 'fingerprint-1');
    expect(running.status).toBe('running');
    expect(f.store.markRunning(plan.id, 'request-1', 'fingerprint-1')).toEqual(running);
    expect(() => f.store.markRunning(plan.id, 'request-2', 'fingerprint-2')).toThrow(/already resolved|已经处理/u);
    const completed = f.store.markCompleted(plan.id, randomUUID(), { targetPath: f.payload.targetPath });
    expect(completed.status).toBe('completed');
    expect(f.store.findConfirmation('request-1')).toEqual(completed);
  });

  it('rejects a reused confirmation id with a different fingerprint', () => {
    const { f, plan } = create(); f.store.markRunning(plan.id, 'request-1', 'fingerprint-1');
    expect(() => f.store.markRunning(plan.id, 'request-1', 'fingerprint-2')).toThrow(/confir|确认/u);
  });

  it('guards terminal transitions and recovers expired/abandoned plans', () => {
    const { f, plan } = create(); f.store.markRunning(plan.id, 'request-1', 'fingerprint-1'); f.store.markFailed(plan.id, 'failed');
    expect(() => f.store.markCompleted(plan.id, randomUUID())).toThrow(/already resolved|已经处理/u);
    const expired = create(f); const abandoned = create(f); f.store.markRunning(abandoned.plan.id, 'request-2', 'fingerprint-2');
    f.advance(4_000_000); expect(f.store.recover()).toMatchObject({ stale: 1, failed: 1 }); expect(f.store.get(plan.id).status).toBe('failed'); expect(f.store.get(expired.plan.id).status).toBe('stale'); expect(f.store.get(abandoned.plan.id).status).toBe('failed');
  });

  it('marks an unconfirmed expired plan stale and lists by conversation', () => {
    const f = fixture(); const first = create(f).plan; f.advance(4_000_000);
    expect(f.store.recover()).toMatchObject({ stale: 1, failed: 0 }); expect(f.store.get(first.id).status).toBe('stale');
    expect(f.store.listForConversation(f.conversationId)).toHaveLength(1);
  });

  it('rejects malformed persisted payloads', () => {
    const { f, plan } = create(); f.db.prepare('UPDATE assistant_action_plans SET payload=? WHERE id=?').run('{bad', plan.id);
    expect(() => f.store.get(plan.id)).toThrow(/无效|invalid/u);
  });
});
