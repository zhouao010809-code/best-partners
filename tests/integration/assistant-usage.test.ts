import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantService } from '../../src/server/assistant/service.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';
import type { AssistantModelCapacity } from '../../src/shared/api/assistant.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function fixture(capacity?: AssistantModelCapacity) {
  const database = new Database(':memory:'); applyMigrations(database);
  const run = vi.fn(async (input: AssistantRunInput) => { input.emit({ type: 'text', text: '合成回答' }); });
  const adapter: AssistantAdapter = { id: 'test', run, describe: async () => ({ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'test', name: 'Test', reasoningEfforts: [], ...(capacity ? { capacity } : {}) }] }) };
  const service = createAssistantService({ database, adapters: [adapter], createTools: () => [] });
  cleanups.push(async () => { await service.close(); database.close(); });
  const request = () => ({ clientRequestId: randomUUID(), message: '合成问题', providerId: 'test', model: 'test', scope: 'brain' as const });
  const settled = async (id: string) => { await vi.waitFor(() => expect(service.get(id).status).not.toBe('running')); return service.get(id); };
  return { database, service, run, request, settled };
}
const step = (index: number, inputTokens: number, outputTokens: number) => ({ step: index, measuredAt: '2026-09-10T00:00:00Z', status: 'reported' as const, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });

it('persists last-request usage separately from per-turn cumulative consumption and ignores duplicate steps', async () => {
  const f = fixture();
  f.run.mockImplementation(async input => { input.emit({ type: 'usage', usage: step(1, 100, 20) }); input.emit({ type: 'usage', usage: step(1, 100, 20) }); input.emit({ type: 'usage', usage: step(2, 150, 30) }); input.emit({ type: 'text', text: '回答' }); });
  const start = await f.service.send(f.request()); const result = await f.settled(start.id);
  expect(result.messages[1]?.usage).toMatchObject({ status: 'complete', latest: { step: 2, inputTokens: 150, outputTokens: 30 }, total: { inputTokens: 250, outputTokens: 50, totalTokens: 300 } });
  expect(result.messages[1]?.usage?.steps).toHaveLength(2);
  expect(result.messages[1]?.context).toMatchObject({ outputReserveTokens: 32768, estimate: { status: 'capacity-unknown' }, history: { availableMessages: 1, selectedMessages: 1, omittedMessages: 0, messageLimit: 24, conversationMessageLimit: 100, conversationMessages: 2, remainingMessages: 98 } });
});

it('retains partial reported usage on cancellation and never invents a zero for absent usage', async () => {
  const f = fixture();
  f.run.mockImplementation(input => { input.emit({ type: 'text', text: '停止前最后一段' }); input.emit({ type: 'usage', usage: step(1, 100, 20) }); return new Promise(() => {}); });
  const start = await f.service.send(f.request());
  await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
  const stopped = f.service.stop(start.id); const result = await f.settled(start.id);
  expect(stopped.messages[1]).toMatchObject({ text: '停止前最后一段', usage: { latest: { inputTokens: 100 } } });
  await vi.waitFor(() => expect(f.service.get(start.id).messages[1]?.usage?.status).toBe('partial'));
  expect(result.messages[1]?.usage?.latest?.inputTokens).toBe(100);
  f.run.mockImplementation(async input => { input.emit({ type: 'usage', usage: { step: 1, measuredAt: '2026-09-10T00:00:00Z', status: 'unavailable' } }); input.emit({ type: 'text', text: '回答' }); });
  const unknown = await f.service.send(f.request());
  expect((await f.settled(unknown.id)).messages[1]?.usage).toMatchObject({ status: 'unavailable', total: {} });
});

it('blocks a conservatively over-budget prompt before model execution and exposes the application limits', async () => {
  const f = fixture({ contextWindowTokens: 100, sourceUrl: 'https://example.com/synthetic', verifiedAt: '2026-09-10' });
  const start = await f.service.send(f.request()); const result = await f.settled(start.id);
  expect(result).toMatchObject({ status: 'failed', problem: expect.stringContaining('上下文') });
  expect(f.run).not.toHaveBeenCalled();
  expect(result.messages[1]?.context).toMatchObject({ capacity: { contextWindowTokens: 100 }, estimate: { status: 'over-budget' }, outputReserveTokens: 32768 });
});

it('shows exactly which historical messages were omitted without filling telemetry into legacy messages', async () => {
  const f = fixture(); const first = await f.service.send(f.request()); await f.settled(first.id);
  const old = f.service.get(first.id);
  old.messages = Array.from({ length: 26 }, (_, index) => ({ id: `old-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const, text: `旧消息${index}`, sources: [], actions: [] }));
  f.database.prepare('UPDATE assistant_conversations SET payload=? WHERE id=?').run(JSON.stringify(old), old.id);
  await f.service.send({ ...f.request(), conversationId: old.id }); const current = await f.settled(old.id);
  expect(current.messages[27]?.context?.history).toMatchObject({ availableMessages: 27, selectedMessages: 24, omittedMessages: 3, firstMessageId: 'old-3', conversationMessages: 28, remainingMessages: 72 });
  expect(current.messages[0]).not.toHaveProperty('usage');
  expect(current.messages[0]).not.toHaveProperty('context');
});
