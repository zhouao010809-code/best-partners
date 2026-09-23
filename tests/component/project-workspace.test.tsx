// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
    expect((await screen.findAllByText('项目语料：需要重新连接')).length).toBeGreaterThan(0);
    expect(screen.getByText('全局知识库：可检索')).toBeVisible();
    expect(screen.getByText('写入范围：A项目 / AI工作区')).toBeVisible();
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
    expect((await screen.findAllByText('项目语料：已连接')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('全局知识库：可检索')).toBeVisible();
    expect(screen.getByText('写入范围：A项目 / AI工作区')).toBeVisible();
  });

  it('opens the existing project assistant intent from the workspace', async () => {
    const received: Event[] = [];
    const listener = (event: Event) => received.push(event);
    window.addEventListener('xiaozhao:ask', listener);
    try {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('写入范围：A项目 / AI工作区');
      await user.click(screen.getByRole('button', { name: '打开项目问问' }));
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
    await screen.findAllByText('项目语料：需要重新连接');
    await user.click(screen.getByRole('button', { name: '刷新索引' }));
    expect(await screen.findByText('项目文件夹已变化，请重新连接；当前项目会话仍保留。')).toBeVisible();
    expect(screen.getByText('A项目')).toBeVisible();
  });
});
