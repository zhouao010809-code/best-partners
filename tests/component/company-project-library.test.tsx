// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CompanyAppShell } from '../../src/client/company/CompanyAppShell.js';
import { CompanyProjectLibraryPage } from '../../src/client/pages/company/CompanyProjectLibraryPage.js';
import type { CompanyApi } from '../../src/client/components/company/company-api.js';

const SHA = 'a'.repeat(64);
const time = '2026-09-18T08:00:00.000Z';
const session = { user: { id: 'owner', displayName: '老板', role: 'owner' as const }, csrfToken: 'c'.repeat(43) };
const completed = { id: 'completed', workspaceId: 'company', name: 'B 餐饮项目', clientName: 'B 餐饮', status: 'completed' as const, projectRoot: 'projects/completed', sourceRoot: 'incoming/completed', configSha256: SHA, confidence: {}, selectedSkillIds: [], createdAt: time, updatedAt: time, dataCoverage: 'not_configured' as const };
const active = { id: 'active', workspaceId: 'company', name: 'A 教育项目', clientName: 'A 培训机构', status: 'active' as const, projectRoot: 'projects/active', sourceRoot: 'incoming/active', configSha256: SHA, confidence: {}, selectedSkillIds: ['education-content'], createdAt: time, updatedAt: time, dataCoverage: 'not_configured' as const };
const proposal = {
  sourceRoot: 'incoming/new-project', sourceSha256: SHA, suggestedName: '新教育项目', suggestedClientName: '新培训机构', suggestedStatus: 'draft' as const,
  fields: { clientName: { value: '新培训机构', confidence: 'inferred' as const, evidencePaths: ['项目说明.md'] }, serviceStart: { confidence: 'unknown' as const, evidencePaths: [] } },
  selectedSkillIds: ['education-content'], entries: [{ relativePath: '项目说明.md', kind: 'file' as const, bytes: 120, sha256: SHA }], issues: []
};
const run = { id: 'run-1', projectId: 'draft-1', sourceSha256: SHA, state: 'proposed' as const, proposal, operationId: 'op-1', createdAt: time, updatedAt: time };

function ok<T>(value: T) { return { ok: true as const, value }; }
function apiFixture(overrides: Partial<CompanyApi['projects']> = {}): CompanyApi {
  return {
    auth: { bootstrap: vi.fn(), login: vi.fn(), session: vi.fn(async () => ok(session)), logout: vi.fn() },
    projects: { list: vi.fn(async () => ok({ items: [completed, active] })), scan: vi.fn(async () => ok({ reused: false, run, project: { ...active, id: 'draft-1', name: '新教育项目', status: 'draft' as const }, proposal })), draft: vi.fn(), confirm: vi.fn(async () => ok({ project: active, run: { ...run, state: 'confirmed' as const }, operationId: 'op-2' })), get: vi.fn(), ...overrides },
    skills: { list: vi.fn(), get: vi.fn() }
  } as CompanyApi;
}

function renderPage(api: CompanyApi) {
  return render(<MemoryRouter initialEntries={['/company/projects']}><Routes><Route element={<CompanyAppShell api={api} initialSession={session} />}><Route path="company/projects" element={<CompanyProjectLibraryPage />} /></Route></Routes></MemoryRouter>);
}

afterEach(() => cleanup());

describe('CompanyProjectLibraryPage', () => {
  it('shows project cards with service projects before completed projects', async () => {
    renderPage(apiFixture());
    expect(await screen.findByRole('heading', { name: 'A 教育项目' })).toBeVisible();
    const cards = screen.getAllByRole('link').filter(link => link.className.includes('company-project-card'));
    expect(cards[0]).toHaveTextContent('A 教育项目');
    expect(cards[1]).toHaveTextContent('B 餐饮项目');
    expect(cards[0]).toHaveTextContent('A 教育项目');
  });

  it('analyzes a staged folder, exposes inferred and unknown labels, confirms it, and refreshes the active card', async () => {
    const user = userEvent.setup();
    const list = vi.fn().mockResolvedValueOnce(ok({ items: [] })).mockResolvedValueOnce(ok({ items: [active] }));
    const scan = vi.fn(async () => ok({ reused: false, run, project: { ...active, id: 'draft-1', name: proposal.suggestedName, status: 'draft' as const }, proposal }));
    const confirm = vi.fn(async () => ok({ project: active, run: { ...run, state: 'confirmed' as const }, operationId: 'op-2' }));
    const api = apiFixture({ list, scan, confirm });
    renderPage(api);
    await user.type(await screen.findByRole('textbox', { name: 'incoming 文件夹路径' }), 'incoming/new-project');
    await user.click(screen.getByRole('button', { name: '分析文件夹' }));
    expect(await screen.findByRole('heading', { name: '导入提案' })).toBeVisible();
    expect(screen.getByText('推断 · 项目说明.md')).toBeVisible();
    expect(screen.getByText('待确认：服务开始日期')).toBeVisible();
    expect(screen.getByText('文件数量')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /确认并建立项目/u }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('run-1', expect.objectContaining({ name: '新教育项目', clientName: '新培训机构', status: 'draft', sourceSha256: SHA })));
    expect(await screen.findByRole('heading', { name: 'A 教育项目' })).toBeVisible();
    expect(scan).toHaveBeenCalledWith({ incomingPath: 'incoming/new-project' }, expect.any(AbortSignal));
  });

  it('keeps the incoming source reference when analysis fails and is retried', async () => {
    const user = userEvent.setup();
    const scan = vi.fn().mockResolvedValueOnce({ ok: false as const, state: { status: 'operation-error' as const, message: 'Mac mini 尚未看到这个文件夹。' } }).mockResolvedValueOnce(ok({ reused: false, run, project: { ...active, id: 'draft-1', name: proposal.suggestedName, status: 'draft' as const }, proposal }));
    const api = apiFixture({ scan });
    renderPage(api);
    const input = await screen.findByRole('textbox', { name: 'incoming 文件夹路径' });
    await user.type(input, 'incoming/retry-project');
    await user.click(screen.getByRole('button', { name: '分析文件夹' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Mac mini 尚未看到这个文件夹。');
    expect(input).toHaveValue('incoming/retry-project');
    await user.click(screen.getByRole('button', { name: '分析文件夹' }));
    expect(await screen.findByRole('heading', { name: '导入提案' })).toBeVisible();
    expect(scan).toHaveBeenLastCalledWith({ incomingPath: 'incoming/retry-project' }, expect.any(AbortSignal));
  });
});
