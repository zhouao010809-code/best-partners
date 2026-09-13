import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantService } from '../../src/server/assistant/service.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';
import type { Attachment } from '../../src/shared/api/attachments.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture(options: { timeoutMs?: number; resolveAttachment?: (id: string) => Attachment } = {}) {
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

it('persists actual model, source, review action and history across turns', async () => {
  const f = fixture();
  f.run.mockImplementation(async input => {
    input.emit({ type: 'activity', text: '正在读取资料' });
    input.emit({ type: 'source', source: { id: 'S1', path: '02知识库/a.md', title: '资料 A' } });
    input.emit({ type: 'text', text: '根据 [S1]，' }); input.emit({ type: 'text', text: '这是结论。' });
    input.emit({ type: 'action', action: { id: 'a1', type: 'review', label: '审阅候选', runId: randomUUID() } });
  });
  const start = await f.service.send(f.request()); const first = await settled(f.service, start.id);
  expect(first.messages[1]).toMatchObject({ role: 'assistant', model: 'pro', text: '根据 [S1]，这是结论。', sources: [{ id: 'S1' }], actions: [{ type: 'review' }] });
  expect(first.messages[1]?.activity).toBeUndefined();
  const next = await f.service.send({ ...f.request('再展开说明'), conversationId: start.id }); await settled(f.service, next.id);
  expect(f.run.mock.calls[1]?.[0].messages).toHaveLength(3);
  expect(f.run.mock.calls[1]?.[0].effort).toBe('ultra');
  expect(f.service.list().conversations).toHaveLength(1);
  expect(f.service.list().conversations[0]).not.toHaveProperty('messages');
});

it('deduplicates an unknown POST result and rejects same id with changed input', async () => {
  const f = fixture(); const request = f.request();
  const [a, b] = await Promise.all([f.service.send(request), f.service.send(request)]);
  expect(a.id).toBe(b.id); await settled(f.service, a.id); expect(f.run).toHaveBeenCalledTimes(1);
  expect((await f.service.send(request)).id).toBe(a.id); expect(f.run).toHaveBeenCalledTimes(1);
  await expect(f.service.send({ ...request, message: 'changed' })).rejects.toMatchObject({ code: 'ASSISTANT_REQUEST_CONFLICT' });
});

it('stops a non-cooperative transport immediately and ignores its late output', async () => {
  const f = fixture(); let release!: () => void;
  f.run.mockImplementation(input => new Promise<void>(resolve => { input.emit({ type: 'text', text: '保留这一段' }); release = () => { input.emit({ type: 'text', text: '迟到结果' }); resolve(); }; }));
  const start = await f.service.send(f.request());
  expect(f.service.stop(start.id).status).toBe('stopped');
  await settled(f.service, start.id); await new Promise(resolve => setTimeout(resolve, 0));
  release(); await Promise.resolve();
  expect(f.service.get(start.id).messages[1]?.text).toBe('保留这一段');
  expect(f.run.mock.calls[0]?.[0].signal.aborted).toBe(true);
});

it('never automatically downgrades an unavailable model or reasoning setting', async () => {
  const f = fixture();
  await expect(f.service.send({ ...f.request(), model: 'flash-not-selected' })).rejects.toMatchObject({ code: 'ASSISTANT_MODEL_UNAVAILABLE' });
  await expect(f.service.send({ ...f.request(), effort: 'unknown' })).rejects.toMatchObject({ code: 'ASSISTANT_EFFORT_UNAVAILABLE' });
  expect(f.run).not.toHaveBeenCalled(); expect(f.service.list().conversations).toEqual([]);
});

it('rejects missing or escaped current context before accessing tools', async () => {
  const f = fixture();
  await expect(f.service.send({ ...f.request(), scope: 'current' })).rejects.toMatchObject({ code: 'ASSISTANT_CONTEXT_REQUIRED' });
  for (const contextPath of ['02知识库/../00大脑规则/a.md', '/tmp/a.md', '02知识库/secret.txt']) {
    await expect(f.service.send({ ...f.request(), scope: 'current', contextPath })).rejects.toMatchObject({ code: 'ASSISTANT_CONTEXT_INVALID' });
  }
  expect(f.createTools).not.toHaveBeenCalled();
});

it('sanitizes unknown upstream errors and leaves the question retryable', async () => {
  const f = fixture(); f.run.mockRejectedValue(new Error('secret-api-key upstream raw response'));
  const start = await f.service.send(f.request()); const result = await settled(f.service, start.id);
  expect(result.status).toBe('failed'); expect(JSON.stringify(result)).not.toContain('secret-api-key');
  expect(result.messages[0]?.text).toBe('帮我理解这份资料');
});

it('limits active tasks even when concurrent model discovery completes together', async () => {
  const f = fixture(); f.run.mockImplementation(() => new Promise(() => {}));
  const results = await Promise.allSettled([f.service.send(f.request('first')), f.service.send(f.request('second'))]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'ASSISTANT_BUSY' } });
  expect(f.run).toHaveBeenCalledTimes(1);
});

it('converts an interrupted persistent run into a recoverable stopped conversation', async () => {
  const f = fixture(); const start = await f.service.send(f.request()); await settled(f.service, start.id);
  const saved = f.service.get(start.id); saved.status = 'running'; saved.messages[1]!.activity = 'old activity';
  f.database.prepare('UPDATE assistant_conversations SET payload=? WHERE id=?').run(JSON.stringify(saved), saved.id);
  const restarted = createAssistantService({ database: f.database, adapters: [f.adapter], createTools: () => [] });
  expect(restarted.get(saved.id)).toMatchObject({ status: 'stopped', problem: expect.stringContaining('中断') });
  expect(restarted.get(saved.id).messages[1]?.activity).toBeUndefined();
  expect(f.run).toHaveBeenCalledTimes(1); await restarted.close();
});

it('ends timed-out runs even when the adapter ignores cancellation', async () => {
  const f = fixture({ timeoutMs: 15 }); f.run.mockImplementation(() => new Promise(() => {}));
  const start = await f.service.send(f.request()); const result = await settled(f.service, start.id);
  expect(result.status).toBe('failed'); expect(result.problem).toContain('等待较久');
});

it('records tool initialization failure rather than leaving a permanently running conversation', async () => {
  const f = fixture(); f.createTools.mockImplementation(() => { throw new Error('no tools'); });
  const start = await f.service.send(f.request()); const result = await settled(f.service, start.id);
  expect(result.status).toBe('failed'); expect(f.run).not.toHaveBeenCalled();
});

it('keeps the prior document identity as historical data while the current tool scope follows the new document', async () => {
  const f = fixture(), pathA = '01图书馆/资料 A.md', pathB = '02知识库/资料 B.md';
  const first = await f.service.send({ ...f.request('解释这篇'), scope: 'current', contextPath: pathA }); await settled(f.service, first.id);
  await f.service.send({ ...f.request('刚才那篇与现在这篇有什么关系？'), conversationId: first.id, scope: 'current', contextPath: pathB }); await settled(f.service, first.id);
  const modelInput = f.run.mock.calls[1]![0], priorUser = modelInput.messages[0]!.content;
  expect(priorUser).toContain(pathA); expect(priorUser).toContain('"contextTitle":"资料 A"'); expect(priorUser).toContain('"scope":"current"');
  expect(priorUser).toContain('历史线索'); expect(priorUser).toContain('不扩大本轮工具权限');
  expect(modelInput.system).toContain(`当前资料路径：${pathB}`); expect(modelInput.system).not.toContain(pathA);
  expect(f.createTools).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'current', contextPath: pathB, attachments: [] }));
});

it('projects only saved attachment identity and selected pages without reauthorizing or reloading an old attachment', async () => {
  const idA = randomUUID(), idB = randomUUID();
  const original: Attachment = { id: idA, name: '历史附件 A.pdf', mediaType: 'application/pdf', sha256: 'a'.repeat(64), size: 2048, status: 'ready', pageCount: 8, textBytes: 1024, createdAt: '2026-09-10', updatedAt: '2026-09-10', problem: 'PRIVATE_DIAGNOSTIC_MUST_NOT_ENTER_HISTORY' };
  const resolveAttachment = vi.fn((id: string) => ({ ...original, id, ...(id === idB ? { name: '当前附件 B.pdf' } : {}) }));
  const f = fixture({ resolveAttachment });
  const first = await f.service.send({ ...f.request('解释选中的页'), scope: 'current', attachments: [{ id: idA, startPage: 2, endPage: 3 }] }); await settled(f.service, first.id);
  resolveAttachment.mockClear();
  await f.service.send({ ...f.request('刚才那个文件与当前附件比较'), conversationId: first.id, scope: 'current', attachments: [{ id: idB, startPage: 5, endPage: 5 }] }); await settled(f.service, first.id);
  const modelInput = f.run.mock.calls[1]![0], priorUser = modelInput.messages[0]!.content;
  expect(priorUser).toContain(idA); expect(priorUser).toContain('历史附件 A.pdf'); expect(priorUser).toContain('"startPage":2'); expect(priorUser).toContain('"endPage":3'); expect(priorUser).toContain('"pageCount":8');
  expect(priorUser).not.toContain('PRIVATE_DIAGNOSTIC'); expect(priorUser).not.toContain(original.sha256); expect(priorUser).not.toContain('textBytes');
  expect(resolveAttachment).toHaveBeenCalledTimes(1); expect(resolveAttachment).toHaveBeenCalledWith(idB);
  expect(modelInput.system).toContain(idB); expect(modelInput.system).not.toContain(idA);
  expect(f.createTools).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'current', attachments: [{ id: idB, startPage: 5, endPage: 5 }] }));
  expect(f.service.get(first.id).messages[0]!.attachments?.[0]).toMatchObject({ id: idA, name: '历史附件 A.pdf', startPage: 2, endPage: 3 });
});
