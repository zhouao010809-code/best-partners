import type { EventEmitter } from 'node:events';
import { dirname } from 'node:path';
import { rm } from 'node:fs/promises';
import type { UpdateCheckResult, UpdateSnapshot, UpdateTransferState } from '../shared/desktop/update.js';
import { downloadUpdateInstaller, verifyInstaller, type InstallerDownloadInput } from './update-download.js';

type NativeUpdater = Pick<EventEmitter, 'on' | 'removeListener'> & {
  setFeedURL(options: { url: string; serverType: 'json' }): void;
  checkForUpdates(): void;
};
type Dependencies = {
  automaticInstall: boolean; native: NativeUpdater; directory: string;
  check(): Promise<UpdateCheckResult>;
  changed(state: UpdateSnapshot): void;
  openInstaller(path: string): Promise<string>;
  requestInstall(): void;
  download?(input: InstallerDownloadInput): Promise<string>;
  verify?(path: string, sha256: string, size: number): Promise<void>;
  cleanup?(path: string): Promise<void>;
};

export function createUpdateController(input: Dependencies) {
  let result: UpdateCheckResult | undefined;
  let transfer: UpdateTransferState = { status: 'idle' };
  let pendingCheck: Promise<UpdateCheckResult> | undefined;
  let abort: AbortController | undefined;
  let installer: string | undefined;
  let operation = 0;
  let opening = false;
  const cleanup = input.cleanup ?? ((path: string) => rm(dirname(path), { recursive: true, force: true }));
  const snapshot = (): UpdateSnapshot => structuredClone({ ...(result ? { result } : {}), transfer, automaticInstall: input.automaticInstall });
  const update = (state: UpdateTransferState) => { transfer = state; input.changed(snapshot()); };
  const failure = (error?: unknown) => {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    const message = code === 'UPDATE_CONNECTION_TIMEOUT' ? '连接更新服务器超时，请检查网络或代理后重试；也可打开下载页面。'
      : code === 'UPDATE_FIRST_BYTE_TIMEOUT' ? '已连接更新服务器，但未收到安装包数据，请检查网络或代理后重试；也可打开下载页面。'
      : code === 'UPDATE_DOWNLOAD_STALLED' ? '更新下载一段时间内没有收到新数据，请检查网络后重试；也可打开下载页面。'
      : code === 'UPDATE_DOWNLOAD_TIMEOUT' ? '更新下载超过 15 分钟，请检查网络后重试；也可打开下载页面。'
      : '更新下载或校验失败，请重试；也可打开下载页面。';
    update({ status: 'error', message });
  };
  const nativePending = () => transfer.status === 'downloading' && transfer.mode === 'automatic';
  const onError = () => { if (nativePending()) failure(); };
  const onDownloaded = () => {
    if (nativePending() && result?.status === 'available') update({ status: 'ready', version: result.version, mode: 'automatic' });
  };
  const onNotAvailable = () => { if (nativePending()) update({ status: 'error', message: '这个更新暂时无法下载，请重新检查更新。' }); };
  input.native.on('error', onError);
  input.native.on('update-downloaded', onDownloaded);
  input.native.on('update-not-available', onNotAvailable);

  return {
    snapshot,
    async checkForUpdates(): Promise<UpdateCheckResult> {
      if (result && ['downloading', 'ready', 'installing'].includes(transfer.status)) return result;
      if (pendingCheck) return pendingCheck;
      pendingCheck = input.check().then(checked => {
        result = checked; update({ status: 'idle' }); return checked;
      }).finally(() => { pendingCheck = undefined; });
      return pendingCheck;
    },
    async downloadUpdate(): Promise<void> {
      if (pendingCheck || ['downloading', 'ready', 'installing'].includes(transfer.status)) return;
      if (result?.status !== 'available') { update({ status: 'error', message: '请先检查应用更新。' }); return; }
      const release = result;
      const automatic = input.automaticInstall && Boolean(release.automaticUpdateUrl);
      if (automatic) {
        update({ status: 'downloading', version: release.version, mode: 'automatic' });
        try {
          input.native.setFeedURL({ url: release.automaticUpdateUrl!, serverType: 'json' });
          input.native.checkForUpdates();
        } catch { failure(); }
        return;
      }
      if (!release.download) { update({ status: 'error', message: '这个安装包暂不支持应用内下载，请打开下载页面。' }); return; }
      const id = ++operation;
      abort = new AbortController();
      update({ status: 'downloading', version: release.version, mode: 'installer', receivedBytes: 0, totalBytes: release.download.size });
      void (input.download ?? downloadUpdateInstaller)({
        directory: input.directory, url: release.assetUrl, ...release.download, signal: abort.signal,
        onProgress: (receivedBytes, totalBytes) => {
          if (id === operation) update({ status: 'downloading', version: release.version, mode: 'installer', receivedBytes, totalBytes });
        }
      }).then(async path => {
        if (id !== operation) { await cleanup(path); return; }
        installer = path; abort = undefined;
        update({ status: 'ready', version: release.version, mode: 'installer' });
      }).catch(error => { if (id === operation) { abort = undefined; failure(error); } });
    },
    async cancelUpdate(): Promise<void> {
      if (transfer.status !== 'downloading' || transfer.mode !== 'installer') return;
      operation += 1;
      abort?.abort(); abort = undefined;
      update({ status: 'idle' });
    },
    async installUpdate(): Promise<void> {
      if (transfer.status !== 'ready' || opening) return;
      if (transfer.mode === 'automatic') {
        update({ status: 'installing', version: transfer.version });
        try { input.requestInstall(); }
        catch {
          update({ status: 'ready', version: transfer.version, mode: 'automatic' });
          throw new Error('未能重启安装更新，请重试。');
        }
        return;
      }
      if (!installer || result?.status !== 'available' || !result.download) return;
      opening = true;
      try {
        try { await (input.verify ?? verifyInstaller)(installer, result.download.sha256, result.download.size); }
        catch {
          await cleanup(installer); installer = undefined; failure();
          throw new Error('安装包校验失败，请重新下载。');
        }
        if (await input.openInstaller(installer)) throw new Error('未能打开安装包，请重试。');
      } finally { opening = false; }
    },
    installCancelled(): void {
      if (transfer.status === 'installing') update({ status: 'ready', version: transfer.version, mode: 'automatic' });
    },
    dispose(): void {
      operation += 1; abort?.abort();
      input.native.removeListener('error', onError);
      input.native.removeListener('update-downloaded', onDownloaded);
      input.native.removeListener('update-not-available', onNotAvailable);
    }
  };
}
