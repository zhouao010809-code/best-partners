import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createUpdateController } from '../../src/electron/update-controller.js';
import type { UpdateCheckResult } from '../../src/shared/desktop/update.js';

const available: UpdateCheckResult = { status: 'available', currentVersion: '0.1.0', version: '0.1.1', notes: '修复', releaseUrl: 'https://github.com/zhouao010809-code/best-partners/releases/tag/v0.1.1', assetUrl: 'https://github.com/zhouao010809-code/best-partners/releases/download/v0.1.1/app-arm64.dmg', download: { sha256: 'a'.repeat(64), size: 12 }, automaticUpdateUrl: 'https://github.com/zhouao010809-code/best-partners/releases/download/v0.1.1/RELEASES.json' };
function fixture(automaticInstall = false) {
  const native = Object.assign(new EventEmitter(), { setFeedURL: vi.fn(), checkForUpdates: vi.fn() });
  const dependencies = { automaticInstall, native, directory: '/unused', check: vi.fn(async () => available),
    download: vi.fn(async () => '/unused/installer-test/update.dmg'), verify: vi.fn(async () => {}),
    openInstaller: vi.fn(async () => ''), requestInstall: vi.fn(), changed: vi.fn(), cleanup: vi.fn(async () => {}) };
  const controller = createUpdateController(dependencies);
  return { ...dependencies, controller };
}
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };

it('requires a main-process checked release before starting', async () => {
  const f = fixture(); await f.controller.downloadUpdate();
  expect(f.download).not.toHaveBeenCalled();
  expect(f.controller.snapshot().transfer.status).toBe('error');
});

it('downloads a verified installer once, retains state across snapshots, and rechecks before opening', async () => {
  const f = fixture(); await f.controller.checkForUpdates();
  await Promise.all([f.controller.downloadUpdate(), f.controller.downloadUpdate()]); await tick();
  expect(f.download).toHaveBeenCalledTimes(1);
  expect(f.controller.snapshot().transfer).toEqual({ status: 'ready', version: '0.1.1', mode: 'installer' });
  await f.controller.installUpdate();
  expect(f.verify).toHaveBeenCalledWith('/unused/installer-test/update.dmg', 'a'.repeat(64), 12);
  expect(f.openInstaller).toHaveBeenCalledWith('/unused/installer-test/update.dmg');
  expect(f.native.checkForUpdates).not.toHaveBeenCalled();
  expect(f.requestInstall).not.toHaveBeenCalled();
});

it('keeps the ready installer for retry when macOS cannot open it', async () => {
  const f = fixture(); await f.controller.checkForUpdates(); await f.controller.downloadUpdate(); await tick();
  f.openInstaller.mockResolvedValueOnce('no handler');
  await expect(f.controller.installUpdate()).rejects.toThrow('未能打开安装包');
  expect(f.controller.snapshot().transfer.status).toBe('ready');
  await f.controller.installUpdate(); expect(f.openInstaller).toHaveBeenCalledTimes(2);
});

it('cancels only installer downloads, discards late completion, and lets a later download succeed', async () => {
  const f = fixture(); let finish!: (value: string) => void;
  f.download.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await f.controller.checkForUpdates(); await f.controller.downloadUpdate();
  await f.controller.cancelUpdate(); finish('/unused/cancelled/update.dmg'); await tick();
  expect(f.controller.snapshot().transfer.status).toBe('idle');
  expect(f.cleanup).toHaveBeenCalledWith('/unused/cancelled/update.dmg');
  await f.controller.downloadUpdate(); await tick();
  expect(f.controller.snapshot().transfer.status).toBe('ready');
});

it('maps download failure without leaking paths and supports retry', async () => {
  const f = fixture(); f.download.mockRejectedValueOnce(new Error('/private/secrets'));
  await f.controller.checkForUpdates(); await f.controller.downloadUpdate(); await tick();
  expect(f.controller.snapshot().transfer).toEqual({ status: 'error', message: '更新下载或校验失败，请重试；也可打开下载页面。' });
  await f.controller.downloadUpdate(); await tick(); expect(f.controller.snapshot().transfer.status).toBe('ready');
});

it('uses native updater only for a signed application and waits for downloaded before installation', async () => {
  const f = fixture(true); await f.controller.checkForUpdates(); await f.controller.downloadUpdate();
  expect(f.native.setFeedURL).toHaveBeenCalledWith({ url: available.automaticUpdateUrl, serverType: 'json' });
  await f.controller.installUpdate(); expect(f.requestInstall).not.toHaveBeenCalled();
  f.native.emit('update-downloaded');
  await f.controller.installUpdate();
  expect(f.requestInstall).toHaveBeenCalledTimes(1);
  f.controller.installCancelled();
  expect(f.controller.snapshot().transfer).toEqual({ status: 'ready', version: '0.1.1', mode: 'automatic' });
  expect(f.download).not.toHaveBeenCalled();
});

it('preserves a pending native download on repeated check/cancel and recovers from native errors', async () => {
  const f = fixture(true); await f.controller.checkForUpdates(); await f.controller.downloadUpdate();
  await f.controller.checkForUpdates(); await f.controller.cancelUpdate(); await f.controller.downloadUpdate();
  expect(f.check).toHaveBeenCalledTimes(1); expect(f.native.checkForUpdates).toHaveBeenCalledTimes(1);
  f.native.emit('error', new Error('private')); expect(f.controller.snapshot().transfer.status).toBe('error');
  await f.controller.downloadUpdate(); expect(f.native.checkForUpdates).toHaveBeenCalledTimes(2);
});

it('restores the downloaded update if restart preparation fails', async () => {
  const f = fixture(true); await f.controller.checkForUpdates(); await f.controller.downloadUpdate();
  f.native.emit('update-downloaded');
  f.requestInstall.mockImplementationOnce(() => { throw new Error('quit failed'); });
  await expect(f.controller.installUpdate()).rejects.toThrow('未能重启');
  expect(f.controller.snapshot().transfer).toEqual({ status: 'ready', version: '0.1.1', mode: 'automatic' });
});

it.each([
  ['UPDATE_CONNECTION_TIMEOUT', '连接更新服务器超时'],
  ['UPDATE_FIRST_BYTE_TIMEOUT', '未收到安装包数据'],
  ['UPDATE_DOWNLOAD_STALLED', '没有收到新数据'],
  ['UPDATE_DOWNLOAD_TIMEOUT', '超过 15 分钟']
])('explains %s without leaking diagnostic paths and permits retry', async (code, expected) => {
  const f = fixture(); f.download.mockRejectedValueOnce(Object.assign(new Error('/private/network/secrets'), { code }));
  await f.controller.checkForUpdates(); await f.controller.downloadUpdate(); await tick();
  const transfer = f.controller.snapshot().transfer;
  expect(transfer).toMatchObject({ status: 'error', message: expect.stringContaining(expected) });
  expect(transfer).toMatchObject({ message: expect.stringContaining('重试') });
  expect(JSON.stringify(transfer)).not.toContain('/private');
  await f.controller.downloadUpdate(); await tick(); expect(f.controller.snapshot().transfer.status).toBe('ready');
});

it('does not show a late timeout from a cancelled download over idle or a retry', async () => {
  const f = fixture(); let reject!: (error: Error) => void;
  f.download.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await f.controller.checkForUpdates(); await f.controller.downloadUpdate(); await f.controller.cancelUpdate();
  reject(Object.assign(new Error('internal'), { code: 'UPDATE_DOWNLOAD_STALLED' })); await tick();
  expect(f.controller.snapshot().transfer.status).toBe('idle');
  await f.controller.downloadUpdate(); await tick(); expect(f.controller.snapshot().transfer.status).toBe('ready');
});
