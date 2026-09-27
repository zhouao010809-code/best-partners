// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { ProjectFilePage, ProjectScanPreview, ProjectSummary } from '../../src/shared/api/projects.js';
import { ProjectWorkspacePage } from '../../src/client/pages/ProjectWorkspacePage.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const id = '1'.repeat(36);
const project: ProjectSummary = {
  id, displayName: 'A项目', sourceRevision: 4, availability: 'reconnect-required', outputRoot: 'AI工作区', fileCount: 1, readableFileCount: 1, issueCount: 0,
  createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:01.000Z', lastScannedAt: '2026-09-21T00:00:01.000Z'
};
const reconnected: ProjectSummary = { ...project, displayName: 'A项目新位置', availability: 'ready', sourceRevision: 5 };
const scan: ProjectScanPreview = { scanId: '2'.repeat(36), displayName: 'A项目新位置', sourceSha256: 'b'.repeat(64), fileCount: 1, readableFileCount: 1, unsupportedCount: 0, ignoredCount: 0, issueCount: 0, guidanceFiles: [], entries: [], issues: [], expiresAt: '2026-09-21T01:00:00.000Z' };
const files: ProjectFilePage = { items: [{ relativePath: 'brief.md', kind: 'file', bytes: 12, parseStatus: 'readable', origin: 'source' }], total: 1, revision: 4 };

const get = vi.fn();
const filesApi = vi.fn();
const scanApi = vi.fn();
const reconnect = vi.fn();
const refresh = vi.fn();
const runtime = {
  api: {} as ReadConsoleApi,
  health: { status: 'ready' as const, data: { index: { status: 'ready' as const, version: 1 } } },
  dataRevision: 0,
  refreshHealth: vi.fn(async () => undefined)
};

vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));

function ProjectShellProbe() {
  const location = useLocation();
  return <><output data-testid="project-route">{location.pathname}</output><p data-testid="visible-project-conversation">已有项目问问会话：上次讨论仍在这里</p></>;
}

function renderPage() {
  return render(<MemoryRouter initialEntries={[`/projects/${id}`]}><Routes><Route path="/projects/:id" element={<><ProjectWorkspacePage /><ProjectShellProbe /></>} /></Routes></MemoryRouter>);
}

beforeEach(() => {
  get.mockResolvedValue(ok(project));
  filesApi.mockResolvedValue(ok(files));
  scanApi.mockResolvedValue(ok(scan));
  reconnect.mockResolvedValue(ok(reconnected));
  refresh.mockResolvedValue(ok(reconnected));
  runtime.api = { projects: { get, files: filesApi, scan: scanApi, reconnect, refresh, list: vi.fn() } } as unknown as ReadConsoleApi;
  Object.defineProperty(window, 'xiaozhaoDesktop', { configurable: true, value: { chooseProjectDirectory: vi.fn(async () => ({ selected: true, path: '/tmp/A项目新位置', displayName: 'A项目新位置' })) } });
});

afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'xiaozhaoDesktop'); vi.clearAllMocks(); });

describe('ProjectWorkspacePage', () => {
  it('shows project context, file/output boundaries, and keeps the project id visible while reconnecting', async () => {
    const user = userEvent.setup();
    const updates: Event[] = [];
    const onUpdate = (event: Event) => updates.push(event);
    window.addEventListener('xiaozhao:project-workspace-updated', onUpdate);
    renderPage();
    expect(await screen.findByText('需要重新连接')).toBeVisible();
    expect(screen.getByRole('tab', { name: /项目资料/u })).toBeVisible();
    expect(screen.getByRole('tab', { name: /已保存产出/u })).toBeVisible();
    expect(screen.getByText('A项目')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '重新连接' }));
    expect(await screen.findByRole('heading', { name: '确认项目文件夹' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '重新连接项目' }));
    expect(scanApi).toHaveBeenCalledWith('/tmp/A项目新位置');
    expect(reconnect).toHaveBeenCalledWith(id, { scanId: scan.scanId, sourceSha256: scan.sourceSha256, displayName: 'A项目新位置' });
    expect(await screen.findByText('项目已重新连接；旧的项目写入计划已标记为过期，需要重新确认。')).toBeVisible();
    expect(updates).toHaveLength(1);
    expect((updates[0] as CustomEvent).detail).toEqual({ projectId: id });
    expect(screen.getByText('A项目新位置')).toBeVisible();
    expect(screen.getByTestId('project-route')).toHaveTextContent(`/projects/${id}`);
    expect(screen.getByTestId('visible-project-conversation')).toHaveTextContent('已有项目问问会话：上次讨论仍在这里');
    window.removeEventListener('xiaozhao:project-workspace-updated', onUpdate);
  });

  it('shows the connected project context when the bound folder is ready', async () => {
    get.mockResolvedValueOnce(ok({ ...project, availability: 'ready' }));
    renderPage();
    expect(await screen.findByText('资料已连接')).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByText('PROJECT SYNC')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /项目资料/u })).toBeVisible();
    expect(screen.getByRole('tab', { name: /已保存产出/u })).toBeVisible();
  });

  it('opens the existing project assistant intent from the workspace', async () => {
    const received: Event[] = [];
    const listener = (event: Event) => received.push(event);
    window.addEventListener('xiaozhao:ask', listener);
    try {
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole('heading', { name: 'A项目', level: 1 });
      await user.click(screen.getByRole('button', { name: '讨论项目' }));
      expect(received).toHaveLength(1);
      expect((received[0] as CustomEvent).detail).toMatchObject({ scope: 'project', projectId: id, projectRevision: project.sourceRevision });
    } finally {
      window.removeEventListener('xiaozhao:ask', listener);
    }
  });

  it('refreshes without replacing the page when the bound root needs reconnect', async () => {
    const user = userEvent.setup();
    refresh.mockResolvedValueOnce({ ok: false, code: 'PROJECT_ROOT_RECONNECT_REQUIRED', state: { status: 'operation-error', message: 'root unavailable' } });
    renderPage();
    await screen.findByText('需要重新连接');
    await user.click(screen.getByRole('button', { name: '更新资料' }));
    expect(await screen.findByText('项目文件夹已变化，请重新连接；当前项目会话仍保留。')).toBeVisible();
    expect(screen.getByText('A项目')).toBeVisible();
  });

  it('notifies the open assistant after refreshing project content', async () => {
    const user = userEvent.setup();
    const updates = vi.fn();
    window.addEventListener('xiaozhao:project-workspace-updated', updates);
    try {
      get.mockResolvedValueOnce(ok({ ...project, availability: 'ready' }));
      renderPage();
      await screen.findByText('资料已连接');
      await user.click(screen.getByRole('button', { name: '更新资料' }));
      await screen.findByText('项目资料已更新。');
      expect(updates).toHaveBeenCalledOnce();
      expect((updates.mock.calls[0]![0] as CustomEvent).detail).toEqual({ projectId: id });
    } finally {
      window.removeEventListener('xiaozhao:project-workspace-updated', updates);
    }
  });

  it('shows completed files together, deduplicates receipts and ignores another project', async () => {
    renderPage();
    await screen.findByText('A项目');
    const notify = (projectId: string, relativePath: string) => window.dispatchEvent(new CustomEvent('xiaozhao:project-workspace-updated', { detail: { projectId, savedFile: { operationId: relativePath, relativePath } } }));
    await act(async () => { notify('another-project', '不属于这里.md'); });
    expect(screen.queryByRole('region', { name: '最近保存的项目文件' })).not.toBeInTheDocument();
    await act(async () => { notify(id, 'AI工作区/第一份.md'); notify(id, 'AI工作区/第二份.md'); notify(id, 'AI工作区/第一份.md'); });
    const receipts = screen.getByRole('region', { name: '最近保存的项目文件' });
    expect(within(receipts).getAllByRole('listitem')).toHaveLength(2);
    expect(receipts).toHaveTextContent('AI工作区/第一份.md');
    expect(receipts).toHaveTextContent('AI工作区/第二份.md');
    expect(within(receipts).getAllByText('已保存')).toHaveLength(2);
    expect(receipts).not.toHaveTextContent('不属于这里');
  });

  it('refreshes the existing preview without resetting the search after a saved-file notification', async () => {
    const read = vi.fn().mockResolvedValue(ok({ ...files.items[0], content: '原来的正文' }));
    runtime.api = { ...runtime.api, projects: { ...runtime.api.projects!, file: read } };
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByRole('textbox', { name: '搜索项目文件' }), 'brief');
    await user.click(await screen.findByRole('button', { name: '打开文件：brief.md' }));
    await screen.findByText('原来的正文');
    read.mockResolvedValue(ok({ ...files.items[0], content: '最新的正文' }));
    await act(async () => { window.dispatchEvent(new CustomEvent('xiaozhao:project-workspace-updated', { detail: { projectId: id, savedFile: { operationId: 'saved-1', relativePath: 'AI工作区/输出.md' } } })); });
    expect(await screen.findByText('最新的正文')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '搜索项目文件' })).toHaveValue('brief');
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it('keeps the work surface mounted during consecutive background summary updates and a failure', async () => {
    const user = userEvent.setup();
    renderPage();
    const search = await screen.findByRole('textbox', { name: '搜索项目文件' });
    await user.type(search, '尚在查看的文件');
    const pending: Array<(value: unknown) => void> = [];
    get.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const notify = (path: string) => window.dispatchEvent(new CustomEvent('xiaozhao:project-workspace-updated', { detail: { projectId: id, savedFile: { operationId: path, relativePath: path } } }));
    await act(async () => { notify('AI工作区/一.md'); });
    await act(async () => { notify('AI工作区/二.md'); });
    expect(screen.getByRole('textbox', { name: '搜索项目文件' })).toBe(search);
    expect(search).toHaveValue('尚在查看的文件');
    await act(async () => { pending[1]!({ ok: false, state: { status: 'operation-error', message: '统计暂时不可用' } }); });
    expect(await screen.findByText('统计暂时不可用')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '搜索项目文件' })).toBe(search);
    await act(async () => { pending[0]!(ok({ ...project, displayName: '不应回来的旧标题' })); });
    expect(screen.queryByText('不应回来的旧标题')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '最近保存的项目文件' })).getAllByRole('listitem')).toHaveLength(2);
  });

  it.each(['unavailable', 'reconnect-required', 'scanning'] as const)('keeps the saved-file indexing warning when refresh returns %s', async availability => {
    const user = userEvent.setup();
    get.mockResolvedValue(ok({ ...project, availability: 'ready' }));
    refresh.mockResolvedValueOnce(ok({ ...project, availability })).mockResolvedValueOnce(ok(reconnected));
    renderPage();
    await screen.findByText('资料已连接');
    const problem = '文件已保存，但列表尚未更新。请点击“更新资料”后查看。';
    await act(async () => { window.dispatchEvent(new CustomEvent('xiaozhao:project-workspace-updated', { detail: {
      projectId: id, savedFile: { operationId: 'saved-with-warning', relativePath: 'AI工作区/输出.md', problem }
    } })); });
    const receipts = screen.getByRole('region', { name: '最近保存的项目文件' });
    await user.click(screen.getByRole('button', { name: '更新资料' }));
    expect(receipts).toHaveTextContent(problem);
    expect(screen.queryByText('项目资料已更新。')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '更新资料' }));
    expect(await screen.findByText('项目资料已更新。')).toBeVisible();
    expect(receipts).not.toHaveTextContent(problem);
    expect(receipts).toHaveTextContent('已保存');
  });

  it('offers a retry if a save notification supersedes the unfinished first load and then fails', async () => {
    let finishInitial!: (value: unknown) => void;
    get.mockImplementationOnce(() => new Promise(resolve => { finishInitial = resolve; }))
      .mockResolvedValueOnce({ ok: false, state: { status: 'operation-error', message: '同步读取失败' } });
    renderPage();
    await screen.findByText('正在读取项目工作区。');
    await act(async () => { window.dispatchEvent(new CustomEvent('xiaozhao:project-workspace-updated', { detail: {
      projectId: id, savedFile: { operationId: 'first-save', relativePath: 'AI工作区/输出.md' }
    } })); });
    expect(await screen.findByRole('button', { name: '重新读取' })).toBeVisible();
    expect(screen.getByText('同步读取失败')).toBeVisible();
    await act(async () => { finishInitial(ok(project)); });
    expect(screen.getByRole('button', { name: '重新读取' })).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: '重新读取' }));
    expect(await screen.findByRole('heading', { name: 'A项目', level: 1 })).toBeVisible();
    expect(screen.getByRole('region', { name: '最近保存的项目文件' })).toHaveTextContent('AI工作区/输出.md');
  });
});
