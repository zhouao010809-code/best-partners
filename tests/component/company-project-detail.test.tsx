// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CompanyAppShell } from '../../src/client/company/CompanyAppShell.js';
import { CompanyProjectDetailPage } from '../../src/client/pages/company/CompanyProjectDetailPage.js';
import type { CompanyApi } from '../../src/client/components/company/company-api.js';
import type { CompanyProjectMetrics } from '../../src/shared/api/company-metrics.js';

const SHA = 'a'.repeat(64);
const date = '2026-09-19T12:00:00.000Z';
const session = { user: { id: 'operator', displayName: '运营', role: 'operator' as const }, csrfToken: 'b'.repeat(43) };
const project = {
  id: 'project-1', workspaceId: 'company', name: '明德教育代运营', clientName: '明德培训机构', status: 'active' as const,
  projectRoot: 'projects/project-1', sourceRoot: 'incoming/project-1', configSha256: SHA, confidence: {}, selectedSkillIds: [],
  createdAt: date, updatedAt: date, dataCoverage: 'not_configured' as const
};

function apiFixture(): CompanyApi {
  return {
    auth: { bootstrap: vi.fn(), login: vi.fn(), session: vi.fn(async () => ({ ok: true as const, value: session })), logout: vi.fn() },
    projects: { list: vi.fn(), scan: vi.fn(), draft: vi.fn(), confirm: vi.fn(), get: vi.fn(async () => ({ ok: true as const, value: project })) },
    skills: { list: vi.fn(), get: vi.fn() },
    metrics: {
      project: vi.fn(async () => ({
        ok: true as const,
        value: {
          projectId: 'project-1', coverage: 'connected' as const, snapshotCount: 1, contentCount: 1,
          totals: { views: 1200, likes: 8 }, latestMetricDate: '2026-09-19', latestObservedAt: date, lastImportedAt: date,
          platforms: [
            { platform: 'douyin' as const, coverage: 'connected' as const, snapshotCount: 1, contentCount: 1, totals: { views: 1200, likes: 8 }, latestMetricDate: '2026-09-19', latestObservedAt: date, lastImportedAt: date },
            { platform: 'xiaohongshu' as const, coverage: 'import_required' as const, snapshotCount: 0, contentCount: 0, totals: {}, latestMetricDate: null, latestObservedAt: null, lastImportedAt: null },
            { platform: 'wechat-channels' as const, coverage: 'import_required' as const, snapshotCount: 0, contentCount: 0, totals: {}, latestMetricDate: null, latestObservedAt: null, lastImportedAt: null }
          ],
          recentImports: [{
            id: 'import-1', workspaceId: 'company', projectId: 'project-1', platform: 'douyin',
            sourceRelativePath: 'platform-data/douyin/project-1/export.csv', rawRelativePath: 'platform-data/raw/douyin/project-1/hash-export.csv',
            sourceSha256: SHA, sourceType: 'official-export' as const, state: 'imported' as const, rowCount: 1, importedCount: 1, rejectedCount: 0,
            issues: [], createdAt: date, updatedAt: date, importedAt: date
          }]
        } as CompanyProjectMetrics
      })),
      status: vi.fn(), scan: vi.fn(), import: vi.fn(), upload: vi.fn(async () => ({
        ok: true as const,
        value: {
          id: 'import-upload', workspaceId: 'company', projectId: 'project-1', platform: 'douyin' as const,
          sourceRelativePath: 'platform-data/douyin/project-1/hash-export.csv', rawRelativePath: 'platform-data/raw/douyin/project-1/hash-export.csv',
          sourceSha256: SHA, sourceType: 'official-export' as const, state: 'imported' as const,
          rowCount: 1, importedCount: 1, rejectedCount: 0, issues: [], createdAt: date, updatedAt: date, importedAt: date
        }
      }))
    }
  };
}

afterEach(() => cleanup());

describe('CompanyProjectDetailPage', () => {
  it('shows imported metrics, source history, and the project drop folders', async () => {
    render(<MemoryRouter initialEntries={['/company/projects/project-1']}><Routes><Route element={<CompanyAppShell api={apiFixture()} initialSession={session} />}><Route path="company/projects/:id" element={<CompanyProjectDetailPage />} /></Route></Routes></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: '明德教育代运营' })).toBeVisible();
    expect(screen.getAllByText('数据已同步').length).toBeGreaterThan(0);
    expect(screen.getByText('1,200')).toBeVisible();
    expect(screen.getByText(/来源：官方后台导出/u)).toBeVisible();
    expect(screen.getByText('platform-data/douyin/project-1/export.csv')).toBeVisible();
    expect(screen.getByText('platform-data/xiaohongshu/project-1/')).toBeVisible();
  });

  it('lets an operator choose a platform export and imports it without manual metric entry', async () => {
    const api = apiFixture();
    render(<MemoryRouter initialEntries={['/company/projects/project-1']}><Routes><Route element={<CompanyAppShell api={api} initialSession={session} />}><Route path="company/projects/:id" element={<CompanyProjectDetailPage />} /></Route></Routes></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: '明德教育代运营' })).toBeVisible();

    const file = new File(['作品ID,数据日期,播放量\nitem-upload,2026-09-19,1300\n'], '抖音官方导出.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('官方导出文件'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: '校验并导入' }));

    await waitFor(() => expect(api.metrics?.upload).toHaveBeenCalledWith('project-1', 'douyin', file));
    expect(await screen.findByText('文件已导入，指标看板已刷新。')).toBeVisible();
  });

  it('keeps the upload control read-only for reviewers', async () => {
    const reviewerSession = { ...session, user: { ...session.user, role: 'reviewer' as const, displayName: '老板' } };
    render(<MemoryRouter initialEntries={['/company/projects/project-1']}><Routes><Route element={<CompanyAppShell api={apiFixture()} initialSession={reviewerSession} />}><Route path="company/projects/:id" element={<CompanyProjectDetailPage />} /></Route></Routes></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: '明德教育代运营' })).toBeVisible();
    expect(screen.getByText(/当前账号只能查看导入记录/u)).toBeVisible();
    expect(screen.queryByLabelText('官方导出文件')).not.toBeInTheDocument();
  });
});
