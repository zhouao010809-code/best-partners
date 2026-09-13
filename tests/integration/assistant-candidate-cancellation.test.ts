import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';
import { parseLibraryNoteForRead } from '../../src/server/rules/read-compatible-notes.js';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { createExtractionService } from '../../src/server/services/extraction-service.js';
import { createReadService } from '../../src/server/services/read-service.js';
import { createAssistantService } from '../../src/server/assistant/service.js';
import { createDeepSeekAssistantAdapter } from '../../src/server/assistant/deepseek-adapter.js';
import { createBrainTools } from '../../src/server/assistant/brain-tools.js';

const path = '01图书馆/来自个人/资料.md';
const note = '---\n类型: 原始资料\n处理状态: 已归档\n来源平台: 个人\n原始标题: 一份资料\n所属主题: []\n关键词: []\n知识入库状态: 未提炼\n生成知识: []\n---\n原始正文。';
const result = {
  briefing: { sentences: ['资料第一点。', '资料第二点。', '资料第三点。'], keyPoints: ['主要点'], usefulness: '帮助判断' },
  candidates: [{ title: '判断方法', knowledgeType: '方法', suggestedPath: '02知识库/09学习/学习方法', topics: [],
    coreContent: '先理解再判断', value: '可反复使用',
    draft: { keywords: ['判断', '原文', '理解'], scenarios: ['理解资料时', '核验知识时'], conclusion: '先理解原文再判断。',
      keyPoints: ['理解语境', '核验依据'], boundary: '适用于有原文依据的资料。', quotes: ['原始正文。'], summaries: ['用证据支撑判断。'] } }]
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Chunk = { delta: Record<string, unknown>; finish_reason?: string };
function completion(chunks: Chunk[]) {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify({ id: 'test', created: 1, model: 'deepseek-v4-pro',
    choices: [{ index: 0, finish_reason: null, ...chunk }] })}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } });
}
function toolCall(name: string, args: unknown, id: string): Chunk {
  return { delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

/** The SDK and all candidate-persistence services are real; only transport and vault are fake. */
function fixture(mode: 'failure' | 'stop' | 'timeout' | 'close') {
  const database = new Database(':memory:'); applyMigrations(database);
  const gateway = new FakeVaultGateway({ [path]: note, '02知识库/09学习/学习方法/已有.md': 'test',
    ...Object.fromEntries(RULE_BUNDLE_SOURCE_PATHS.map(rule => [rule, '规则内容'])) });
  const repository = createIndexRepository(database);
  repository.replaceFile({ kind: 'material', record: parseLibraryNoteForRead(Buffer.from(note), path).record! });
  const readBlocked = deferred(); const releaseRead = deferred(); const submitSettled = deferred();
  let submitting = false; let paused = false; let runSignal: AbortSignal | undefined;
  const originalRead = gateway.readRaw.bind(gateway);
  vi.spyOn(gateway, 'readRaw').mockImplementation(async (...args) => {
    if (submitting && !paused) {
      paused = true; readBlocked.resolve(); await releaseRead.promise;
    }
    return originalRead(...args);
  });
  const credentials = { status: () => ({ available: true, configured: true, revision: '1' }),
    getKey: () => 'only-fake-key', setKey() {}, clear() {} };
  const extraction = createExtractionService({ database, repository, gateway, credentials,
    provider: { generate: async () => { throw new Error('UNEXPECTED_MODEL_REQUEST'); } } });
  const accept = extraction.acceptAssistant!.bind(extraction);
  extraction.acceptAssistant = async (...args) => {
    submitting = true;
    try { return await accept(...args); } finally { submitSettled.resolve(); }
  };
  const readService = createReadService({ database, repository, gateway, currentIndexVersion: () => 1, cursorSecret: Buffer.alloc(32, 1) });
  let completionCount = 0;
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'deepseek-v4-pro' }] });
    completionCount++;
    if (completionCount === 1) return completion([toolCall('prepare_extraction', { path }, 'prepare'), { delta: {}, finish_reason: 'tool_calls' }]);
    if (completionCount === 2) {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const preparation = JSON.parse(request.messages.find(message => message.role === 'tool')!.content) as { token: string };
      return completion([{ delta: { content: mode === 'failure' ? 'x'.repeat(160001) : '正在整理候选。' } },
        toolCall('submit_candidates', { token: preparation.token, result }, 'submit'), { delta: {}, finish_reason: 'tool_calls' }]);
    }
    return completion([{ delta: { content: '完成。' }, finish_reason: 'stop' }]);
  });
  const adapter = createDeepSeekAssistantAdapter({ credentials, fetch: transport });
  const service = createAssistantService({ database, adapters: [adapter], timeoutMs: mode === 'timeout' ? 1000 : 3000,
    createTools: context => { runSignal = context.signal; return createBrainTools({ ...context, readService, extractionService: extraction }); } });
  async function releasePendingRead() {
    releaseRead.resolve();
    if (submitting) await submitSettled.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  cleanup.push(async () => {
    await service.close(); await releasePendingRead(); await extraction.close(); database.close();
  });
  return { service, extraction, readBlocked: readBlocked.promise, releasePendingRead, signal: () => runSignal,
    completionCount: () => completionCount,
    send: () => service.send({ clientRequestId: randomUUID(), providerId: 'deepseek', model: 'deepseek-v4-pro',
      message: '提炼这份原始资料', scope: 'current', contextPath: path }) };
}

it.each(['failure', 'stop', 'timeout', 'close'] as const)('prevents late SDK candidates from persisting after %s', async mode => {
  const f = fixture(mode);
  const started = await f.send();
  if (mode !== 'failure') {
    await f.readBlocked;
    expect(f.extraction.list().items).toEqual([]);
    if (mode === 'stop') f.service.stop(started.id);
    // close must return while the in-flight vault read is still paused.
    if (mode === 'close') await f.service.close();
  }
  await vi.waitFor(() => expect(f.service.get(started.id).status).not.toBe('running'), { timeout: 2000 });
  await f.releasePendingRead();
  const conversation = f.service.get(started.id);
  expect(f.extraction.list().items).toEqual([]);
  expect(f.signal()?.aborted).toBe(true);
  expect(conversation.status).toBe(mode === 'failure' || mode === 'timeout' ? 'failed' : 'stopped');
  expect(conversation.problem).toContain(mode === 'failure' ? '回答过长' : mode === 'timeout' ? '等待较久' : '已停止');
  expect(conversation.messages.at(-1)?.actions).toEqual([]);
  expect(f.completionCount()).toBe(2);
});
