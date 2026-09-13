import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsPage } from '../../src/client/pages/SettingsPage.js';

const desktop = { getAppVersion: vi.fn(), getVaultInfo: vi.fn(), openVaultDirectory: vi.fn(), chooseVaultDirectory: vi.fn() };
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => ({ health: { status: 'loading' }, refreshHealth: vi.fn() }) }));
vi.mock('../../src/client/components/DeepSeekSettings.js', () => ({ DeepSeekSettings: () => null }));
vi.mock('../../src/client/components/DocumentIssuesPanel.js', () => ({ DocumentIssuesPanel: () => null }));
beforeEach(() => {
  Object.defineProperty(window, 'xiaozhaoDesktop', { configurable: true, value: desktop });
  desktop.getAppVersion.mockResolvedValue('0.1.0');
  desktop.getVaultInfo.mockResolvedValue({ displayName: '当前大脑', path: '/Users/example/Documents/当前大脑' });
  desktop.openVaultDirectory.mockResolvedValue(undefined);
  desktop.chooseVaultDirectory.mockResolvedValue({ selected: false, reason: 'unchanged' });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'xiaozhaoDesktop'); vi.resetAllMocks(); });
function open() { render(<MemoryRouter><SettingsPage /></MemoryRouter>); }

it('shows the actual desktop vault path and opens that vault without passing a user-controlled path', async () => {
  const user = userEvent.setup();
  open();
  expect(await screen.findByText('/Users/example/Documents/当前大脑')).toBeVisible();
  expect(screen.getByText('当前大脑')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '在 Finder 中打开' }));
  expect(desktop.openVaultDirectory).toHaveBeenCalledExactlyOnceWith();
  expect(desktop.chooseVaultDirectory).not.toHaveBeenCalled();
  expect(screen.getByText('版本 0.1.0')).toBeVisible();
  expect(screen.queryByText('自动归档尚未启用。新资料在收件箱预览，确认后再归档。')).not.toBeInTheDocument();
});

it('recovers from a failed location read without inventing a current path', async () => {
  desktop.getVaultInfo.mockRejectedValueOnce(new Error('unavailable'));
  const user = userEvent.setup();
  open();
  expect(await screen.findByText('未能读取文件夹位置')).toBeVisible();
  expect(screen.queryByText('/Users/example/Documents/当前大脑')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '重新读取位置' }));
  expect(await screen.findByText('/Users/example/Documents/当前大脑')).toBeVisible();
});

it('makes a failed Finder request actionable and can retry', async () => {
  desktop.openVaultDirectory.mockRejectedValueOnce(new Error('native open failed'));
  const user = userEvent.setup();
  open();
  await user.click(await screen.findByRole('button', { name: '在 Finder 中打开' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('未能打开文件夹');
  await user.click(screen.getByRole('button', { name: '在 Finder 中打开' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(desktop.openVaultDirectory).toHaveBeenCalledTimes(2);
});

it('explains selecting the current folder without reporting cancellation or a restart', async () => {
  const user = userEvent.setup();
  open();
  await user.click(screen.getByRole('button', { name: '更换大脑文件夹' }));
  expect(await screen.findByText('已在使用这个大脑，无需更换。')).toBeVisible();
  expect(screen.queryByText('已取消，继续使用当前大脑文件夹')).not.toBeInTheDocument();
});
