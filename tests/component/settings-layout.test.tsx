// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsPage } from '../../src/client/pages/SettingsPage.js';

const { runtime } = vi.hoisted(() => ({
  runtime: {
    health: {
      status: 'ready' as const,
      data: {
        status: 'ready' as const,
        vaultSource: { status: 'ready' as const, adapter: 'filesystem' as const, displayName: '我的大脑' },
        index: { status: 'ready' as const, version: 47, refreshedAt: '2026-09-21T00:00:00.000Z' },
        model: { status: 'configured' as const, providerHost: 'api.deepseek.com', name: 'deepseek-v4-flash' },
        writeGate: { status: 'blocked' as const, missing: [], fingerprintMatches: true },
        schemaIssues: { status: 'available' as const, count: 3 }
      }
    },
    api: {},
    refreshHealth: vi.fn()
  }
}));

const desktop = {
  getAppVersion: vi.fn(), getVaultInfo: vi.fn(), openVaultDirectory: vi.fn(), chooseVaultDirectory: vi.fn(),
  checkForUpdates: vi.fn(), openUpdateDownload: vi.fn()
};

vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));
vi.mock('../../src/client/components/DeepSeekSettings.js', () => ({
  DeepSeekSettings: () => <section aria-label="AI 模型"><h2>AI 模型</h2></section>
}));
vi.mock('../../src/client/components/DocumentIssuesPanel.js', () => ({
  DocumentIssuesPanel: () => <div data-testid="document-issues-panel">详情列表</div>
}));

beforeEach(() => {
  Object.defineProperty(window, 'xiaozhaoDesktop', { configurable: true, value: desktop });
  desktop.getAppVersion.mockResolvedValue('0.1.0');
  desktop.getVaultInfo.mockResolvedValue({ displayName: '我的大脑', path: '/Users/example/Documents/我的大脑' });
  desktop.openVaultDirectory.mockResolvedValue(undefined);
  desktop.chooseVaultDirectory.mockResolvedValue({ selected: false, reason: 'unchanged' });
  desktop.checkForUpdates.mockResolvedValue({ status: 'up-to-date', currentVersion: '0.1.0', checkedAt: '2026-09-21T00:00:00.000Z' });
});

afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'xiaozhaoDesktop'); vi.resetAllMocks(); });

function open() { render(<MemoryRouter><SettingsPage /></MemoryRouter>); }

it('puts the three primary cards and one current-version label on the settings surface', async () => {
  open();
  expect(screen.getByRole('heading', { name: '大脑文件夹' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'AI 模型' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '应用更新' })).toBeVisible();
  expect(await screen.findByText('版本 0.1.0')).toBeVisible();
  expect(screen.getAllByText('版本 0.1.0')).toHaveLength(1);
  expect(screen.queryByText('本地桌面应用')).not.toBeInTheDocument();
});

it('shows a compact issue alert and keeps the detailed panel closed until requested', async () => {
  const user = userEvent.setup();
  open();
  expect(screen.getByRole('status', { name: '资料检查提醒' })).toHaveTextContent('3 项资料待确认');
  expect(screen.queryByTestId('document-issues-panel')).not.toBeInTheDocument();
  const detailsToggle = screen.getByRole('button', { name: /^待确认资料/u });
  expect(detailsToggle).toHaveAttribute('aria-expanded', 'false');
  expect(document.getElementById('settings-document-issues')).toHaveAttribute('hidden');
  await user.click(screen.getByRole('button', { name: '查看待确认资料' }));
  expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
  expect(document.getElementById('settings-document-issues')).not.toHaveAttribute('hidden');
  expect(await screen.findByTestId('document-issues-panel')).toBeVisible();
});

it('keeps the runtime summary compact while advanced diagnostics remain collapsible', async () => {
  const user = userEvent.setup();
  open();
  expect(screen.getByTestId('schema-issue-count')).toHaveTextContent('3 个结构问题');
  expect(screen.getByText('索引 v47')).toBeVisible();
  expect(screen.queryByText('本地索引')).not.toBeInTheDocument();
  const diagnostics = screen.getByRole('button', { name: /高级诊断/u });
  expect(diagnostics).toHaveAttribute('aria-expanded', 'false');
  await user.click(diagnostics);
  expect(diagnostics).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('旧版通用写入门')).toBeVisible();
});
