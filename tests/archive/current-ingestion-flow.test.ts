import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { CURRENT_VAULT_LAYOUT as layout } from '../../src/shared/domain/vault-layout.js';
import { openPersonalArchive } from '../../src/server/archive/sandbox-native.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { SearchIndexer } from '../../src/server/index/SearchIndexer.js';
import { createIngestionService } from '../../src/server/ingestion/ingestion-service.js';
import { parseFrontmatter } from '../../src/server/rules/frontmatter.js';
import { createExtractionService } from '../../src/server/services/extraction-service.js';
import { FileSystemVaultGateway } from '../../src/server/vault/FileSystemVaultGateway.js';
import { createNativeReadVaultPortFactory } from '../../src/server/vault/NativeReadVaultPort.js';

it('extracts a current source, reviews and commits through native storage, then resumes without altering discussion or rewriting the source', async () => {
  const base = mkdtempSync('/private/tmp/current-brain-ingestion-');
  const root = join(base, '小兆大脑');
  const source = '01图书馆/01公域资料/来自网站/2026/2026-10/证据/证据.md';
  const directory = '03知识库/AI/AI工具';
  const candidate = { title: '证据核查', knowledgeType: '方法', suggestedPath: directory, topics: [],
    coreContent: '核验陈述的依据再决定。', value: '提供可检验的判断依据。', draft: {
      keywords: ['证据', '核验', '判断'], scenarios: ['阅读时', '决策时'], conclusion: '先核查证据再下结论。',
      keyPoints: ['找到原文', '核实依据'], boundary: '用于能够核实来源的判断。', quotes: ['先核查证据。'], summaries: ['核实陈述所依据的来源。']
    } };
  const original = Buffer.from('---\n类型: 原始资料\n标题: 证据\n资料来源: 网站\n入馆时间: 2026-10-01-10:30\n探讨状态: 部分探讨完成\n关联日记: ["[[02日记本/已有日记]]"]\n---\n\n先核查证据。');
  const cleanup: Array<() => void | Promise<void>> = [];
  try {
    for (const dir of ['00大脑规则/文档规范', layout.inboxRoot, dirname(source), directory, '02日记本', layout.outputRoot])
      mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
    for (const path of layout.rulePaths) writeFileSync(join(root, path), '新版规则 ' + path + (path.includes('06知识库分类规则') ? '\n| AI工具〔年月〕 | 记录工具用法。 |' : ''));
    writeFileSync(join(root, source), original);
    for (const name of ['archive', 'ingestion']) mkdirSync(join(base, name), { mode: 0o700 });
    const gateway = await FileSystemVaultGateway.create({ vaultRoot: root,
      nativeReader: createNativeReadVaultPortFactory(resolve('dist/native/atomic-file-helper')) });
    const database = new Database(':memory:'); cleanup.push(() => { database.close(); }); applyMigrations(database);
    database.prepare("INSERT INTO index_metadata (singleton,version,updated_at) VALUES (1,0,'2026-10-01T00:00:00Z')").run();
    const repository = createIndexRepository(database);
    const indexer = new SearchIndexer({ repository, gateway, maxRawReadsPerPoll: 50 });
    const refreshIndex = async () => (await indexer.refresh()).status === 'ready';
    await refreshIndex();
    const archive = openPersonalArchive(root, join(base, 'archive'), resolve('dist/native/personal-archive.node'));
    cleanup.push(() => archive.close());
    const native = archive.openIngestion(join(base, 'ingestion')); cleanup.push(() => native.close());
    const generate = vi.fn(async () => ({ briefing: { sentences: ['一。', '二。', '三。'], keyPoints: ['核实依据'], usefulness: '证据核查' }, candidates: [candidate] }));
    const extraction = createExtractionService({ database, gateway, repository, provider: { generate },
      credentials: { status: () => ({ available: true, configured: true, revision: '1' }),
        getKey: () => 'fixture-only-no-network', setKey: () => {}, clear: () => {} } });
    cleanup.push(() => extraction.close());
    expect(extraction.queue({ view: 'pending' }).items[0]).toMatchObject({ materialPath: source, canExtract: true });
    const preview = await extraction.preview({ materialPath: source, readingState: '已看' });
    expect(preview.messages[0]?.content).toContain('新版规则 00大脑规则/03知识库规则.md');
    const run = await extraction.start(preview.token);
    await vi.waitFor(() => expect(extraction.get(run.id).status).toBe('ready')); expect(generate).toHaveBeenCalledOnce();
    let interrupted = false;
    const service = createIngestionService({ database, repository, gateway, refreshIndex, now: () => new Date('2026-11-20T12:30:00Z'), port: {
      ...native, apply(...args) { native.apply(...args); if (!interrupted) { interrupted = true; throw new Error('SIMULATED_INTERRUPTION'); } }
    } });
    cleanup.push(() => service.close());
    let review = await service.review(run.id);
    const item = review.candidates[0]!;
    service.save(run.id, { candidateId: item.id, version: item.version, draft: item.draft, target: { mode: 'new' }, decision: 'keep' });
    review = await service.review(run.id);
    const planned = await service.preview({ runId: run.id, versions: review.candidates.map(({id, version}) => ({id, version})) });
    const target = directory + '/2026/2026-11/证据核查｜20261120.md';
    expect(planned.files.map(file => file.path)).toEqual([target]);
    expect(readdirSync(join(root, directory))).toEqual([]);
    expect(await service.commit(planned.id)).toMatchObject({ status: 'needs-review' });
    expect(await service.resume(planned.id)).toMatchObject({ status: 'committed', sourceStatus: '已入库', indexed: true });
    expect(await service.commit(planned.id)).toMatchObject({ status: 'committed', pendingCount: 0 });
    const fields = parseFrontmatter(readFileSync(join(root, target))).data;
    expect(fields).toMatchObject({ 类型: '知识笔记', 核心内容: candidate.draft.conclusion, 关联资料: ['[[' + source.slice(0, -3) + ']]'], 关联日记: [], 历史记录: [] });
    expect(fields.创建时间).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}:\d{2}$/u);
    expect(readFileSync(join(root, source))).toEqual(original);
    expect(readdirSync(join(root, '02日记本'))).toEqual([]);
    expect(extraction.queue({ view: 'ready' }).items[0]).toMatchObject({ canExtract: false, reviewComplete: true });

    for (const mode of ['reference', 'merge'] as const) {
      const extra = source.replaceAll('证据/', mode + '/').replace('证据.md', mode + '.md');
      mkdirSync(join(root, dirname(extra)), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, extra), original);
      await refreshIndex();
      const selected = await extraction.preview({ materialPath: extra, readingState: '未看' });
      const another = await extraction.start(selected.token);
      await vi.waitFor(() => expect(extraction.get(another.id).status).toBe('ready'));
      const anotherReview = await service.review(another.id);
      const anotherItem = anotherReview.candidates[0]!;
      const changed = service.save(another.id, { candidateId: anotherItem.id, version: anotherItem.version,
        draft: { ...anotherItem.draft, coreContent: '新的限定条件。' }, decision: 'keep', target: { mode, path: target } });
      const proposal = await service.preview({ runId: another.id, versions: [{ id: changed.id, version: changed.version }] });
      const before = parseFrontmatter(readFileSync(join(root, target)));
      expect(await service.commit(proposal.id)).toMatchObject({ status: 'committed', indexed: true });
      const after = parseFrontmatter(readFileSync(join(root, target)));
      expect(after.data.关联资料).toContain('[[' + extra.slice(0, -3) + ']]');
      expect(after.data.关联日记).toEqual([]);
      expect(after.data.创建时间).toBe(fields.创建时间);
      if (mode === 'reference') expect(after.bodyBytes).toEqual(before.bodyBytes);
      else expect(Buffer.from(after.bodyBytes).toString()).toContain('新的限定条件。');
      expect(readFileSync(join(root, extra))).toEqual(original);
    }
  } finally {
    for (const close of cleanup.reverse()) await close();
    rmSync(base, { recursive: true, force: true });
  }
});
