import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantService } from '../../src/server/assistant/service.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture(options: { timeoutMs?: number } = {}) {
  const database = new Database(':memory:'); applyMigrations(database);
  const run = vi.fn(async (input: AssistantRunInput) => { input.emit({ type: 'text', text: '已完成。' }); });
  const describe = vi.fn<AssistantAdapter['describe']>(async () => ({ id: 'test', name: 'Test', status: 'ready', defaultModel: 'pro', defaultEffort: 'ultra', models: [{ id: 'pro', name: 'Pro', reasoningEfforts: ['high', 'ultra'] }] }));
  const createTools = vi.fn(() => []);
  const adapter = { id: 'test', describe, run };
  const service = createAssistantService({ database, adapters: [adapter], createTools, ...options });
  cleanup.push(async () => { await service.close(); database.close(); });
  const request = (message = '帮我理解这份资料') => ({ clientRequestId: randomUUID(), message, providerId: 'test', model: 'pro', effort: 'ultra', scope: 'brain' as const });
  return { database, service, run, describe, createTools, request, adapter };
}
async function settled(service: ReturnType<typeof createAssistantService>, id: string) {
  await vi.waitFor(() => expect(service.get(id).status).not.toBe('running'));
  return service.get(id);
}


function seedHistory(f: ReturnType<typeof fixture>, count = 101) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = randomUUID(); ids.push(id);
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, Math.floor(index / 2))).toISOString();
    const record = { id, title: index === 0 ? '旧问题 100%_完整' : `审计对话 ${index}`, contextPath: index === 0 ? '01图书馆/旧原文.md' : '01图书馆/其他.md', createdAt: updatedAt, updatedAt, status: 'idle', providerId: 'test', model: 'pro', scope: 'brain', messages: [{ id: 'a', role: 'assistant', text: '正文不应进入历史列表', sources: [], actions: [] }] };
    f.database.prepare('INSERT INTO assistant_conversations(id,updated_at,payload) VALUES(?,?,?)').run(id, updatedAt, JSON.stringify(record));
  }
  return ids;
}
it('pages beyond 100 conversations without duplicates at tied timestamps or returning messages', () => {
  const f = fixture(); const ids = seedHistory(f);
  const first = f.service.list({ limit: 100 });
  expect(first.conversations).toHaveLength(100); expect(first.hasMore).toBe(true); expect(first.nextCursor).toEqual(expect.any(String));
  const second = f.service.list({ limit: 100, cursor: first.nextCursor! });
  expect(second.hasMore).toBe(false); expect(second.nextCursor).toBeUndefined();
  const all = [...first.conversations, ...second.conversations];
  expect(new Set(all.map(item => item.id))).toEqual(new Set(ids)); expect(all).toHaveLength(101);
  expect(all.every(item => !('messages' in item))).toBe(true); expect(f.run).not.toHaveBeenCalled();
});
it('searches persisted titles and material paths beyond the first page with literal special characters', () => {
  const f = fixture(); const ids = seedHistory(f);
  expect(f.service.list({ search: '100%_完整' }).conversations.map(item => item.id)).toEqual([ids[0]]);
  expect(f.service.list({ search: '旧原文' }).conversations.map(item => item.id)).toEqual([ids[0]]);
  expect(f.service.list({ search: '不存在' })).toMatchObject({ conversations: [], hasMore: false });
});
it('rejects malformed and cross-search cursors without widening the search', () => {
  const f = fixture(); seedHistory(f);
  const cursor = f.service.list({ limit: 1, search: '审计' }).nextCursor!;
  expect(() => f.service.list({ cursor, search: '旧问题' })).toThrow();
  expect(() => f.service.list({ cursor: 'not-a-cursor' })).toThrow();
  expect(() => f.service.list({ limit: 101 })).toThrow();
});
