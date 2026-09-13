// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import App from '../../src/client/App.js';
import type {
  ApiClientResult,
  HealthSnapshot,
  IndexJob,
  LiveKnowledgeDetail,
  ReadConsoleApi
} from '../../src/client/api/client.js';
import { AppShell } from '../../src/client/app/AppShell.js';
import { AppRouter } from '../../src/client/app/router.js';
import { useConsoleRuntime } from '../../src/client/app/ConsoleRuntime.js';
import { PageState } from '../../src/client/components/PageState.js';
import { ASSISTANT_INTENT_EVENT } from '../../src/client/components/assistant/assistantIntent.js';

const MAIN_NAVIGATION_NAMES = [
  '大脑总览',
  '收件箱',
  '提炼队列',
  '档案库',
  '知识库',
  'Skill 库',
  '操作与恢复',
  '设置'
] as const;

function setPath(path: string): void {
  window.history.replaceState(null, '', path);
}

function ok<T>(value: T): ApiClientResult<T> {
  return { ok: true, value };
}

function failure<T>(
  status: 'disconnected' | 'validation-error' | 'operation-error' | 'busy' | 'conflict' | 'recovery-required',
  message: string
): ApiClientResult<T> {
  return { ok: false, state: { status, message } };
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
    model: { status: 'configured', providerHost: 'api.example.com', name: 'model-v1' },
    writeGate: { status: 'blocked', missing: ['WRITE_ENABLED'], fingerprintMatches: true },
    schemaIssues: { status: 'available', count: 3 }
  };
}

function completedJob(version = 8): IndexJob {
  return {
    id: 'job-1',
    operationId: 'operation-1',
    status: 'completed',
    requestedIndexVersion: 7,
    indexVersion: version,
    progress: { completed: 3, total: 3 },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:01.000Z'
  };
}

function createApi(overrides: Partial<ReadConsoleApi> = {}): ReadConsoleApi {
  return {
    getHealth: vi.fn(async () => ok(readyHealth())),
    listDocumentIssues: vi.fn(async () => ok({ items: [] })),
    getDocumentDetail: vi.fn(async () => ({ ok: false as const, state: { status: 'operation-error' as const, message: 'Unavailable' } })),
    listMaterials: vi.fn(async () => ok({ items: [] })),
    listLibrary: vi.fn(async () => ok({ mode: 'topic' as const, path: '', breadcrumbs: [{ path: '', label: '全部资料' }], folders: [], items: [], total: 0, directTotal: 0, unclassifiedCount: 0, indexVersion: 7 })),
    listKnowledge: vi.fn(async () => ok({ items: [] })),
    getKnowledgeDetail: vi.fn(async () => failure<LiveKnowledgeDetail>('operation-error', 'not used')),
    listOperations: vi.fn(async () => ok({ items: [] })),
    openKnowledge: vi.fn(async (path) => ok({ opened: true as const, path })),
    rebuildIndex: vi.fn(async () => ok(completedJob())),
    getIndexJob: vi.fn(async () => ok(completedJob())),
    ...overrides
  };
}

function RuntimeProbe() {
  const runtime = useConsoleRuntime();
  return (
    <>
      <button type="button" onClick={() => void runtime.refreshHealth()}>刷新运行时健康状态</button>
      <output aria-label="运行时快照">
        <span>{runtime.health.status}</span>
        <span data-testid="revision">{runtime.dataRevision}</span>
      </output>
    </>
  );
}

function renderShell(api: ReadConsoleApi) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<AppShell api={api} />}>
          <Route index element={<RuntimeProbe />} />
          <Route path="queue" element={<p>队列内容</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('asking about selected source prose', () => {
  const materialPath = '01图书馆/来自个人/原始资料.md';
  const knowledgePath = '02知识库/阅读知识.md';
  function mountSelectionPage(route: string) {
    const api = createApi();
    render(<MemoryRouter initialEntries={[route]}><Routes><Route element={<AppShell api={api} />}><Route path="*" element={<>
      <div className="library-original__reading"><div className="safe-markdown"><p data-testid="library-source">档案原文证据</p></div></div>
      <div className="library-original__source"><pre data-testid="library-raw">原始文件元信息</pre></div>
      <div className="knowledge-detail__body"><section aria-label="知识正文"><div className="safe-markdown"><p data-testid="knowledge-source">知识正文证据</p></div></section><section aria-label="来源材料"><div className="safe-markdown"><p data-testid="knowledge-provenance">关联资料信息</p></div></section></div>
      <section className="queue-original"><div className="safe-markdown"><p data-testid="queue-source">队列原文证据</p></div></section>
      <article className="ingestion-candidate"><div className="safe-markdown"><p data-testid="candidate">尚未提交的候选判断</p></div></article>
    </>} /></Route></Routes></MemoryRouter>);
    return api;
  }
  function selectText(start: string, end = start) {
    act(() => {
      const first = screen.getByTestId(start).firstChild!;
      const last = screen.getByTestId(end).firstChild!;
      const range = document.createRange(); range.setStart(first, 0); range.setEnd(last, last.textContent!.length);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
  }
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });
  afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); });

  it.each([
    ['/library', 'path', materialPath, 'library-source', '档案原文证据'],
    ['/knowledge', 'path', knowledgePath, 'knowledge-source', '知识正文证据'],
    ['/queue', 'materialPath', materialPath, 'queue-source', '队列原文证据']
  ])('prepares a source-bound draft from the original reading area on %s', async (route, key, path, target, passage) => {
    const listener = vi.fn(); window.addEventListener(ASSISTANT_INTENT_EVENT, listener);
    try {
      const api = mountSelectionPage(`${route}?${new URLSearchParams({ [key]: path })}`);
      await screen.findByTitle('索引 v7 已就绪');
      selectText(target);
      await userEvent.click(screen.getByRole('button', { name: '问问这段内容' }));
      expect(listener).toHaveBeenCalledOnce();
      expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({
        prompt: `请解释这段原文，并结合上下文说明：\n\n“${passage}”`, contextPath: path
      });
      expect(screen.queryByRole('button', { name: '问问这段内容' })).toBeNull();
      expect(api.getDocumentDetail).not.toHaveBeenCalled(); expect(api.getKnowledgeDetail).not.toHaveBeenCalled();
    } finally { window.removeEventListener(ASSISTANT_INTENT_EVENT, listener); }
  });

  it.each([
    [`/library?${new URLSearchParams({ path: materialPath })}`, 'candidate'],
    [`/knowledge?${new URLSearchParams({ path: knowledgePath })}`, 'candidate'],
    [`/queue?${new URLSearchParams({ materialPath })}`, 'candidate'],
    [`/library?${new URLSearchParams({ path: materialPath })}`, 'library-raw'],
    [`/knowledge?${new URLSearchParams({ path: knowledgePath })}`, 'knowledge-provenance']
  ])('does not attribute %s selection in %s to the current source', async (route, target) => {
    mountSelectionPage(route); await screen.findByTitle('索引 v7 已就绪');
    selectText(target);
    expect(screen.queryByRole('button', { name: '问问这段内容' })).toBeNull();
  });

  it('clears the source action when a selection crosses from original prose into a candidate', async () => {
    mountSelectionPage(`/queue?${new URLSearchParams({ materialPath })}`); await screen.findByTitle('索引 v7 已就绪');
    selectText('queue-source'); expect(screen.getByRole('button', { name: '问问这段内容' })).toBeVisible();
    selectText('queue-source', 'candidate');
    expect(screen.queryByRole('button', { name: '问问这段内容' })).toBeNull();
  });

  it('requires an explicit source path before attributing selected original prose', async () => {
    mountSelectionPage('/library'); await screen.findByTitle('索引 v7 已就绪');
    selectText('library-source');
    expect(screen.queryByRole('button', { name: '问问这段内容' })).toBeNull();
  });
});

describe('black-glass application shell', () => {
  beforeEach(() => setPath('/'));
  afterEach(() => cleanup());

  it('exposes skip, sidebar, navigation, and main-content landmarks', () => {
    render(<App />);

    expect(screen.getByRole('link', { name: '跳到主内容' })).toHaveAttribute(
      'href',
      '#main-content'
    );
    expect(screen.getByRole('complementary', { name: '最佳拍档侧边栏' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1');
  });

  it('contains the eight main navigation destinations including the Skill catalog', () => {
    render(<App />);

    const navigation = screen.getByRole('navigation', { name: '主导航' });
    const links = within(navigation).getAllByRole('link');
    expect(links).toHaveLength(8);
    expect(links.map((link) => link.textContent?.trim())).toEqual(MAIN_NAVIGATION_NAMES);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/',
      '/intake',
      '/queue',
      '/library',
      '/knowledge',
      '/skills',
      '/operations',
      '/settings'
    ]);
  });

  it('keeps the icon-only recycle link discoverable outside the main navigation', async () => {
    renderShell(createApi());

    const link = screen.getByRole('link', { name: '回收站' });
    expect(link).toHaveAttribute('href', '/trash');
    expect(link).toHaveAttribute('title', expect.stringContaining('回收站'));
    expect(within(link).queryByText('回收站', { exact: true })).toBeNull();
    expect(within(screen.getByRole('navigation', { name: '主导航' })).queryByRole('link', { name: '回收站' })).toBeNull();
    await waitFor(() => expect(link).toHaveAccessibleDescription('回收站数量暂不可用'));
  });

  it('marks the current destination and keeps live connection state out of links', async () => {
    const api = createApi();
    renderShell(api);

    expect(screen.getByRole('link', { name: '大脑总览' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    const connection = screen.getByRole('status', { name: '本地连接状态' });
    expect(await within(connection).findByText('已连接')).toBeVisible();
    expect(connection).toHaveTextContent('本地文件 · 我的大脑');
    expect(connection).not.toHaveTextContent('待检查');
    expect(connection).toHaveClass('connection-badge--connected');
    expect(connection.closest('a')).toBeNull();
  });

  it.each([
    ['/', '大脑总览'],
    ['/queue/', '提炼工作台'],
    ['/library/', '档案库'],
    ['/knowledge/', '知识库'],
    ['/skills/', 'Skill 库'],
    ['/operations/', '操作与恢复'],
    ['/settings/', '设置'],
    ['/connections/', '设置']
  ])('normalizes the canonical page identity for %s', (path, heading) => {
    setPath(path);
    render(<App />);

    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
  });

  it.each([
    ['/extractions/material-01', '提炼工作区'],
    ['/write-plans/plan-01', '写入计划']
  ])('routes %s without adding it to the sidebar', (path, heading) => {
    setPath(path);
    render(<App />);

    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    const navigation = screen.getByRole('navigation', { name: '主导航' });
    expect(within(navigation).getAllByRole('link')).toHaveLength(8);
    expect(within(navigation).queryByText(heading)).not.toBeInTheDocument();
  });

  it('moves focus to the page heading after client-side navigation only', async () => {
    const user = userEvent.setup();
    render(<App />);

    const initialHeading = screen.getByRole('heading', { level: 1, name: '大脑总览' });
    expect(initialHeading).not.toHaveFocus();

    await user.click(screen.getByRole('link', { name: '提炼队列' }));
    expect(screen.getByRole('heading', { level: 1, name: '提炼工作台' })).toHaveFocus();
  });

  it('returns from settings to the cabinet with search preserved but no automatically selected file', async () => {
    const user = userEvent.setup();
    const query = '?view=ready&title=资料&materialPath=01图书馆%2F资料.md&run=run-1';
    setPath(`/queue${query}`); render(<App />);
    await user.click(screen.getByRole('link', { name: '设置' }));
    const queue = screen.getByRole('link', { name: '提炼队列' });
    expect(queue.getAttribute('href')).not.toContain('materialPath=');
    await user.click(queue);
    expect(new URLSearchParams(window.location.search).get('title')).toBe('资料');
    expect(new URLSearchParams(window.location.search).get('view')).toBe('ready');
    expect(new URLSearchParams(window.location.search).has('run')).toBe(false);
    expect(new URLSearchParams(window.location.search).has('materialPath')).toBe(false);
  });
});

describe('live console runtime', () => {
  afterEach(() => cleanup());

  it('loads only health on mount and exposes the authoritative snapshot through Outlet context', async () => {
    const api = createApi();
    renderShell(api);

    expect(screen.getByLabelText('运行时快照')).toHaveTextContent('loading');
    await waitFor(() => expect(api.getHealth).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText('运行时快照')).toHaveTextContent('ready'));
    expect(api.listMaterials).not.toHaveBeenCalled();
    expect(api.listKnowledge).not.toHaveBeenCalled();
    expect(api.rebuildIndex).not.toHaveBeenCalled();
    expect(screen.getByTitle('索引 v7 已就绪')).toBeVisible();
  });

  it.each([
    ['disconnected', '未连接'],
    ['recovery-required', '需要恢复']
  ] as const)('prioritizes a fresh %s failure over a cached connected snapshot', async (status, label) => {
    const user = userEvent.setup();
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(failure<HealthSnapshot>(
        status,
        'http://private.local/?key=must-not-render'
      ));
    const api = createApi({ getHealth });
    renderShell(api);
    const connection = screen.getByRole('status', { name: '本地连接状态' });
    expect(await within(connection).findByText('已连接')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '刷新运行时健康状态' }));

    expect(await within(connection).findByText(label)).toBeVisible();
    expect(connection).not.toHaveTextContent('已连接');
    expect(document.body).not.toHaveTextContent('private.local');
  });

  it('recovers the initial health read when StrictMode replays effects', async () => {
    const getHealth = vi.fn((signal?: AbortSignal) => {
      if (getHealth.mock.calls.length === 1) {
        return new Promise<ApiClientResult<HealthSnapshot>>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => resolve({ ok: false, cancelled: true }),
            { once: true }
          );
        });
      }
      return Promise.resolve(ok(readyHealth(7)));
    });
    const api = createApi({ getHealth });

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell api={api} />}>
              <Route index element={<RuntimeProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </StrictMode>
    );

    expect(await screen.findByTitle('索引 v7 已就绪')).toBeVisible();
    expect(getHealth).toHaveBeenCalledTimes(2);
    expect(api.rebuildIndex).not.toHaveBeenCalled();
  });

  it('coalesces repeated focus events, polls a running job, refreshes health, and increments revision', async () => {
    let releaseFocusHealth!: (result: ApiClientResult<HealthSnapshot>) => void;
    const focusHealth = new Promise<ApiClientResult<HealthSnapshot>>((resolve) => {
      releaseFocusHealth = resolve;
    });
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockReturnValueOnce(focusHealth)
      .mockResolvedValueOnce(ok(readyHealth(8)));
    const runningJob: IndexJob = { ...completedJob(7), status: 'running' };
    const api = createApi({
      getHealth,
      rebuildIndex: vi.fn(async () => ok(runningJob)),
      getIndexJob: vi.fn(async () => ok(completedJob(8)))
    });
    renderShell(api);
    await screen.findByTitle('索引 v7 已就绪');

    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(2));
    expect(api.rebuildIndex).not.toHaveBeenCalled();

    releaseFocusHealth(ok(readyHealth(7)));
    await waitFor(() => expect(api.rebuildIndex).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.getIndexJob).toHaveBeenCalledWith('job-1', expect.any(AbortSignal)));
    await waitFor(() => expect(screen.getByTestId('revision')).toHaveTextContent('1'));

    expect(getHealth).toHaveBeenCalledTimes(3);
    expect(screen.getByTitle('索引 v8 已就绪')).toBeVisible();
  });

  it('forces a fresh post-terminal health read and ignores an older concurrent refresh result', async () => {
    const user = userEvent.setup();
    let releaseStaleHealth!: (result: ApiClientResult<HealthSnapshot>) => void;
    const staleHealth = new Promise<ApiClientResult<HealthSnapshot>>((resolve) => {
      releaseStaleHealth = resolve;
    });
    let releaseTerminalJob!: (result: ApiClientResult<IndexJob>) => void;
    const terminalJob = new Promise<ApiClientResult<IndexJob>>((resolve) => {
      releaseTerminalJob = resolve;
    });
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockReturnValueOnce(staleHealth)
      .mockResolvedValueOnce(ok(readyHealth(8)));
    const runningJob: IndexJob = { ...completedJob(7), status: 'running' };
    const api = createApi({
      getHealth,
      rebuildIndex: vi.fn(async () => ok(runningJob)),
      getIndexJob: vi.fn(() => terminalJob)
    });
    renderShell(api);
    await screen.findByTitle('索引 v7 已就绪');

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(api.getIndexJob).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '刷新运行时健康状态' }));
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(3));

    act(() => releaseTerminalJob(ok(completedJob(8))));

    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(4));
    expect(await screen.findByTitle('索引 v8 已就绪')).toBeVisible();
    expect(screen.getByTestId('revision')).toHaveTextContent('1');

    act(() => releaseStaleHealth(ok(readyHealth(7))));
    await waitFor(() => expect(screen.getByTitle('索引 v8 已就绪')).toBeVisible());
    expect(screen.getByTestId('revision')).toHaveTextContent('1');
  });

  it('keeps focus-owned refreshing state when refreshHealth joins its initial health request', async () => {
    const user = userEvent.setup();
    let releaseFocusHealth!: (result: ApiClientResult<HealthSnapshot>) => void;
    const focusHealth = new Promise<ApiClientResult<HealthSnapshot>>((resolve) => {
      releaseFocusHealth = resolve;
    });
    let releaseRebuild!: (result: ApiClientResult<IndexJob>) => void;
    const rebuild = new Promise<ApiClientResult<IndexJob>>((resolve) => {
      releaseRebuild = resolve;
    });
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockReturnValueOnce(focusHealth)
      .mockResolvedValueOnce(ok(readyHealth(8)));
    const rebuildIndex = vi.fn(() => rebuild);
    const api = createApi({ getHealth, rebuildIndex });
    renderShell(api);
    await screen.findByTitle('索引 v7 已就绪');

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: '刷新运行时健康状态' }));

    await act(async () => {
      releaseFocusHealth(ok(readyHealth(7)));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rebuildIndex).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('运行时快照')).toHaveTextContent('refreshing');
    expect(screen.getByText('索引刷新中')).toBeVisible();
    expect(screen.queryByTitle('索引 v7 已就绪')).not.toBeInTheDocument();

    act(() => releaseRebuild(ok(completedJob(8))));
    await waitFor(() => expect(screen.getByTestId('revision')).toHaveTextContent('1'));
    expect(screen.getByTitle('索引 v8 已就绪')).toBeVisible();
  });

  it('allows a health refresh started after a focus cycle to publish its newer snapshot', async () => {
    const user = userEvent.setup();
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(8)))
      .mockResolvedValueOnce(ok(readyHealth(9)));
    const api = createApi({ getHealth });
    renderShell(api);
    await screen.findByTitle('索引 v7 已就绪');

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(screen.getByTestId('revision')).toHaveTextContent('1'));
    expect(screen.getByTitle('索引 v8 已就绪')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '刷新运行时健康状态' }));

    expect(await screen.findByTitle('索引 v9 已就绪')).toBeVisible();
    expect(getHealth).toHaveBeenCalledTimes(4);
    expect(screen.getByLabelText('运行时快照')).toHaveTextContent('ready');
  });

  it.each([
    [{ status: 'ready', version: 10, refreshedAt: '2026-09-01T00:00:00.000Z' }, 10],
    [{ status: 'building', version: 11, startedAt: '2026-09-01T00:00:00.000Z' }, 11],
    [{ status: 'failed', version: 12, reason: 'INDEX_FAILED' }, 12],
    [{
      status: 'stale',
      version: 13,
      lastSuccessAt: '2026-09-01T00:00:00.000Z',
      reason: 'INDEX_STALE'
    }, 13]
  ] as const)('uses the version from an authoritative %s snapshot when rebuilding', async (index, version) => {
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok({ ...readyHealth(7), index }))
      .mockResolvedValueOnce(ok(readyHealth(version + 1)));
    const api = createApi({ getHealth });
    renderShell(api);
    await screen.findByTitle('索引 v7 已就绪');

    act(() => window.dispatchEvent(new Event('focus')));

    await waitFor(() => expect(api.rebuildIndex).toHaveBeenCalledWith(version, expect.any(String)));
  });

  it('polls queued and running jobs until completion before the final health read', async () => {
    const queuedJob: IndexJob = { ...completedJob(7), status: 'queued' };
    const runningJob: IndexJob = { ...completedJob(7), status: 'running' };
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(8)));
    const getIndexJob = vi.fn()
      .mockResolvedValueOnce(ok(queuedJob))
      .mockResolvedValueOnce(ok(runningJob))
      .mockResolvedValueOnce(ok(completedJob(8)));
    const api = createApi({
      getHealth,
      rebuildIndex: vi.fn(async () => ok(queuedJob)),
      getIndexJob
    });
    renderShell(api);
    await screen.findByTitle('索引 v7 已就绪');

    act(() => window.dispatchEvent(new Event('focus')));

    await waitFor(
      () => expect(screen.getByTestId('revision')).toHaveTextContent('1'),
      { timeout: 2_000 }
    );
    expect(getIndexJob).toHaveBeenCalledTimes(3);
    expect(getIndexJob.mock.calls.every(([, signal]) => signal instanceof AbortSignal)).toBe(true);
    expect(getHealth).toHaveBeenCalledTimes(3);
    expect(screen.getByTitle('索引 v8 已就绪')).toBeVisible();
  });

  it.each(['failed', 'interrupted'] as const)(
    'reads final health after a terminal %s job without incrementing revision',
    async (status) => {
      const runningJob: IndexJob = { ...completedJob(7), status: 'running' };
      const terminalJob: IndexJob = {
        ...completedJob(7),
        status,
        errorCode: status === 'failed' ? 'INDEX_FAILED' : 'INDEX_INTERRUPTED'
      };
      const getHealth = vi.fn()
        .mockResolvedValueOnce(ok(readyHealth(7)))
        .mockResolvedValueOnce(ok(readyHealth(7)))
        .mockResolvedValueOnce(ok(readyHealth(7)));
      const api = createApi({
        getHealth,
        rebuildIndex: vi.fn(async () => ok(runningJob)),
        getIndexJob: vi.fn(async () => ok(terminalJob))
      });
      renderShell(api);
      await screen.findByTitle('索引 v7 已就绪');

      act(() => window.dispatchEvent(new Event('focus')));

      expect(await screen.findByText('索引刷新失败')).toBeVisible();
      expect(getHealth).toHaveBeenCalledTimes(3);
      expect(screen.getByLabelText('运行时快照')).toHaveTextContent('failed');
      expect(screen.getByTestId('revision')).toHaveTextContent('0');
    }
  );

  it('keeps revision unchanged when the required final health read fails', async () => {
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(failure<HealthSnapshot>('disconnected', 'private final health error'));
    const api = createApi({
      getHealth,
      rebuildIndex: vi.fn(async () => ok(completedJob(8)))
    });
    renderShell(api);
    await screen.findByTitle('索引 v7 已就绪');

    act(() => window.dispatchEvent(new Event('focus')));

    expect(await screen.findByText('索引服务未连接')).toBeVisible();
    expect(screen.getByRole('status', { name: '本地连接状态' })).toHaveTextContent('未连接');
    expect(getHealth).toHaveBeenCalledTimes(3);
    expect(api.getIndexJob).not.toHaveBeenCalled();
    expect(screen.getByTestId('revision')).toHaveTextContent('0');
    expect(document.body).not.toHaveTextContent('private final health error');
  });

  it('retries an ambiguous disconnected rebuild with the same key and rotates it next focus cycle', async () => {
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok(readyHealth(8)))
      .mockResolvedValueOnce(ok(readyHealth(8)))
      .mockResolvedValueOnce(ok(readyHealth(9)));
    const rebuildIndex = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        state: { status: 'disconnected', message: '未知是否已接收' }
      })
      .mockResolvedValueOnce(ok(completedJob(8)))
      .mockResolvedValueOnce(ok(completedJob(9)));
    const api = createApi({ getHealth, rebuildIndex });
    renderShell(api);
    await screen.findByTitle('索引 v7 已就绪');

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(screen.getByTestId('revision')).toHaveTextContent('1'));
    const firstKey = vi.mocked(rebuildIndex).mock.calls[0]?.[1];
    expect(rebuildIndex).toHaveBeenNthCalledWith(2, 7, firstKey);

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(screen.getByTestId('revision')).toHaveTextContent('2'));
    const secondCycleKey = vi.mocked(rebuildIndex).mock.calls[2]?.[1];
    expect(secondCycleKey).not.toBe(firstKey);
  });

  it('keeps busy failures visible without rendering server error text', async () => {
    const api = createApi({
      getHealth: vi.fn()
        .mockResolvedValueOnce(ok(readyHealth(7)))
        .mockResolvedValueOnce(ok({
          ...readyHealth(7),
          index: {
            status: 'building',
            version: 7,
            startedAt: '2026-09-01T00:00:00.000Z'
          }
        })),
      rebuildIndex: vi.fn(async () => failure<IndexJob>(
        'busy',
        'http://private.local/?key=must-not-render'
      ))
    });
    renderShell(api);
    await screen.findByTitle('索引 v7 已就绪');

    act(() => window.dispatchEvent(new Event('focus')));

    expect(await screen.findByText('索引任务进行中')).toBeVisible();
    expect(screen.getByLabelText('运行时快照')).toHaveTextContent('failed');
    expect(document.body).not.toHaveTextContent('private.local');
    expect(screen.getByRole('status', { name: '本地连接状态' })).toHaveTextContent('已连接');
  });

  it('aborts an in-flight health request on unmount without showing a disconnected state', async () => {
    let capturedSignal: AbortSignal | undefined;
    const getHealth = vi.fn((signal?: AbortSignal) => new Promise<ApiClientResult<HealthSnapshot>>((resolve) => {
      capturedSignal = signal;
      signal?.addEventListener('abort', () => resolve({ ok: false, cancelled: true }), { once: true });
    }));
    const api = createApi({ getHealth });
    const view = renderShell(api);
    await waitFor(() => expect(capturedSignal).toBeDefined());

    view.unmount();

    expect(capturedSignal?.aborted).toBe(true);
    expect(document.body).not.toHaveTextContent('连接已断开');
  });

  it('aborts a polling wait on unmount without issuing another job read', async () => {
    let pollSignal: AbortSignal | undefined;
    const runningJob: IndexJob = { ...completedJob(7), status: 'running' };
    const getIndexJob = vi.fn(async (_id: string, signal?: AbortSignal) => {
      pollSignal = signal;
      return ok(runningJob);
    });
    const api = createApi({
      getHealth: vi.fn()
        .mockResolvedValueOnce(ok(readyHealth(7)))
        .mockResolvedValueOnce(ok(readyHealth(7))),
      rebuildIndex: vi.fn(async () => ok(runningJob)),
      getIndexJob
    });
    const view = renderShell(api);
    await screen.findByTitle('索引 v7 已就绪');

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(getIndexJob).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());

    view.unmount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pollSignal?.aborted).toBe(true);
    expect(getIndexJob).toHaveBeenCalledTimes(1);
  });
});

describe('passive desktop refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const nonce = document.createElement('meta');
    nonce.name = 'csp-nonce';
    nonce.content = 'component-test-nonce';
    document.head.append(nonce);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.querySelector('meta[name="csp-nonce"]')?.remove();
  });

  it('reloads visible dashboard data only after a newly published index version', async () => {
    let version = 7;
    const api = createApi({ getHealth: vi.fn(async () => ok(readyHealth(version))) });
    render(<MemoryRouter><AppRouter api={api} /></MemoryRouter>);
    await act(async () => {});
    expect(api.listMaterials).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(api.listMaterials).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle('索引 v7 已就绪')).toBeVisible();

    version = 8;
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(api.listMaterials).toHaveBeenCalledTimes(2);
    expect(screen.getByTitle('索引 v8 已就绪')).toBeVisible();
    expect(api.rebuildIndex).not.toHaveBeenCalled();
  });

  it('recovers from a transient backend failure without a focus event', async () => {
    const api = createApi({ getHealth: vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(failure<HealthSnapshot>('disconnected', 'private backend path'))
      .mockResolvedValue(ok(readyHealth(8))) });
    renderShell(api);
    await act(async () => {});

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(screen.getByLabelText('运行时快照')).toHaveTextContent('failed');
    expect(document.body).not.toHaveTextContent('private backend path');

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(screen.getByTitle('索引 v8 已就绪')).toBeVisible();
    expect(screen.getByTestId('revision')).toHaveTextContent('1');
    expect(api.rebuildIndex).not.toHaveBeenCalled();
  });

  it('suspends passive reads while hidden and resumes after becoming visible', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const api = createApi();
    renderShell(api);
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(api.getHealth).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('visible');
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(api.getHealth).toHaveBeenCalledTimes(2);
  });

  it('does not overlap passive health requests and aborts the pending read on unmount', async () => {
    let pendingSignal: AbortSignal | undefined;
    const api = createApi({ getHealth: vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockImplementation((signal?: AbortSignal) => new Promise((resolve) => {
        pendingSignal = signal;
        signal?.addEventListener('abort', () => resolve({ ok: false, cancelled: true }), { once: true });
      })) });
    const view = renderShell(api);
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(9_000));
    expect(api.getHealth).toHaveBeenCalledTimes(2);
    expect(pendingSignal?.aborted).toBe(false);
    view.unmount();
    expect(pendingSignal?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(api.getHealth).toHaveBeenCalledTimes(2);
  });

  it('does not republish an unchanged version after a successful focus rebuild', async () => {
    const api = createApi();
    renderShell(api);
    await act(async () => {});
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(api.rebuildIndex).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('revision')).toHaveTextContent('0');
  });

  it.each([
    ['/queue', 'listMaterials', '当前筛选范围内没有待处理材料'],
    ['/knowledge', 'listKnowledge', '当前筛选范围内没有知识记录'],
    ['/operations', 'listOperations', '还没有操作记录']
  ] as const)('recovers %s after an initial disconnect even when no new index version exists', async (path, method, emptyMessage) => {
    let available = false;
    const api = createApi({
      getHealth: vi.fn(async () => available ? ok(readyHealth(7)) : failure<HealthSnapshot>('disconnected', 'offline')),
      [method]: vi.fn(async () => available ? ok({ items: [] }) : failure('disconnected', 'offline'))
    });
    render(<MemoryRouter initialEntries={[path]}><AppRouter api={api} /></MemoryRouter>);
    await act(async () => {});
    const disconnectedMessage = path === '/operations' ? '操作记录暂时无法读取，请重试。已有记录可能不是最新状态。' : '无法连接本地服务。';
    expect(screen.getByText(disconnectedMessage)).toBeVisible();

    available = true;
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(screen.queryByText(disconnectedMessage)).not.toBeInTheDocument();
    expect(screen.getByText(emptyMessage)).toBeVisible();
    expect(api[method]).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(api[method]).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['/queue', 'listMaterials', '当前筛选范围内没有待处理材料'],
    ['/knowledge', 'listKnowledge', '当前筛选范围内没有知识记录'],
    ['/operations', 'listOperations', '还没有操作记录']
  ] as const)('loads %s after the initial index finishes building', async (path, method, emptyMessage) => {
    let building = true;
    const api = createApi({
      getHealth: vi.fn(async () => ok<HealthSnapshot>({
        ...readyHealth(7),
        ...(building ? { index: { status: 'building', version: 7, startedAt: '2026-09-01T00:00:00.000Z' } } : {})
      })),
      [method]: vi.fn(async () => building ? failure('busy', 'building') : ok({ items: [] }))
    });
    render(<MemoryRouter initialEntries={[path]}><AppRouter api={api} /></MemoryRouter>);
    await act(async () => {});
    expect(screen.queryByText(emptyMessage)).not.toBeInTheDocument();

    building = false;
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(screen.getByText(emptyMessage)).toBeVisible();
    expect(api[method]).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(api[method]).toHaveBeenCalledTimes(2);
  });
});

describe('complete page state system', () => {
  afterEach(() => cleanup());

  const cases = [
    ['loading', '正在加载'],
    ['empty', '暂无数据'],
    ['refreshing', '正在刷新'],
    ['disconnected', '连接已断开'],
    ['validation-error', '数据校验失败'],
    ['operation-error', '操作失败'],
    ['busy', '系统繁忙'],
    ['success', '操作成功'],
    ['conflict', '版本冲突'],
    ['recovery-required', '需要恢复']
  ] as const;

  it.each(cases)('renders %s with a visible label and named icon', (status, label) => {
    render(<PageState state={{ status }} />);

    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByRole('img', { name: `${label}图标` })).toBeInTheDocument();
  });

  it('announces busy work without presenting it as a fatal alert', () => {
    render(<PageState state={{ status: 'busy', message: '索引任务正在执行' }} />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).not.toHaveAttribute('aria-busy');
    expect(status).toHaveAttribute('data-busy', 'true');
    expect(status).toHaveTextContent('索引任务正在执行');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('announces loading without marking the live region permanently busy', () => {
    render(<PageState state={{ status: 'loading' }} />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).not.toHaveAttribute('aria-busy');
    expect(status).toHaveAttribute('data-busy', 'true');
  });
});
