import fastifyStatic from '@fastify/static';
import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildServer } from '../../src/server/app.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import type { NormalStateKernel } from '../../src/server/db/database.js';
import { SearchIndexer } from '../../src/server/index/SearchIndexer.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { IndexScheduler } from '../../src/server/index/index-scheduler.js';
import { IndexStateController } from '../../src/server/index/index-state.js';
import { createHealthService } from '../../src/server/services/health-service.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';

const HOST = '127.0.0.1';
const PORT = 4317;
const FIXED_INSTANT = '2026-09-01T08:00:00.000Z';
const FIXED_DATE = new Date(FIXED_INSTANT);
const CURSOR_SECRET = new TextEncoder().encode('xiaozhao-e2e-cursor-secret-v1');
const ROUTES = ['/', '/queue', '/knowledge', '/operations', '/settings', '/connections'] as const;

function materialNote(input: {
  readonly title: string;
  readonly knowledgeStatus: '未提炼' | '部分入库' | '已入库';
  readonly sourcePlatform: string;
  readonly collectedAt?: string;
  readonly type?: string;
}): string {
  return `---
类型: ${input.type ?? '原始资料'}
处理状态: 未归档
来源平台: ${input.sourcePlatform}
原始标题: ${input.title}
作者:
原始链接:
${input.collectedAt === undefined ? '' : `采集日期: "${input.collectedAt}"\n`}所属主题: [知识管理]
关键词: [只读, 索引]
知识入库状态: ${input.knowledgeStatus}
生成知识: []
备注:
---

这是确定性浏览器测试材料，正文不会进入 SQLite。
`;
}

function knowledgeNote(input: {
  readonly usageStatus: 'AI总结' | '已优化' | '定论' | '过时';
  readonly conclusion: string;
  readonly body: string;
  readonly sourceMaterials: readonly string[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly knowledgeType?: string;
}): string {
  return `---
类型: 知识笔记
来源类型: AI提炼
使用状态: ${input.usageStatus}
知识类型: ${input.knowledgeType ?? '方法'}
所属主题: [知识管理]
关键词: [召回, 证据链]
来源资料: [${input.sourceMaterials.map((source) => `"[[${source}]]"`).join(', ')}]
适用场景: [构建本地只读大脑]
核心结论: ${input.conclusion}
关键要点: [只索引 YAML 召回字段, 正文按需读取]
使用边界: 不把 Markdown 正文放入 SQLite。
${input.createdAt === undefined ? '' : `创建日期: "${input.createdAt}"\n`}${input.updatedAt === undefined ? '' : `更新日期: "${input.updatedAt}"\n`}备注:
---

${input.body}
`;
}

const gateway = new FakeVaultGateway({
  '01图书馆/B站/待提炼-深度访谈.md': materialNote({
    title: '待提炼：深度访谈',
    knowledgeStatus: '未提炼',
    sourcePlatform: 'B站',
    collectedAt: '2026-08-31'
  }),
  '01图书馆/公众号/待提炼-写作系统.md': materialNote({
    title: '待提炼：写作系统',
    knowledgeStatus: '未提炼',
    sourcePlatform: '公众号'
  }),
  '01图书馆/YouTube/部分入库-证据链.md': materialNote({
    title: '部分入库：证据链',
    knowledgeStatus: '部分入库',
    sourcePlatform: 'YouTube',
    collectedAt: '2026-08-29'
  }),
  '01图书馆/飞书/已入库-归档案例.md': materialNote({
    title: '已入库：归档案例',
    knowledgeStatus: '已入库',
    sourcePlatform: '飞书',
    collectedAt: '2026-08-20'
  }),
  '01图书馆/历史/异常-演讲访谈.md': materialNote({
    title: '历史演讲访谈',
    knowledgeStatus: '未提炼',
    sourcePlatform: '个人',
    type: '演讲稿/访谈实录'
  }),
  '01图书馆/历史/异常-操作方法.md': materialNote({
    title: '历史操作方法',
    knowledgeStatus: '未提炼',
    sourcePlatform: '个人',
    type: '操作指南/方法论'
  }),
  '01图书馆/历史/异常-个人画像.md': materialNote({
    title: '历史个人画像',
    knowledgeStatus: '未提炼',
    sourcePlatform: '个人',
    type: '个人画像'
  }),
  '02知识库/AI总结-核心结论.md': knowledgeNote({
    usageStatus: 'AI总结',
    conclusion: '星火结论唯一词只存在于 YAML 核心结论。',
    createdAt: '2026-08-28',
    updatedAt: '2026-08-31',
    sourceMaterials: ['01图书馆/B站/待提炼-深度访谈'],
    body: `# 核心结论详情

正文幽灵唯一词只存在于 Markdown 正文，不应被列表检索命中。

关联知识：[[02知识库/已优化-关联知识]]

<script>window.__E2E_SCRIPT_RAN__ = true</script>
<iframe src="https://remote.invalid/frame"></iframe>
<img src=x onerror="window.__E2E_EVENT_RAN__ = true">
[危险协议](javascript:window.__E2E_JAVASCRIPT_RAN__=true)
![远程追踪图](https://remote.invalid/pixel.png)
`
  }),
  '02知识库/已优化-关联知识.md': knowledgeNote({
    usageStatus: '已优化',
    conclusion: '知识之间通过可验证的本地路径建立连接。',
    createdAt: '2026-08-20',
    updatedAt: '2026-08-30',
    sourceMaterials: ['01图书馆/YouTube/部分入库-证据链'],
    body: '# 关联知识\n\n这是合法的 02 知识库内链目标。'
  }),
  '02知识库/定论-只读边界.md': knowledgeNote({
    usageStatus: '定论',
    conclusion: '正式知识默认保持只读，写入必须经过独立安全门。',
    sourceMaterials: ['01图书馆/飞书/已入库-归档案例'],
    body: '# 只读边界\n\n该笔记故意不提供创建和更新日期。',
    knowledgeType: '标准'
  }),
  '02知识库/过时-旧召回策略.md': knowledgeNote({
    usageStatus: '过时',
    conclusion: '旧召回策略仅用于验证过时知识筛选。',
    createdAt: '2025-01-01',
    sourceMaterials: ['01图书馆/公众号/待提炼-写作系统'],
    body: '# 旧召回策略\n\n默认列表不应显示这条知识。'
  })
});

const fixtureRoot = await mkdtemp(join(tmpdir(), 'xiaozhao-e2e-'));
const recoveryDir = join(fixtureRoot, 'recovery');
const backupsDir = join(fixtureRoot, 'backups');
await Promise.all([
  mkdir(recoveryDir, { mode: 0o700 }),
  mkdir(backupsDir, { mode: 0o700 })
]);

const database = new Database(':memory:');
applyMigrations(database);
database.prepare(`
  INSERT INTO index_metadata (singleton, version, updated_at)
  VALUES (1, 0, ?)
`).run(FIXED_INSTANT);

const repository = createIndexRepository(database, () => FIXED_INSTANT);
const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 100 });
while ((await indexer.refresh()).status !== 'ready') {
  // The fixture stays deterministic even if its file count later exceeds one index poll.
}

const state = new IndexStateController(() => new Date(FIXED_DATE));
state.recordSuccess(indexer.version, new Date(FIXED_DATE));
const scheduler = new IndexScheduler({
  refresh: (signal) => indexer.refresh(signal),
  state,
  intervals: {
    every: () => () => undefined
  },
  deadlines: {
    after: () => () => undefined
  },
  now: () => new Date(FIXED_DATE)
});
scheduler.start();

const stateKernel: NormalStateKernel = {
  mode: 'normal',
  db: database,
  path: ':memory:',
  backupsDir,
  recoveryDir,
  close: () => undefined
};
const healthService = createHealthService({
  writeEnabled: false,
  gateway,
  profileDirectory: join(fixtureRoot, 'contract-profiles'),
  stateKernel,
  indexState: { snapshot: () => scheduler.snapshot().state },
  model: {
    baseUrl: 'https://models.fixture.example/v1?api_key=e2e-model-secret-never-expose',
    name: 'fixture-brain-model'
  },
  schemaIssues: { count: () => repository.listIssues().length }
});

let operationIdSequence = 0;
let jobIdSequence = 0;
let closed = false;
async function closeResources(): Promise<void> {
  if (closed) return;
  closed = true;
  await scheduler.stopAndWait();
  if (database.open) database.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}

const app = buildServer({
  healthService,
  onClose: closeResources,
  readApi: {
    repository,
    gateway,
    database,
    indexScheduler: scheduler,
    currentIndexVersion: () => indexer.version,
    cursorSecret: CURSOR_SECRET,
    now: () => FIXED_INSTANT,
    operationIdFactory: () => `fixture-operation-${++operationIdSequence}`,
    jobIdFactory: () => `fixture-job-${++jobIdSequence}`
  }
});

const clientRoot = resolve('dist/client');
await app.register(fastifyStatic, {
  root: join(clientRoot, 'assets'),
  prefix: '/assets/'
});
const html = await readFile(join(clientRoot, 'index.html'));
for (const route of ROUTES) {
  app.get(route, async (_request, reply) => reply
    .type('text/html; charset=utf-8')
    .send(Buffer.from(html)));
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

try {
  await app.listen({ host: HOST, port: PORT });
} catch (error) {
  await closeResources();
  throw error;
}
