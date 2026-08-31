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
import { useConsoleRuntime } from '../../src/client/app/ConsoleRuntime.js';
import { PageState } from '../../src/client/components/PageState.js';

const MAIN_NAVIGATION_NAMES = [
  '大脑总览',
  '提炼队列',
  '知识库',
  '操作记录',
  '系统连接'
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
    listMaterials: vi.fn(async () => ok({ items: [] })),
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
    <output aria-label="运行时快照">
      <span>{runtime.health.status}</span>
      <span data-testid="revision">{runtime.dataRevision}</span>
    </output>
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

describe('black-glass application shell', () => {
  beforeEach(() => setPath('/'));
  afterEach(() => cleanup());

  it('exposes skip, sidebar, navigation, and main-content landmarks', () => {
    render(<App />);

    expect(screen.getByRole('link', { name: '跳到主内容' })).toHaveAttribute(
      'href',
      '#main-content'
    );
    expect(screen.getByRole('complementary', { name: '小兆大脑侧边栏' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1');
  });

  it('contains five and only five main navigation destinations', () => {
    render(<App />);

    const navigation = screen.getByRole('navigation', { name: '主导航' });
    const links = within(navigation).getAllByRole('link');
    expect(links).toHaveLength(5);
    expect(links.map((link) => link.textContent?.trim())).toEqual(MAIN_NAVIGATION_NAMES);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/',
      '/queue',
      '/knowledge',
      '/operations',
      '/connections'
    ]);
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
    expect(connection).toHaveTextContent('Obsidian 1.9.12 · 插件 5.1.0');
    expect(connection).not.toHaveTextContent('待检查');
    expect(connection).toHaveClass('connection-badge--connected');
    expect(connection.closest('a')).toBeNull();
  });

  it.each([
    ['/', '大脑总览'],
    ['/queue/', '提炼队列'],
    ['/knowledge/', '知识库'],
    ['/operations/', '操作记录'],
    ['/connections/', '系统连接']
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
    expect(within(navigation).getAllByRole('link')).toHaveLength(5);
    expect(within(navigation).queryByText(heading)).not.toBeInTheDocument();
  });

  it('moves focus to the page heading after client-side navigation only', async () => {
    const user = userEvent.setup();
    render(<App />);

    const initialHeading = screen.getByRole('heading', { level: 1, name: '大脑总览' });
    expect(initialHeading).not.toHaveFocus();

    await user.click(screen.getByRole('link', { name: '提炼队列' }));
    expect(screen.getByRole('heading', { level: 1, name: '提炼队列' })).toHaveFocus();
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
    expect(screen.getByText('索引 v7 已就绪')).toBeVisible();
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

    expect(await screen.findByText('索引 v7 已就绪')).toBeVisible();
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
    await screen.findByText('索引 v7 已就绪');

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
    expect(screen.getByText('索引 v8 已就绪')).toBeVisible();
  });

  it.each([
    [{ status: 'building', version: 11, startedAt: '2026-09-01T00:00:00.000Z' }, 11],
    [{ status: 'failed', version: 12, reason: 'INDEX_FAILED' }, 12]
  ] as const)('uses the version from an authoritative %s snapshot when rebuilding', async (index, version) => {
    const getHealth = vi.fn()
      .mockResolvedValueOnce(ok(readyHealth(7)))
      .mockResolvedValueOnce(ok({ ...readyHealth(7), index }))
      .mockResolvedValueOnce(ok(readyHealth(version + 1)));
    const api = createApi({ getHealth });
    renderShell(api);
    await screen.findByText('索引 v7 已就绪');

    act(() => window.dispatchEvent(new Event('focus')));

    await waitFor(() => expect(api.rebuildIndex).toHaveBeenCalledWith(version, expect.any(String)));
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
    await screen.findByText('索引 v7 已就绪');

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
    await screen.findByText('索引 v7 已就绪');

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
