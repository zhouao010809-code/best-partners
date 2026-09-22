import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsPage } from '../../src/client/pages/SettingsPage.js';

const desktop = {
  getAppVersion: vi.fn(), getVaultInfo: vi.fn(), openVaultDirectory: vi.fn(), chooseVaultDirectory: vi.fn(),
  checkForUpdates: vi.fn(), openUpdateDownload: vi.fn()
};
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => ({ health: { status: 'loading' }, refreshHealth: vi.fn() }) }));
vi.mock('../../src/client/components/DeepSeekSettings.js', () => ({ DeepSeekSettings: () => null }));
vi.mock('../../src/client/components/DocumentIssuesPanel.js', () => ({ DocumentIssuesPanel: () => null }));

beforeEach(() => {
  Object.defineProperty(window, 'xiaozhaoDesktop', { configurable: true, value: desktop });
  desktop.getAppVersion.mockResolvedValue('0.1.0');
  desktop.getVaultInfo.mockResolvedValue({ displayName: '当前大脑', path: '/Users/example/Documents/当前大脑' });
  desktop.openVaultDirectory.mockResolvedValue(undefined);
  desktop.chooseVaultDirectory.mockResolvedValue({ selected: false, reason: 'unchanged' });
  desktop.openUpdateDownload.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'xiaozhaoDesktop'); vi.resetAllMocks(); });
function open() { render(<MemoryRouter><SettingsPage /></MemoryRouter>); }

it('shows an available update with plain-text notes and opens the asset URL', async () => {
  desktop.checkForUpdates.mockResolvedValue({ status: 'available', currentVersion: '0.1.0', version: '0.1.1', releaseUrl: 'https://github.com/example/release', assetUrl: 'https://github.com/example/app.dmg', notes: '修复\n第二行' });
  const user = userEvent.setup(); open();
  expect(screen.queryByText('当前版本 0.1.0')).not.toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: '检查应用更新' }));
  expect(await screen.findByText('发现新版本 0.1.1')).toBeVisible();
  expect(screen.getByText('当前版本 0.1.0')).toBeVisible();
  expect(screen.getByText((_, element) => Boolean(element?.classList.contains('settings-updates__notes') && element.textContent === '修复\n第二行'))).toBeVisible();
  await user.click(screen.getByRole('button', { name: '打开下载页面' }));
  expect(desktop.openUpdateDownload).toHaveBeenCalledExactlyOnceWith('https://github.com/example/app.dmg');
  await user.click(screen.getByRole('button', { name: '查看 Release 页面' }));
  expect(desktop.openUpdateDownload).toHaveBeenCalledWith('https://github.com/example/release');
});

it('shows up-to-date result', async () => {
  desktop.checkForUpdates.mockResolvedValue({ status: 'up-to-date', currentVersion: '0.1.0', checkedAt: '2026-09-21T00:00:00.000Z' });
  const user = userEvent.setup(); open();
  await user.click(await screen.findByRole('button', { name: '检查应用更新' }));
  expect(await screen.findByText('已是最新版本')).toBeVisible();
});

it('explains that browser preview cannot check updates when bridge is absent', async () => {
  Reflect.deleteProperty(window, 'xiaozhaoDesktop');
  open();
  expect(await screen.findByText('桌面版可用，浏览器预览不会检查应用更新。')).toBeVisible();
  expect(screen.queryByRole('button', { name: '检查应用更新' })).not.toBeInTheDocument();
});

it('recovers from a failed check with retry and deduplicates pending clicks', async () => {
  let resolve!: (value: unknown) => void;
  desktop.checkForUpdates.mockImplementationOnce(() => new Promise((r) => { resolve = r; })).mockResolvedValueOnce({ status: 'up-to-date', currentVersion: '0.1.0', checkedAt: '2026-09-21T00:00:00.000Z' });
  const user = userEvent.setup(); open();
  const button = await screen.findByRole('button', { name: '检查应用更新' });
  await user.click(button); await user.click(button);
  expect(desktop.checkForUpdates).toHaveBeenCalledTimes(1);
  resolve(Promise.reject(new Error('offline')));
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法检查');
  await user.click(screen.getByRole('button', { name: '重试检查' }));
  await waitFor(() => expect(screen.getByText('已是最新版本')).toBeVisible());
});

it('keeps the update card and reports an actionable download error', async () => {
  desktop.checkForUpdates.mockResolvedValue({ status: 'available', currentVersion: '0.1.0', version: '0.1.1', releaseUrl: 'https://github.com/example/release', assetUrl: 'https://github.com/example/app.dmg', notes: '修复' });
  desktop.openUpdateDownload.mockRejectedValueOnce(new Error('failed'));
  const user = userEvent.setup(); open();
  await user.click(await screen.findByRole('button', { name: '检查应用更新' }));
  await user.click(await screen.findByRole('button', { name: '打开下载页面' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('未能打开下载页面');
  expect(screen.getByText('发现新版本 0.1.1')).toBeVisible();
});

it('reports a release-page opening failure while keeping the update card', async () => {
  desktop.checkForUpdates.mockResolvedValue({ status: 'available', currentVersion: '0.1.0', version: '0.1.1', releaseUrl: 'https://github.com/example/release', assetUrl: 'https://github.com/example/app.dmg', notes: '修复' });
  desktop.openUpdateDownload.mockRejectedValueOnce(new Error('failed'));
  const user = userEvent.setup(); open();
  await user.click(await screen.findByRole('button', { name: '检查应用更新' }));
  await user.click(await screen.findByRole('button', { name: '查看 Release 页面' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('未能打开下载页面');
  expect(screen.getByText('发现新版本 0.1.1')).toBeVisible();
});
