// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { ProjectScanPreview, ProjectSummary } from '../../src/shared/api/projects.js';
import { ProjectsPage } from '../../src/client/pages/ProjectsPage.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const project: ProjectSummary = {
  id: '1'.repeat(36), displayName: 'A项目', sourceRevision: 1, availability: 'ready', outputRoot: 'AI工作区',
  fileCount: 2, readableFileCount: 2, issueCount: 0, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:01.000Z', lastScannedAt: '2026-09-21T00:00:01.000Z'
};
const preview: ProjectScanPreview = {
  scanId: '2'.repeat(36), displayName: 'A项目', sourceSha256: 'a'.repeat(64), fileCount: 4, readableFileCount: 2, unsupportedCount: 1, ignoredCount: 3, issueCount: 1,
  guidanceFiles: ['brief.md'], entries: [], issues: ['unsupported.png'], expiresAt: '2026-09-21T01:00:00.000Z'
};

const list = vi.fn();
const scan = vi.fn();
const bind = vi.fn();
const runtime = {
  api: {} as ReadConsoleApi,
  health: { status: 'ready' as const, data: { index: { status: 'ready' as const, version: 1 } } },
  dataRevision: 0,
  refreshHealth: vi.fn(async () => undefined)
};

vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));

function renderPage() {
  return render(<MemoryRouter initialEntries={['/projects']}><Routes><Route path="/projects" element={<ProjectsPage />} /><Route path="/projects/:id" element={<div>项目工作区已打开</div>} /></Routes></MemoryRouter>);
}

beforeEach(() => {
  list.mockResolvedValue(ok({ projects: [] }));
  scan.mockResolvedValue(ok(preview));
  bind.mockResolvedValue(ok(project));
  runtime.api = { projects: { list, scan, bind } } as unknown as ReadConsoleApi;
  Object.defineProperty(window, 'xiaozhaoDesktop', { configurable: true, value: { chooseProjectDirectory: vi.fn(async () => ({ selected: true, path: '/tmp/A项目', displayName: 'A项目' })) } });
});

afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'xiaozhaoDesktop'); vi.clearAllMocks(); });

describe('ProjectsPage', () => {
  it('uses the native picker, previews counts, and binds without project-management form fields', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '添加项目' }));
    expect(await screen.findByRole('heading', { name: '确认项目文件夹' })).toBeVisible();
    expect(screen.getByText('4')).toBeVisible();
    expect(screen.getByText('2')).toBeVisible();
    expect(screen.getByText(/不需要填写客户背景、阶段或目标/u)).toBeVisible();
    expect(screen.queryByLabelText(/背景|阶段|目标/u)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '项目显示名（可选）' })).toHaveValue('A项目');
    await user.click(screen.getByRole('button', { name: '确认添加项目' }));
    expect(bind).toHaveBeenCalledWith({ scanId: preview.scanId, sourceSha256: preview.sourceSha256, displayName: 'A项目' });
    expect(await screen.findByText('项目工作区已打开')).toBeVisible();
  });

  it('allows an empty optional display name and lets the service use its folder default', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '添加项目' }));
    await user.clear(screen.getByRole('textbox', { name: '项目显示名（可选）' }));
    await user.click(screen.getByRole('button', { name: '确认添加项目' }));
    expect(bind).toHaveBeenCalledWith({ scanId: preview.scanId, sourceSha256: preview.sourceSha256 });
  });

  it('keeps the list actionable when the native picker is cancelled', async () => {
    const user = userEvent.setup();
    window.xiaozhaoDesktop!.chooseProjectDirectory = vi.fn(async () => ({ selected: false as const, reason: 'cancelled' as const }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: '添加项目' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已取消选择');
    expect(screen.getByRole('button', { name: '添加项目' })).toBeEnabled();
    expect(scan).not.toHaveBeenCalled();
  });
});
