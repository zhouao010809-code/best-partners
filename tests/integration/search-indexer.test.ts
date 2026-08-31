import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { SearchIndexer } from '../../src/server/index/SearchIndexer.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';

const encoder = new TextEncoder();
const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createRepository() {
  const database = new Database(':memory:');
  databases.push(database);
  applyMigrations(database);
  database.prepare(`
    INSERT INTO index_metadata (singleton, version, updated_at)
    VALUES (1, 0, '2026-08-30T00:00:00.000Z')
  `).run();
  return { database, repository: createIndexRepository(database, () => '2026-08-31T00:00:00.000Z') };
}

function materialNote(input: {
  title: string;
  type?: string;
  status?: '未提炼' | '部分入库' | '已入库';
  body?: string;
}): string {
  return `---
类型: ${input.type ?? '原始资料'}
处理状态: 未归档
来源平台: B站
原始标题: ${input.title}
作者:
原始链接:
采集日期: "2026-08-31"
所属主题: []
关键词: [索引]
知识入库状态: ${input.status ?? '未提炼'}
生成知识: ["[[已有知识]]"]
备注:
---

${input.body ?? '不应进入 SQLite 的原始正文'}
`;
}

function knowledgeNote(input: {
  status?: 'AI总结' | '已优化' | '定论' | '过时';
  conclusion?: string;
  body?: string;
} = {}): string {
  return `---
类型: 知识笔记
来源类型: AI提炼
使用状态: ${input.status ?? 'AI总结'}
知识类型: 方法
所属主题: [知识管理]
关键词: [检索, 召回]
来源资料: ["[[一份资料]]"]
适用场景: [构建只读索引]
核心结论: ${input.conclusion ?? '只存召回字段。'}
关键要点: [标题先行, 正文后取]
使用边界: 不存正文。
---

${input.body ?? '不应进入 SQLite 的知识正文'}
`;
}

describe('SearchIndexer', () => {
  it('projects only current note types and reports all three historical types as schema issues', async () => {
    const gateway = new FakeVaultGateway({
      '01图书馆/当前资料.md': materialNote({ title: '当前资料' }),
      '01图书馆/历史演讲.md': materialNote({ title: '历史演讲', type: '演讲稿/访谈实录' }),
      '01图书馆/历史方法.md': materialNote({ title: '历史方法', type: '操作指南/方法论' }),
      '01图书馆/历史画像.md': materialNote({ title: '历史画像', type: '个人画像' }),
      '02知识库/当前知识.md': knowledgeNote(),
      '02知识库/错误类型.md': materialNote({ title: '错放资料' })
    });
    const { repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });

    await expect(indexer.refresh()).resolves.toMatchObject({ status: 'ready', version: 1 });

    expect(repository.listMaterials({}).items.map((record) => record.path))
      .toEqual(['01图书馆/当前资料.md']);
    expect(repository.listKnowledge({}).items.map((record) => record.path))
      .toEqual(['02知识库/当前知识.md']);
    expect(repository.listIssues().map((issue) => [issue.path, issue.code])).toEqual([
      ['01图书馆/历史方法.md', 'UNEXPECTED_TYPE'],
      ['01图书馆/历史演讲.md', 'UNEXPECTED_TYPE'],
      ['01图书馆/历史画像.md', 'UNEXPECTED_TYPE'],
      ['02知识库/错误类型.md', 'UNEXPECTED_TYPE']
    ]);

    gateway.mutateFixture('01图书馆/历史画像.md', materialNote({ title: '修复画像' }));
    gateway.deleteFixture('01图书馆/历史方法.md');
    await indexer.refresh();
    expect(repository.listMaterials({}).items.map((record) => record.path)).toContain(
      '01图书馆/历史画像.md'
    );
    expect(repository.listIssues().map((issue) => issue.path)).not.toContain(
      '01图书馆/历史画像.md'
    );
    expect(repository.listIssues().map((issue) => issue.path)).not.toContain(
      '01图书馆/历史方法.md'
    );
  });

  it('recurses only through allowed visible directories and reads only Markdown files', async () => {
    const gateway = new FakeVaultGateway({
      '01图书馆/根资料.md': materialNote({ title: '根资料' }),
      '01图书馆/专题/嵌套资料.md': materialNote({ title: '嵌套资料' }),
      '01图书馆/.隐藏/秘密.md': materialNote({ title: '秘密' }),
      '01图书馆/专题/.秘密.md': materialNote({ title: '秘密文件' }),
      '01图书馆/专题/附件.png': 'not markdown',
      '02知识库/知识.md': knowledgeNote(),
      '03大讲堂/不允许.md': materialNote({ title: '不允许' })
    });
    const { repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });

    await indexer.refresh();

    expect(repository.listMaterials({}).items.map((record) => record.path)).toEqual([
      '01图书馆/专题/嵌套资料.md',
      '01图书馆/根资料.md'
    ]);
    expect(gateway.rawReadPaths).toEqual([
      '01图书馆/专题/嵌套资料.md',
      '01图书馆/根资料.md',
      '02知识库/知识.md'
    ]);
  });

  it('stores canonical projection JSON and never stores Markdown body text', async () => {
    const forbiddenMaterialBody = 'SENSITIVE_MATERIAL_BODY_42';
    const forbiddenKnowledgeBody = 'SENSITIVE_KNOWLEDGE_BODY_43';
    const gateway = new FakeVaultGateway({
      '01图书馆/资料.md': materialNote({ title: '资料', body: forbiddenMaterialBody }),
      '02知识库/知识.md': knowledgeNote({ body: forbiddenKnowledgeBody })
    });
    const { database, repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });

    await indexer.refresh();

    const stored = database.prepare(`
      SELECT path, yaml_json AS yamlJson, links_json AS linksJson
      FROM search_index
      ORDER BY path
    `).all() as Array<{ path: string; yamlJson: string; linksJson: string }>;
    const serializedRows = JSON.stringify(stored);
    expect(serializedRows).not.toContain(forbiddenMaterialBody);
    expect(serializedRows).not.toContain(forbiddenKnowledgeBody);
    expect(stored[0]?.yamlJson).toBe(
      '{"collectedAt":"2026-08-31","knowledgeStatus":"未提炼","processingStatus":"未归档","sourcePlatform":"B站","title":"资料"}'
    );
    expect(stored[0]?.linksJson).toBe('["已有知识"]');
  });

  it('excludes obsolete knowledge by default and includes it only when requested', async () => {
    const gateway = new FakeVaultGateway({
      '02知识库/当前.md': knowledgeNote({ status: '定论', conclusion: '当前可检索结论。' }),
      '02知识库/过时.md': knowledgeNote({ status: '过时' })
    });
    const { repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });
    await indexer.refresh();

    expect(repository.listKnowledge({}).items.map((record) => record.path))
      .toEqual(['02知识库/当前.md']);
    expect(repository.listKnowledge({ includeObsolete: true }).items.map((record) => record.path))
      .toEqual(['02知识库/当前.md', '02知识库/过时.md']);
    expect(repository.listKnowledge({ usageStatus: '过时' }).items.map((record) => record.path))
      .toEqual(['02知识库/过时.md']);
    expect(repository.listKnowledge({ search: '当前可检索结论' }).items.map((record) => record.path))
      .toEqual(['02知识库/当前.md']);
    expect(repository.listKnowledge({ search: 'boundary' }).items).toEqual([]);
  });

  it('reconciles external create, modify, rename, and delete without preserving an old-path identity', async () => {
    const gateway = new FakeVaultGateway({
      '01图书馆/原路径.md': materialNote({ title: '初始标题' })
    });
    const { repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });
    await indexer.refresh();

    gateway.mutateFixture(
      '01图书馆/原路径.md',
      materialNote({ title: '修改后标题', status: '部分入库' }),
      'version-2'
    );
    await indexer.refresh();
    expect(repository.listMaterials({}).items).toMatchObject([
      { path: '01图书馆/原路径.md', title: '修改后标题', knowledgeStatus: '部分入库' }
    ]);

    gateway.renameFixture('01图书馆/原路径.md', '01图书馆/新路径.md', 'version-3');
    await indexer.refresh();
    expect(repository.listMaterials({}).items.map((record) => record.path))
      .toEqual(['01图书馆/新路径.md']);
    expect(repository.getManifestEntry('01图书馆/原路径.md')).toBeUndefined();

    gateway.deleteFixture('01图书馆/新路径.md');
    gateway.mutateFixture('01图书馆/新增.md', materialNote({ title: '新增' }), 'version-4');
    await indexer.refresh();
    expect(repository.listMaterials({}).items.map((record) => record.path))
      .toEqual(['01图书馆/新增.md']);
  });

  it('boundedly rereads raw bytes on every unproven-metadata poll and stays refreshing until a full pass', async () => {
    const gateway = new FakeVaultGateway({
      '01图书馆/一.md': materialNote({ title: '一' }),
      '01图书馆/二.md': materialNote({ title: '二' }),
      '01图书馆/三.md': materialNote({ title: '三' })
    });
    const { database, repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 2 });
    const metadataBeforePartial = database.prepare(`
      SELECT version, updated_at AS updatedAt FROM index_metadata WHERE singleton = 1
    `).get();

    await expect(indexer.refresh()).resolves.toEqual({
      status: 'refreshing', checked: 2, total: 3, version: 0
    });
    expect(gateway.rawReadPaths).toHaveLength(2);
    expect(repository.listMaterials({}).total).toBe(0);
    expect(database.prepare(`
      SELECT version, updated_at AS updatedAt FROM index_metadata WHERE singleton = 1
    `).get()).toEqual(metadataBeforePartial);

    await expect(indexer.refresh()).resolves.toEqual({
      status: 'ready', checked: 3, total: 3, version: 1
    });
    expect(gateway.rawReadPaths).toHaveLength(3);
    expect(database.prepare(`
      SELECT version, updated_at AS updatedAt FROM index_metadata WHERE singleton = 1
    `).get()).toEqual({ version: 1, updatedAt: '2026-08-31T00:00:00.000Z' });

    await expect(indexer.refresh()).resolves.toEqual({
      status: 'refreshing', checked: 2, total: 3, version: 1
    });
    expect(gateway.rawReadPaths).toHaveLength(5);
    expect(repository.listMaterials({}).total).toBe(3);
  });

  it.each([
    {
      name: 'rename',
      mutate: (gateway: FakeVaultGateway) => gateway.renameFixture(
        '01图书馆/A.md',
        '01图书馆/A2.md',
        'renamed-version'
      ),
      expectedPaths: ['01图书馆/A2.md', '01图书馆/B.md']
    },
    {
      name: 'create',
      mutate: (gateway: FakeVaultGateway) => gateway.mutateFixture(
        '01图书馆/C.md',
        materialNote({ title: 'C' }),
        'created-version'
      ),
      expectedPaths: ['01图书馆/A.md', '01图书馆/B.md', '01图书馆/C.md']
    },
    {
      name: 'delete',
      mutate: (gateway: FakeVaultGateway) => gateway.deleteFixture('01图书馆/A.md'),
      expectedPaths: ['01图书馆/B.md']
    }
  ])('restarts a bounded cycle when an already-read path is externally $name', async ({ mutate, expectedPaths }) => {
    const gateway = new FakeVaultGateway({
      '01图书馆/A.md': materialNote({ title: 'A' }),
      '01图书馆/B.md': materialNote({ title: 'B' })
    });
    const { repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 1 });

    await expect(indexer.refresh()).resolves.toEqual({
      status: 'refreshing', checked: 1, total: 2, version: 0
    });
    mutate(gateway);

    await expect(indexer.refresh()).resolves.toEqual({
      status: 'refreshing', checked: 0, total: expectedPaths.length, version: 0
    });
    expect(repository.listMaterials({}).total).toBe(0);

    let result = await indexer.refresh();
    for (let remaining = expectedPaths.length; result.status === 'refreshing' && remaining > 0; remaining -= 1) {
      result = await indexer.refresh();
    }
    expect(result).toMatchObject({ status: 'ready', version: 1 });
    expect(repository.listMaterials({}).items.map((record) => record.path)).toEqual(expectedPaths);
  });

  it('publishes a complete scan in one batch and leaves projection, version, and deletes unchanged on read failure', async () => {
    const gateway = new FakeVaultGateway({
      '01图书馆/保留.md': materialNote({ title: '旧标题' }),
      '01图书馆/将删除.md': materialNote({ title: '将删除' })
    });
    const { repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });
    await expect(indexer.refresh()).resolves.toMatchObject({ status: 'ready', version: 1 });

    gateway.mutateFixture('01图书馆/保留.md', materialNote({ title: '新标题' }), 'version-2');
    gateway.deleteFixture('01图书馆/将删除.md');
    gateway.mutateFixture('01图书馆/新增.md', materialNote({ title: '新增' }), 'version-2');
    gateway.failNextRead('01图书馆/新增.md', new Error('simulated upstream failure'));

    await expect(indexer.refresh()).rejects.toThrow('simulated upstream failure');
    expect(indexer.version).toBe(1);
    expect(repository.listMaterials({}).items.map((record) => [record.path, record.title])).toEqual([
      ['01图书馆/保留.md', '旧标题'],
      ['01图书馆/将删除.md', '将删除']
    ]);

    await expect(indexer.refresh()).resolves.toMatchObject({ status: 'ready', version: 2 });
    expect(repository.listMaterials({}).items.map((record) => [record.path, record.title])).toEqual([
      ['01图书馆/保留.md', '新标题'],
      ['01图书馆/新增.md', '新增']
    ]);
  });

  it('advances the projection, schema issues, and index metadata in one successful transaction', async () => {
    const gateway = new FakeVaultGateway({
      '01图书馆/资料.md': materialNote({ title: '资料' }),
      '01图书馆/历史.md': materialNote({ title: '历史', type: '个人画像' })
    });
    const { database, repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });

    await expect(indexer.refresh()).resolves.toMatchObject({ status: 'ready', version: 1 });

    expect(repository.listMaterials({}).items.map((record) => record.title)).toEqual(['资料']);
    expect(repository.listIssues().map((issue) => issue.path)).toEqual(['01图书馆/历史.md']);
    expect(database.prepare(`
      SELECT version, updated_at AS updatedAt FROM index_metadata WHERE singleton = 1
    `).get()).toEqual({ version: 1, updatedAt: '2026-08-31T00:00:00.000Z' });
  });

  it('rolls back projection, schema issues, and version when metadata publication fails', async () => {
    const gateway = new FakeVaultGateway({
      '01图书馆/资料.md': materialNote({ title: '旧标题' }),
      '01图书馆/历史.md': materialNote({ title: '历史', type: '个人画像' })
    });
    const { database, repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });
    await indexer.refresh();
    const beforeMetadata = database.prepare(`
      SELECT version, updated_at AS updatedAt FROM index_metadata WHERE singleton = 1
    `).get();

    gateway.mutateFixture('01图书馆/资料.md', materialNote({ title: '新标题' }), 'version-2');
    gateway.mutateFixture('01图书馆/历史.md', materialNote({ title: '已修复' }), 'version-2');
    database.exec(`
      CREATE TRIGGER reject_index_metadata_update
      BEFORE UPDATE ON index_metadata
      BEGIN
        SELECT RAISE(ABORT, 'metadata publication failed');
      END;
    `);

    await expect(indexer.refresh()).rejects.toThrow('metadata publication failed');

    expect(indexer.version).toBe(1);
    expect(repository.listMaterials({}).items.map((record) => record.title)).toEqual(['旧标题']);
    expect(repository.listIssues().map((issue) => issue.path)).toEqual(['01图书馆/历史.md']);
    expect(database.prepare(`
      SELECT version, updated_at AS updatedAt FROM index_metadata WHERE singleton = 1
    `).get()).toEqual(beforeMetadata);
  });

  it('aborts a deferred raw read without publishing late bytes or allowing a concurrent refresh', async () => {
    const gateway = new FakeVaultGateway({
      '01图书馆/资料.md': materialNote({ title: '资料' })
    });
    const originalReadRaw = gateway.readRaw.bind(gateway);
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    let releaseRead!: () => void;
    const deferred = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    gateway.readRaw = async (path: string, _signal?: AbortSignal) => {
      const raw = await originalReadRaw(path);
      announceStarted();
      await deferred;
      return raw;
    };
    const { repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });
    const controller = new AbortController();

    const refresh = indexer.refresh(controller.signal);
    await started;
    controller.abort(new Error('test abort'));
    const concurrent = indexer.refresh();
    expect(repository.listMaterials({}).total).toBe(0);
    expect(indexer.version).toBe(0);

    const concurrentAssertion = expect(concurrent).rejects.toThrow('INDEX_REFRESH_ALREADY_RUNNING');
    const abortedAssertion = expect(refresh).rejects.toThrow('INDEX_REFRESH_ABORTED');
    releaseRead();
    await Promise.all([concurrentAssertion, abortedAssertion]);
    expect(repository.listMaterials({}).total).toBe(0);
    expect(indexer.version).toBe(0);

    await expect(indexer.refresh()).resolves.toMatchObject({ status: 'ready', version: 1 });
    expect(repository.listMaterials({}).items.map((record) => record.path))
      .toEqual(['01图书馆/资料.md']);
  });

  it('fails the whole scan on malformed direct directory entries without publishing staged rows', async () => {
    const gateway = new FakeVaultGateway({
      '01图书馆/资料.md': materialNote({ title: '资料' })
    });
    gateway.addMalformedDirectoryEntry('02知识库', '../逃逸.md');
    const { repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });

    await expect(indexer.refresh()).rejects.toThrow('MALFORMED_DIRECTORY_ENTRY');
    expect(indexer.version).toBe(0);
    expect(repository.listMaterials({}).total).toBe(0);
    expect(repository.listIssues()).toEqual([]);
  });

  it('rejects duplicate direct directory entries instead of silently normalizing them', async () => {
    const gateway = new FakeVaultGateway({
      '01图书馆/资料.md': materialNote({ title: '资料' })
    });
    gateway.addMalformedDirectoryEntry('01图书馆', '资料.md');
    const { repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });

    await expect(indexer.refresh()).rejects.toThrow('MALFORMED_DIRECTORY_ENTRY');
    expect(repository.listMaterials({}).total).toBe(0);
  });

  it('advances projection version only when a complete batch changes indexed content', async () => {
    const gateway = new FakeVaultGateway({
      '01图书馆/资料.md': materialNote({ title: '资料' })
    });
    const { repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });

    await expect(indexer.refresh()).resolves.toMatchObject({ status: 'ready', version: 1 });
    await expect(indexer.refresh()).resolves.toMatchObject({ status: 'ready', version: 1 });

    gateway.mutateFixture('01图书馆/资料.md', materialNote({ title: '已变更' }));
    await expect(indexer.refresh()).resolves.toMatchObject({ status: 'ready', version: 2 });
  });

  it('includes invalid-note raw identity in the full manifest even when its issue text is unchanged', async () => {
    const path = '01图书馆/历史.md';
    const gateway = new FakeVaultGateway({
      [path]: materialNote({ title: '历史', type: '个人画像', body: '旧正文' })
    });
    const { repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });
    await expect(indexer.refresh()).resolves.toMatchObject({ version: 1 });

    gateway.mutateFixture(path, materialNote({ title: '历史', type: '个人画像', body: '新正文' }));
    await expect(indexer.refresh()).resolves.toMatchObject({ version: 2 });
    expect(repository.listIssues()).toHaveLength(1);
  });

  it('builds manifest identity from path, canonical contract metadata, upstream version, and raw hash', async () => {
    const gateway = new FakeVaultGateway({
      '01图书馆/资料.md': {
        bytes: encoder.encode(materialNote({ title: '资料' })),
        upstreamVersion: 'version-1'
      }
    });
    const { repository } = createRepository();
    const indexer = new SearchIndexer({ gateway, repository, maxRawReadsPerPoll: 20 });
    await indexer.refresh();
    const before = repository.getManifestEntry('01图书馆/资料.md');

    gateway.mutateFixture(
      '01图书馆/资料.md',
      materialNote({ title: '资料二' }),
      'version-2'
    );
    await indexer.refresh();
    const after = repository.getManifestEntry('01图书馆/资料.md');

    expect(before).toMatchObject({
      path: '01图书馆/资料.md',
      upstreamVersion: 'version-1',
      kind: 'material'
    });
    expect(before?.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(before?.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(after?.manifestSha256).not.toBe(before?.manifestSha256);
  });
});
