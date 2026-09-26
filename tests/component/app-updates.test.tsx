import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsPage } from '../../src/client/pages/SettingsPage.js';
import type { UpdateSnapshot } from '../../src/shared/desktop/update.js';

const available = { status: 'available', currentVersion: '0.1.0', version: '0.1.1', releaseUrl: 'https://github.com/example/release', assetUrl: 'https://github.com/example/app.dmg', notes: '修复问问状态', download: { sha256: 'a'.repeat(64), size: 1000 } } as const;
const desktop = {
  getAppVersion: vi.fn(), getVaultInfo: vi.fn(), chooseVaultDirectory: vi.fn(),
  checkForUpdates: vi.fn(), openUpdateDownload: vi.fn(), getUpdateState: vi.fn(), onUpdateState: vi.fn(),
  downloadUpdate: vi.fn(), cancelUpdate: vi.fn(), installUpdate: vi.fn()
};
let current: UpdateSnapshot;
let updateListener: ((value: UpdateSnapshot) => void) | undefined;
const unsubscribe = vi.fn();
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => ({ health: { status: 'loading' }, refreshHealth: vi.fn() }) }));
vi.mock('../../src/client/components/DeepSeekSettings.js', () => ({ DeepSeekSettings: () => null }));
vi.mock('../../src/client/components/DocumentIssuesPanel.js', () => ({ DocumentIssuesPanel: () => null }));

beforeEach(() => {
  current = { result: available, transfer: { status: 'idle' }, automaticInstall: false };
  updateListener = undefined;
  Object.defineProperty(window, 'xiaozhaoDesktop', { configurable: true, value: desktop });
  desktop.getAppVersion.mockResolvedValue('0.1.0');
  desktop.getVaultInfo.mockResolvedValue({ displayName: '测试大脑', path: '/tmp/test-vault' });
  desktop.getUpdateState.mockImplementation(async () => current);
  desktop.onUpdateState.mockImplementation((listener) => { updateListener = listener; return unsubscribe; });
  desktop.checkForUpdates.mockResolvedValue(available);
  desktop.openUpdateDownload.mockResolvedValue(undefined);
  desktop.downloadUpdate.mockResolvedValue(undefined);
  desktop.cancelUpdate.mockResolvedValue(undefined);
  desktop.installUpdate.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'xiaozhaoDesktop'); vi.resetAllMocks(); });
function open() { return render(<MemoryRouter><SettingsPage /></MemoryRouter>); }
async function publish(value: UpdateSnapshot) {
  current = value;
  await act(async () => { updateListener?.(value); });
}

it('downloads an unsigned installer explicitly, reports real progress and opens it for manual replacement', async () => {
  const user = userEvent.setup(); open();
  expect(await screen.findByText('发现新版本 0.1.1')).toBeVisible();
  expect(screen.getByText('下载完成后打开安装包，按提示替换应用。')).toBeVisible();
  expect(desktop.downloadUpdate).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '下载更新' }));
  expect(desktop.downloadUpdate).toHaveBeenCalledTimes(1);
  await publish({ ...current, transfer: { status: 'downloading', version: available.version, mode: 'installer', receivedBytes: 250, totalBytes: 1000 } });
  expect(screen.getByRole('progressbar', { name: '更新下载进度' })).toHaveAttribute('value', '25');
  expect(screen.getByText('正在下载更新 · 25% · 已下载 250 B / 1000 B')).toBeVisible();
  expect(screen.getByRole('button', { name: '取消下载' })).toBeEnabled();
  await publish({ ...current, transfer: { status: 'ready', version: available.version, mode: 'installer' } });
  await user.click(screen.getByRole('button', { name: '打开安装包' }));
  expect(desktop.installUpdate).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: '重启并更新' })).not.toBeInTheDocument();
});

it('uses indeterminate progress when the updater has no total and allows cancelling an installer download', async () => {
  current.transfer = { status: 'downloading', version: available.version, mode: 'installer' };
  const user = userEvent.setup(); open();
  const progress = await screen.findByRole('progressbar', { name: '更新下载进度' });
  expect(progress).not.toHaveAttribute('value');
  await user.click(screen.getByRole('button', { name: '取消下载' }));
  expect(desktop.cancelUpdate).toHaveBeenCalledTimes(1);
  await publish({ ...current, transfer: { status: 'idle' } });
  expect(screen.getByRole('button', { name: '下载更新' })).toBeEnabled();
});

it('shows a connecting state instead of a stationary zero percent until the first bytes arrive', async () => {
  current.transfer = { status: 'downloading', version: available.version, mode: 'installer', receivedBytes: 0, totalBytes: 160 * 1024 * 1024 };
  const user = userEvent.setup(); open();
  expect(await screen.findByText('正在连接下载源…')).toBeVisible();
  expect(screen.getByRole('progressbar', { name: '更新下载进度' })).not.toHaveAttribute('value');
  expect(screen.queryByText(/0%/u)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '打开安装包' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '取消下载' }));
  expect(desktop.cancelUpdate).toHaveBeenCalledTimes(1);
});

it('makes sub-one-percent transfers visible with byte counts and one decimal percentage', async () => {
  current.transfer = { status: 'downloading', version: available.version, mode: 'installer', receivedBytes: 256 * 1024, totalBytes: 160 * 1024 * 1024 };
  open();
  expect(await screen.findByText('正在下载更新 · 0.2% · 已下载 256 KB / 160 MB')).toBeVisible();
  expect(screen.getByRole('progressbar', { name: '更新下载进度' })).toHaveAttribute('value', '0.15625');
  await publish({ ...current, transfer: { status: 'downloading', version: available.version, mode: 'installer', receivedBytes: 1024, totalBytes: 160 * 1024 * 1024 } });
  expect(screen.getByText('正在下载更新 · <0.1% · 已下载 1 KB / 160 MB')).toBeVisible();
});

it('shows received bytes even when the download total is unknown', async () => {
  current.transfer = { status: 'downloading', version: available.version, mode: 'installer', receivedBytes: 1.5 * 1024 * 1024 };
  open();
  expect(await screen.findByText('正在下载更新 · 已下载 1.5 MB')).toBeVisible();
  expect(screen.getByRole('progressbar', { name: '更新下载进度' })).not.toHaveAttribute('value');
  expect(screen.queryByText('正在连接下载源…')).not.toBeInTheDocument();
});

it('keeps the installer unavailable at one hundred percent until verification reports ready', async () => {
  current.transfer = { status: 'downloading', version: available.version, mode: 'installer', receivedBytes: 1000, totalBytes: 1000 };
  open();
  expect(await screen.findByText('正在下载更新 · 100% · 已下载 1000 B / 1000 B')).toBeVisible();
  expect(screen.queryByRole('button', { name: '打开安装包' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '取消下载' })).toBeEnabled();
  await publish({ ...current, transfer: { status: 'error', message: '安装包校验失败，请重试下载。' } });
  expect(screen.getByRole('alert')).toHaveTextContent('安装包校验失败');
  expect(screen.getByRole('button', { name: '重试下载' })).toBeEnabled();
  expect(desktop.installUpdate).not.toHaveBeenCalled();
});

it('only offers restart installation with both automatic capability and an automatic release manifest', async () => {
  current = { ...current, automaticInstall: true, result: { ...available, automaticUpdateUrl: 'https://github.com/example/update.json' } };
  const user = userEvent.setup(); open();
  expect(await screen.findByText('下载完成后，重启应用即可完成更新。')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '下载更新' }));
  await publish({ ...current, transfer: { status: 'downloading', version: available.version, mode: 'automatic' } });
  expect(screen.queryByRole('button', { name: '取消下载' })).not.toBeInTheDocument();
  await publish({ ...current, transfer: { status: 'ready', version: available.version, mode: 'automatic' } });
  await user.click(screen.getByRole('button', { name: '重启并更新' }));
  expect(desktop.installUpdate).toHaveBeenCalledTimes(1);
  await publish({ ...current, transfer: { status: 'installing', version: available.version } });
  expect(screen.getByText('正在重启并安装更新…')).toBeVisible();
});

it.each([false, true])('uses manual installer wording when automatic manifest is missing (capability %s)', async (automaticInstall) => {
  current.automaticInstall = automaticInstall;
  open();
  expect(await screen.findByText('下载完成后打开安装包，按提示替换应用。')).toBeVisible();
  expect(screen.queryByText('下载完成后，重启应用即可完成更新。')).not.toBeInTheDocument();
});

it('does not promise automatic installation from manifest data without local signing support', async () => {
  current.result = { ...available, automaticUpdateUrl: 'https://github.com/example/update.json' };
  open();
  expect(await screen.findByText('下载完成后打开安装包，按提示替换应用。')).toBeVisible();
  expect(screen.queryByText('下载完成后，重启应用即可完成更新。')).not.toBeInTheDocument();
});

it('keeps release-page fallback when the manifest has no download digest', async () => {
  const { download: _download, ...legacy } = available;
  current.result = legacy;
  const user = userEvent.setup(); open();
  await user.click(await screen.findByRole('button', { name: '打开下载页面' }));
  expect(desktop.openUpdateDownload).toHaveBeenCalledExactlyOnceWith(available.assetUrl);
  expect(screen.queryByRole('button', { name: '下载更新' })).not.toBeInTheDocument();
  expect(desktop.downloadUpdate).not.toHaveBeenCalled();
});

it('allows native automatic download without manual-installer metadata when signing support and the automatic manifest are available', async () => {
  const { download: _download, ...release } = available;
  current = { ...current, automaticInstall: true, result: { ...release, automaticUpdateUrl: 'https://github.com/example/update.json' } };
  const user = userEvent.setup(); open();
  expect(await screen.findByText('下载完成后，重启应用即可完成更新。')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '下载更新' }));
  expect(desktop.downloadUpdate).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: '打开下载页面' })).not.toBeInTheDocument();
});

it('restores a completed download after leaving and returning to settings', async () => {
  const view = open();
  await screen.findByRole('button', { name: '下载更新' });
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  current.transfer = { status: 'ready', version: available.version, mode: 'installer' };
  open();
  expect(await screen.findByRole('button', { name: '打开安装包' })).toBeEnabled();
  expect(desktop.downloadUpdate).not.toHaveBeenCalled();
});

it('does not let a late initial snapshot overwrite a newer update event', async () => {
  let resolveInitial!: (snapshot: UpdateSnapshot) => void;
  desktop.getUpdateState.mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }));
  const stale = current;
  open();
  await waitFor(() => expect(desktop.onUpdateState).toHaveBeenCalledTimes(1));
  await publish({ ...current, transfer: { status: 'ready', version: available.version, mode: 'installer' } });
  await act(async () => { resolveInitial(stale); });
  expect(screen.getByRole('button', { name: '打开安装包' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '下载更新' })).not.toBeInTheDocument();
});

it('allows retrying a failed download without losing the release information', async () => {
  desktop.downloadUpdate.mockRejectedValueOnce(new Error('download failed'));
  const user = userEvent.setup(); open();
  await user.click(await screen.findByRole('button', { name: '下载更新' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('下载未完成，请重试');
  expect(screen.getByText('发现新版本 0.1.1')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '重试下载' }));
  expect(desktop.downloadUpdate).toHaveBeenCalledTimes(2);
});

it('restores a background transfer failure with a retry and clears it when a new transfer starts', async () => {
  current.transfer = { status: 'error', message: '更新下载已中断，请重试。' };
  const user = userEvent.setup(); open();
  expect(await screen.findByRole('alert')).toHaveTextContent('更新下载已中断');
  await user.click(screen.getByRole('button', { name: '重试下载' }));
  expect(desktop.downloadUpdate).toHaveBeenCalledTimes(1);
  await publish({ ...current, transfer: { status: 'downloading', version: available.version, mode: 'installer' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('keeps cancellation usable while the download command itself is pending', async () => {
  let resolveDownload!: () => void;
  desktop.downloadUpdate.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveDownload = resolve; }));
  const user = userEvent.setup(); open();
  await user.dblClick(await screen.findByRole('button', { name: '下载更新' }));
  expect(desktop.downloadUpdate).toHaveBeenCalledTimes(1);
  await publish({ ...current, transfer: { status: 'downloading', version: available.version, mode: 'installer' } });
  await user.click(screen.getByRole('button', { name: '取消下载' }));
  expect(desktop.cancelUpdate).toHaveBeenCalledTimes(1);
  await act(async () => { resolveDownload(); });
});

it('keeps a ready installer available for another open attempt after an opening failure', async () => {
  current.transfer = { status: 'ready', version: available.version, mode: 'installer' };
  desktop.installUpdate.mockRejectedValueOnce(new Error('cannot open'));
  const user = userEvent.setup(); open();
  await user.click(await screen.findByRole('button', { name: '打开安装包' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('未能打开安装包，请重试');
  await user.click(screen.getByRole('button', { name: '打开安装包' }));
  expect(desktop.installUpdate).toHaveBeenCalledTimes(2);
});
