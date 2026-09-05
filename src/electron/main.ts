import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { basename, join } from 'node:path';
import { loadDesktopSettings, resolveInitialVaultSettings, saveDesktopSettings, validateDesktopVault } from './settings-store.js';
import { createDesktopWindowPolicy } from './window-policy.js';
import { validateDesktopTestRoots } from './test-roots.js';
import { prepareVaultCacheDirectory } from './vault-cache.js';
import { createNativeReadVaultPortFactory } from '../server/vault/NativeReadVaultPort.js';
import { FileSystemVaultGateway } from '../server/vault/FileSystemVaultGateway.js';
import type { StartedServer } from '../server/start-server.js';

app.setName('小兆大脑');
let started: StartedServer | undefined;
let window: BrowserWindow | undefined;
let quitting = false;
let choosing = false;

function createMainWindow(origin: string): BrowserWindow {
  const policy = createDesktopWindowPolicy(origin);
  const created = new BrowserWindow({
    width: 1360, height: 900, minWidth: 720, minHeight: 600,
    title: '小兆大脑', backgroundColor: '#070909',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      partition: `xiaozhao-${process.pid}`
    }
  });
  created.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  created.webContents.session.setPermissionCheckHandler(() => false);
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  created.webContents.on('will-navigate', (event, url) => { if (!policy.allowNavigation(url)) event.preventDefault(); });
  created.webContents.on('will-redirect', (event, url) => { if (!policy.allowNavigation(url)) event.preventDefault(); });
  created.webContents.on('will-attach-webview', (event) => event.preventDefault());
  return created;
}

function assertMainSender(event: Electron.IpcMainInvokeEvent): void {
  if (window === undefined || started === undefined || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame
    || !createDesktopWindowPolicy(started.origin).allowNavigation(event.senderFrame.url)) {
    throw new Error('DESKTOP_SENDER_FORBIDDEN');
  }
}

async function bootstrap(): Promise<void> {
  let testRoot: string | undefined;
  if (process.env.NODE_ENV === 'test') {
    const paths = validateDesktopTestRoots({
      vaultRoot: process.env.XIAOZHAO_TEST_VAULT_ROOT ?? '',
      userDataDir: process.env.XIAOZHAO_TEST_USER_DATA ?? ''
    });
    app.setPath('userData', paths.userDataDir);
    testRoot = paths.vaultRoot;
  }
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  await app.whenReady();
  const userDataDir = app.getPath('userData');
  const nativeReader = createNativeReadVaultPortFactory(join(import.meta.dirname, '../native/atomic-file-helper'));
  const validate = (vaultRoot: string) => validateDesktopVault({ vaultRoot, userDataDir, nativeReaderFactory: nativeReader });
  const chooseDirectory = async (): Promise<string | undefined> => {
    const result = await dialog.showOpenDialog({ title: '选择我的大脑文件夹', properties: ['openDirectory'] });
    return result.canceled ? undefined : result.filePaths[0];
  };
  const showInvalidSelection = async () => {
    await dialog.showMessageBox({ type: 'warning', title: '文件夹暂不可用', message: '请选择包含大脑规则、图书馆、知识库和大讲堂的文件夹。', detail: '文件夹不能是快捷链接，也不能与应用数据目录重叠。', buttons: ['重新选择'] });
  };
  const saved = await loadDesktopSettings({ userDataDir }).catch(() => undefined);
  const settings = testRoot === undefined
    ? await resolveInitialVaultSettings({ saved, defaultRoot: join(app.getPath('home'), '我的大脑'), validate, chooseDirectory, showInvalidSelection })
    : await validate(testRoot);
  if (settings === undefined) {
    await dialog.showMessageBox({ message: '未选择大脑文件夹，应用尚未启动', buttons: ['关闭'] });
    app.quit();
    return;
  }
  await saveDesktopSettings({ userDataDir, config: settings });
  const gateway = await FileSystemVaultGateway.create({
    vaultRoot: settings.vaultRoot, nativeReader,
    openExternal: async (url) => {
      if (new URL(url).protocol !== 'obsidian:') throw new Error('EXTERNAL_URL_FORBIDDEN');
      await shell.openExternal(url);
    }
  });
  // Keep the server bundle separate so SQLite migrations retain their relative location.
  const { startServer } = await import(new URL('../server/start-server.js', import.meta.url).href) as typeof import('../server/start-server.js');
  const appDataDir = prepareVaultCacheDirectory({ userDataDir, vaultRoot: settings.vaultRoot, cacheKey: gateway.cacheKey });
  started = await startServer({
    host: '127.0.0.1', port: 0, appDataDir,
    vaultRealRoot: settings.vaultRoot, clientRoot: join(import.meta.dirname, '../client'),
    modelBaseUrl: 'https://api.deepseek.com', gateway, adapter: 'filesystem'
  });
  window = createMainWindow(started.origin);
  ipcMain.handle('desktop:get-app-version', (event) => { assertMainSender(event); return app.getVersion(); });
  ipcMain.handle('desktop:choose-vault-directory', async (event) => {
    assertMainSender(event);
    if (choosing) return { selected: false };
    choosing = true;
    try {
      const selected = await chooseDirectory();
      if (selected === undefined) return { selected: false };
      let config;
      try { config = await validate(selected); } catch { await showInvalidSelection(); return { selected: false }; }
      await saveDesktopSettings({ userDataDir, config });
      setTimeout(() => { app.relaunch(); app.quit(); }, 250);
      return { selected: true, displayName: basename(config.vaultRoot) };
    } catch { throw new Error('大脑文件夹设置未能保存，请重试。'); }
    finally { choosing = false; }
  });
  await window.loadURL(started.origin);
}

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void (started?.close() ?? Promise.resolve()).finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });

void bootstrap().catch(async () => {
  if (process.env.NODE_ENV !== 'test') dialog.showErrorBox('小兆大脑未能启动', '本地服务或大脑文件夹暂不可用。原始资料没有被修改，请重新打开应用或选择有效的大脑文件夹。');
  await started?.close();
  app.exit(1);
});
