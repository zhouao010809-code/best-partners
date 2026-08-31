import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository, type IndexRepository } from '../../src/server/index/index-repository.js';
import { IndexScheduler } from '../../src/server/index/index-scheduler.js';
import { IndexStateController } from '../../src/server/index/index-state.js';
import type { IndexSchedulerPort } from '../../src/server/services/index-job-service.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';
import type { KnowledgeRecord, MaterialRecord } from '../../src/shared/domain/records.js';

const HOST = '127.0.0.1:4317';
const ORIGIN = 'http://127.0.0.1:4317';
const servers: Array<ReturnType<typeof buildServer>> = [];
const databases: Database.Database[] = [];

type RebuildSnapshot = {
  state: { status: 'ready'; version: number; refreshedAt: string };
  refresh: { status: 'ready' | 'refreshing'; checked: number; total: number; version: number };
};

type OpenableFakeGateway = FakeVaultGateway & {
  openInObsidian(path: string, signal?: AbortSignal): Promise<void>;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const database of databases.splice(0)) database.close();
});

function openDatabase(): Database.Database {
  const database = new Database(':memory:');
  databases.push(database);
  applyMigrations(database);
  return database;
}

function material(input: Partial<MaterialRecord> & Pick<MaterialRecord, 'path' | 'title'>): MaterialRecord {
  return {
    path: input.path,
    rawSha256: input.rawSha256 ?? 'a'.repeat(64),
    title: input.title,
    sourcePlatform: input.sourcePlatform ?? 'B站',
    processingStatus: input.processingStatus ?? '未归档',
    knowledgeStatus: input.knowledgeStatus ?? '未提炼',
    collectedAt: input.collectedAt ?? '2026-08-31',
    generatedKnowledge: input.generatedKnowledge ?? [],
    ...(input.upstreamVersion === undefined ? {} : { upstreamVersion: input.upstreamVersion })
  };
}

function knowledge(input: Partial<KnowledgeRecord> & Pick<KnowledgeRecord, 'path' | 'title' | 'rawSha256'>): KnowledgeRecord {
  return {
    path: input.path,
    rawSha256: input.rawSha256,
    title: input.title,
    sourceType: input.sourceType ?? 'AI提炼',
    usageStatus: input.usageStatus ?? 'AI总结',
    knowledgeType: input.knowledgeType ?? '方法',
    recallFields: input.recallFields ?? {
      topics: ['知识管理'],
      keywords: ['召回关键词'],
      scenarios: ['构建检索'],
      conclusion: 'YAML 中的核心结论',
      keyPoints: ['只搜允许字段'],
      boundary: '不搜索正文'
    },
    sourceMaterials: input.sourceMaterials ?? ['原始资料'],
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    ...(input.upstreamVersion === undefined ? {} : { upstreamVersion: input.upstreamVersion })
  };
}

function createGateway(fixtures: Record<string, string>): {
  gateway: OpenableFakeGateway;
  openedPaths: string[];
  writeCalls: string[];
} {
  const gateway = new FakeVaultGateway(fixtures) as OpenableFakeGateway & {
    writeRaw?: (path: string) => Promise<void>;
  };
  const openedPaths: string[] = [];
  const writeCalls: string[] = [];
  gateway.openInObsidian = async (path) => {
    openedPaths.push(path);
  };
  gateway.writeRaw = async (path) => {
    writeCalls.push(path);
  };
  return { gateway, openedPaths, writeCalls };
}

function createReadServer(input: {
  repository: IndexRepository;
  gateway: OpenableFakeGateway;
  database?: Database.Database;
  currentIndexVersion?: () => number;
  requestFocusRefresh?: () => Promise<void>;
  rebuildSnapshot?: () => RebuildSnapshot;
  indexScheduler?: IndexSchedulerPort;
  cursorSecret?: Uint8Array;
}) {
  const database = input.database ?? openDatabase();
  let operationSequence = 0;
  let jobSequence = 0;
  let refreshGeneration = 0;
  const snapshot = input.rebuildSnapshot ?? (() => ({
      state: { status: 'ready', version: 7, refreshedAt: '2026-08-31T00:00:00.000Z' },
      refresh: { status: 'ready', checked: 0, total: 0, version: 7 }
    }));
  const indexScheduler: IndexSchedulerPort = input.indexScheduler ?? {
    requestFocusRefresh: async () => {
      refreshGeneration += 1;
      await (input.requestFocusRefresh ?? (async () => {}))();
      return {
        generation: refreshGeneration,
        outcome: 'succeeded',
        refresh: snapshot().refresh
      };
    },
    snapshot
  };
  const server = buildServer({
    healthService: {
      getSnapshot: async () => ({
        status: 'ready',
        plugin: {
          status: 'connected',
          pluginId: 'obsidian-local-rest-api',
          pluginVersion: '5.1.0',
          obsidianVersion: '1.13.7'
        },
        writeGate: {
          status: 'blocked',
          missing: ['writeEnabled'],
          fingerprintMatches: true
        },
        index: indexScheduler.snapshot().state,
        model: {
          status: 'unconfigured',
          providerHost: 'models.example'
        },
        schemaIssues: { status: 'available', count: 0 }
      })
    },
    readApi: {
      repository: input.repository,
      gateway: input.gateway,
      database,
      indexScheduler,
      currentIndexVersion: input.currentIndexVersion ?? (() => 7),
      cursorSecret: input.cursorSecret ?? Buffer.from('read-api-test-cursor-secret-32b'),
      now: () => '2026-08-31T00:00:00.000Z',
      operationIdFactory: () => `operation-${++operationSequence}`,
      jobIdFactory: () => `job-${++jobSequence}`
    }
  } as Parameters<typeof buildServer>[0]);
  servers.push(server);
  return server;
}

function requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { host: HOST, ...extra };
}

async function bootstrap(server: ReturnType<typeof buildServer>) {
  const response = await server.inject({
    method: 'GET',
    url: '/api/v1/bootstrap',
    headers: requestHeaders()
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];
  if (cookie === undefined) throw new Error('session cookie missing');
  return {
    cookie,
    csrfToken: response.json<{ data: { csrfToken: string } }>().data.csrfToken
  };
}

function mutationHeaders(session: { cookie: string; csrfToken: string }, extra: Record<string, string> = {}) {
  return requestHeaders({
    origin: ORIGIN,
    cookie: session.cookie,
    'x-csrf-token': session.csrfToken,
    ...extra
  });
}

function expectFailure(
  response: { statusCode: number; json<T>(): T; body: string },
  status: number,
  code: string
) {
  expect(response.statusCode).toBe(status);
  const failure = response.json<{
    error: { code: string; message: string; operationId: string; fields?: Record<string, string> };
  }>();
  expect(failure.error).toEqual(expect.objectContaining({
    code,
    message: expect.any(String),
    operationId: expect.stringMatching(/^[a-z0-9._:-]+$/i)
  }));
  expect(response.body).not.toMatch(/Bearer |api[_-]?key|\/Users\/ao\/|vault-secret/i);
  return failure;
}

describe('versioned read APIs', () => {
  it('returns only pending materials by default and parses every supported filter', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    repository.replaceFile({ kind: 'material', record: material({
      path: '01图书馆/一.md', title: 'Alpha 一', knowledgeStatus: '未提炼', sourcePlatform: 'B站', collectedAt: '2026-08-20'
    }) });
    repository.replaceFile({ kind: 'material', record: material({
      path: '01图书馆/二.md', title: 'Alpha 二', knowledgeStatus: '部分入库', sourcePlatform: 'YouTube', collectedAt: '2026-08-25'
    }) });
    repository.replaceFile({ kind: 'material', record: material({
      path: '01图书馆/三.md', title: 'Alpha 三', knowledgeStatus: '已入库', sourcePlatform: 'YouTube', collectedAt: '2026-08-26'
    }) });
    repository.replaceFile({ kind: 'material', record: material({
      path: '01图书馆/四.md', title: 'Beta 四', knowledgeStatus: '部分入库', sourcePlatform: 'YouTube', collectedAt: '2026-08-02'
    }) });
    const { gateway } = createGateway({});
    const server = createReadServer({ repository, gateway, database });

    const pending = await server.inject({ method: 'GET', url: '/api/v1/materials', headers: requestHeaders() });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({
      version: 1,
      data: { items: [
        { path: '01图书馆/一.md', knowledgeStatus: '未提炼' },
        { path: '01图书馆/二.md', knowledgeStatus: '部分入库' },
        { path: '01图书馆/四.md', knowledgeStatus: '部分入库' }
      ] }
    });

    const filtered = await server.inject({
      method: 'GET',
      url: '/api/v1/materials?status=%E9%83%A8%E5%88%86%E5%85%A5%E5%BA%93&sourcePlatform=YouTube&collectedFrom=2026-08-20&collectedTo=2026-08-31&title=Alpha',
      headers: requestHeaders()
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toMatchObject({
      version: 1,
      data: { items: [{ path: '01图书馆/二.md', title: 'Alpha 二' }] }
    });

    const invalid = await server.inject({
      method: 'GET',
      url: '/api/v1/materials?status=%E6%9C%AA%E7%9F%A5',
      headers: requestHeaders()
    });
    expectFailure(invalid, 400, 'VALIDATION_ERROR');
  });

  it('continues after a deleted material anchor with a stateless Unicode cursor', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    for (const [suffix, title] of [['甲', '一'], ['乙', '二']] as const) {
      repository.replaceFile({ kind: 'material', record: material({
        path: `01图书馆/${'很长的中文路径'.repeat(45)}${suffix}.md`,
        title
      }) });
    }
    const { gateway } = createGateway({});
    const cursorSecret = Buffer.from('restart-stable-cursor-secret-value');
    const server = createReadServer({ repository, gateway, database, cursorSecret });

    const first = await server.inject({
      method: 'GET', url: '/api/v1/materials?limit=1', headers: requestHeaders()
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json<{
      data: { items: Array<{ path: string }>; nextCursor: string };
    }>().data;
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    expect(firstPage.nextCursor.length).toBeGreaterThan(64);
    expect(firstPage.nextCursor.length).toBeLessThanOrEqual(12_288);

    repository.removeFile(firstPage.items[0]!.path);
    const restartedServer = createReadServer({ repository, gateway, database, cursorSecret });

    const second = await restartedServer.inject({
      method: 'GET',
      url: `/api/v1/materials?limit=1&cursor=${firstPage.nextCursor}`,
      headers: requestHeaders()
    });
    expect(second.statusCode).toBe(200);
    const remainingPaths = second
      .json<{ data: { items: Array<{ path: string }> } }>()
      .data.items.map((item) => item.path);
    expect(remainingPaths).toHaveLength(1);
    expect(remainingPaths[0]).not.toBe(firstPage.items[0]!.path);
  });

  it('binds material cursors to canonical filters and the current index version', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    for (const [suffix, date] of [['甲', '2026-08-20'], ['乙', '2026-08-21']] as const) {
      repository.replaceFile({ kind: 'material', record: material({
        path: `01图书馆/Alpha-${suffix}.md`,
        title: `Alpha ${suffix}`,
        sourcePlatform: 'B站',
        collectedAt: date
      }) });
    }
    const { gateway } = createGateway({});
    let indexVersion = 7;
    const server = createReadServer({
      repository,
      gateway,
      database,
      currentIndexVersion: () => indexVersion
    });

    const first = await server.inject({
      method: 'GET',
      url: '/api/v1/materials?title=Alpha&sourcePlatform=B%E7%AB%99&limit=1',
      headers: requestHeaders()
    });
    const cursor = first.json<{ data: { nextCursor: string } }>().data.nextCursor;

    const reordered = await server.inject({
      method: 'GET',
      url: `/api/v1/materials?limit=1&sourcePlatform=B%E7%AB%99&title=Alpha&cursor=${cursor}`,
      headers: requestHeaders()
    });
    expect(reordered.statusCode).toBe(200);

    const changedFilter = await server.inject({
      method: 'GET',
      url: `/api/v1/materials?sourcePlatform=B%E7%AB%99&title=Al&limit=1&cursor=${cursor}`,
      headers: requestHeaders()
    });
    expectFailure(changedFilter, 400, 'VALIDATION_ERROR');

    indexVersion = 8;
    const changedVersion = await server.inject({
      method: 'GET',
      url: `/api/v1/materials?title=Alpha&sourcePlatform=B%E7%AB%99&limit=1&cursor=${cursor}`,
      headers: requestHeaders()
    });
    expectFailure(changedVersion, 409, 'VERSION_CONFLICT');
  });

  it('rejects a page when the index version changes while records are collected', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    repository.replaceFile({ kind: 'material', record: material({
      path: '01图书馆/索引一.md', title: '索引一'
    }) });
    repository.replaceFile({ kind: 'material', record: material({
      path: '01图书馆/索引二.md', title: '索引二'
    }) });
    let indexVersion = 7;
    let changeDuringCollection = false;
    const racingRepository = {
      ...repository,
      listMaterials: (query: Parameters<IndexRepository['listMaterials']>[0]) => {
        const page = repository.listMaterials(query);
        if (changeDuringCollection) indexVersion = 8;
        return page;
      }
    } as IndexRepository;
    const { gateway } = createGateway({});
    const server = createReadServer({
      repository: racingRepository,
      gateway,
      database,
      currentIndexVersion: () => indexVersion
    });
    const first = await server.inject({
      method: 'GET', url: '/api/v1/materials?limit=1', headers: requestHeaders()
    });
    const cursor = first.json<{ data: { nextCursor: string } }>().data.nextCursor;

    changeDuringCollection = true;
    const mixedGeneration = await server.inject({
      method: 'GET',
      url: `/api/v1/materials?limit=1&cursor=${cursor}`,
      headers: requestHeaders()
    });
    expectFailure(mixedGeneration, 409, 'VERSION_CONFLICT');
  });

  it('rejects malformed or cross-kind cursors without reflecting cursor content', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    repository.replaceFile({ kind: 'knowledge', record: knowledge({
      path: '02知识库/游标来源.md', title: 'MODEL_API_KEY=vault-secret-body', rawSha256: 'f'.repeat(64)
    }) });
    repository.replaceFile({ kind: 'knowledge', record: knowledge({
      path: '02知识库/游标后续.md', title: '游标后续', rawSha256: 'e'.repeat(64)
    }) });
    const { gateway } = createGateway({});
    const cursorSecret = Buffer.from('cursor-secret-that-must-never-leak');
    const server = createReadServer({ repository, gateway, database, cursorSecret });
    const first = await server.inject({
      method: 'GET', url: '/api/v1/knowledge?limit=1', headers: requestHeaders()
    });
    const cursor = first.json<{ data: { nextCursor: string } }>().data.nextCursor;
    const [encodedPayload] = cursor.split('.');
    const decodedPayload = Buffer.from(encodedPayload!, 'base64url').toString('utf8');
    expect(JSON.parse(decodedPayload)).toEqual({
      version: 1,
      kind: 'knowledge',
      filterSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      indexVersion: 7,
      afterPath: expect.stringMatching(/^02知识库\//)
    });
    expect(decodedPayload).not.toContain('vault-secret-body');
    expect(cursor).not.toContain(cursorSecret.toString('utf8'));

    const crossKind = await server.inject({
      method: 'GET',
      url: `/api/v1/materials?limit=1&cursor=${cursor}`,
      headers: requestHeaders()
    });
    expectFailure(crossKind, 400, 'VALIDATION_ERROR');

    const tamperedCursor = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;
    const tampered = await server.inject({
      method: 'GET',
      url: `/api/v1/knowledge?limit=1&cursor=${tamperedCursor}`,
      headers: requestHeaders()
    });
    expectFailure(tampered, 400, 'VALIDATION_ERROR');
    expect(tampered.body).not.toContain(cursorSecret.toString('utf8'));
    expect(tampered.body).not.toContain('vault-secret-body');

    const malformedValue = 'not-a-cursor-vault-secret';
    const malformed = await server.inject({
      method: 'GET',
      url: `/api/v1/knowledge?cursor=${malformedValue}`,
      headers: requestHeaders()
    });
    expectFailure(malformed, 400, 'VALIDATION_ERROR');
    expect(malformed.body).not.toContain(malformedValue);
    expect(malformed.body).not.toContain('游标来源');
  });

  it('searches knowledge only through title and YAML recall fields and excludes obsolete notes by default', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    repository.replaceFile({ kind: 'knowledge', record: knowledge({
      path: '02知识库/标题命中.md', title: 'Needle title', rawSha256: 'b'.repeat(64), sourceMaterials: ['body-only-token']
    }) });
    repository.replaceFile({ kind: 'knowledge', record: knowledge({
      path: '02知识库/召回命中.md', title: '普通标题', rawSha256: 'c'.repeat(64),
      recallFields: {
        topics: ['Needle topic'], keywords: [], scenarios: [], conclusion: '', keyPoints: [], boundary: ''
      }
    }) });
    repository.replaceFile({ kind: 'knowledge', record: knowledge({
      path: '02知识库/正文命中-body-only-token.md', title: '不会命中', rawSha256: 'd'.repeat(64), sourceMaterials: ['Needle source-link']
    }) });
    repository.replaceFile({ kind: 'knowledge', record: knowledge({
      path: '02知识库/过时.md', title: 'Needle obsolete', rawSha256: 'e'.repeat(64), usageStatus: '过时'
    }) });
    const { gateway } = createGateway({});
    const server = createReadServer({ repository, gateway, database });

    const search = await server.inject({
      method: 'GET', url: '/api/v1/knowledge?search=Needle', headers: requestHeaders()
    });
    expect(search.statusCode).toBe(200);
    expect(search.json<{ data: { items: Array<{ path: string }> } }>().data.items.map((item) => item.path))
      .toEqual(['02知识库/召回命中.md', '02知识库/标题命中.md']);

    const sourceOnly = await server.inject({
      method: 'GET', url: '/api/v1/knowledge?search=source-link', headers: requestHeaders()
    });
    expect(sourceOnly.json<{ data: { items: unknown[] } }>().data.items).toEqual([]);

    const obsolete = await server.inject({
      method: 'GET', url: '/api/v1/knowledge?usageStatus=%E8%BF%87%E6%97%B6', headers: requestHeaders()
    });
    expect(obsolete.json<{ data: { items: Array<{ path: string }> } }>().data.items)
      .toMatchObject([{ path: '02知识库/过时.md' }]);
  });

  it('round-trips an authenticated knowledge cursor for long Unicode vault paths', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    for (const [suffix, hash] of [['甲', 'b'], ['乙', 'c']] as const) {
      repository.replaceFile({ kind: 'knowledge', record: knowledge({
        path: `02知识库/${'很长的中文路径'.repeat(45)}${suffix}.md`,
        title: suffix,
        rawSha256: hash.repeat(64)
      }) });
    }
    const { gateway } = createGateway({});
    const server = createReadServer({ repository, gateway, database });

    const first = await server.inject({
      method: 'GET', url: '/api/v1/knowledge?limit=1', headers: requestHeaders()
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json<{ data: { items: unknown[]; nextCursor: string } }>().data;
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    expect(firstPage.nextCursor.length).toBeGreaterThan(64);
    expect(firstPage.nextCursor.length).toBeLessThanOrEqual(12_288);

    const second = await server.inject({
      method: 'GET',
      url: `/api/v1/knowledge?limit=1&cursor=${firstPage.nextCursor}`,
      headers: requestHeaders()
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(1);
  });

  it('returns only hash-verified live Markdown for an indexed knowledge path', async () => {
    const markdown = '---\n类型: 知识笔记\n---\n\n# 安全正文\n\n<script>raw only</script>\n';
    const { gateway } = createGateway({ '02知识库/安全.md': markdown, '01图书馆/资料.md': '# material' });
    const live = await gateway.readRaw('02知识库/安全.md');
    const database = openDatabase();
    const repository = createIndexRepository(database);
    repository.replaceFile({ kind: 'knowledge', record: knowledge({
      path: live.path,
      title: '安全知识',
      rawSha256: live.rawSha256,
      upstreamVersion: 'indexed-version'
    }) });
    const server = createReadServer({ repository, gateway, database });

    const detail = await server.inject({
      method: 'GET',
      url: `/api/v1/knowledge/file?path=${encodeURIComponent(live.path)}`,
      headers: requestHeaders()
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(detail.json()).toEqual({
      data: {
        path: live.path,
        title: '安全知识',
        markdown,
        internalKnowledgeLinks: [],
        versionMarker: { rawSha256: live.rawSha256 }
      },
      version: 1
    });

    const disallowed = await server.inject({
      method: 'GET',
      url: `/api/v1/knowledge/file?path=${encodeURIComponent('03大讲堂/秘密.md')}`,
      headers: requestHeaders()
    });
    expectFailure(disallowed, 400, 'PATH_NOT_ALLOWED');

    const unindexed = await server.inject({
      method: 'GET',
      url: `/api/v1/knowledge/file?path=${encodeURIComponent('02知识库/不存在.md')}`,
      headers: requestHeaders()
    });
    expectFailure(unindexed, 404, 'KNOWLEDGE_NOT_FOUND');

    gateway.mutateFixture('02知识库/安全.md', `${markdown}\nchanged`);
    const conflicted = await server.inject({
      method: 'GET',
      url: `/api/v1/knowledge/file?path=${encodeURIComponent(live.path)}`,
      headers: requestHeaders()
    });
    expectFailure(conflicted, 409, 'VERSION_CONFLICT');
    expect(conflicted.headers['cache-control']).toBe('no-store');
    expect(conflicted.body).not.toContain(`${markdown}\nchanged`);
  });

  it('resolves only unique exact indexed 02 knowledge wikilinks from live Markdown', async () => {
    const markdown = [
      '# 内链',
      '[[02知识库/知识管理/唯一#小节^块|显示名]]',
      '[[唯一^块|重复目标]]',
      '[[02知识库/知识管理/唯一.md]]',
      '[[重名]]',
      '[[02知识库/子目录/重名.md#精确路径]]',
      '[[不存在]]',
      '[[00大脑规则/规则.md]]',
      '[[01图书馆/资料.md]]',
      '[[03大讲堂/秘密.md]]',
      '[[02知识库/../01图书馆/逃逸.md]]',
      '[[../逃逸.md]]',
      '[[file:///Users/ao/秘密.md]]',
      '[[obsidian://open?vault=秘密]]',
      '[[https://example.com/不是内链]]'
    ].join('\n');
    const gatewayFixture = createGateway({ '02知识库/来源.md': markdown });
    const live = await gatewayFixture.gateway.readRaw('02知识库/来源.md');
    const database = openDatabase();
    const repository = createIndexRepository(database);
    for (const record of [
      knowledge({ path: live.path, title: '来源', rawSha256: live.rawSha256 }),
      knowledge({ path: '02知识库/知识管理/唯一.md', title: '唯一', rawSha256: '1'.repeat(64) }),
      knowledge({ path: '02知识库/甲/重名.md', title: '重名', rawSha256: '2'.repeat(64) }),
      knowledge({ path: '02知识库/子目录/重名.md', title: '重名', rawSha256: '3'.repeat(64) }),
      knowledge({ path: '02知识库/01图书馆/逃逸.md', title: '逃逸', rawSha256: '4'.repeat(64) })
    ]) {
      repository.replaceFile({ kind: 'knowledge', record });
    }
    const server = createReadServer({ repository, gateway: gatewayFixture.gateway, database });

    const detail = await server.inject({
      method: 'GET',
      url: `/api/v1/knowledge/file?path=${encodeURIComponent(live.path)}`,
      headers: requestHeaders()
    });

    expect(detail.statusCode).toBe(200);
    const internalKnowledgeLinks = detail
      .json<{ data: { internalKnowledgeLinks: unknown[] } }>()
      .data.internalKnowledgeLinks;
    expect(internalKnowledgeLinks).toEqual([
      { path: '02知识库/知识管理/唯一.md', title: '唯一' },
      { path: '02知识库/子目录/重名.md', title: '重名' }
    ]);
    expect(JSON.stringify(internalKnowledgeLinks))
      .not.toMatch(/00大脑规则|01图书馆|03大讲堂|file:|obsidian:|https:/u);
  });

  it('resolves only body links with globally unique normalized and layered index identities', async () => {
    const markdown = [
      '---',
      '类型: 知识笔记',
      '来源资料: ["[[YAML目标]]"]',
      '---',
      '[[正文标题]]',
      '[[同名]]',
      '[[02知识库/同名.md]]',
      '[[跨库标题]]',
      '[[仅资料]]',
      '[[foo.pdf]]',
      '[[foo.md]]',
      '[[foo.md.md]]',
      `[[${'Café'.normalize('NFD')}]]`,
      '[[子目录/相对.md]]',
      '[[来源]]'
    ].join('\n');
    const gatewayFixture = createGateway({ '02知识库/来源.md': markdown });
    const live = await gatewayFixture.gateway.readRaw('02知识库/来源.md');
    const database = openDatabase();
    const repository = createIndexRepository(database);

    for (const record of [
      material({ path: '01图书馆/同名.md', title: '同名' }),
      material({ path: '01图书馆/标题资料.md', title: '跨库标题' }),
      material({ path: '01图书馆/仅资料.md', title: '仅资料' })
    ]) {
      repository.replaceFile({ kind: 'material', record });
    }
    for (const record of [
      knowledge({ path: live.path, title: '来源', rawSha256: live.rawSha256 }),
      knowledge({ path: '02知识库/YAML目标.md', title: 'YAML目标', rawSha256: '1'.repeat(64) }),
      knowledge({ path: '02知识库/正文路径.md', title: '正文标题', rawSha256: '2'.repeat(64) }),
      knowledge({ path: '02知识库/同名.md', title: '同名', rawSha256: '3'.repeat(64) }),
      knowledge({ path: '02知识库/标题知识.md', title: '跨库标题', rawSha256: '4'.repeat(64) }),
      knowledge({ path: '02知识库/foo.pdf.md', title: 'PDF Markdown', rawSha256: '5'.repeat(64) }),
      knowledge({ path: '02知识库/foo.md', title: 'Foo exact', rawSha256: '6'.repeat(64) }),
      knowledge({ path: '02知识库/foo.md.md', title: 'Foo double', rawSha256: '7'.repeat(64) }),
      knowledge({ path: '02知识库/Café.md', title: 'Café', rawSha256: '8'.repeat(64) }),
      knowledge({ path: '02知识库/子目录/相对.md', title: '相对', rawSha256: '9'.repeat(64) })
    ]) {
      repository.replaceFile({ kind: 'knowledge', record });
    }

    let indexVersionReads = 0;
    const server = createReadServer({
      repository,
      gateway: gatewayFixture.gateway,
      database,
      currentIndexVersion: () => {
        indexVersionReads += 1;
        return 7;
      }
    });
    const readsBeforeDetail = indexVersionReads;
    const detail = await server.inject({
      method: 'GET',
      url: `/api/v1/knowledge/file?path=${encodeURIComponent(live.path)}`,
      headers: requestHeaders()
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ data: { internalKnowledgeLinks: unknown[] } }>().data.internalKnowledgeLinks)
      .toEqual([
        { path: '02知识库/正文路径.md', title: '正文标题' },
        { path: '02知识库/同名.md', title: '同名' },
        { path: '02知识库/foo.md', title: 'Foo exact' },
        { path: '02知识库/foo.md.md', title: 'Foo double' },
        { path: '02知识库/Café.md', title: 'Café' },
        { path: '02知识库/子目录/相对.md', title: '相对' }
      ]);
    expect(indexVersionReads - readsBeforeDetail).toBe(2);
  });

  it('fails closed when live metadata lies or the indexed projection changes during a detail read', async () => {
    const markdown = '# coherent';
    const gatewayFixture = createGateway({ '02知识库/竞态.md': markdown });
    const live = await gatewayFixture.gateway.readRaw('02知识库/竞态.md');
    const database = openDatabase();
    const repository = createIndexRepository(database);
    const indexed = knowledge({ path: live.path, title: '竞态', rawSha256: live.rawSha256 });
    repository.replaceFile({ kind: 'knowledge', record: indexed });

    const originalRead = gatewayFixture.gateway.readRaw.bind(gatewayFixture.gateway);
    gatewayFixture.gateway.readRaw = async (path, signal) => {
      const raw = await originalRead(path, signal);
      return { ...raw, rawSha256: '0'.repeat(64) };
    };
    const lyingServer = createReadServer({ repository, gateway: gatewayFixture.gateway, database });
    const lying = await lyingServer.inject({
      method: 'GET',
      url: `/api/v1/knowledge/file?path=${encodeURIComponent(indexed.path)}`,
      headers: requestHeaders()
    });
    expectFailure(lying, 409, 'VERSION_CONFLICT');

    gatewayFixture.gateway.readRaw = async (path, signal) => {
      const raw = await originalRead(path, signal);
      return { ...raw, path: '02知识库/另一个文件.md' };
    };
    const wrongPath = await lyingServer.inject({
      method: 'GET',
      url: `/api/v1/knowledge/file?path=${encodeURIComponent(indexed.path)}`,
      headers: requestHeaders()
    });
    expectFailure(wrongPath, 409, 'VERSION_CONFLICT');

    gatewayFixture.gateway.readRaw = originalRead;
    let projectionReads = 0;
    const racingRepository = {
      ...repository,
      getKnowledge: (path: string) => {
        projectionReads += 1;
        const current = repository.getKnowledge(path);
        return projectionReads === 2 && current !== undefined
          ? { ...current, upstreamVersion: 'changed-during-read' }
          : current;
      }
    } as IndexRepository;
    const racingServer = createReadServer({
      repository: racingRepository,
      gateway: gatewayFixture.gateway,
      database
    });
    const raced = await racingServer.inject({
      method: 'GET',
      url: `/api/v1/knowledge/file?path=${encodeURIComponent(indexed.path)}`,
      headers: requestHeaders()
    });
    expectFailure(raced, 409, 'VERSION_CONFLICT');

    let indexVersion = 7;
    let indexVersionReads = 0;
    const versionRacingRepository = {
      ...repository,
      listKnowledge: (query: Parameters<IndexRepository['listKnowledge']>[0]) => {
        const page = repository.listKnowledge(query);
        indexVersion = 8;
        return page;
      }
    } as IndexRepository;
    const versionRacingServer = createReadServer({
      repository: versionRacingRepository,
      gateway: gatewayFixture.gateway,
      database,
      currentIndexVersion: () => {
        indexVersionReads += 1;
        return indexVersion;
      }
    });
    const versionRaced = await versionRacingServer.inject({
      method: 'GET',
      url: `/api/v1/knowledge/file?path=${encodeURIComponent(indexed.path)}`,
      headers: requestHeaders()
    });
    expectFailure(versionRaced, 409, 'VERSION_CONFLICT');
    expect(indexVersionReads).toBe(3);
  });

  it('opens only an indexed knowledge note through the dedicated read-only gateway command', async () => {
    const markdown = '# knowledge';
    const gatewayFixture = createGateway({ '02知识库/可打开.md': markdown });
    const live = await gatewayFixture.gateway.readRaw('02知识库/可打开.md');
    const database = openDatabase();
    const repository = createIndexRepository(database);
    repository.replaceFile({ kind: 'knowledge', record: knowledge({
      path: live.path, title: '可打开', rawSha256: live.rawSha256
    }) });
    const server = createReadServer({ repository, gateway: gatewayFixture.gateway, database });

    const withoutSession = await server.inject({
      method: 'POST',
      url: '/api/v1/knowledge/open',
      headers: requestHeaders({ origin: ORIGIN, 'content-type': 'application/json' }),
      payload: { path: live.path }
    });
    expectFailure(withoutSession, 401, 'SESSION_REQUIRED');

    const session = await bootstrap(server);
    const opened = await server.inject({
      method: 'POST',
      url: '/api/v1/knowledge/open',
      headers: mutationHeaders(session, { 'content-type': 'application/json' }),
      payload: { path: live.path }
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({
      data: { opened: true, path: live.path },
      version: 1,
      operationId: expect.stringMatching(/^operation-/)
    });
    expect(gatewayFixture.openedPaths).toEqual([live.path]);
    expect(gatewayFixture.writeCalls).toEqual([]);

    const missing = await server.inject({
      method: 'POST',
      url: '/api/v1/knowledge/open',
      headers: mutationHeaders(session, { 'content-type': 'application/json' }),
      payload: { path: '02知识库/未索引.md' }
    });
    expectFailure(missing, 404, 'KNOWLEDGE_NOT_FOUND');
    expect(gatewayFixture.openedPaths).toEqual([live.path]);
  });

  it('returns an empty versioned operation page before workflows exist', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    const { gateway } = createGateway({});
    const server = createReadServer({ repository, gateway, database });

    const response = await server.inject({
      method: 'GET', url: '/api/v1/operations', headers: requestHeaders()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { items: [] }, version: 1 });
  });
});

describe('persistent index rebuild jobs', () => {
  it('uses the index version exposed by health for a rebuild command', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    const { gateway } = createGateway({});
    const server = createReadServer({ repository, gateway, database });

    const health = await server.inject({
      method: 'GET', url: '/api/v1/health', headers: requestHeaders()
    });
    expect(health.statusCode).toBe(200);
    const indexVersion = health.json<{
      data: { index: { status: string; version: number } };
      version: number;
    }>();
    expect(indexVersion).toMatchObject({
      data: { index: { status: 'ready', version: 7 } },
      version: 1
    });

    const session = await bootstrap(server);
    const rebuild = await server.inject({
      method: 'POST',
      url: '/api/v1/index-jobs/rebuild',
      headers: mutationHeaders(session, {
        'content-type': 'application/json',
        'idempotency-key': 'health-version-rebuild'
      }),
      payload: { indexVersion: indexVersion.data.index.version }
    });
    expect(rebuild.statusCode).toBe(202);
    expect(rebuild.json()).toMatchObject({ data: { requestedIndexVersion: 7 }, version: 1 });
  });

  it('requires session, CSRF, index version, and idempotency key', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    const { gateway } = createGateway({});
    const server = createReadServer({ repository, gateway, database });

    const noSession = await server.inject({
      method: 'POST',
      url: '/api/v1/index-jobs/rebuild',
      headers: requestHeaders({ origin: ORIGIN, 'content-type': 'application/json', 'idempotency-key': 'rebuild-1' }),
      payload: { indexVersion: 7 }
    });
    expectFailure(noSession, 401, 'SESSION_REQUIRED');

    const session = await bootstrap(server);
    const noKey = await server.inject({
      method: 'POST',
      url: '/api/v1/index-jobs/rebuild',
      headers: mutationHeaders(session, { 'content-type': 'application/json' }),
      payload: { indexVersion: 7 }
    });
    expectFailure(noKey, 400, 'VALIDATION_ERROR');

    database.prepare(`UPDATE index_metadata SET version = 8 WHERE singleton = 1`).run();
    const staleVersion = await server.inject({
      method: 'POST',
      url: '/api/v1/index-jobs/rebuild',
      headers: mutationHeaders(session, { 'content-type': 'application/json', 'idempotency-key': 'rebuild-stale' }),
      payload: { indexVersion: 7 }
    });
    expectFailure(staleVersion, 409, 'VERSION_CONFLICT');
  });

  it('creates one durable job for concurrent idempotent requests and returns its authoritative snapshot', async () => {
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCycle = 0;
    const requestFocusRefresh = vi.fn(async () => {
      refreshCycle += 1;
      if (refreshCycle === 1) await refreshBlocked;
    });
    const database = openDatabase();
    const repository = createIndexRepository(database);
    const { gateway } = createGateway({});
    const server = createReadServer({
      repository,
      gateway,
      database,
      currentIndexVersion: () => refreshCycle >= 2 ? 8 : 7,
      requestFocusRefresh,
      rebuildSnapshot: () => ({
        state: {
          status: 'ready',
          version: refreshCycle >= 2 ? 8 : 7,
          refreshedAt: refreshCycle >= 2 ? '2026-08-31T00:01:00.000Z' : '2026-08-31T00:00:00.000Z'
        },
        refresh: {
          status: refreshCycle >= 2 ? 'ready' : 'refreshing',
          checked: refreshCycle >= 2 ? 2 : 1,
          total: 2,
          version: refreshCycle >= 2 ? 8 : 7
        }
      })
    });
    const session = await bootstrap(server);
    const request = () => server.inject({
      method: 'POST' as const,
      url: '/api/v1/index-jobs/rebuild',
      headers: mutationHeaders(session, {
        'content-type': 'application/json',
        'idempotency-key': 'stable-rebuild-key'
      }),
      payload: { indexVersion: 7 }
    });

    const [first, duplicate] = await Promise.all([request(), request()]);
    expect([first.statusCode, duplicate.statusCode].sort()).toEqual([202, 202]);
    expect(first.json()).toEqual(duplicate.json());
    expect(first.json()).toMatchObject({
      data: {
        id: 'job-1',
        status: 'running',
        requestedIndexVersion: 7,
        indexVersion: 7,
        progress: { completed: 0, total: 0 },
        operationId: expect.stringMatching(/^operation-/)
      },
      version: 1,
      operationId: expect.stringMatching(/^operation-/)
    });
    expect(requestFocusRefresh).toHaveBeenCalledTimes(1);
    expect(database.prepare('SELECT COUNT(*) AS count FROM index_jobs').get()).toEqual({ count: 1 });

    releaseRefresh();
    await vi.waitFor(() => {
      expect(database.prepare('SELECT status FROM index_jobs WHERE id = ?').get('job-1'))
        .toEqual({ status: 'completed' });
    });
    expect(requestFocusRefresh).toHaveBeenCalledTimes(2);

    const snapshot = await server.inject({
      method: 'GET', url: '/api/v1/index-jobs/job-1', headers: requestHeaders()
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      data: {
        id: 'job-1',
        status: 'completed',
        requestedIndexVersion: 7,
        indexVersion: 8,
        progress: { completed: 2, total: 2 },
        operationId: expect.stringMatching(/^operation-/)
      },
      version: 1
    });

    const secondProcess = createReadServer({ repository, gateway, database, currentIndexVersion: () => 8 });
    const persisted = await secondProcess.inject({
      method: 'GET', url: '/api/v1/index-jobs/job-1', headers: requestHeaders()
    });
    expect(persisted.json()).toEqual(snapshot.json());
  });

  it('rejects idempotency conflicts and a different key while one rebuild is active', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    const { gateway } = createGateway({});
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestFocusRefresh = vi.fn(async () => blocked);
    const server = createReadServer({ repository, gateway, database, requestFocusRefresh });
    const session = await bootstrap(server);
    const headers = mutationHeaders(session, {
      'content-type': 'application/json',
      'idempotency-key': 'conflicting-rebuild-key'
    });

    const accepted = await server.inject({
      method: 'POST', url: '/api/v1/index-jobs/rebuild', headers, payload: { indexVersion: 7 }
    });
    expect(accepted.statusCode).toBe(202);
    const conflict = await server.inject({
      method: 'POST', url: '/api/v1/index-jobs/rebuild', headers, payload: { indexVersion: 8 }
    });
    expectFailure(conflict, 409, 'IDEMPOTENCY_CONFLICT');

    const busy = await server.inject({
      method: 'POST',
      url: '/api/v1/index-jobs/rebuild',
      headers: { ...headers, 'idempotency-key': 'different-rebuild-key' },
      payload: { indexVersion: 7 }
    });
    expectFailure(busy, 409, 'INDEX_BUSY');
    expect(database.prepare('SELECT COUNT(*) AS count FROM index_jobs').get()).toEqual({ count: 1 });
    expect(requestFocusRefresh).toHaveBeenCalledTimes(1);
    release();
  });

  it('marks a pre-start queued or running rebuild interrupted without invoking the scheduler', async () => {
    const database = openDatabase();
    database.prepare(`
      INSERT INTO index_jobs (
        id, operation_id, requested_index_version, result_index_version,
        status, progress_completed, progress_total, error_code, created_at, updated_at
      ) VALUES (?, ?, 7, NULL, 'running', 1, 3, NULL, ?, ?)
    `).run('job-before-restart', 'operation-before-restart', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
    const repository = createIndexRepository(database);
    const { gateway } = createGateway({});
    const requestFocusRefresh = vi.fn(async () => {});
    const server = createReadServer({ repository, gateway, database, requestFocusRefresh });

    const response = await server.inject({
      method: 'GET', url: '/api/v1/index-jobs/job-before-restart', headers: requestHeaders()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        id: 'job-before-restart',
        status: 'interrupted',
        progress: { completed: 1, total: 3 },
        errorCode: 'SERVER_RESTARTED'
      },
      version: 1
    });
    expect(requestFocusRefresh).not.toHaveBeenCalled();
  });

  it('persists bounded refresh progress and captures background rejection as a safe failed job', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    const { gateway } = createGateway({});
    let cycle = 0;
    const server = createReadServer({
      repository,
      gateway,
      database,
      requestFocusRefresh: async () => {
        cycle += 1;
        if (cycle === 2) throw new Error('Bearer vault-secret /Users/ao/我的大脑/private.md');
      },
      rebuildSnapshot: () => ({
        state: { status: 'ready', version: 7, refreshedAt: '2026-08-31T00:00:00.000Z' },
        refresh: { status: 'ready', checked: 0, total: 0, version: 7 }
      })
    });
    const session = await bootstrap(server);

    const accepted = await server.inject({
      method: 'POST',
      url: '/api/v1/index-jobs/rebuild',
      headers: mutationHeaders(session, {
        'content-type': 'application/json',
        'idempotency-key': 'failed-background-rebuild'
      }),
      payload: { indexVersion: 7 }
    });
    expect(accepted.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(database.prepare('SELECT status FROM index_jobs WHERE id = ?').get('job-1'))
        .toEqual({ status: 'completed' });
    });

    database.prepare(`UPDATE index_metadata SET version = 7 WHERE singleton = 1`).run();
    const failed = await server.inject({
      method: 'POST',
      url: '/api/v1/index-jobs/rebuild',
      headers: mutationHeaders(session, {
        'content-type': 'application/json',
        'idempotency-key': 'second-failed-background-rebuild'
      }),
      payload: { indexVersion: 7 }
    });
    expect(failed.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(database.prepare('SELECT status, error_code AS errorCode FROM index_jobs WHERE id = ?').get('job-2'))
        .toEqual({ status: 'failed', errorCode: 'INDEX_REBUILD_FAILED' });
    });
    const snapshot = await server.inject({
      method: 'GET', url: '/api/v1/index-jobs/job-2', headers: requestHeaders()
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      data: { status: 'failed', errorCode: 'INDEX_REBUILD_FAILED' },
      version: 1
    });
    expect(snapshot.body).not.toMatch(/Bearer |vault-secret|\/Users\/ao\//i);
  });

  it('does not complete a rebuild from an older ready snapshot when its real scheduler attempt fails', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    const { gateway } = createGateway({});
    let fail = false;
    const now = () => new Date('2026-08-31T00:00:00.000Z');
    const scheduler = new IndexScheduler({
      refresh: async () => {
        if (fail) throw new Error('current rebuild failed');
        return { status: 'ready', checked: 2, total: 2, version: 7 };
      },
      state: new IndexStateController(now),
      intervals: { every: () => () => {} },
      deadlines: { after: () => () => {} },
      now
    });
    await scheduler.requestFocusRefresh();
    expect(scheduler.snapshot()).toMatchObject({
      state: { status: 'ready', version: 7 },
      refresh: { status: 'ready', version: 7 }
    });
    fail = true;
    const server = createReadServer({
      repository,
      gateway,
      database,
      indexScheduler: scheduler
    });
    const session = await bootstrap(server);

    const accepted = await server.inject({
      method: 'POST',
      url: '/api/v1/index-jobs/rebuild',
      headers: mutationHeaders(session, {
        'content-type': 'application/json',
        'idempotency-key': 'real-scheduler-failure'
      }),
      payload: { indexVersion: 7 }
    });
    expect(accepted.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(database.prepare(`
        SELECT status, error_code AS errorCode FROM index_jobs WHERE id = 'job-1'
      `).get()).toEqual({ status: 'failed', errorCode: 'INDEX_REBUILD_FAILED' });
    });
  });
});

describe('read API validation and containment', () => {
  it('safe-closes routes when read dependencies were not injected', async () => {
    const server = buildServer();
    servers.push(server);
    const response = await server.inject({
      method: 'GET', url: '/api/v1/materials', headers: requestHeaders()
    });
    expectFailure(response, 503, 'READ_API_UNAVAILABLE');
  });

  it('parses service output and never reflects a corrupt projection or upstream secret', async () => {
    const database = openDatabase();
    const repository = createIndexRepository(database);
    const corruptRepository = {
      ...repository,
      listMaterials: () => ({
        items: [{ path: '/Users/ao/我的大脑/secret.md', body: 'vault-secret' }],
        total: 1,
        page: 1,
        pageSize: 50
      })
    } as unknown as IndexRepository;
    const { gateway } = createGateway({});
    const server = createReadServer({ repository: corruptRepository, gateway, database });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/materials?status=%E6%9C%AA%E6%8F%90%E7%82%BC',
      headers: requestHeaders()
    });
    expectFailure(response, 500, 'INTERNAL_ERROR');
  });
});
