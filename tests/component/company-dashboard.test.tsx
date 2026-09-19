// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CompanyAppShell } from '../../src/client/company/CompanyAppShell.js';
import { CompanyProjectDashboardPage } from '../../src/client/pages/company/CompanyProjectDashboardPage.js';
import type { CompanyApi } from '../../src/client/components/company/company-api.js';

const SHA = 'c'.repeat(64);
const date = '2026-09-18T08:00:00.000Z';
const session = { user: { id: 'operator', displayName: '运营', role: 'operator' as const }, csrfToken: 'd'.repeat(43) };
const items = [
  { id: 'done', workspaceId: 'company', name: '已完成项目', clientName: '旧客户', status: 'completed' as const, projectRoot: 'projects/done', sourceRoot: 'incoming/done', configSha256: SHA, confidence: {}, createdAt: date, updatedAt: date, dataCoverage: 'not_configured' as const },
  { id: 'accept', workspaceId: 'company', name: '验收项目', clientName: '验收客户', status: 'acceptance' as const, projectRoot: 'projects/accept', sourceRoot: 'incoming/accept', configSha256: SHA, confidence: {}, createdAt: date, updatedAt: date, dataCoverage: 'not_configured' as const },
  { id: 'active', workspaceId: 'company', name: '服务中项目', clientName: '当前客户', status: 'active' as const, projectRoot: 'projects/active', sourceRoot: 'incoming/active', configSha256: SHA, confidence: {}, createdAt: date, updatedAt: date, dataCoverage: 'not_configured' as const }
];

function apiFixture(): CompanyApi {
  return { auth: { bootstrap: vi.fn(), login: vi.fn(), session: vi.fn(async () => ({ ok: true as const, value: session })), logout: vi.fn() }, projects: { list: vi.fn(async () => ({ ok: true as const, value: { items } })), scan: vi.fn(), draft: vi.fn(), confirm: vi.fn(), get: vi.fn() } } as CompanyApi;
}

afterEach(() => cleanup());

describe('CompanyProjectDashboardPage', () => {
  it('prioritizes active and acceptance projects and does not fake platform metrics', async () => {
    render(<MemoryRouter initialEntries={['/company/dashboard']}><Routes><Route element={<CompanyAppShell api={apiFixture()} initialSession={session} />}><Route path="company/dashboard" element={<CompanyProjectDashboardPage />} /></Route></Routes></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: '项目数据看板' })).toBeVisible();
    const rows = screen.getAllByRole('link').filter(link => link.className.includes('company-dashboard-row'));
    expect(rows[0]).toHaveTextContent('服务中项目');
    expect(rows[1]).toHaveTextContent('验收项目');
    expect(screen.getByText('尚未接入')).toBeVisible();
    expect(screen.getByText('待建立基线')).toBeVisible();
    expect(screen.queryByText('播放量 0')).not.toBeInTheDocument();
    expect(screen.getByText('需核对')).toBeVisible();
  });

  it('shows a truthful empty state when no projects exist', async () => {
    const api = apiFixture();
    api.projects.list = vi.fn(async () => ({ ok: true as const, value: { items: [] } }));
    render(<MemoryRouter initialEntries={['/company/dashboard']}><Routes><Route element={<CompanyAppShell api={api} initialSession={session} />}><Route path="company/dashboard" element={<CompanyProjectDashboardPage />} /></Route></Routes></MemoryRouter>);
    expect(await screen.findByText('还没有项目数据')).toBeVisible();
    expect(screen.getByRole('link', { name: /进入项目档案库/u })).toHaveAttribute('href', '/company/projects');
  });
});
