import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';
import { RULE_BUNDLE_SOURCE_PATHS, loadRuleBundle } from '../../src/server/rules/rule-bundle.js';
import { parseLibraryNoteForRead } from '../../src/server/rules/read-compatible-notes.js';
import { parseFrontmatter } from '../../src/server/rules/frontmatter.js';
import { sha256Bytes } from '../../src/server/vault/raw-bytes.js';
import { createIngestionService } from '../../src/server/ingestion/ingestion-service.js';
import type { PersonalIngestionPort } from '../../src/server/ingestion/ingestion-native.js';
import { patchFrontmatter } from '../../src/server/ingestion/note-format.js';
import { createExtractionQueueService } from '../../src/server/services/extraction-queue-service.js';
import { createExtractionService } from '../../src/server/services/extraction-service.js';

const source = '01图书馆/来自个人/原文.md';
const original = Buffer.from('---\n类型: 原始资料\n处理状态: 已归档\n来源平台: 个人\n原始标题: 原文\n所属主题: []\n关键词: []\n知识入库状态: 未提炼\n生成知识: []\n---\n\n先核实证据，再决定行动。\n![保留附件](a.png)\n');
const content = { keywords: ['证据', '判断', '行动'], scenarios: ['决策之前', '复盘时'], conclusion: '核实证据再行动。', keyPoints: ['核查证据', '决定行动'], boundary: '适用于可验证的问题。', quotes: [], summaries: ['个人总结：证据决定行动。'] };
const candidate = { title: '证据核查方法', knowledgeType: '方法', suggestedPath: '02知识库/09学习', topics: [], coreContent: '先核实证据，再决定行动。', value: '减少无效行动', draft: content };
const closes: (() => void)[] = [];
afterEach(() => closes.splice(0).reverse().forEach((close) => close()));
async function fixture(count = 2) {
  const db = new Database(':memory:'); closes.push(() => db.close()); applyMigrations(db);
  const fixtures = { [source]: original.toString(), '02知识库/09学习/.keep.md': '', ...Object.fromEntries(RULE_BUNDLE_SOURCE_PATHS.map((name) => [name, `规则 ${name}`])) };
  const gateway = new FakeVaultGateway(fixtures); const repository = createIndexRepository(db);
  repository.replaceFile({ kind: 'material', record: parseLibraryNoteForRead(original, source).record! });
  const files = new Map(Object.entries(fixtures).map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const recovery = new Map<string, Buffer>(); let writes = 0; let failAfter = 0;
  const put = (path: string, bytes: Buffer) => { files.set(path, Buffer.from(bytes)); gateway.mutateFixture(path, bytes.toString()); };
  const port: PersonalIngestionPort = { rootIdentity: { dev: '1', ino: '2' },
    read: (path) => files.get(path) ?? null, readRecovery: (name) => recovery.get(name) ?? null,
    writeRecovery: (name, bytes) => { if (recovery.has(name)) throw new Error('TARGET_EXISTS'); recovery.set(name, Buffer.from(bytes)); },
    listRecovery: () => [...recovery.keys()], close: () => {},
    apply: (path, stage, before, after) => {
      const current = files.get(path) ?? null;
      if ((before === null) !== (current === null) || (before && !before.equals(current!))) throw new Error('VERSION_CONFLICT');
      if (!recovery.get(stage)?.equals(after)) throw new Error('STAGE_INVALID');
      put(path, after); if (before) recovery.set(stage, before); else recovery.delete(stage);
      writes++; if (failAfter === writes) throw new Error('INGESTION_NEEDS_REVIEW');
    }
  };
  const runId = randomUUID(); const rule = (await loadRuleBundle(gateway)).fingerprint;
  const result = { briefing: { sentences: ['一。', '二。', '三。'], keyPoints: [], usefulness: '判断' }, candidates: Array.from({ length: count }, (_, index) => ({ ...candidate, title: `${candidate.title}${index + 1}` })) };
  db.prepare("INSERT INTO personal_extraction_runs (id,preview_token,material_path,title,reading_state,source_raw_sha256,rule_fingerprint,model,created_at,status,result_json) VALUES (?,?,?,?,?,?,?,?,?,'ready',?)")
    .run(runId, randomUUID(), source, '原文', '未看', sha256Bytes(original), rule, 'deepseek-v4-flash', '2026-09-07T00:00:00.000Z', JSON.stringify(result));
  let indexOk = true;
  const make = () => createIngestionService({ database: db, repository, gateway, port, refreshIndex: async () => indexOk });
  return { db, files, recovery, port, gateway, repository, runId, service: make(), make, put, writes: () => writes, failAfter: (n: number) => { failAfter = n; }, index: (ok: boolean) => { indexOk = ok; } };
}
async function select(f: Awaited<ReturnType<typeof fixture>>, index = 0, decision: 'keep' | 'discard' = 'keep') {
  const review = await f.service.review(f.runId); const c = review.candidates[index]!;
  return f.service.save(f.runId, { candidateId: c.id, version: c.version, draft: c.draft, target: c.target, decision });
}
async function preview(f: Awaited<ReturnType<typeof fixture>>) {
  const review = await f.service.review(f.runId);
  return f.service.preview({ runId: f.runId, versions: review.candidates.map(({ id, version }) => ({ id, version })) });
}
function replaceDeletedSource(f: Awaited<ReturnType<typeof fixture>>) {
  f.db.prepare("INSERT INTO personal_trash_entries(id,material_path,title,created_at,status,manifest_json) VALUES(?,?,?,?,'deleted','{}')")
    .run(randomUUID(), source, '旧资料', '2026-09-08T00:00:00.000Z');
  const bytes = Buffer.concat([original, Buffer.from('\n新资料的不同正文。')]);
  f.put(source, bytes);
  const runId = randomUUID();
  f.db.prepare(`INSERT INTO personal_extraction_runs (id,preview_token,material_path,title,reading_state,source_raw_sha256,rule_fingerprint,model,created_at,status,result_json)
    SELECT ?,?,material_path,'新资料',reading_state,?,rule_fingerprint,model,?,'ready',result_json FROM personal_extraction_runs WHERE id=?`)
    .run(runId, randomUUID(), sha256Bytes(bytes), '2026-09-09T00:00:00.000Z', f.runId);
  return { ...f, runId, bytes };
}
it('saves drafts durably but writes no vault files until confirmation', async () => {
  const f = await fixture(); await select(f); const before = [...f.files].map(([p, b]) => [p, b.toString()]);
  const p = await preview(f); expect(p.selectedCount).toBe(1); expect(f.writes()).toBe(0);
  expect([...f.files].map(([path, bytes]) => [path, bytes.toString()])).toEqual(before);
  const reopened = await f.make().review(f.runId); expect(reopened.candidates[0]!.decision).toBe('keep');
});
it('commits a subset, preserves original body, then resolves remaining candidates without re-extraction', async () => {
  const f = await fixture(); await select(f); const p = await preview(f); const first = await f.service.commit(p.id);
  expect(first.status).toBe('committed'); expect(first.pendingCount).toBe(1); expect(first.sourceStatus).toBe('部分入库');
  expect(parseFrontmatter(f.files.get(source)!).bodyBytes).toEqual(parseFrontmatter(original).bodyBytes);
  expect((await f.service.review(f.runId)).sourceChanged).toBe(false);
  expect(await f.service.commit(p.id)).toEqual(first); expect(f.writes()).toBe(2);
  await select(f, 1, 'discard'); const finish = await f.service.commit((await preview(f)).id);
  expect(finish.sourceStatus).toBe('已入库'); expect((await f.service.review(f.runId)).complete).toBe(true);
  expect(parseFrontmatter(f.files.get(source)!).data.生成知识).toHaveLength(1);
});

it.each([false, undefined, true])('uses explicit whole-source coverage when previewing and writing a finished selected range (%s)', async coversWholeSource => {
  const f = await fixture(1);
  const sourceRange = { offset: original.toString().indexOf('先核实'), length: 14, label: '合成文件第 2 页', ...(coversWholeSource === undefined ? {} : { coversWholeSource }) };
  f.db.prepare('UPDATE personal_extraction_runs SET source_range_json=? WHERE id=?').run(JSON.stringify(sourceRange), f.runId);
  await select(f); const planned = await preview(f);
  const expectedStatus = coversWholeSource ? '已入库' : '部分入库';
  expect(planned.sourceStatus).toBe(expectedStatus);
  expect(parseFrontmatter(Buffer.from(planned.files.find(file => file.kind === 'source')!.after)).data.知识入库状态).toBe(expectedStatus);
  const committed = await f.service.commit(planned.id);
  expect(committed.sourceStatus).toBe(expectedStatus);
  expect(parseFrontmatter(f.files.get(source)!).data.知识入库状态).toBe(expectedStatus);
  expect(parseFrontmatter(f.files.get(source)!).bodyBytes).toEqual(parseFrontmatter(original).bodyBytes);
  f.repository.replaceFile({ kind: 'material', record: parseLibraryNoteForRead(f.files.get(source)!, source).record! });
  const queue = createExtractionQueueService({ database: f.db, repository: f.repository });
  expect(queue.source(source).item).toMatchObject(coversWholeSource ? { view: 'ready', reviewComplete: true, canExtract: false }
    : { view: 'pending', reviewComplete: false, canExtract: true, pendingCandidateCount: 0 });
  if (!coversWholeSource) {
    const credentials = { status: () => ({ available: true, configured: true, revision: '1' }), getKey: () => 'synthetic', setKey: () => {}, clear: () => {} };
    const extraction = createExtractionService({ database: f.db, repository: f.repository, gateway: f.gateway, credentials, provider: { generate: async () => { throw Error('not called'); } } });
    try {
      const request = { materialPath: source, readingState: '已看' as const, model: 'test' };
      expect(await extraction.prepareAssistant!(request, new AbortController().signal)).toMatchObject({ materialPath: source });
      expect(await extraction.preview({ materialPath: source, readingState: '已看' })).toMatchObject({ materialPath: source });
    } finally { await extraction.close(); }
  }
});

it('keeps a selected-range source partial when rebuilding and applying an interrupted ingestion plan', async () => {
  const f = await fixture(1);
  f.db.prepare('UPDATE personal_extraction_runs SET source_range_json=? WHERE id=?').run(JSON.stringify({ offset: 0, length: 10, label: '第 2 页', coversWholeSource: false }), f.runId);
  await select(f); const planned = await preview(f); f.failAfter(1);
  expect((await f.service.commit(planned.id)).status).toBe('needs-review');
  const recovery = await f.service.recoveryPreview(planned.id);
  expect(recovery.files.find(file => file.kind === 'source')!.after).toContain('部分入库');
  expect((await f.service.resolve(recovery.id)).sourceStatus).toBe('部分入库');
  expect(parseFrontmatter(f.files.get(source)!).data.知识入库状态).toBe('部分入库');
});

it.each([false, true])('does not apply an old whole-source completion plan to a selected range (already started: %s)', async started => {
  const f = await fixture(1); await select(f); const planned = await preview(f);
  if (started) { f.failAfter(1); expect((await f.service.commit(planned.id)).status).toBe('needs-review'); }
  // The old version created this same full-completion plan even for a range.
  f.db.prepare('UPDATE personal_extraction_runs SET source_range_json=? WHERE id=?').run(JSON.stringify({ offset: 0, length: 10, label: '第 2 页' }), f.runId);
  if (started) {
    expect((await f.make().resume(planned.id)).status).toBe('needs-review');
    expect(parseFrontmatter(f.files.get(source)!).data.知识入库状态).toBe('未提炼');
    const recovery = await f.service.recoveryPreview(planned.id);
    expect((await f.service.resolve(recovery.id)).sourceStatus).toBe('部分入库');
  } else {
    await expect(f.service.commit(planned.id)).rejects.toMatchObject({ code: 'PLAN_STALE' });
    expect(f.writes()).toBe(0);
  }
});

it('keeps unresolved selected-range candidates visible and does not open another extraction prematurely', async () => {
  const f = await fixture(2);
  f.db.prepare('UPDATE personal_extraction_runs SET source_range_json=? WHERE id=?').run(JSON.stringify({ offset: 0, length: 10, label: '第 2 页' }), f.runId);
  await select(f); await f.service.commit((await preview(f)).id);
  f.repository.replaceFile({ kind: 'material', record: parseLibraryNoteForRead(f.files.get(source)!, source).record! });
  const queue = createExtractionQueueService({ database: f.db, repository: f.repository });
  expect(queue.source(source).item).toMatchObject({ view: 'ready', reviewComplete: false, canExtract: false, pendingCandidateCount: 1 });
  const credentials = { status: () => ({ available: true, configured: true, revision: '1' }), getKey: () => 'synthetic', setKey: () => {}, clear: () => {} };
  const extraction = createExtractionService({ database: f.db, repository: f.repository, gateway: f.gateway, credentials, provider: { generate: async () => { throw Error('not called'); } } });
  try { await expect(extraction.preview({ materialPath: source, readingState: '已看' })).rejects.toMatchObject({ code: 'SOURCE_NOT_ELIGIBLE' }); }
  finally { await extraction.close(); }
});

it('leaves a discarded page selection pending without claiming any knowledge was ingested', async () => {
  const f = await fixture(1);
  f.db.prepare('UPDATE personal_extraction_runs SET source_range_json=? WHERE id=?').run(JSON.stringify({ offset: 0, length: 10, label: '第 2 页' }), f.runId);
  await select(f, 0, 'discard'); const done = await f.service.commit((await preview(f)).id);
  expect(done).toMatchObject({ sourceStatus: '未提炼', knowledgePaths: [] });
  const queue = createExtractionQueueService({ database: f.db, repository: f.repository });
  expect(queue.source(source).item).toMatchObject({ view: 'pending', reviewComplete: false, canExtract: true });
  expect(f.writes()).toBe(0);
});
it('rejects stale drafts and target collision rather than overwriting', async () => {
  const f = await fixture(); const old = (await f.service.review(f.runId)).candidates[0]!;
  await select(f); expect(() => f.service.save(f.runId, { candidateId: old.id, version: old.version, draft: old.draft, target: old.target, decision: 'keep' })).toThrow();
  f.put('02知识库/09学习/证据核查方法1.md', Buffer.from('已有内容'));
  await expect(preview(f)).rejects.toMatchObject({ code: 'TARGET_EXISTS' }); expect(f.writes()).toBe(0);
});
it('rejects source changed after preview before writing any knowledge', async () => {
  const f = await fixture(); await select(f); const p = await preview(f); f.put(source, Buffer.concat([original, Buffer.from('外部新增')]));
  await expect(f.service.commit(p.id)).rejects.toMatchObject({ code: 'PLAN_STALE' }); expect(f.writes()).toBe(0);
});
it('rejects a source reserved by trash after the ingestion preview without losing saved candidates', async () => {
  const f = await fixture(); await select(f); const p = await preview(f);
  f.db.prepare("INSERT INTO personal_trash_entries(id,material_path,title,created_at,status,manifest_json) VALUES(?,?,?,?,'moving','{}')")
    .run(randomUUID(), source, '原文', new Date().toISOString());
  await expect(f.service.commit(p.id)).rejects.toMatchObject({ code: 'SOURCE_IN_TRASH' });
  await expect(preview(f)).rejects.toMatchObject({ code: 'SOURCE_IN_TRASH' });
  expect(f.writes()).toBe(0); expect((await f.service.review(f.runId)).candidates[0]!.decision).toBe('keep');
});
it('resumes an interrupted confirmed batch and never duplicates already written knowledge', async () => {
  const f = await fixture(); await select(f); const p = await preview(f); f.failAfter(1);
  const failed = await f.service.commit(p.id); expect(failed.status).toBe('needs-review');
  const resumed = await f.make().resume(p.id); expect(resumed.status).toBe('committed'); expect(f.writes()).toBe(2);
  expect((await f.service.review(f.runId)).candidates[0]!.state).toBe('committed');
});

it('does not create a knowledge target reserved by trash between preview and commit', async () => {
  const f = await fixture(1); await select(f); const p = await preview(f);
  const target = p.files.find(file => file.kind === 'new')!.path;
  f.db.prepare("INSERT INTO personal_trash_entries(id,material_path,title,created_at,status,manifest_json) VALUES(?,?,?,?,'trashed','{}')")
    .run(randomUUID(), target, '回收中的知识', new Date().toISOString());
  await expect(f.service.commit(p.id)).rejects.toMatchObject({ code: 'KNOWLEDGE_IN_TRASH' });
  await expect(preview(f)).rejects.toMatchObject({ code: 'KNOWLEDGE_IN_TRASH' });
  expect(f.writes()).toBe(0);
  expect((await f.service.review(f.runId)).candidates[0]!.decision).toBe('keep');
});

it('never recreates a recycled knowledge file when resuming an interrupted ingestion batch', async () => {
  const f = await fixture(1); await select(f); const p = await preview(f); f.failAfter(1);
  expect((await f.service.commit(p.id)).status).toBe('needs-review');
  const target = p.files.find(file => file.kind === 'new')!.path;
  f.files.delete(target);
  f.db.prepare("INSERT INTO personal_trash_entries(id,material_path,title,created_at,status,manifest_json) VALUES(?,?,?,?,'trashed','{}')")
    .run(randomUUID(), target, '回收中的知识', new Date().toISOString());
  const writes = f.writes();
  expect((await f.make().resume(p.id)).status).toBe('needs-review');
  expect(f.writes()).toBe(writes); expect(f.files.has(target)).toBe(false);
  await expect(f.service.recoveryPreview(p.id)).rejects.toMatchObject({ code: 'KNOWLEDGE_IN_TRASH' });
});
it('only retries the index after files are committed', async () => {
  const f = await fixture(); await select(f); f.index(false); const p = await preview(f);
  expect((await f.service.commit(p.id)).indexed).toBe(false); const writes = f.writes();
  f.index(true); expect((await f.service.resume(p.id)).indexed).toBe(true); expect(f.writes()).toBe(writes);
});
it('all-discard closes the review without pretending a knowledge note was ingested', async () => {
  const f = await fixture(); await select(f, 0, 'discard'); await select(f, 1, 'discard');
  const result = await f.service.commit((await preview(f)).id);
  expect(result.knowledgePaths).toEqual([]); expect(result.sourceStatus).toBe('未提炼');
  expect((await f.service.review(f.runId)).complete).toBe(true); expect(f.writes()).toBe(0);
});

it('excludes deleted-source pending history when completing a new same-path source', async () => {
  const old = await fixture(1);
  const oldCandidates = (await old.service.review(old.runId)).candidates;
  const f = replaceDeletedSource(old); await select(f);
  const result = await f.service.commit((await preview(f)).id);
  expect(result).toMatchObject({ status: 'committed', pendingCount: 0, sourceStatus: '已入库' });
  const review = await f.service.review(f.runId);
  expect(review.complete).toBe(true); expect(review.relatedRuns).toEqual([]);
  expect(parseFrontmatter(f.files.get(source)!).bodyBytes).toEqual(parseFrontmatter(f.bytes).bodyBytes);
  expect((await old.service.review(old.runId)).candidates).toEqual(oldCandidates);
});

it('does not reuse deleted-source committed history to ingest a new all-discard source', async () => {
  const old = await fixture(1); await select(old);
  await old.service.commit((await preview(old)).id);
  // A run at the deletion cutoff belongs to the old document, matching queue visibility.
  old.db.prepare('UPDATE personal_extraction_runs SET created_at=? WHERE id=?').run('2026-09-08T00:00:00.000Z', old.runId);
  const oldCandidates = (await old.service.review(old.runId)).candidates;
  const f = replaceDeletedSource(old); await select(f, 0, 'discard');
  const writes = f.writes();
  const result = await f.service.commit((await preview(f)).id);
  expect(result).toMatchObject({ status: 'committed', pendingCount: 0, sourceStatus: '未提炼', knowledgePaths: [] });
  expect(f.files.get(source)).toEqual(f.bytes); expect(f.writes()).toBe(writes);
  expect((await f.service.review(f.runId)).complete).toBe(true);
  expect((await old.service.review(old.runId)).candidates).toEqual(oldCandidates);
});
it('does not hide a raced source version in stage on restart; recovery can restore its unchanged body', async () => {
  const f = await fixture(); await select(f); const p = await preview(f); f.failAfter(2);
  const failed = await f.service.commit(p.id); expect(failed.status).toBe('needs-review');
  const row = f.db.prepare('SELECT plan_json FROM personal_ingestion_batches WHERE id=?').get(p.id) as { plan_json: string };
  const plan = JSON.parse(row.plan_json); const sourceFile = plan.files.find((file: { kind: string }) => file.kind === 'source');
  const external = Buffer.concat([original, Buffer.from('\n用户在交换前新增的原文。')]);
  f.recovery.set(`${sourceFile.stageId}.stage.md`, external);
  expect((await f.make().resume(p.id)).status).toBe('needs-review');
  const recovery = await f.service.recoveryPreview(p.id);
  expect(recovery.sourceChoice).toBe('preserved'); expect(recovery.hasPreservedSource).toBe(true);
  expect(recovery.files.find((file) => file.kind === 'source')?.preserved).toContain('用户在交换前新增');
  const result = await f.service.resolve(recovery.id); expect(result.status).toBe('committed');
  expect(parseFrontmatter(f.files.get(source)!).bodyBytes).toEqual(parseFrontmatter(external).bodyBytes);
  expect(await f.make().resolve(recovery.id)).toEqual(result);
});
it('requires explicit source acknowledgment after external edits and preserves the current version', async () => {
  const f = await fixture(); await select(f); const external = Buffer.concat([original, Buffer.from('\n新的证据')]); f.put(source, external);
  const review = await f.service.review(f.runId); expect(review.sourceChanged).toBe(true);
  await expect(preview(f)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  const p = await f.service.preview({ runId: f.runId, versions: review.candidates.map(({ id, version }) => ({ id, version })), acknowledgedSourceSha: review.sourceCurrentSha! });
  expect((await f.service.commit(p.id)).status).toBe('committed');
  expect(parseFrontmatter(f.files.get(source)!).bodyBytes).toEqual(parseFrontmatter(external).bodyBytes);
});

it.each(['定论', '已优化', '过时'])('never overwrites an externally protected %s note during recovery; explicit new title provides an in-app exit', async (status) => {
  const f = await fixture(1); await select(f); const p = await preview(f); f.failAfter(1);
  expect((await f.service.commit(p.id)).status).toBe('needs-review');
  const target = p.files.find((file) => file.kind === 'new')!.path;
  const protectedBytes = patchFrontmatter(f.files.get(target)!, { 使用状态: status }); f.put(target, protectedBytes);
  await expect(f.service.recoveryPreview(p.id)).rejects.toMatchObject({ code: 'RECOVERY_TARGET_PROTECTED' });
  expect(f.files.get(target)).toEqual(protectedBytes);
  const alternative = '02知识库/09学习/独立补充知识.md';
  const recovery = await f.service.recoveryPreview(p.id, undefined, { [target]: alternative });
  expect(recovery.files.some((file) => file.path === target)).toBe(false);
  expect(recovery.files.find((file) => file.path === alternative)?.kind).toBe('new');
  const done = await f.service.resolve(recovery.id); expect(done.status).toBe('committed');
  expect(done.knowledgePaths).toEqual([alternative]); expect(f.files.get(target)).toEqual(protectedBytes);
  expect(parseFrontmatter(f.files.get(source)!).bodyBytes).toEqual(parseFrontmatter(original).bodyBytes);
});

it('does not overwrite a protected version preserved in the native swap stage', async () => {
  const f = await fixture(1); await select(f); const p = await preview(f); f.failAfter(1);
  await f.service.commit(p.id);
  const row = f.db.prepare('SELECT plan_json FROM personal_ingestion_batches WHERE id=?').get(p.id) as { plan_json: string };
  const file = JSON.parse(row.plan_json).files[0];
  f.recovery.set(`${file.stageId}.stage.md`, patchFrontmatter(Buffer.from(file.after), { 使用状态: '定论' }));
  await expect(f.service.recoveryPreview(p.id)).rejects.toMatchObject({ code: 'RECOVERY_TARGET_PROTECTED' });
  const preserved = f.recovery.get(`${file.stageId}.stage.md`)!;
  const recovery = await f.service.recoveryPreview(p.id, undefined, { [file.path]: '02知识库/09学习/单独的新知识.md' });
  expect(recovery.files.find((item) => item.path === file.path)?.after).toBe(preserved.toString());
  expect((await f.service.resolve(recovery.id)).status).toBe('committed');
  expect(f.files.get(file.path)).toEqual(preserved);
});

it('rechecks newly discovered same-source candidates before resuming and shows the updated remaining count in recovery', async () => {
  const f = await fixture(1); await select(f); const p = await preview(f); f.failAfter(1); await f.service.commit(p.id);
  const secondRun = randomUUID();
  f.db.prepare("INSERT INTO personal_extraction_runs (id,preview_token,material_path,title,reading_state,source_raw_sha256,rule_fingerprint,model,created_at,status,result_json) SELECT ?,?,material_path,title,reading_state,source_raw_sha256,rule_fingerprint,model,created_at,status,result_json FROM personal_extraction_runs WHERE id=?")
    .run(secondRun, randomUUID(), f.runId);
  expect((await f.service.resume(p.id)).status).toBe('needs-review');
  const recovery = await f.service.recoveryPreview(p.id);
  expect(recovery.files.find((file) => file.kind === 'source')!.after).toContain('部分入库');
  const done = await f.service.resolve(recovery.id); expect(done.status).toBe('committed'); expect(done.pendingCount).toBe(1);
  expect((await f.service.review(secondRun)).candidates[0]!.state).toBe('pending');
});

it('does not redirect recovery into a new path reserved by another unfinished batch', async () => {
  const f = await fixture(1); await select(f); const p = await preview(f); f.failAfter(1); await f.service.commit(p.id);
  const row = f.db.prepare('SELECT plan_json FROM personal_ingestion_batches WHERE id=?').get(p.id) as { plan_json: string };
  const otherId = randomUUID(), originalPlan = JSON.parse(row.plan_json);
  const alternative = '02知识库/09学习/另一个已确认目标.md';
  const otherPlan = { ...originalPlan, id: otherId, journalId: otherId, materialPath: '01图书馆/来自个人/另一资料.md',
    preview: { ...originalPlan.preview, id: otherId }, files: [{ ...originalPlan.files[0], path: alternative }] };
  f.db.prepare("INSERT INTO personal_ingestion_batches VALUES (?,?,?,'writing',0,?,NULL)").run(otherId, f.runId, '2026-09-07T00:00:00.000Z', JSON.stringify(otherPlan));
  await expect(f.service.recoveryPreview(p.id, undefined, { [originalPlan.files[0].path]: alternative })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(f.files.has(alternative)).toBe(false);
});

async function interruptedSourceRecovery() {
  const f = await fixture(1); await select(f); const p = await preview(f); f.failAfter(2);
  expect((await f.service.commit(p.id)).status).toBe('needs-review');
  const plan = JSON.parse((f.db.prepare('SELECT plan_json FROM personal_ingestion_batches WHERE id=?').get(p.id) as { plan_json: string }).plan_json);
  const sourceStageId = plan.files.find((file: { kind: string }) => file.kind === 'source').stageId as string;
  const sourceStage = `${sourceStageId}.stage.md`;
  const shown = Buffer.concat([original, Buffer.from('\n预览时的保留原文。')]);
  f.recovery.set(sourceStage, shown);
  return { ...f, p, sourceStageId, sourceStage, shown };
}

it('rejects a recovery confirmation when its original stage changed and lets a fresh preview restore that new version', async () => {
  const f = await interruptedSourceRecovery(); const recovery = await f.service.recoveryPreview(f.p.id);
  const newest = Buffer.concat([f.shown, Buffer.from('\n确认之前新增的证据。')]); f.recovery.set(f.sourceStage, newest);
  const writes = f.writes();
  await expect(f.service.resolve(recovery.id)).rejects.toMatchObject({ code: 'PLAN_STALE' });
  expect(f.writes()).toBe(writes); expect(f.recovery.get(f.sourceStage)).toEqual(newest);
  expect((await f.service.review(f.runId)).complete).toBe(false);
  const reopened = f.make(), fresh = await reopened.recoveryPreview(f.p.id);
  expect(fresh.files.find((file) => file.kind === 'source')!.preserved).toBe(newest.toString());
  expect((await reopened.resolve(fresh.id)).status).toBe('committed');
  expect(parseFrontmatter(f.files.get(source)!).bodyBytes).toEqual(parseFrontmatter(newest).bodyBytes);
  expect(f.recovery.get(f.sourceStage)).toEqual(newest);
});

it('persists ancestor stage dependencies when they change after registering a recovery and can re-preview them after reopening', async () => {
  const f = await interruptedSourceRecovery(), recovery = await f.service.recoveryPreview(f.p.id);
  const newest = Buffer.concat([f.shown, Buffer.from('\n恢复计划登记之后新增的证据。')]);
  const writeRecovery = f.port.writeRecovery; let recoveryIntent: string | undefined;
  f.port.writeRecovery = (name, bytes) => {
    writeRecovery(name, bytes);
    if (name.endsWith('.intent.json')) { recoveryIntent = name; f.recovery.set(f.sourceStage, newest); }
  };
  const writes = f.writes(); expect((await f.service.resolve(recovery.id)).status).toBe('needs-review');
  expect(f.writes()).toBe(writes); f.port.writeRecovery = writeRecovery;
  const saved = JSON.parse((f.db.prepare('SELECT plan_json FROM personal_ingestion_batches WHERE id=?').get(f.p.id) as { plan_json: string }).plan_json);
  expect(saved.recoveryReadSet).toContainEqual(expect.objectContaining({ path: source, stageId: f.sourceStageId, expectedSha256: sha256Bytes(f.shown) }));
  const intent = f.recovery.get(recoveryIntent!)!;
  const reopened = f.make(); expect((await reopened.resume(f.p.id)).status).toBe('needs-review');
  const fresh = await reopened.recoveryPreview(f.p.id);
  expect(fresh.hasPreservedSource).toBe(true);
  expect(fresh.files.find((file) => file.kind === 'source')!.preserved).toBe(newest.toString());
  expect((await reopened.resolve(fresh.id)).status).toBe('committed');
  expect(parseFrontmatter(f.files.get(source)!).bodyBytes).toEqual(parseFrontmatter(newest).bodyBytes);
  expect(f.recovery.get(f.sourceStage)).toEqual(newest); expect(f.recovery.get(recoveryIntent!)).toEqual(intent);
});

it('keeps a changed ancestor stage reviewable when a later recovery source swap has already happened', async () => {
  const f = await interruptedSourceRecovery(), recovery = await f.service.recoveryPreview(f.p.id);
  const newest = Buffer.concat([f.shown, Buffer.from('\n恢复交换时又新增的证据。')]);
  const apply = f.port.apply;
  f.port.apply = (...args) => { apply(...args); if (args[0] === source) f.recovery.set(f.sourceStage, newest); };
  expect((await f.service.resolve(recovery.id)).status).toBe('needs-review'); f.port.apply = apply;
  const saved = JSON.parse((f.db.prepare('SELECT plan_json FROM personal_ingestion_batches WHERE id=?').get(f.p.id) as { plan_json: string }).plan_json);
  expect(f.recovery.has(`${saved.journalId}.result.json`)).toBe(false);
  expect(parseFrontmatter(f.files.get(source)!).bodyBytes).toEqual(parseFrontmatter(f.shown).bodyBytes);
  const reopened = f.make(), fresh = await reopened.recoveryPreview(f.p.id);
  expect(fresh.files.find((file) => file.kind === 'source')!.preserved).toBe(newest.toString());
  expect((await reopened.resolve(fresh.id)).status).toBe('committed');
  expect(parseFrontmatter(f.files.get(source)!).bodyBytes).toEqual(parseFrontmatter(newest).bodyBytes);
  expect(f.recovery.get(f.sourceStage)).toEqual(newest);
});

it('can re-preview and restore an updated protected ancestor after its separate-new-target recovery was registered', async () => {
  const f = await fixture(1); await select(f); const p = await preview(f); f.failAfter(1); await f.service.commit(p.id);
  const plan = JSON.parse((f.db.prepare('SELECT plan_json FROM personal_ingestion_batches WHERE id=?').get(p.id) as { plan_json: string }).plan_json);
  const file = plan.files[0], stage = `${file.stageId}.stage.md`, alternative = '02知识库/09学习/独立候选.md';
  const protectedVersion = patchFrontmatter(Buffer.from(file.after), { 使用状态: '定论' }); f.recovery.set(stage, protectedVersion);
  const recovery = await f.service.recoveryPreview(p.id, undefined, { [file.path]: alternative });
  const newest = Buffer.concat([protectedVersion, Buffer.from('\n定论保留版的最新人工补充。')]);
  const writeRecovery = f.port.writeRecovery;
  f.port.writeRecovery = (name, bytes) => { writeRecovery(name, bytes); if (name.endsWith('.intent.json')) f.recovery.set(stage, newest); };
  expect((await f.service.resolve(recovery.id)).status).toBe('needs-review'); f.port.writeRecovery = writeRecovery;
  const reopened = f.make(), fresh = await reopened.recoveryPreview(p.id);
  expect(fresh.files.find((item) => item.path === file.path)?.after).toBe(newest.toString());
  expect((await reopened.resolve(fresh.id)).status).toBe('committed');
  expect(f.files.get(file.path)).toEqual(newest); expect(f.files.has(alternative)).toBe(true);
  expect(f.recovery.get(stage)).toEqual(newest);
});
