import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { openPersonalArchive } from '../../src/server/archive/sandbox-native.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { loadIndexMetadata } from '../../src/server/index/index-metadata.js';
import { SearchIndexer } from '../../src/server/index/SearchIndexer.js';
import { createIngestionService } from '../../src/server/ingestion/ingestion-service.js';
import { ingestionPlanSchema } from '../../src/server/ingestion/ingestion-coordinator.js';
import { createKnowledgeNote } from '../../src/server/ingestion/note-format.js';
import type { PersonalIngestionPort } from '../../src/server/ingestion/ingestion-native.js';
import { parseFrontmatter } from '../../src/server/rules/frontmatter.js';
import { RULE_BUNDLE_SOURCE_PATHS, loadRuleBundle } from '../../src/server/rules/rule-bundle.js';
import { FileSystemVaultGateway } from '../../src/server/vault/FileSystemVaultGateway.js';
import { createNativeReadVaultPortFactory } from '../../src/server/vault/NativeReadVaultPort.js';
import { sha256Bytes } from '../../src/server/vault/raw-bytes.js';

const addon = resolve('dist/native/personal-archive.node'), helper = resolve('dist/native/atomic-file-helper');
const source = '01图书馆/来自个人/测试资料/原文.md', knowledge = '02知识库/09学习/证据核查方法.md';
const marker = 'personal-ingestion-flow-v1\n';
const original = Buffer.from('\ufeff---\r\n类型: 原始资料\r\n处理状态: 已归档\r\n来源平台: 个人\r\n原始标题: 原文\r\n所属主题: []\r\n关键词: []\r\n知识入库状态: 未提炼\r\n生成知识: []\r\n---\r\n\r\n先核实证据，再决定行动。\r\n![保留附件](附件.bin)\r\n');
const content = { keywords: ['证据', '判断', '行动'], scenarios: ['决策之前', '复盘时'], conclusion: '核实证据再行动。', keyPoints: ['核查证据', '决定行动'], boundary: '适用于可验证的问题。', quotes: ['先核实证据，再决定行动。'], summaries: ['个人总结：证据决定行动。'] };
const candidate = { title: '证据核查方法', knowledgeType: '方法' as const, suggestedPath: '02知识库/09学习', topics: [], coreContent: '先核实证据，再决定行动。', value: '减少无效行动', draft: content };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/build-native-helper.ts']);
  await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/build-sandbox-archive.ts', '--personal']);
});

async function fixture(existing = false, decorate: (port: PersonalIngestionPort) => PersonalIngestionPort = (port) => port) {
  const base = mkdtempSync('/private/tmp/xiaozhao-personal-ingestion-flow-'); chmodSync(base, 0o700);
  writeFileSync(join(base, '.test-marker'), marker, { mode: 0o600, flag: 'wx' });
  cleanup.push(() => {
    if (dirname(base) !== '/private/tmp' || !basename(base).startsWith('xiaozhao-personal-ingestion-flow-')
      || realpathSync(base) !== base || !lstatSync(base).isDirectory()
      || readFileSync(join(base, '.test-marker'), 'utf8') !== marker) throw new Error('REFUSE_UNVERIFIED_INGESTION_FLOW_CLEANUP');
    rmSync(base, { recursive: true });
  });
  const root = join(base, 'vault'), intakeRecovery = join(base, 'intake'), recovery = join(base, 'ingestion'), databasePath = join(base, 'state.sqlite3');
  for (const path of [root, intakeRecovery, recovery]) mkdirSync(path, { mode: 0o700 });
  for (const path of ['00大脑规则', '01图书馆/小兆clipper', dirname(source), '02知识库/09学习', '03大讲堂']) mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  for (const path of RULE_BUNDLE_SOURCE_PATHS) writeFileSync(join(root, path), `隔离测试规则 ${path}\n`, { mode: 0o600, flag: 'wx' });
  writeFileSync(join(root, source), original, { mode: 0o644, flag: 'wx' });
  writeFileSync(join(root, dirname(source), '附件.bin'), Buffer.from([0, 255, 1, 13, 10]), { mode: 0o600, flag: 'wx' });
  const previousKnowledge = createKnowledgeNote({ ...candidate, coreContent: '已有知识正文必须完整保留。', draft: { ...content, quotes: [] } }, source, '2026-09-06');
  if (existing) writeFileSync(join(root, knowledge), previousKnowledge, { mode: 0o644, flag: 'wx' });
  const gateway = await FileSystemVaultGateway.create({ vaultRoot: root, nativeReader: createNativeReadVaultPortFactory(helper) });
  expect(await gateway.probeReadiness()).toEqual({ status: 'ready' });
  const runId = randomUUID();
  async function open(wrap: (port: PersonalIngestionPort) => PersonalIngestionPort = (port) => port) {
    const database = new Database(databasePath); applyMigrations(database);
    // The HTTP IndexJobService normally seeds this singleton during App startup.
    database.prepare("INSERT OR IGNORE INTO index_metadata (singleton,version,updated_at) VALUES (1,0,'2026-09-07T00:00:00.000Z')").run();
    const archive = openPersonalArchive(root, intakeRecovery, addon), native = archive.openIngestion(recovery);
    const repository = createIndexRepository(database), indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 50 });
    indexer.version = loadIndexMetadata(database)?.version ?? 0;
    const indexErrors: unknown[] = [];
    const service = createIngestionService({ database, repository, gateway, port: wrap(native), refreshIndex: async () => {
      try { let result = await indexer.refresh(); while (result.status === 'refreshing') result = await indexer.refresh(); return result.status === 'ready'; }
      catch (error) { indexErrors.push(error); throw error; }
    } });
    let closed = false;
    const close = async () => { if (closed) return; closed = true; await service.close(); native.close(); archive.close(); database.close(); };
    cleanup.push(close);
    return { service, native, database, repository, close, indexErrors,
      plan: (id: string) => ingestionPlanSchema.parse(JSON.parse((database.prepare('SELECT plan_json FROM personal_ingestion_batches WHERE id=?').get(id) as { plan_json: string }).plan_json)) };
  }
  const current = await open(decorate), rule = (await loadRuleBundle(gateway)).fingerprint;
  current.database.prepare("INSERT INTO personal_extraction_runs (id,preview_token,material_path,title,reading_state,source_raw_sha256,rule_fingerprint,model,created_at,status,result_json) VALUES (?,?,?,?,?,?,?,?,?,'ready',?)")
    .run(runId, randomUUID(), source, '隔离原文', '未看', sha256Bytes(original), rule, 'deepseek-v4-flash', '2026-09-07T00:00:00.000Z',
      JSON.stringify({ briefing: { sentences: ['一。', '二。', '三。'], keyPoints: [], usefulness: '判断' }, candidates: [candidate] }));
  return { base, root, recovery, runId, previousKnowledge, current, reopen: open };
}
async function preview(f: Awaited<ReturnType<typeof fixture>>, mode: 'new' | 'merge' = 'new') {
  let review = await f.current.service.review(f.runId); const c = review.candidates[0]!;
  f.current.service.save(f.runId, { candidateId: c.id, version: c.version, draft: c.draft,
    target: mode === 'new' ? { mode } : { mode, path: knowledge }, decision: 'keep' });
  review = await f.current.service.review(f.runId);
  return f.current.service.preview({ runId: f.runId, versions: review.candidates.map(({ id, version }) => ({ id, version })) });
}

it('previews without writes, commits through the real native port, and retains bytes and idempotency after reopening SQLite', async () => {
  const f = await fixture(); const originalInode = lstatSync(join(f.root, source)).ino;
  const p = await preview(f);
  expect(existsSync(join(f.root, knowledge))).toBe(false); expect(f.current.native.listRecovery()).toEqual([]);
  expect(readFileSync(join(f.root, source))).toEqual(original);
  const result = await f.current.service.commit(p.id); expect(f.current.indexErrors).toEqual([]);
  expect(result).toMatchObject({ status: 'committed', indexed: true, sourceStatus: '已入库', pendingCount: 0 });
  const plan = f.current.plan(p.id);
  for (const file of plan.files) expect(readFileSync(join(f.root, file.path))).toEqual(Buffer.from(file.after));
  expect(parseFrontmatter(readFileSync(join(f.root, source))).bodyBytes).toEqual(parseFrontmatter(original).bodyBytes);
  expect(readFileSync(join(f.root, dirname(source), '附件.bin'))).toEqual(Buffer.from([0, 255, 1, 13, 10]));
  const sourceStage = `${plan.files.find((file) => file.kind === 'source')!.stageId}.stage.md`;
  expect(f.current.native.readRecovery(sourceStage)).toEqual(original);
  expect(lstatSync(join(f.recovery, sourceStage)).ino).toBe(originalInode);
  expect(f.current.native.readRecovery(`${plan.files[0]!.stageId}.stage.md`)).toBeNull();
  expect(f.current.native.listRecovery()).toContain(`${plan.id}.intent.json`);
  expect(f.current.native.listRecovery()).toContain(`${plan.id}.result.json`);
  expect(f.current.repository.listKnowledge({ page: 1, pageSize: 50 }).items.map((item) => item.path)).toContain(knowledge);
  const knowledgeInode = lstatSync(join(f.root, knowledge)).ino;
  await f.current.close(); const reopened = await f.reopen();
  expect(await reopened.service.commit(p.id)).toEqual(result);
  expect(lstatSync(join(f.root, knowledge)).ino).toBe(knowledgeInode);
  expect((await reopened.service.review(f.runId)).candidates[0]!.state).toBe('committed');
  expect(reopened.native.readRecovery(sourceStage)).toEqual(original);
});

it('resumes a real completed knowledge swap after interruption and writes only the remaining source', async () => {
  const f = await fixture(true, (native) => ({ ...native, apply: (...args) => { native.apply(...args); throw new Error('INTERRUPTED_AFTER_NATIVE_SWAP'); } }));
  const p = await preview(f, 'merge');
  expect((await f.current.service.commit(p.id)).status).toBe('needs-review');
  const plan = f.current.plan(p.id), knowledgeStage = `${plan.files[0]!.stageId}.stage.md`;
  expect(readFileSync(join(f.root, knowledge))).toEqual(Buffer.from(plan.files[0]!.after));
  expect(f.current.native.readRecovery(knowledgeStage)).toEqual(f.previousKnowledge);
  expect(readFileSync(join(f.root, source))).toEqual(original);
  expect(f.current.native.readRecovery(`${plan.id}.result.json`)).toBeNull();
  const inode = lstatSync(join(f.root, knowledge)).ino;
  await f.current.close(); const applied: string[] = [];
  const reopened = await f.reopen((native) => ({ ...native, apply: (...args) => { applied.push(args[0]); native.apply(...args); } }));
  expect((await reopened.service.resume(p.id)).status).toBe('committed');
  expect(applied).toEqual([source]); expect(lstatSync(join(f.root, knowledge)).ino).toBe(inode);
  expect(readFileSync(join(f.root, knowledge))).toEqual(Buffer.from(plan.files[0]!.after));
  expect(readFileSync(join(f.root, knowledge), 'utf8')).toContain('已有知识正文必须完整保留。');
  expect(parseFrontmatter(readFileSync(join(f.root, source))).bodyBytes).toEqual(parseFrontmatter(original).bodyBytes);
  expect(reopened.native.readRecovery(knowledgeStage)).toEqual(f.previousKnowledge);
  expect(reopened.native.readRecovery(`${plan.files[1]!.stageId}.stage.md`)).toEqual(original);
  expect(reopened.native.readRecovery(`${plan.id}.result.json`)).not.toBeNull();
});

it('keeps real files and recovery evidence in needs-review when a retained stage changes during a later native apply', async () => {
  let firstStage: string | undefined, recoveryRoot = '';
  const external = Buffer.from('外部修改后的保留版本，必须留待核查。');
  const f = await fixture(true, (native) => ({ ...native, apply: (...args) => {
    native.apply(...args);
    if (args[0] === knowledge) firstStage = args[1];
    if (args[0] === source) writeFileSync(join(recoveryRoot, firstStage!), external);
  } }));
  recoveryRoot = f.recovery;
  const p = await preview(f, 'merge'), result = await f.current.service.commit(p.id), plan = f.current.plan(p.id);
  expect(result.status).toBe('needs-review'); expect(result.indexed).toBe(false);
  expect(readFileSync(join(f.root, knowledge))).toEqual(Buffer.from(plan.files[0]!.after));
  expect(readFileSync(join(f.root, source))).toEqual(Buffer.from(plan.sourceAfter));
  expect(f.current.native.readRecovery(firstStage!)).toEqual(external);
  expect(f.current.native.readRecovery(`${plan.files[1]!.stageId}.stage.md`)).toEqual(original);
  const intent = f.current.native.readRecovery(`${plan.id}.intent.json`)!;
  expect(JSON.parse(intent.toString()).plan.files[0].before).toBe(f.previousKnowledge.toString());
  expect(f.current.native.readRecovery(`${plan.id}.result.json`)).toBeNull();
  const inodes = plan.files.map((file) => lstatSync(join(f.root, file.path)).ino);
  await f.current.close(); const reopened = await f.reopen();
  expect((await reopened.service.resume(p.id)).status).toBe('needs-review');
  expect(plan.files.map((file) => lstatSync(join(f.root, file.path)).ino)).toEqual(inodes);
  expect(reopened.native.readRecovery(firstStage!)).toEqual(external);
  expect(reopened.native.readRecovery(`${plan.id}.intent.json`)).toEqual(intent);
  expect(reopened.native.readRecovery(`${plan.id}.result.json`)).toBeNull();
  expect((await reopened.service.review(f.runId)).candidates[0]!.state).toBe('pending');
});

it('persists real ancestor-stage dependencies and recovers their newest source bytes after reopening native handles and SQLite', async () => {
  let interruptSource = true, changeOnIntent = false, ancestorPath = '';
  const shown = Buffer.concat([original, Buffer.from('\r\n恢复预览中的保留证据。\r\n')]);
  const newest = Buffer.concat([shown, Buffer.from('恢复确认后又新增的证据。\r\n')]);
  const f = await fixture(false, (native) => ({ ...native,
    apply: (...args) => {
      native.apply(...args);
      if (args[0] === source && interruptSource) { interruptSource = false; throw new Error('INTERRUPTED_AFTER_SOURCE_SWAP'); }
    },
    writeRecovery: (name, bytes) => {
      native.writeRecovery(name, bytes);
      if (changeOnIntent && name.endsWith('.intent.json')) { changeOnIntent = false; writeFileSync(ancestorPath, newest); }
    }
  }));
  const p = await preview(f); expect((await f.current.service.commit(p.id)).status).toBe('needs-review');
  const originalPlan = f.current.plan(p.id), stageId = originalPlan.files.find((file) => file.kind === 'source')!.stageId;
  ancestorPath = join(f.recovery, `${stageId}.stage.md`); writeFileSync(ancestorPath, shown);
  const recovery = await f.current.service.recoveryPreview(p.id); changeOnIntent = true;
  const sourceBefore = readFileSync(join(f.root, source)), inode = lstatSync(join(f.root, knowledge)).ino;
  expect((await f.current.service.resolve(recovery.id)).status).toBe('needs-review');
  const registered = f.current.plan(p.id);
  expect(registered.recoveryReadSet).toContainEqual(expect.objectContaining({ path: source, stageId, expectedSha256: sha256Bytes(shown) }));
  expect(readFileSync(join(f.root, source))).toEqual(sourceBefore);
  expect(f.current.native.readRecovery(`${registered.journalId}.result.json`)).toBeNull();
  const intent = f.current.native.readRecovery(`${registered.journalId}.intent.json`)!;
  await f.current.close(); const reopened = await f.reopen();
  expect((await reopened.service.resume(p.id)).status).toBe('needs-review');
  const fresh = await reopened.service.recoveryPreview(p.id);
  expect(fresh.files.find((file) => file.kind === 'source')!.preserved).toBe(newest.toString());
  expect(await reopened.service.resolve(fresh.id)).toMatchObject({ status: 'committed', indexed: true });
  expect(readFileSync(join(f.root, source))).toEqual(Buffer.from(fresh.files.find((file) => file.kind === 'source')!.after));
  expect(parseFrontmatter(readFileSync(join(f.root, source))).bodyBytes).toEqual(parseFrontmatter(newest).bodyBytes);
  expect(readFileSync(ancestorPath)).toEqual(newest); expect(lstatSync(join(f.root, knowledge)).ino).toBe(inode);
  expect(reopened.native.readRecovery(`${registered.journalId}.intent.json`)).toEqual(intent);
  expect((await reopened.service.review(f.runId)).complete).toBe(true);
});
