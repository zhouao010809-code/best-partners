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
  type MaterialQuery,
  type MaterialPage,
  type OperationPage,
  type ReadConsoleApi
} from '../../src/client/api/client.js';
import { AppRouter } from '../../src/client/app/router.js';
import type { KnowledgeRecord, MaterialRecord } from '../../src/shared/domain/records.js';

function ok<T>(value: T): ApiClientResult<T> {
  return { ok: true, value };
}

function readyHealth(version = 7): HealthSnapshot {
  return {
    status: 'ready',
    plugin: {
      status: 'connected',
      pluginId: 'local-rest-api',
      pluginVersion: '5.1.0',
      obsidianVersion: '1.9.12'
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
    listMaterials: vi.fn(async () => ok({ items: [] })),
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
  render(
    <MemoryRouter initialEntries={[path]}>
      <InjectableRouter api={api} />
    </MemoryRouter>
  );
}

describe('Phase 1 read pages', () => {
  beforeEach(() => {
    const nonce = document.createElement('meta');
    nonce.name = 'csp-nonce';
    nonce.content = 'read-pages-test-nonce';
    document.head.append(nonce);
    vi.spyOn(browserReadConsoleApi, 'getHealth').mockResolvedValue(ok(readyHealth()));
    vi.spyOn(browserReadConsoleApi, 'listMaterials').mockResolvedValue(ok<MaterialPage>({ items: [] }));
    vi.spyOn(browserReadConsoleApi, 'listKnowledge').mockResolvedValue(ok<KnowledgePage>({ items: [] }));
    vi.spyOn(browserReadConsoleApi, 'listOperations').mockResolvedValue(ok<OperationPage>({ items: [] }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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

    expect(await screen.findByTestId('metric-pending')).toHaveTextContent('1');
    expect(screen.getByTestId('metric-partial')).toHaveTextContent('1');
    expect(screen.getByTestId('metric-knowledge')).toHaveTextContent('1');
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
    expect(screen.getByTestId('metric-upgradeable')).toHaveTextContent('1');
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
    const recent = screen.getByRole('list', { name: '最近知识' });
    expect(within(recent).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('定论'),
      expect.stringContaining('ai'),
      expect.stringContaining('过时')
    ]);
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
    expect(screen.queryByTestId('metric-pending')).not.toBeInTheDocument();
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

    expect(await screen.findByText('稳定材料')).toBeVisible();
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
      expect(screen.queryByTestId('metric-pending')).not.toBeInTheDocument();
    }
  );

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
    expect(await screen.findByTestId('metric-pending')).toHaveTextContent('1');

    act(() => window.dispatchEvent(new Event('focus')));

    expect(await screen.findByText('索引正在构建，完成前不会显示不完整数字')).toBeVisible();
    expect(screen.queryByTestId('metric-pending')).not.toBeInTheDocument();
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
    expect(await screen.findByTestId('metric-pending')).toHaveTextContent('1');

    act(() => window.dispatchEvent(new Event('focus')));

    const main = screen.getByRole('main');
    expect(await within(main).findByText('无法连接本地服务。')).toBeVisible();
    expect(within(main).getByTestId('metric-pending')).toHaveTextContent('1');
  });

  it('shows a runtime failure directly when no dashboard snapshot was published', async () => {
    const api = createApi({
      getHealth: vi.fn(async () => failure<HealthSnapshot>('disconnected'))
    });
    renderRoute('/', api);

    const main = screen.getByRole('main');
    expect(await within(main).findByText('无法连接本地服务。')).toBeVisible();
    expect(within(main).queryByTestId('metric-pending')).not.toBeInTheDocument();
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
    renderRoute('/knowledge');

    await waitFor(() => expect(browserReadConsoleApi.listKnowledge).toHaveBeenCalled());
    expect(detail).not.toHaveBeenCalled();
    expect(screen.getByText('仅搜索标题与 YAML 召回字段')).toBeVisible();
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
    const api = createApi({ listKnowledge, getKnowledgeDetail });
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

    expect(await screen.findByText('当前尚无提炼/写入工作流操作')).toBeVisible();
    expect(browserReadConsoleApi.listOperations).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('fails closed when operations unexpectedly advertise another cursor', async () => {
    const api = createApi({
      listOperations: vi.fn(async () => ok({
        items: [], nextCursor: 'bad.dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
      }))
    });
    renderRoute('/operations', api);

    expect(await screen.findByText('操作记录响应不符合只读契约')).toBeVisible();
    expect(screen.queryByText('SECRET_SERVER_MESSAGE')).not.toBeInTheDocument();
  });

  it('renders connection diagnostics from the runtime snapshot without extra reads', async () => {
    renderRoute('/connections');

    expect(await screen.findByText('models.example')).toBeVisible();
    expect(screen.getByText('deepseek-v3')).toBeVisible();
    expect(screen.getByText('3 个结构问题')).toBeVisible();
    expect(screen.getByText('Phase 1 始终只读')).toBeVisible();
    expect(browserReadConsoleApi.listMaterials).not.toHaveBeenCalled();
    expect(browserReadConsoleApi.listKnowledge).not.toHaveBeenCalled();
    expect(browserReadConsoleApi.listOperations).not.toHaveBeenCalled();
  });

  it('covers unavailable diagnostics, translates known blockers, and redacts unknown blockers', async () => {
    const api = createApi({
      getHealth: vi.fn(async () => ok<HealthSnapshot>({
        ...readyHealth(),
        plugin: { status: 'unavailable', reason: 'PLUGIN_UNAVAILABLE' },
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

    expect(await screen.findByText('插件不可用')).toBeVisible();
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

    expect(await screen.findByText('安全读取能力未验证')).toBeVisible();
    expect(screen.getByText('安全恢复能力未验证')).toBeVisible();
    expect(screen.getByText('回读验证能力未验证')).toBeVisible();
    expect(screen.getByText('外部变更观测能力未验证')).toBeVisible();
    expect(screen.queryByText(/其他阻断项/u)).not.toBeInTheDocument();
  });

  it('keeps stale connection cards visible with a stable failed-state message', async () => {
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth()))
      .mockResolvedValueOnce(failure<HealthSnapshot>('disconnected'));
    const api = createApi({ getHealth });
    renderRoute('/connections', api);
    expect(await screen.findByText('models.example')).toBeVisible();

    act(() => window.dispatchEvent(new Event('focus')));

    expect(await screen.findByText('无法连接本地服务。')).toBeVisible();
    expect(screen.getByText('models.example')).toBeVisible();
    expect(screen.queryByText('SECRET_SERVER_MESSAGE')).not.toBeInTheDocument();
  });
});
