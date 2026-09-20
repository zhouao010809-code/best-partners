// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyProjectAssistant } from '../../src/client/components/company/CompanyProjectAssistant.js';
import type { CompanyProject } from '../../src/client/components/company/company-api.js';
import type { CompanyProjectMetrics } from '../../src/shared/api/company-metrics.js';

const SHA = 'a'.repeat(64);
const date = '2026-09-19T12:00:00.000Z';
const project: CompanyProject = {
  id: 'project-1', workspaceId: 'company', name: '明德教育代运营', clientName: '明德培训机构', status: 'active',
  projectRoot: 'projects/project-1', sourceRoot: 'incoming/project-1', configSha256: SHA, confidence: {}, selectedSkillIds: [],
  createdAt: date, updatedAt: date, dataCoverage: 'not_configured'
};

const metrics: CompanyProjectMetrics = {
  projectId: 'project-1', coverage: 'connected', snapshotCount: 2, contentCount: 4,
  totals: { views: 1200, likes: 8 }, latestMetricDate: '2026-09-19', latestObservedAt: date, lastImportedAt: date,
  platforms: [
    { platform: 'douyin', coverage: 'connected', snapshotCount: 2, contentCount: 4, totals: { views: 1200, likes: 8 }, latestMetricDate: '2026-09-19', latestObservedAt: date, lastImportedAt: date },
    { platform: 'xiaohongshu', coverage: 'import_required', snapshotCount: 0, contentCount: 0, totals: {}, latestMetricDate: null, latestObservedAt: null, lastImportedAt: null },
    { platform: 'wechat-channels', coverage: 'import_required', snapshotCount: 0, contentCount: 0, totals: {}, latestMetricDate: null, latestObservedAt: null, lastImportedAt: null }
  ],
  recentImports: []
};

afterEach(() => cleanup());

describe('CompanyProjectAssistant', () => {
  it('shows a read-only assistant entry with data date and gaps without metrics', () => {
    render(<CompanyProjectAssistant project={project} />);

    expect(screen.getByRole('heading', { name: '项目助理' })).toBeVisible();
    expect(screen.getByText('只读项目上下文')).toBeVisible();
    expect(screen.getByText('平台数据尚未建立基线')).toBeVisible();
    expect(screen.getByText(/数据日期/u)).toBeVisible();
    expect(screen.getByRole('button', { name: '分析项目现状' })).toBeVisible();
    expect(screen.getByRole('button', { name: '找平台异常' })).toBeVisible();
    expect(screen.getByRole('button', { name: '生成下周计划' })).toBeVisible();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('opens a controlled task prompt and copies it without exposing paths or credentials', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CompanyProjectAssistant project={project} metrics={metrics} />);

    fireEvent.click(screen.getByRole('button', { name: '分析项目现状' }));
    const task = screen.getByRole('region', { name: '项目助理任务' });
    expect(task).toBeVisible();
    expect(task).toHaveTextContent('不会直接修改项目文件');
    expect(task).toHaveTextContent('明德教育代运营');
    expect(task).toHaveTextContent('数据截至 2026-09-19');
    expect(task).not.toHaveTextContent('/Users/');
    expect(task).not.toHaveTextContent('api_key');
    expect(task).not.toHaveTextContent('密码');

    fireEvent.click(screen.getByRole('button', { name: '复制给 Codex' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain('分析项目现状');
    expect(await screen.findByText('已复制任务提示，可粘贴到 Codex 或 WorkBuddy')).toBeVisible();
  });

  it('keeps copy failure visible and allows retry', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('clipboard unavailable'))
      .mockResolvedValueOnce(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CompanyProjectAssistant project={project} />);
    fireEvent.click(screen.getByRole('button', { name: '找平台异常' }));
    fireEvent.click(screen.getByRole('button', { name: '复制给 Codex' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('复制失败');
    expect(screen.queryByText('已复制任务提示，可粘贴到 Codex 或 WorkBuddy')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试复制' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('已复制任务提示，可粘贴到 Codex 或 WorkBuddy')).toBeVisible();
  });
});
