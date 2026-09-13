import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createAssistantService } from '../../src/server/assistant/service.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture() {
  const database = new Database(':memory:'); applyMigrations(database);
  const run = vi.fn(async (input: AssistantRunInput) => { input.emit({ type: 'text', text: '回答' }); });
  const adapter: AssistantAdapter = { id: 'test', run, describe: async () => ({ id: 'test', name: 'Test', status: 'ready', models: [{ id: 'test', name: 'Test', reasoningEfforts: [] }] }) };
  const service = createAssistantService({ database, adapters: [adapter], createTools: () => [] });
  cleanup.push(async () => { await service.close(); database.close(); });
  const request = () => ({ clientRequestId: randomUUID(), message: '解释这篇', providerId: 'test', model: 'test', scope: 'brain' as const });
  return { database, run, service, request, adapter };
}
async function settled(service: ReturnType<typeof createAssistantService>, id: string) {
  await vi.waitFor(() => expect(service.get(id).status).not.toBe('running'));
  return service.get(id);
}

it('keeps each turn context and indexed title after navigating and renaming the index entry', async () => {
  const f = fixture(); const path = '01图书馆/a.md';
  f.database.prepare('INSERT INTO search_index VALUES (?, ?, ?, NULL, ?, ?, ?)').run(path, 'material', 'a'.repeat(64), JSON.stringify({ title: '原始资料标题' }), '[]', new Date().toISOString());
  const first = await f.service.send({ ...f.request(), scope: 'current', contextPath: path }); await settled(f.service, first.id);
  f.database.prepare('UPDATE search_index SET yaml_json=? WHERE path=?').run(JSON.stringify({ title: '改名后的标题' }), path);
  await f.service.send({ ...f.request(), conversationId: first.id, scope: 'current', contextPath: '02知识库/另一个标题.md' });
  const result = await settled(f.service, first.id);
  expect(result.messages[0]).toMatchObject({ scope: 'current', contextPath: path, contextTitle: '原始资料标题' });
  expect(result.messages[2]).toMatchObject({ scope: 'current', contextPath: '02知识库/另一个标题.md', contextTitle: '另一个标题' });
  expect(result.messages[1]?.startedAt).toEqual(expect.any(String));
  expect(result.messages[1]?.finishedAt).toEqual(expect.any(String));
  expect(Date.parse(result.messages[1]!.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(result.messages[1]!.startedAt!));
});

it('does not invent per-turn context, evidence or timing for old history', async () => {
  const f = fixture(); const first = await f.service.send(f.request()); await settled(f.service, first.id);
  const old = f.service.get(first.id);
  old.messages = [{ id: 'old', role: 'user', text: '旧问题', sources: [], actions: [] }, { id: 'old-answer', role: 'assistant', text: '旧回答', sources: [{ id: 'S1', path: '01图书馆/a.md', title: 'A' }], actions: [] }];
  f.database.prepare('UPDATE assistant_conversations SET payload=? WHERE id=?').run(JSON.stringify(old), old.id);
  expect(f.service.get(old.id).messages).toEqual(old.messages);
});

it('upgrades a discovered source with real excerpts without changing its citation id or feeding excerpts back as fresh evidence', async () => {
  const f = fixture(); const evidence = { excerpt: '真正读到的片段', revision: 'a'.repeat(64), offset: 20, length: 8, startLine: 3, endLine: 3 };
  f.run.mockImplementationOnce(async input => {
    input.emit({ type: 'source', source: { id: 'S1', path: '01图书馆/a.md', title: 'A', kind: 'search' } });
    input.emit({ type: 'source', source: { id: 'S1', path: '01图书馆/a.md', title: 'A', kind: 'read', evidence: [evidence] } });
    input.emit({ type: 'source', source: { id: 'S1', path: '01图书馆/a.md', title: 'A', kind: 'search' } });
    input.emit({ type: 'text', text: '结论 [S1]' });
  });
  const first = await f.service.send(f.request()); const result = await settled(f.service, first.id);
  expect(result.messages[1]?.sources).toEqual([{ id: 'S1', path: '01图书馆/a.md', title: 'A', kind: 'read', evidence: [evidence] }]);
  await f.service.send({ ...f.request(), conversationId: first.id }); await settled(f.service, first.id);
  expect(JSON.stringify(f.run.mock.calls[1]?.[0].messages)).not.toContain(evidence.excerpt);
});

it('persists real tool start/end times and stops in-flight steps on interruption', async () => {
  const f = fixture();
  f.run.mockImplementationOnce(async input => {
    input.emit({ type: 'step', id: 'search-1', toolName: 'search_knowledge', label: '查找资料', status: 'running' });
    input.emit({ type: 'step', id: 'search-1', toolName: 'search_knowledge', label: '查找资料', status: 'completed' });
    input.emit({ type: 'text', text: '有结果' });
  });
  const first = await f.service.send(f.request()); const result = await settled(f.service, first.id);
  expect(result.messages[1]?.steps).toEqual([{ id: 'search-1', toolName: 'search_knowledge', label: '查找资料', status: 'completed', startedAt: expect.any(String), finishedAt: expect.any(String) }]);
  f.run.mockImplementation(input => { input.emit({ type: 'step', id: 'read-2', toolName: 'read_document', label: '阅读依据', status: 'running' }); return new Promise(() => {}); });
  const next = await f.service.send({ ...f.request(), conversationId: first.id });
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
  f.service.stop(next.id); await settled(f.service, next.id);
  await vi.waitFor(() => expect(f.service.get(next.id).messages[3]?.steps?.[0]).toMatchObject({ status: 'stopped', finishedAt: expect.any(String) }));
});

it('refreshes candidate card counts and recovery state from actual run, reviews and batches without changing history ordering', async () => {
  const f = fixture(); const runId = randomUUID();
  f.database.prepare('INSERT INTO personal_extraction_runs (id,preview_token,material_path,title,reading_state,source_raw_sha256,rule_fingerprint,model,created_at,status,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(runId, randomUUID(), '01图书馆/a.md', '真实资料标题', '未看', 'a'.repeat(64), 'rules', 'test', new Date().toISOString(), 'ready', JSON.stringify({ candidates: [{}, {}] }));
  f.run.mockImplementationOnce(async input => { input.emit({ type: 'action', action: { id: runId, type: 'review', label: '审阅知识候选', runId } }); });
  const first = await f.service.send(f.request()); const result = await settled(f.service, first.id);
  const updatedAt = result.updatedAt;
  expect(result.messages[1]?.actions[0]).toMatchObject({ materialTitle: '真实资料标题', materialPath: '01图书馆/a.md', candidateCount: 2, committedCount: 0, discardedCount: 0, status: 'ready' });
  const insert = f.database.prepare('INSERT INTO personal_candidate_reviews VALUES (?,?,?,1,?,?,?, ?, NULL, NULL)');
  insert.run('one', runId, 0, 'committed', 'keep', '{}', '{}');
  insert.run('two', runId, 1, 'pending', 'later', '{}', '{}');
  expect(f.service.get(first.id).messages[1]?.actions[0]).toMatchObject({ status: 'partial', committedCount: 1 });
  const batchId = randomUUID();
  f.database.prepare("INSERT INTO personal_ingestion_batches VALUES (?,?,?,'needs-review',0,'{}',NULL)").run(batchId, runId, new Date().toISOString());
  expect(f.service.get(first.id).messages[1]?.actions[0]?.status).toBe('needs-review');
  f.database.prepare("UPDATE personal_ingestion_batches SET status='writing' WHERE id=?").run(batchId);
  expect(f.service.get(first.id).messages[1]?.actions[0]?.status).toBe('writing');
  f.database.prepare("UPDATE personal_ingestion_batches SET status='committed' WHERE id=?").run(batchId);
  f.database.prepare("UPDATE personal_candidate_reviews SET state='discarded' WHERE id='two'").run();
  expect(f.service.get(first.id).messages[1]?.actions[0]).toMatchObject({ status: 'committed', committedCount: 1, discardedCount: 1 });
  expect(f.service.get(first.id).updatedAt).toBe(updatedAt);
});

it('marks a missing historical candidate run unavailable rather than claiming it remains ready', async () => {
  const f = fixture();
  f.run.mockImplementationOnce(async input => { input.emit({ type: 'action', action: { id: 'old-action', type: 'review', label: '审阅', runId: randomUUID(), status: 'ready', candidateCount: 3 } }); });
  const first = await f.service.send(f.request());
  expect((await settled(f.service, first.id)).messages[1]?.actions[0]?.status).toBe('unavailable');
});

it('projects a zero-candidate result as completed empty without pretending it was committed or discarded', async () => {
  const f = fixture(); const runId = randomUUID();
  f.database.prepare('INSERT INTO personal_extraction_runs (id,preview_token,material_path,title,reading_state,source_raw_sha256,rule_fingerprint,model,created_at,status,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(runId, randomUUID(), '01图书馆/empty.md', '没有可复用知识的资料', '未看', 'a'.repeat(64), 'rules', 'test', new Date().toISOString(), 'ready', JSON.stringify({ candidates: [] }));
  f.run.mockImplementationOnce(async input => { input.emit({ type: 'action', action: { id: runId, type: 'review', label: '审阅知识候选', runId, status: 'ready' } }); });
  const first = await f.service.send(f.request());
  const result = await settled(f.service, first.id);
  expect(result.messages[1]?.actions[0]).toMatchObject({ status: 'empty', label: '查看导读', candidateCount: 0, committedCount: 0, discardedCount: 0, runId });
  expect(f.database.prepare('SELECT COUNT(*) AS count FROM personal_candidate_reviews WHERE run_id=?').get(runId)).toEqual({ count: 0 });
});

it('recovers a crashed step without inventing when the previous process actually stopped', async () => {
  const f = fixture(); const first = await f.service.send(f.request()); await settled(f.service, first.id);
  const saved = f.service.get(first.id); saved.status = 'running';
  const answer = saved.messages[1]!; delete answer.finishedAt;
  answer.steps = [{ id: 'old-step', toolName: 'read_document', label: '阅读依据', status: 'running', startedAt: answer.startedAt! }];
  f.database.prepare('UPDATE assistant_conversations SET payload=? WHERE id=?').run(JSON.stringify(saved), saved.id);
  const restarted = createAssistantService({ database: f.database, adapters: [f.adapter], createTools: () => [] });
  try {
    const recovered = restarted.get(saved.id);
    expect(recovered.messages[1]?.steps?.[0]).toMatchObject({ status: 'stopped', startedAt: answer.startedAt });
    expect(recovered.messages[1]?.steps?.[0]?.finishedAt).toBeUndefined();
    expect(recovered.messages[1]?.finishedAt).toBeUndefined();
  } finally { await restarted.close(); }
});
