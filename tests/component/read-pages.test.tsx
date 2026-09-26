// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import {
  browserReadConsoleApi,
  type ApiClientResult,
  type HealthSnapshot,
  type IndexJob,
  type KnowledgeQuery,
  type KnowledgePage,
  type LiveKnowledgeDetail,
  type LiveDocumentDetail,
  type MaterialQuery,
  type MaterialPage,
  type OperationPage,
  type ReadConsoleApi
} from '../../src/client/api/client.js';
import { AppRouter } from '../../src/client/app/router.js';
import type { KnowledgeRecord, MaterialRecord } from '../../src/shared/domain/records.js';
afterEach(cleanup);
beforeEach(() => sessionStorage.clear());

function ok<T>(value: T): ApiClientResult<T> {
  return { ok: true, value };
}

function readyHealth(version = 7): HealthSnapshot {
  return {
    status: 'ready',
    vaultSource: {
      status: 'ready',
      adapter: 'filesystem',
      displayName: '我的大脑'
    },
    index: {
      status: 'ready',
      version,
      refreshedAt: '2026-09-01T00:00:00.000Z'
    },
    model: { status: 'configured', providerHost: 'models.example', name: 'deepseek-v3' },
    writeGate: { status: 'blocked', missing: ['writeEnabled'], fingerprintMatches: true },
    schemaIssues: { status: 'available', count: 3 }
  };
}

function failure<T>(status: 'disconnected' | 'validation-error' | 'operation-error' | 'busy' | 'conflict' | 'recovery-required'): ApiClientResult<T> {
  return { ok: false, state: { status, message: 'SECRET_SERVER_MESSAGE' } };
}

function material(overrides: Partial<MaterialRecord> = {}): MaterialRecord {
  return {
    path: '01图书馆/来自微信/材料.md',
    rawSha256: 'a'.repeat(64),
    title: '材料标题',
    sourcePlatform: '微信',
    processingStatus: '已归档',
    knowledgeStatus: '未提炼',
    generatedKnowledge: [],
    ...overrides
  };
}

function knowledge(overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    path: '02知识库/增长/知识.md',
    rawSha256: 'b'.repeat(64),
    title: '知识标题',
    sourceType: 'AI提炼',
    usageStatus: 'AI总结',
    knowledgeType: '方法',
    recallFields: {
      topics: ['增长'], keywords: ['复利'], scenarios: ['制定策略'], conclusion: '核心结论',
      keyPoints: ['关键点'], boundary: '边界'
    },
    sourceMaterials: ['01图书馆/来自微信/材料.md'],
    ...overrides
  };
}

function completedJob(): IndexJob {
  return {
    id: 'job-1', operationId: 'operation-1', status: 'completed', requestedIndexVersion: 7,
    indexVersion: 8, progress: { completed: 1, total: 1 },
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:01.000Z'
  };
}

function createApi(overrides: Partial<ReadConsoleApi> = {}): ReadConsoleApi {
  return {
    getHealth: vi.fn(async () => ok(readyHealth())),
    listDocumentIssues: vi.fn(async () => ok({ items: [] })),
    getDocumentDetail: vi.fn(async () => failure<LiveDocumentDetail>('operation-error')),
    listMaterials: vi.fn(async () => ok({ items: [] })),
    listLibrary: vi.fn(async () => ok({ mode: 'topic' as const, path: '', breadcrumbs: [{ path: '', label: '全部资料' }], folders: [], items: [], total: 0, directTotal: 0, unclassifiedCount: 0, indexVersion: 7 })),
    listKnowledge: vi.fn(async () => ok({ items: [] })),
    getKnowledgeDetail: vi.fn(async () => failure<LiveKnowledgeDetail>('operation-error')),
    listOperations: vi.fn(async () => ok({ items: [] })),
    openKnowledge: vi.fn(async (path) => ok({ opened: true as const, path })),
    rebuildIndex: vi.fn(async () => ok(completedJob())),
    getIndexJob: vi.fn(async () => ok(completedJob())),
    ...overrides
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function renderRoute(path: string, api: ReadConsoleApi = browserReadConsoleApi): void {
  const InjectableRouter = AppRouter as ComponentType<{ readonly api: ReadConsoleApi }>;
  // This suite exercises the read-only adapter contract; the extraction-capable
  // workspace and its navigation are covered by extraction-workspace.test.tsx.
  const { extractionQueue: _queue, ...readOnlyApi } = api;
  render(
    <MemoryRouter initialEntries={[path]}>
      <InjectableRouter api={readOnlyApi} />
    </MemoryRouter>
  );
}

it('opens an exact linked knowledge outside the current list and follows its original source in the app', async () => {
  const user = userEvent.setup(); const record = knowledge(); const source = record.sourceMaterials[0]!;
  const api = createApi({
    getKnowledgeDetail: vi.fn(async () => ok({ path: record.path, title: record.title, record, markdown: '精确知识正文', internalKnowledgeLinks: [], versionMarker: { rawSha256: record.rawSha256 } })),
    getDocumentDetail: vi.fn(async () => ok({ path: source, title: '精确原资料', markdown: '完整来源证据', versionMarker: { rawSha256: 'c'.repeat(64) } }))
  });
  renderRoute(`/knowledge?${new URLSearchParams({ path: record.path })}`, api);
  expect(await screen.findByText('精确知识正文')).toBeVisible();
  expect(api.getKnowledgeDetail).toHaveBeenCalledExactlyOnceWith(record.path, expect.any(AbortSignal));
  expect(api.listKnowledge).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('link', { name: '查看原文 · 材料' }));
  expect(await screen.findByText('完整来源证据', { selector: 'p' })).toBeVisible();
  expect(api.getDocumentDetail).toHaveBeenCalledWith(source, expect.any(AbortSignal));
  expect(await screen.findByRole('link', { name: '返回这份资料的提炼工作台' })).toHaveAttribute('href', `/queue?${new URLSearchParams({ view: 'ready', materialPath: source })}`);
  expect(api.openKnowledge).not.toHaveBeenCalled();
});

it('never displays a linked knowledge response for a different exact path', async () => {
  const record = knowledge();
  const api = createApi({ getKnowledgeDetail: vi.fn(async () => ok({ path: '02知识库/其他.md', title: record.title,
    record, markdown: '不能显示的错误知识', internalKnowledgeLinks: [], versionMarker: { rawSha256: record.rawSha256 } })) });
  renderRoute(`/knowledge?${new URLSearchParams({ path: record.path })}`, api);
  expect(await screen.findByText('知识详情与指定路径或版本不一致，请重新读取。')).toBeVisible();
  expect(screen.queryByText('不能显示的错误知识')).not.toBeInTheDocument();
});

it('removes all paginated completed sources from dashboard work while keeping changed originals', async () => {
  const nonce = document.createElement('meta');
  nonce.name = 'csp-nonce'; nonce.content = 'completed-sources-test-nonce';
  document.head.append(nonce);
  const records = ['零候选已完成', '全部放弃已完成', '新版原文', '仍需处理'].map((title) => material({ path: `01图书馆/${title}.md`, title }));
  const summary = (index: number, sha = records[index]!.rawSha256) => ({ materialPath: records[index]!.path, title: records[index]!.title,
    view: 'ready' as const, canExtract: true, reviewComplete: true, pendingCandidateCount: 0, sourceRawSha256: sha,
    latestReadyRun: { id: `done-${index}`, status: 'ready' as const, createdAt: '2026-09-07T00:00:00Z', candidateCount: 0, sourceRawSha256: records[index]!.rawSha256 } });
  const counts = { pending: 1, generating: 0, ready: 3, unfinished: 0 };
  const list = vi.fn(async (query: { view?: string | undefined; cursor?: string | undefined; visibility?: string | undefined; reviewState?: string | undefined }) => ok(query.visibility === 'removed' ? { items: [], counts }
    : query.view === 'pending' ? { items: [{ materialPath: records[3]!.path, title: records[3]!.title, view: 'pending' as const, canExtract: true }], counts }
      : query.view !== 'ready' || query.reviewState !== 'complete' ? { items: [], counts }
        : query.cursor ? { items: [summary(1), summary(2, 'd'.repeat(64))], counts } : { items: [summary(0)], counts, nextCursor: 'completed-next' }));
  const api = createApi({ listMaterials: vi.fn(async () => ok({ items: records })), extractionQueue: { list, get: vi.fn(), history: vi.fn() } });
  render(<MemoryRouter initialEntries={['/']}><AppRouter api={api} /></MemoryRouter>);
  expect(await screen.findByTestId('metric-materials')).toHaveTextContent('2 份');
  expect(screen.getByRole('heading', { name: '待处理资料 2 份' })).toBeVisible();
  const deck = screen.getByRole('region', { name: '待提炼材料牌堆' });
  expect(within(deck).queryByRole('button', { name: /零候选已完成/u })).not.toBeInTheDocument();
  expect(within(deck).queryByRole('button', { name: /全部放弃已完成/u })).not.toBeInTheDocument();
  expect(within(deck).getByRole('button', { name: /新版原文/u })).toBeVisible();
  expect(list).toHaveBeenCalledWith({ view: 'ready', reviewState: 'complete', limit: 200, cursor: 'completed-next' }, expect.any(AbortSignal));
  nonce.remove();
});

it('keeps removed pending and historical sources out of dashboard cards without excluding active changed originals', async () => {
  const nonce = document.createElement('meta'); nonce.name = 'csp-nonce'; nonce.content = 'removed-sources-test-nonce'; document.head.append(nonce);
  const records = ['移出的待提炼', '移出的旧结果', '继续处理'].map((title) => material({ path: `01图书馆/${title}.md`, title }));
  const counts = { pending: 1, ready: 0, unfinished: 1, generating: 0 };
  const list = vi.fn(async (query: { view?: string | undefined; visibility?: string | undefined }) => ok({ counts,
    items: query.visibility !== 'removed' || !['pending', 'unfinished'].includes(query.view ?? '') ? [] : [{
      materialPath: records[query.view === 'pending' ? 0 : 1]!.path, title: '已移出资料', view: query.view === 'pending' ? 'pending' as const : 'unfinished' as const,
      removedAt: '2026-09-07T00:00:00Z', canExtract: false, sourceRawSha256: 'c'.repeat(64)
    }] }));
  const api = createApi({ listMaterials: vi.fn(async () => ok({ items: records })), extractionQueue: { list, get: vi.fn(), history: vi.fn() } });
  render(<MemoryRouter initialEntries={['/']}><AppRouter api={api} /></MemoryRouter>);
  expect(await screen.findByTestId('metric-materials')).toHaveTextContent('1');
  const deck = screen.getByRole('region', { name: '待提炼材料牌堆' });
  expect(within(deck).queryByRole('button', { name: /移出的/u })).not.toBeInTheDocument();
  expect(within(deck).getByRole('button', { name: /继续处理/u })).toBeVisible();
  nonce.remove();
});

type PaginationFocusOutcome = 'next' | 'terminal' | 'failed';

type PaginationFocusHarness = {
  readonly api: ReadConsoleApi;
  readonly focusControlLabel: string;
  readonly path: '/queue' | '/knowledge';
  readonly resultText: string;
  readonly resultsHeading: string;
  readonly settle: () => void;
};

function queuePaginationFocusHarness(outcome: PaginationFocusOutcome): PaginationFocusHarness {
  const pendingPage = deferred<ApiClientResult<MaterialPage>>();
  const listMaterials = vi.fn()
    .mockResolvedValueOnce(ok({
      items: [material({ title: '焦点材料' })],
      nextCursor: 'focus.queue.a'.padEnd(72, 'a')
    }))
    .mockImplementationOnce(() => pendingPage.promise);
  const resultText = outcome === 'failed' ? '读取材料未完成，请稍后重试。' : '延迟材料';
  return {
    api: createApi({ listMaterials }),
    focusControlLabel: '标题',
    path: '/queue',
    resultText,
    resultsHeading: '材料结果',
    settle: () => {
      pendingPage.resolve(outcome === 'failed'
        ? failure<MaterialPage>('operation-error')
        : ok({
            items: [material({ path: '01图书馆/延迟材料.md', title: resultText })],
            ...(outcome === 'next' ? { nextCursor: 'focus.queue.b'.padEnd(72, 'b') } : {})
          }));
    }
  };
}

function knowledgePaginationFocusHarness(outcome: PaginationFocusOutcome): PaginationFocusHarness {
  const pendingPage = deferred<ApiClientResult<KnowledgePage>>();
  const listKnowledge = vi.fn()
    .mockResolvedValueOnce(ok({
      items: [knowledge({ title: '焦点知识' })],
      nextCursor: 'focus.knowledge.a'.padEnd(72, 'a')
    }))
    .mockImplementationOnce(() => pendingPage.promise);
  const resultText = outcome === 'failed' ? '读取知识未完成，请稍后重试。' : '延迟知识';
  return {
    api: createApi({ listKnowledge }),
    focusControlLabel: '标题与 YAML 召回字段',
    path: '/knowledge',
    resultText,
    resultsHeading: '知识结果',
    settle: () => {
      pendingPage.resolve(outcome === 'failed'
        ? failure<KnowledgePage>('operation-error')
        : ok({
            items: [knowledge({ path: '02知识库/延迟知识.md', title: resultText })],
            ...(outcome === 'next' ? { nextCursor: 'focus.knowledge.b'.padEnd(72, 'b') } : {})
          }));
    }
  };
}

const PAGINATION_FOCUS_PAGES = [
  { name: 'queue', createHarness: queuePaginationFocusHarness },
  { name: 'knowledge', createHarness: knowledgePaginationFocusHarness }
] as const;

function simulateNativeDisabledFocusLoss(): void {
  document.body.tabIndex = -1;
  document.body.focus();
}

describe('Phase 1 read pages', () => {
  it('keeps settings details collapsed and loads document issues only when opened', async () => {
    const user = userEvent.setup();
    const listDocumentIssues = vi.fn(async () => ok({ items: [] }));
    renderRoute('/settings', createApi({ listDocumentIssues }));

    expect(await screen.findByText('3 个结构问题')).toBeVisible();
    const issuesToggle = screen.getByRole('button', { name: /^待确认资料/u });
    const diagnosticsToggle = screen.getByRole('button', { name: /^高级诊断/u });
    expect(issuesToggle).toHaveAttribute('aria-expanded', 'false');
    expect(diagnosticsToggle).toHaveAttribute('aria-expanded', 'false');
    expect(listDocumentIssues).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: '待确认资料' })).not.toBeInTheDocument();
    expect(screen.getByText('models.example')).not.toBeVisible();

    await user.click(screen.getByRole('button', { name: '查看待确认资料' }));
    expect(issuesToggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('没有待确认的资料格式')).toBeVisible();
    expect(listDocumentIssues).toHaveBeenCalledExactlyOnceWith({ limit: 50 }, expect.any(AbortSignal));
    expect(diagnosticsToggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows legacy issues in settings and reads their original text without executing HTML or leaving App', async () => {
    const path = '01图书馆/小兆clipper/旧剪藏.md';
    const markdown = '# 原文\n<script>window.bad = true</script>\n![附件](https://example.com/image.png)';
    const api = createApi({
      listDocumentIssues: vi.fn(async () => ok({ items: [{ path, code: 'FRONTMATTER_INVALID' as const, message: 'FRONTMATTER_OPENING_DELIMITER_MISSING' }] })),
      getDocumentDetail: vi.fn(async () => ok({ path, title: '旧剪藏', markdown, versionMarker: { rawSha256: 'a'.repeat(64) } }))
    });
    renderRoute('/settings', api);
    await userEvent.click(await screen.findByRole('button', { name: /^待确认资料/u }));
    await userEvent.click(await screen.findByRole('button', { name: '查看原文：旧剪藏' }));
    const original = await screen.findByTestId('document-original');
    expect(original.textContent).toBe(markdown);
    expect(original.querySelector('script, img')).toBeNull();
    expect(screen.getByText('缺少资料信息，原文仍可查看')).toBeInTheDocument();
    expect(api.openKnowledge).not.toHaveBeenCalled();
  });

  it('lets the user retry failed issue listing and does not leak technical server errors', async () => {
    const listDocumentIssues = vi.fn().mockResolvedValueOnce(failure('disconnected')).mockResolvedValueOnce(ok({ items: [] }));
    renderRoute('/settings', createApi({ listDocumentIssues }));
    await userEvent.click(await screen.findByRole('button', { name: /^待确认资料/u }));
    await userEvent.click(await screen.findByRole('button', { name: '重新读取资料列表' }));
    expect(await screen.findByText('没有待确认的资料格式')).toBeInTheDocument();
    expect(screen.queryByText('SECRET_SERVER_MESSAGE')).not.toBeInTheDocument();
  });

  beforeEach(() => {
    const nonce = document.createElement('meta');
    nonce.name = 'csp-nonce';
    nonce.content = 'read-pages-test-nonce';
    document.head.append(nonce);
    vi.spyOn(browserReadConsoleApi, 'getHealth').mockResolvedValue(ok(readyHealth()));
    vi.spyOn(browserReadConsoleApi, 'listDocumentIssues').mockResolvedValue(ok({ items: [] }));
    vi.spyOn(browserReadConsoleApi, 'listMaterials').mockResolvedValue(ok<MaterialPage>({ items: [] }));
    vi.spyOn(browserReadConsoleApi, 'listKnowledge').mockResolvedValue(ok<KnowledgePage>({ items: [] }));
    vi.spyOn(browserReadConsoleApi, 'listOperations').mockResolvedValue(ok<OperationPage>({ items: [] }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.removeAttribute('tabindex');
    document.head.querySelector('meta[name="csp-nonce"]')?.remove();
  });

  it('publishes dashboard counts only from live read APIs', async () => {
    vi.mocked(browserReadConsoleApi.listMaterials).mockResolvedValue(ok({
      items: [
        {
          path: '01图书馆/待提炼.md', rawSha256: 'a'.repeat(64), title: '待提炼',
          sourcePlatform: '微信', processingStatus: '已归档', knowledgeStatus: '未提炼',
          generatedKnowledge: []
        },
        {
          path: '01图书馆/部分.md', rawSha256: 'b'.repeat(64), title: '部分',
          sourcePlatform: '网页', processingStatus: '已归档', knowledgeStatus: '部分入库',
          generatedKnowledge: ['02知识库/一个.md']
        }
      ]
    }));
    vi.mocked(browserReadConsoleApi.listKnowledge).mockResolvedValue(ok({
      items: [
        {
          path: '02知识库/结论.md', rawSha256: 'c'.repeat(64), title: '结论',
          sourceType: 'AI提炼', usageStatus: '定论', knowledgeType: '方法',
          recallFields: { topics: [], keywords: [], scenarios: [], conclusion: '', keyPoints: [], boundary: '' },
          sourceMaterials: []
        }
      ]
    }));

    renderRoute('/');

    expect(await screen.findByTestId('metric-materials')).toHaveTextContent('1');
    expect(screen.queryByTestId('metric-partial')).not.toBeInTheDocument();
    expect(screen.getByTestId('metric-knowledge')).toHaveTextContent('1');
    const deck = screen.getByRole('region', { name: '待提炼材料牌堆' });
    expect(within(deck).getByRole('button', {
      name: '待提炼，微信，未提炼'
    })).toBeVisible();
    expect(within(deck).queryByRole('button', {
      name: '部分，网页，部分入库'
    })).not.toBeInTheDocument();
    expect(browserReadConsoleApi.listMaterials).toHaveBeenCalledWith(
      { limit: 200 },
      expect.any(AbortSignal)
    );
    expect(browserReadConsoleApi.listKnowledge).toHaveBeenCalledWith(
      { includeObsolete: true, limit: 200 },
      expect.any(AbortSignal)
    );
  });

  it('collects every dashboard cursor page and derives protected upgrade counts', async () => {
    const listMaterials = vi.fn(async (query: MaterialQuery) => ok<MaterialPage>(query.cursor === undefined
      ? { items: [material()], nextCursor: 'next.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
      : { items: [material({ path: '01图书馆/部分.md', knowledgeStatus: '部分入库' })] }));
    const listKnowledge = vi.fn(async (query: KnowledgeQuery) => ok<KnowledgePage>(query.cursor === undefined
      ? {
          items: [
            knowledge({ path: '02知识库/ai.md', usageStatus: 'AI总结', updatedAt: '2026-08-31' }),
            knowledge({ path: '02知识库/定论.md', usageStatus: '定论', updatedAt: '2026-09-01' })
          ],
          nextCursor: 'next.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        }
      : { items: [knowledge({ path: '02知识库/过时.md', usageStatus: '过时' })] }));
    const api = createApi({ listMaterials, listKnowledge });

    renderRoute('/', api);

    expect(await screen.findByTestId('metric-knowledge')).toHaveTextContent('3');
    expect(screen.queryByTestId('metric-upgradeable')).not.toBeInTheDocument();
    expect(listMaterials).toHaveBeenLastCalledWith(
      { cursor: 'next.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', limit: 200 },
      expect.any(AbortSignal)
    );
    expect(listKnowledge).toHaveBeenLastCalledWith(
      {
        cursor: 'next.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        includeObsolete: true,
        limit: 200
      },
      expect.any(AbortSignal)
    );
    expect(screen.queryByRole('list', { name: '最近知识' })).not.toBeInTheDocument();
  });

  it('retries one dashboard index drift and never publishes mixed generations', async () => {
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7))) // shell
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(8)))
      .mockResolvedValueOnce(ok(readyHealth(8)))
      .mockResolvedValueOnce(ok(readyHealth(9)));
    const api = createApi({
      getHealth,
      listMaterials: vi.fn(async () => ok({ items: [material()] })),
      listKnowledge: vi.fn(async () => ok({ items: [knowledge()] }))
    });

    renderRoute('/', api);

    expect(await screen.findByText('索引版本仍在变化，等待稳定快照')).toBeVisible();
    expect(screen.queryByTestId('metric-materials')).not.toBeInTheDocument();
    expect(api.listMaterials).toHaveBeenCalledTimes(2);
    expect(api.listKnowledge).toHaveBeenCalledTimes(2);
  });

  it('discards a conflicted dashboard batch and retries the whole sandwich once', async () => {
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(7)));
    const listMaterials = vi.fn()
      .mockResolvedValueOnce(failure<MaterialPage>('conflict'))
      .mockResolvedValueOnce(ok({ items: [material({ title: '稳定材料' })] }));
    const api = createApi({ getHealth, listMaterials });

    renderRoute('/', api);

    expect(await screen.findByRole('button', { name: /^稳定材料，/u })).toBeVisible();
    expect(listMaterials).toHaveBeenCalledTimes(2);
    expect(api.listKnowledge).toHaveBeenCalledTimes(2);
    expect(api.listOperations).toHaveBeenCalledTimes(2);
    expect(getHealth).toHaveBeenCalledTimes(4);
  });

  it.each(['building', 'failed', 'unavailable'] as const)(
    'does not request dashboard lists while runtime index is %s',
    async (status) => {
      const index = status === 'building'
        ? { status, version: 7, startedAt: '2026-09-01T00:00:00.000Z' } as const
        : status === 'failed'
          ? { status, version: 7, reason: 'INDEX_FAILED' } as const
          : { status, reason: 'READ_API_UNAVAILABLE' } as const;
      const api = createApi({ getHealth: vi.fn(async () => ok({ ...readyHealth(), index })) });

      renderRoute('/', api);

      expect(await screen.findByText(
        status === 'building'
          ? '索引正在构建，完成前不会显示不完整数字'
          : status === 'failed'
            ? '索引失败，当前不显示可能过时的数字'
            : '索引不可用，当前无法读取统计数据'
      )).toBeVisible();
      expect(api.listMaterials).not.toHaveBeenCalled();
      expect(api.listKnowledge).not.toHaveBeenCalled();
      expect(screen.queryByTestId('metric-materials')).not.toBeInTheDocument();
    }
  );

  it.each(['ready', 'stale'] as const)('loads a newly mounted dashboard during a focus refresh with a %s index', async (status) => {
    const pendingRebuild = deferred<ApiClientResult<IndexJob>>();
    const health: HealthSnapshot = status === 'ready' ? readyHealth() : {
      ...readyHealth(),
      index: {
        status: 'stale', version: 7, lastSuccessAt: '2026-09-01T00:00:00.000Z',
        reason: 'INDEX_STALE'
      }
    };
    const api = createApi({
      getHealth: vi.fn(async () => ok(health)),
      listMaterials: vi.fn(async () => ok({ items: [material()] })),
      rebuildIndex: vi.fn(() => pendingRebuild.promise)
    });
    renderRoute('/settings', api);
    await waitFor(() => expect(api.getHealth).toHaveBeenCalledTimes(1));

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(api.rebuildIndex).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('link', { name: '大脑总览' }));

    expect(await screen.findByTestId('metric-materials')).toHaveTextContent('1');
    expect(screen.queryByText('索引不可用，当前无法读取统计数据')).not.toBeInTheDocument();
    expect(api.listMaterials).toHaveBeenCalledTimes(1);
    expect(api.getHealth).toHaveBeenCalledTimes(4);
  });

  it('retries a failed dashboard read after a successful same-version focus refresh', async () => {
    const pendingRebuild = deferred<ApiClientResult<IndexJob>>();
    const api = createApi({
      listMaterials: vi.fn()
        .mockResolvedValueOnce(failure<MaterialPage>('disconnected'))
        .mockResolvedValue(ok({ items: [material()] })),
      rebuildIndex: vi.fn(() => pendingRebuild.promise)
    });
    renderRoute('/', api);
    expect(await within(screen.getByRole('main')).findByText('无法连接本地服务。')).toBeVisible();

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(api.rebuildIndex).toHaveBeenCalledTimes(1));
    expect(api.listMaterials).toHaveBeenCalledTimes(1);
    await act(async () => pendingRebuild.resolve(ok({ ...completedJob(), indexVersion: 7 })));

    expect(await screen.findByTestId('metric-materials')).toHaveTextContent('1');
    expect(api.listMaterials).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole('main')).queryByText('无法连接本地服务。')).not.toBeInTheDocument();
  });

  it('removes previously published dashboard numbers when an authoritative focus snapshot starts building', async () => {
    const pendingRebuild = deferred<ApiClientResult<IndexJob>>();
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok<HealthSnapshot>({
        ...readyHealth(7),
        index: { status: 'building', version: 8, startedAt: '2026-09-01T00:00:02.000Z' }
      }));
    const api = createApi({
      getHealth,
      listMaterials: vi.fn(async () => ok({ items: [material()] })),
      rebuildIndex: vi.fn(() => pendingRebuild.promise)
    });
    renderRoute('/', api);
    expect(await screen.findByTestId('metric-materials')).toHaveTextContent('1');

    act(() => window.dispatchEvent(new Event('focus')));

    expect(await screen.findByText('索引正在构建，完成前不会显示不完整数字')).toBeVisible();
    expect(screen.queryByTestId('metric-materials')).not.toBeInTheDocument();
    expect(api.listMaterials).toHaveBeenCalledTimes(1);
  });

  it('shows the runtime failure while retaining a previously verified dashboard snapshot', async () => {
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(failure<HealthSnapshot>('disconnected'));
    const api = createApi({
      getHealth,
      listMaterials: vi.fn(async () => ok({ items: [material()] }))
    });
    renderRoute('/', api);
    expect(await screen.findByTestId('metric-materials')).toHaveTextContent('1');

    act(() => window.dispatchEvent(new Event('focus')));

    const main = screen.getByRole('main');
    expect(await within(main).findByText('无法连接本地服务。')).toBeVisible();
    expect(within(main).getByTestId('metric-materials')).toHaveTextContent('1');
  });

  it('shows a runtime failure directly when no dashboard snapshot was published', async () => {
    const api = createApi({
      getHealth: vi.fn(async () => failure<HealthSnapshot>('disconnected'))
    });
    renderRoute('/', api);

    const main = screen.getByRole('main');
    expect(await within(main).findByText('无法连接本地服务。')).toBeVisible();
    expect(within(main).queryByTestId('metric-materials')).not.toBeInTheDocument();
    expect(api.listMaterials).not.toHaveBeenCalled();
  });

  it('shows a real queue filter form and loaded-count disclosure', async () => {
    renderRoute('/queue');

    expect(await screen.findByRole('button', { name: '应用筛选' })).toBeEnabled();
    expect(screen.getByText('已加载 0 条')).toBeVisible();
    expect(screen.queryByText(/总计/u)).not.toBeInTheDocument();
  });

  it('applies a trimmed queue query and paginates with the same filters', async () => {
    const user = userEvent.setup();
    const listMaterials = vi.fn()
      .mockResolvedValueOnce(ok({ items: [] }))
      .mockResolvedValueOnce(ok({
        items: [material({ title: '第一条', collectedAt: '2026-08-01' })],
        nextCursor: 'more.cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
      }))
      .mockResolvedValueOnce(ok({ items: [material({ path: '01图书馆/第二条.md', title: '第二条' })] }));
    const api = createApi({ listMaterials });
    renderRoute('/queue', api);
    await waitFor(() => expect(listMaterials).toHaveBeenCalledTimes(1));

    await user.type(screen.getByLabelText('标题'), '  复利  ');
    await user.selectOptions(screen.getByLabelText('状态'), '部分入库');
    await user.type(screen.getByLabelText('来源平台'), '  微信  ');
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-31' } });
    await user.click(screen.getByRole('button', { name: '应用筛选' }));

    await screen.findByText('第一条');
    expect(listMaterials).toHaveBeenLastCalledWith({
      status: '部分入库', sourcePlatform: '微信', collectedFrom: '2026-08-01',
      collectedTo: '2026-08-31', title: '复利', limit: 200
    }, expect.any(AbortSignal));

    await user.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('第二条')).toBeVisible();
    expect(listMaterials).toHaveBeenLastCalledWith({
      status: '部分入库', sourcePlatform: '微信', collectedFrom: '2026-08-01',
      collectedTo: '2026-08-31', title: '复利',
      cursor: 'more.cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', limit: 200
    }, expect.any(AbortSignal));
    expect(screen.getByText('已加载 2 条')).toBeVisible();
    expect(screen.getByRole('heading', { name: '材料结果' })).toHaveFocus();
  });

  it('disables queue pagination while pending or failed and restores it after a ready refresh', async () => {
    const user = userEvent.setup();
    const pendingPage = deferred<ApiClientResult<MaterialPage>>();
    const listMaterials = vi.fn()
      .mockResolvedValueOnce(ok({
        items: [material({ title: '初始材料' })],
        nextCursor: 'queue.a'.padEnd(72, 'a')
      }))
      .mockImplementationOnce(() => pendingPage.promise)
      .mockResolvedValueOnce(ok({
        items: [material({ path: '01图书馆/恢复材料.md', title: '恢复材料' })],
        nextCursor: 'queue.b'.padEnd(72, 'b')
      }));
    const api = createApi({ listMaterials });
    renderRoute('/queue', api);

    const loadMore = await screen.findByRole('button', { name: '加载更多' });
    await user.click(loadMore);

    await waitFor(() => expect(loadMore).toBeDisabled());
    expect(loadMore).toHaveAttribute('aria-busy', 'true');
    expect(loadMore).toHaveTextContent('加载中');

    pendingPage.resolve(failure<MaterialPage>('operation-error'));
    expect(await screen.findByText('读取材料未完成，请稍后重试。')).toBeVisible();
    const failedLoadMore = screen.getByRole('button', { name: '加载更多' });
    expect(failedLoadMore).toBeDisabled();
    expect(failedLoadMore).toHaveAttribute('aria-busy', 'false');

    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(await screen.findByText('恢复材料')).toBeVisible();
    const recoveredLoadMore = screen.getByRole('button', { name: '加载更多' });
    expect(recoveredLoadMore).toBeEnabled();
    expect(recoveredLoadMore).toHaveAttribute('aria-busy', 'false');
  });

  it.each(PAGINATION_FOCUS_PAGES)(
    'restores $name pagination focus to the enabled button after a delayed page still has a cursor',
    async ({ createHarness }) => {
      const user = userEvent.setup();
      const harness = createHarness('next');
      renderRoute(harness.path, harness.api);

      const loadMore = await screen.findByRole('button', { name: '加载更多' });
      await user.click(loadMore);
      await waitFor(() => expect(loadMore).toBeDisabled());
      simulateNativeDisabledFocusLoss();
      expect(document.body).toHaveFocus();

      harness.settle();
      await screen.findByText(harness.resultText);
      expect(screen.getByRole('button', { name: '加载更多' })).toHaveFocus();
    }
  );

  it.each(PAGINATION_FOCUS_PAGES)(
    'moves $name pagination focus to the results heading after a delayed terminal page',
    async ({ createHarness }) => {
      const user = userEvent.setup();
      const harness = createHarness('terminal');
      renderRoute(harness.path, harness.api);

      const loadMore = await screen.findByRole('button', { name: '加载更多' });
      await user.click(loadMore);
      await waitFor(() => expect(loadMore).toBeDisabled());
      simulateNativeDisabledFocusLoss();
      expect(document.body).toHaveFocus();

      harness.settle();
      await screen.findByText(harness.resultText);
      expect(screen.getByRole('heading', { name: harness.resultsHeading })).toHaveFocus();
    }
  );

  it.each(PAGINATION_FOCUS_PAGES)(
    'moves $name pagination focus to the results heading after a delayed failure',
    async ({ createHarness }) => {
      const user = userEvent.setup();
      const harness = createHarness('failed');
      renderRoute(harness.path, harness.api);

      const loadMore = await screen.findByRole('button', { name: '加载更多' });
      await user.click(loadMore);
      await waitFor(() => expect(loadMore).toBeDisabled());
      simulateNativeDisabledFocusLoss();
      expect(document.body).toHaveFocus();

      harness.settle();
      await screen.findByText(harness.resultText);
      expect(screen.getByRole('heading', { name: harness.resultsHeading })).toHaveFocus();
    }
  );

  it.each(PAGINATION_FOCUS_PAGES)(
    'preserves active $name filter focus when delayed pagination settles',
    async ({ createHarness }) => {
      const user = userEvent.setup();
      const harness = createHarness('next');
      renderRoute(harness.path, harness.api);

      const loadMore = await screen.findByRole('button', { name: '加载更多' });
      await user.click(loadMore);
      await waitFor(() => expect(loadMore).toBeDisabled());
      const filter = screen.getByLabelText(harness.focusControlLabel);
      await user.click(filter);
      expect(filter).toHaveFocus();

      harness.settle();
      await screen.findByText(harness.resultText);
      expect(filter).toHaveFocus();
    }
  );

  it('rejects an impossible queue date range locally with zero new requests', async () => {
    const user = userEvent.setup();
    const api = createApi();
    renderRoute('/queue', api);
    await waitFor(() => expect(api.listMaterials).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-09-02' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-09-01' } });
    await user.click(screen.getByRole('button', { name: '应用筛选' }));

    expect(await screen.findByText('开始日期不能晚于结束日期')).toBeVisible();
    expect(api.listMaterials).toHaveBeenCalledTimes(1);
  });

  it('aborts and ignores a late queue generation', async () => {
    const user = userEvent.setup();
    const late = deferred<ApiClientResult<MaterialPage>>();
    let firstSignal: AbortSignal | undefined;
    const listMaterials = vi.fn((query: MaterialQuery, signal?: AbortSignal) => {
      if (query.title === undefined) {
        firstSignal = signal;
        return late.promise;
      }
      return Promise.resolve(ok({ items: [material({ title: '新结果' })] }));
    });
    const api = createApi({ listMaterials });
    renderRoute('/queue', api);

    await waitFor(() => expect(listMaterials).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText('标题'), '新');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(await screen.findByText('新结果')).toBeVisible();
    expect(firstSignal?.aborted).toBe(true);

    late.resolve(ok({ items: [material({ title: '旧结果' })] }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('旧结果')).not.toBeInTheDocument();
  });

  it('does not pre-read knowledge markdown from the list page', async () => {
    const detail = vi.spyOn(browserReadConsoleApi, 'getKnowledgeDetail');
    const catalog = vi.spyOn(browserReadConsoleApi, 'listKnowledgeCatalog').mockResolvedValue(ok({path: '', breadcrumbs: [{path: '', label: '知识书柜'}], folders: [], items: [], total: 0, directTotal: 0, indexVersion: 7}));
    renderRoute('/knowledge');

    await waitFor(() => expect(catalog).toHaveBeenCalled());
    expect(detail).not.toHaveBeenCalled();
    expect(screen.getByRole('searchbox', {name: '搜索知识'})).toBeVisible();
  });

  it('maps knowledge filters precisely and includes obsolete only when explicitly selected', async () => {
    const user = userEvent.setup();
    const api = createApi();
    renderRoute('/knowledge', api);
    await waitFor(() => expect(api.listKnowledge).toHaveBeenCalledTimes(1));
    expect(api.listKnowledge).toHaveBeenLastCalledWith({ limit: 200 }, expect.any(AbortSignal));

    await user.type(screen.getByLabelText('标题与 YAML 召回字段'), '  核心结论  ');
    await user.selectOptions(screen.getByLabelText('使用状态'), '过时');
    await user.type(screen.getByLabelText('知识类型'), '  方法  ');
    await user.type(screen.getByLabelText('领域'), '  增长  ');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));

    await waitFor(() => expect(api.listKnowledge).toHaveBeenCalledTimes(2));
    expect(api.listKnowledge).toHaveBeenLastCalledWith({
      search: '核心结论', usageStatus: '过时', includeObsolete: true,
      knowledgeType: '方法', topic: '增长', limit: 200
    }, expect.any(AbortSignal));
  });

  it('disables knowledge pagination while pending or failed and restores it after a ready refresh', async () => {
    const user = userEvent.setup();
    const pendingPage = deferred<ApiClientResult<KnowledgePage>>();
    const listKnowledge = vi.fn()
      .mockResolvedValueOnce(ok({
        items: [knowledge({ title: '初始知识' })],
        nextCursor: 'knowledge.a'.padEnd(72, 'a')
      }))
      .mockImplementationOnce(() => pendingPage.promise)
      .mockResolvedValueOnce(ok({
        items: [knowledge({ path: '02知识库/恢复知识.md', title: '恢复知识' })],
        nextCursor: 'knowledge.b'.padEnd(72, 'b')
      }));
    const api = createApi({ listKnowledge });
    renderRoute('/knowledge', api);

    const loadMore = await screen.findByRole('button', { name: '加载更多' });
    await user.click(loadMore);

    await waitFor(() => expect(loadMore).toBeDisabled());
    expect(loadMore).toHaveAttribute('aria-busy', 'true');
    expect(loadMore).toHaveTextContent('加载中');

    pendingPage.resolve(failure<KnowledgePage>('operation-error'));
    expect(await screen.findByText('读取知识未完成，请稍后重试。')).toBeVisible();
    const failedLoadMore = screen.getByRole('button', { name: '加载更多' });
    expect(failedLoadMore).toBeDisabled();
    expect(failedLoadMore).toHaveAttribute('aria-busy', 'false');

    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(await screen.findByText('恢复知识')).toBeVisible();
    const recoveredLoadMore = screen.getByRole('button', { name: '加载更多' });
    expect(recoveredLoadMore).toBeEnabled();
    expect(recoveredLoadMore).toHaveAttribute('aria-busy', 'false');
  });

  it('loads one validated knowledge detail per version, restores focus, and opens through the API', async () => {
    const user = userEvent.setup();
    const record = knowledge({ title: '复利知识', rawSha256: 'd'.repeat(64), upstreamVersion: 'v2' });
    const detail: LiveKnowledgeDetail = {
      path: record.path,
      title: record.title,
      markdown: '# 正文\n[安全链接](https://example.com)',
      internalKnowledgeLinks: [{ path: '02知识库/相关.md', title: '相关知识' }],
      versionMarker: { rawSha256: record.rawSha256, upstreamVersion: record.upstreamVersion }
    };
    const api = createApi({
      listKnowledge: vi.fn(async () => ok({ items: [record] })),
      getKnowledgeDetail: vi.fn(async () => ok(detail))
    });
    renderRoute('/knowledge', api);

    const trigger = await screen.findByRole('button', { name: /复利知识/u });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '复利知识 详情' });
    expect(dialog).toHaveAttribute('aria-modal', 'false');
    expect(within(dialog).getByText('正文')).toBeVisible();
    expect(within(dialog).getByText('01图书馆/来自微信/材料.md')).toBeVisible();
    expect(within(dialog).getByText('相关知识')).toBeVisible();
    expect(api.getKnowledgeDetail).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole('button', { name: '在 Obsidian 中打开' }));
    expect(api.openKnowledge).toHaveBeenCalledWith(record.path);
    expect(await within(dialog).findByText('已在 Obsidian 中打开')).toBeVisible();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    expect(await screen.findByRole('dialog', { name: '复利知识 详情' })).toBeVisible();
    expect(api.getKnowledgeDetail).toHaveBeenCalledTimes(1);
  });

  it('renders only the Markdown body when a live knowledge file includes YAML frontmatter', async () => {
    const user = userEvent.setup();
    const record = knowledge({ title: '整文件知识' });
    const api = createApi({
      listKnowledge: vi.fn(async () => ok({ items: [record] })),
      getKnowledgeDetail: vi.fn(async () => ok({
        path: record.path,
        title: record.title,
        markdown: [
          '---',
          'title: 不应重复出现的 YAML 标题',
          '类型: 知识笔记',
          '---',
          '# 核心结论详情',
          '',
          '这是安全正文。'
        ].join('\n'),
        internalKnowledgeLinks: [],
        versionMarker: { rawSha256: record.rawSha256 }
      }))
    });
    renderRoute('/knowledge', api);

    await user.click(await screen.findByRole('button', { name: /查看 整文件知识 详情/u }));
    const dialog = await screen.findByRole('dialog', { name: '整文件知识 详情' });
    expect(within(dialog).getByRole('heading', { name: '核心结论详情' })).toBeVisible();
    expect(within(dialog).getByText('这是安全正文。')).toBeVisible();
    expect(within(dialog).queryByText(/不应重复出现的 YAML 标题/u)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/类型: 知识笔记/u)).not.toBeInTheDocument();
  });

  it('shares an in-flight knowledge detail and rejects mismatched or unsafe content', async () => {
    const user = userEvent.setup();
    const record = knowledge({ title: '安全知识', rawSha256: 'e'.repeat(64) });
    const pending = deferred<ApiClientResult<LiveKnowledgeDetail>>();
    const api = createApi({
      listKnowledge: vi.fn(async () => ok({ items: [record] })),
      getKnowledgeDetail: vi.fn(() => pending.promise)
    });
    renderRoute('/knowledge', api);

    const trigger = await screen.findByRole('button', { name: /安全知识/u });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    await user.click(trigger);
    expect(api.getKnowledgeDetail).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: '安全知识 详情' })).toBeVisible();

    pending.resolve(ok({
      path: record.path,
      title: record.title,
      markdown: '<script>window.pwned=true</script> [恶意](javascript:alert(1)) ![远程](https://evil.example/a.png)',
      internalKnowledgeLinks: [],
      versionMarker: { rawSha256: 'f'.repeat(64) }
    }));

    expect(await screen.findByText('知识版本与列表不一致，请刷新后重试')).toBeVisible();
    expect(screen.queryByText('window.pwned=true')).not.toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('never carries A detail into B dialog and refocuses the changed detail heading', async () => {
    const user = userEvent.setup();
    const recordA = knowledge({ path: '02知识库/A.md', title: '知识 A', rawSha256: '1'.repeat(64) });
    const recordB = knowledge({ path: '02知识库/B.md', title: '知识 B', rawSha256: '2'.repeat(64) });
    const pendingB = deferred<ApiClientResult<LiveKnowledgeDetail>>();
    const api = createApi({
      listKnowledge: vi.fn(async () => ok({ items: [recordA, recordB] })),
      getKnowledgeDetail: vi.fn((path) => path === recordA.path
        ? Promise.resolve(ok({
            path: recordA.path, title: recordA.title, markdown: 'A 独有正文', internalKnowledgeLinks: [],
            versionMarker: { rawSha256: recordA.rawSha256 }
          }))
        : pendingB.promise)
    });
    renderRoute('/knowledge', api);

    await user.click(await screen.findByRole('button', { name: /查看 知识 A 详情/u }));
    expect(await screen.findByText('A 独有正文')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /查看 知识 B 详情/u }));

    const dialog = await screen.findByRole('dialog', { name: '知识 B 详情' });
    expect(within(dialog).queryByText('A 独有正文')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: '知识 B' })).toHaveFocus();
  });

  it('clears the knowledge detail cache when dataRevision publishes a new record version', async () => {
    const user = userEvent.setup();
    const recordV1 = knowledge({ title: '版本知识', rawSha256: '3'.repeat(64), upstreamVersion: 'v1' });
    const recordV2 = knowledge({ title: '版本知识', rawSha256: '4'.repeat(64), upstreamVersion: 'v2' });
    const listKnowledge = vi.fn()
      .mockResolvedValueOnce(ok({ items: [recordV1] }))
      .mockResolvedValueOnce(ok({ items: [recordV2] }));
    const getKnowledgeDetail = vi.fn()
      .mockResolvedValueOnce(ok({
        path: recordV1.path, title: recordV1.title, markdown: '旧版正文', internalKnowledgeLinks: [],
        versionMarker: { rawSha256: recordV1.rawSha256, upstreamVersion: 'v1' }
      }))
      .mockResolvedValueOnce(ok({
        path: recordV2.path, title: recordV2.title, markdown: '新版正文', internalKnowledgeLinks: [],
        versionMarker: { rawSha256: recordV2.rawSha256, upstreamVersion: 'v2' }
      }));
    const api = createApi({
      listKnowledge,
      getKnowledgeDetail,
      getHealth: vi.fn()
        .mockResolvedValueOnce(ok(readyHealth(7)))
        .mockResolvedValueOnce(ok(readyHealth(7)))
        .mockResolvedValue(ok(readyHealth(8)))
    });
    renderRoute('/knowledge', api);

    await user.click(await screen.findByRole('button', { name: /查看 版本知识 详情/u }));
    expect(await screen.findByText('旧版正文')).toBeVisible();
    await user.keyboard('{Escape}');

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: /查看 版本知识 详情/u }));

    expect(await screen.findByText('新版正文')).toBeVisible();
    expect(screen.queryByText('旧版正文')).not.toBeInTheDocument();
    expect(getKnowledgeDetail).toHaveBeenCalledTimes(2);
  });

  it('renders the honest empty operations ledger from the API', async () => {
    renderRoute('/operations');

    expect(await screen.findByText('还没有操作记录')).toBeVisible();
    expect(browserReadConsoleApi.listOperations).toHaveBeenCalledWith(expect.any(AbortSignal), { view: 'all' });
  });
  it('keeps the overview usable when operation history has another page', async () => {
    renderRoute('/', createApi({ listOperations: vi.fn(async () => ok({ items: [], nextCursor: '50', counts: { all: 51, attention: 0, running: 0 }, issues: [] })) }));
    expect(await screen.findByRole('link', { name: '操作记录' })).toBeVisible();
    expect(screen.queryByText('总览操作响应包含意外游标。')).not.toBeInTheDocument();
  });

  it('supports the operation ledger pagination contract', async () => {
    const api = createApi({
      listOperations: vi.fn(async () => ok({
        items: [], nextCursor: '50'
      }))
    });
    renderRoute('/operations', api);

    expect(await screen.findByRole('button', { name: '加载更多记录' })).toBeVisible();
    expect(screen.queryByText('SECRET_SERVER_MESSAGE')).not.toBeInTheDocument();
  });

  it('offers app-only folder selection and explains when model configuration is unavailable', async () => {
    renderRoute('/settings', createApi());
    expect(await screen.findByRole('button', { name: '更换大脑文件夹' })).toBeDisabled();
    expect(screen.getByText('请在桌面 App 中更换大脑文件夹')).toBeVisible();
    expect(screen.getByText('请打开最新版桌面 App 配置模型。')).toBeVisible();
  });

  it('opens archived pending material from the queue into local extraction preparation without sending it', async () => {
    const source = material({ processingStatus: '已归档' });
    const extraction = { list: vi.fn(async () => ok({ items: [] })), preview: vi.fn(), start: vi.fn(), get: vi.fn(), cancel: vi.fn() };
    const api = createApi({ extraction, listMaterials: vi.fn(async () => ok({ items: [source] })) });
    renderRoute('/queue', api);
    expect(await screen.findByRole('link', { name: '提炼 材料标题' })).toHaveAttribute('href', `/extractions/new?materialPath=${encodeURIComponent(source.path)}`);
    expect(extraction.start).not.toHaveBeenCalled();
  });

  it.each(['已归档', '未归档'] as const)('keeps %s cards visible but only enables archived extraction', async (processingStatus) => {
    const source = material({ processingStatus });
    const extraction = { list: vi.fn(async () => ok({ items: [] })), preview: vi.fn(), start: vi.fn(), get: vi.fn(), cancel: vi.fn() };
    renderRoute('/', createApi({ extraction, listMaterials: vi.fn(async () => ok({ items: [source] })) }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '材料标题，微信，未提炼' }));
    const action = screen.getByRole('button', { name: '开始提炼' });
    if (processingStatus === '已归档') expect(action).toBeEnabled();
    else {
      expect(action).toBeDisabled();
      expect(screen.getByText('请先到收件箱归档这份资料，再开始提炼。')).toBeVisible();
      await user.click(action);
    }
    expect(extraction.preview).not.toHaveBeenCalled();
    expect(extraction.start).not.toHaveBeenCalled();
  });

  it('keeps persisted extraction records discoverable even if the material is no longer in the queue', async () => {
    const run = { id: 'e52917bc-a9df-482f-aae8-8c4b6da4301d', materialPath: material().path, title: '已经移走的原文', readingState: '未看' as const,
      sourceRawSha256: 'a'.repeat(64), ruleFingerprint: 'b'.repeat(64), model: 'deepseek-v4-flash' as const, createdAt: '2026-09-06T00:00:00.000Z', status: 'cancelled' as const };
    const extraction = { list: vi.fn(async () => ok({ items: [run] })), preview: vi.fn(), start: vi.fn(), get: vi.fn(), cancel: vi.fn() };
    renderRoute('/queue', createApi({ extraction }));
    expect(await screen.findByRole('link', { name: /已经移走的原文/u })).toHaveAttribute('href', `/extractions/${run.id}`);
    expect(extraction.list).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    expect(extraction.start).not.toHaveBeenCalled();
  });

  it('labels the extraction workspace as candidate-only rather than claiming it writes knowledge', async () => {
    renderRoute('/extractions/new', createApi());
    expect(await screen.findByLabelText('当前模式：候选不入库')).toBeVisible();
  });

  it('handles pending, cancelled, failed, and successful desktop folder selection', async () => {
    const user = userEvent.setup();
    const pending = deferred<{ selected: boolean; displayName?: string }>();
    const chooseVaultDirectory = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockRejectedValueOnce(new Error('/private/SECRET_FOLDER'))
      .mockResolvedValueOnce({ selected: true, displayName: '新大脑' });
    vi.stubGlobal('xiaozhaoDesktop', {
      getAppVersion: vi.fn(async () => '0.1.0'),
      chooseVaultDirectory
    });
    renderRoute('/settings');
    await user.click(await screen.findByRole('button', { name: '更换大脑文件夹' }));
    expect(screen.getByRole('button', { name: '正在选择…' })).toBeDisabled();
    await act(async () => pending.resolve({ selected: false }));
    expect(screen.getByText('已取消，继续使用当前大脑文件夹')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '更换大脑文件夹' }));
    expect(screen.getByText('未能更换大脑文件夹，请重试')).toBeVisible();
    expect(document.body).not.toHaveTextContent('SECRET_FOLDER');
    await user.click(screen.getByRole('button', { name: '更换大脑文件夹' }));
    expect(screen.getByText('已选择「新大脑」，正在重新打开应用')).toBeVisible();
    expect(chooseVaultDirectory).toHaveBeenCalledTimes(3);
  });

  it('retries a failed health read from settings without navigating away', async () => {
    const user = userEvent.setup();
    const getHealth = vi.fn()
      .mockResolvedValueOnce(failure<HealthSnapshot>('disconnected'))
      .mockResolvedValueOnce(ok(readyHealth()));
    renderRoute('/settings', createApi({ getHealth }));
    await user.click(await screen.findByRole('button', { name: '重新连接' }));
    expect(await screen.findByText('3 个结构问题')).toBeVisible();
    expect(screen.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
    expect(getHealth).toHaveBeenCalledTimes(2);
  });

  it('renders connection diagnostics from the runtime snapshot without extra reads', async () => {
    renderRoute('/connections');
    await userEvent.click(await screen.findByRole('button', { name: /^高级诊断/u }));

    expect(await screen.findByText('models.example')).toBeVisible();
    expect(screen.getByText('deepseek-v3')).toBeVisible();
    expect(screen.getByText('3 个结构问题')).toBeVisible();
    expect(screen.getByText(/此项仅诊断旧版通用接口；个人 App 的确认归档和候选入库使用独立入口/u)).toBeVisible();
    expect(browserReadConsoleApi.listMaterials).not.toHaveBeenCalled();
    expect(browserReadConsoleApi.listKnowledge).not.toHaveBeenCalled();
    expect(browserReadConsoleApi.listOperations).not.toHaveBeenCalled();
  });

  it('covers unavailable diagnostics, translates known blockers, and redacts unknown blockers', async () => {
    const api = createApi({
      getHealth: vi.fn(async () => ok<HealthSnapshot>({
        ...readyHealth(),
        vaultSource: { status: 'unavailable', reason: 'VAULT_UNAVAILABLE' },
        index: { status: 'unavailable', reason: 'READ_API_UNAVAILABLE' },
        model: { status: 'unavailable', reason: 'CONFIG_UNAVAILABLE' },
        writeGate: {
          status: 'blocked',
          missing: ['writeEnabled', 'profile', 'TOP_SECRET_INTERNAL_CAPABILITY'],
          fingerprintMatches: false
        },
        schemaIssues: { status: 'unavailable', count: 0, reason: 'INDEX_UNAVAILABLE' }
      }))
    });
    renderRoute('/connections', api);
    await userEvent.click(await screen.findByRole('button', { name: /^高级诊断/u }));

    expect(await screen.findByText('大脑文件夹不可用')).toBeVisible();
    expect(screen.getByText('未配置写入开关')).toBeVisible();
    expect(screen.getByText('缺少契约画像')).toBeVisible();
    expect(screen.getByText('其他阻断项 1 项')).toBeVisible();
    expect(screen.queryByText('TOP_SECRET_INTERNAL_CAPABILITY')).not.toBeInTheDocument();
    expect(screen.getByTestId('schema-issue-count')).toHaveTextContent('—');
  });

  it('recognizes every declared write-gate blocker without counting it as unknown', async () => {
    const api = createApi({
      getHealth: vi.fn(async () => ok<HealthSnapshot>({
        ...readyHealth(),
        writeGate: {
          status: 'blocked',
          missing: [
            'profile', 'writeEnabled', 'database', 'recovery', 'safeRead', 'safeCreate',
            'safeReplace', 'safeRestore', 'safeDelete', 'rereadVerified',
            'externalMutationObservation', 'restartPersistence'
          ],
          fingerprintMatches: true
        }
      }))
    });
    renderRoute('/connections', api);
    await userEvent.click(await screen.findByRole('button', { name: /^高级诊断/u }));

    expect(await screen.findByText('安全读取能力未验证')).toBeVisible();
    expect(screen.getByText('安全恢复能力未验证')).toBeVisible();
    expect(screen.getByText('回读验证能力未验证')).toBeVisible();
    expect(screen.getByText('外部变更观测能力未验证')).toBeVisible();
    expect(screen.queryByText(/其他阻断项/u)).not.toBeInTheDocument();
  });

  it('explains why direct filesystem mode still blocks formal writing', async () => {
    const api = createApi({ getHealth: vi.fn(async () => ok<HealthSnapshot>({
      ...readyHealth(),
      writeGate: {
        status: 'blocked',
        missing: ['ruleApproval', 'nativeWritePrimitives', 'capabilityProfile', 'recoveryKernel'],
        fingerprintMatches: false,
        reasonCode: 'RULE_BUNDLE_UNAPPROVED'
      }
    })) });
    renderRoute('/settings', api);
    await userEvent.click(await screen.findByRole('button', { name: /^高级诊断/u }));
    expect(await screen.findByText('通用写入接口尚未启用')).toBeVisible();
    expect(screen.getByText('通用接口恢复模块尚未启用')).toBeVisible();
    expect(screen.getByText('当前规则未批准旧通用接口写入')).toBeVisible();
    expect(screen.queryByText(/其他阻断项/u)).not.toBeInTheDocument();
    expect(screen.getByText(/此项仅诊断旧版通用接口；个人 App 的确认归档和候选入库使用独立入口/u)).toBeVisible();
  });

  it('reports an enabled write gate truthfully while keeping the Phase 1 interface read-only', async () => {
    const api = createApi({
      getHealth: vi.fn(async () => ok<HealthSnapshot>({
        ...readyHealth(),
        writeGate: { status: 'enabled', missing: [], fingerprintMatches: true }
      }))
    });
    renderRoute('/connections', api);
    await userEvent.click(await screen.findByRole('button', { name: /^高级诊断/u }));

    expect(await screen.findByText('写入门已通过')).toBeVisible();
    expect(screen.getByText(/此项仅诊断旧版通用接口；个人 App 的确认归档和候选入库使用独立入口/u)).toBeVisible();
    expect(screen.queryByText('能力已验证但未启用')).not.toBeInTheDocument();
  });

  it('keeps stale connection cards visible with a stable failed-state message', async () => {
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth()))
      .mockResolvedValueOnce(failure<HealthSnapshot>('disconnected'));
    const api = createApi({ getHealth });
    renderRoute('/connections', api);
    await userEvent.click(await screen.findByRole('button', { name: /^高级诊断/u }));
    expect(await screen.findByText('models.example')).toBeVisible();

    act(() => window.dispatchEvent(new Event('focus')));

    expect(await screen.findByText('无法连接本地服务。')).toBeVisible();
    expect(screen.getByText('models.example')).toBeVisible();
    expect(screen.queryByText('SECRET_SERVER_MESSAGE')).not.toBeInTheDocument();
  });
});
