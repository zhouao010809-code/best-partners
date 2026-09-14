import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { createInitialVault, loadDesktopSettings, resolveInitialVaultSettings, saveDesktopSettings, validateDesktopVault } from './settings-store.js';
import { createDesktopWindowPolicy } from './window-policy.js';
import { validateDesktopTestRoots } from './test-roots.js';
import { prepareVaultCacheDirectory } from './vault-cache.js';
import { createNativeReadVaultPortFactory } from '../server/vault/NativeReadVaultPort.js';
import { FileSystemVaultGateway } from '../server/vault/FileSystemVaultGateway.js';
import type { StartedServer } from '../server/start-server.js';
import { createModelKeyStore } from './model-key-store.js';
import { changeDesktopVault } from './vault-selection.js';
import { createDesktopVaultNavigation } from './vault-navigation.js';
import { validateAssistantLoginUrl } from './assistant-login.js';
import { runClipperHost } from './clipper-host.js';
import { clipperPaths, installClipperHost, readClipperBridgeConfig } from './clipper-installer.js';
import { createBridgeConfig } from './clipper-installer.js';

app.setName('最佳拍档');
let started: StartedServer | undefined;
let window: BrowserWindow | undefined;
let quitState: 'idle' | 'closing' | 'ready' = 'idle';
let choosing = false;

function createMainWindow(origin: string): BrowserWindow {
  const policy = createDesktopWindowPolicy(origin);
  const created = new BrowserWindow({
    width: 1360, height: 900, minWidth: 720, minHeight: 600,
    title: '最佳拍档', backgroundColor: '#070909',
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
  if (process.env.NODE_ENV !== 'test') {
    // Keep the existing data namespace so configured users do not lose settings after the brand change.
    app.setPath('userData', join(app.getPath('appData'), '小兆大脑'));
  }
  const userDataDir = app.getPath('userData');
  const nativeReader = createNativeReadVaultPortFactory(join(import.meta.dirname, '../native/atomic-file-helper'));
  const validate = (vaultRoot: string) => validateDesktopVault({ vaultRoot, userDataDir, nativeReaderFactory: nativeReader });
  const chooseDirectory = async (): Promise<string | undefined> => {
    const result = await dialog.showOpenDialog({
      title: '选择我的大脑文件夹', properties: ['openDirectory'],
      message: '请选择完整的大脑文件夹。切换后应用将重启，现有资料不会移动。'
    });
    return result.canceled ? undefined : result.filePaths[0];
  };
  const showInvalidSelection = async (): Promise<'retry' | 'cancel'> => {
    const result = await dialog.showMessageBox({
      type: 'warning', title: '文件夹暂不可用',
      message: '请选择包含大脑规则、图书馆、知识库和大讲堂的文件夹。',
      detail: '文件夹不能是快捷链接，也不能与应用数据目录重叠。当前大脑设置没有更改。',
      buttons: ['重新选择', '取消'], defaultId: 0, cancelId: 1
    });
    return result.response === 0 ? 'retry' : 'cancel';
  };
  const showInitialChoice = async () => {
    const result = await dialog.showMessageBox({
      type: 'question', title: '开始使用最佳拍档',
      message: '还没有可用的大脑文件夹',
      detail: '你可以创建一个新的“我的大脑”文件夹，或选择已经存在的大脑文件夹。创建只会建立初始目录和规则文件，不会移动现有资料。',
      buttons: ['创建我的大脑', '选择已有文件夹', '取消'], defaultId: 0, cancelId: 2
    });
    return result.response === 0 ? 'create' as const : result.response === 1 ? 'select' as const : 'cancel' as const;
  };
  const createInitial = async () => {
    for (;;) {
      const result = await dialog.showOpenDialog({
        title: '选择保存位置', properties: ['openDirectory'],
        message: '应用将在这里创建“我的大脑”文件夹，不会移动现有资料。'
      });
      if (result.canceled || result.filePaths[0] === undefined) return undefined;
      try {
        return await createInitialVault({ parentRoot: result.filePaths[0], userDataDir, validate });
      } catch (error) {
        const message = error instanceof Error && error.message === 'INITIAL_VAULT_EXISTS'
          ? '这里已经有“我的大脑”文件夹，请换一个保存位置。'
          : '无法在这里创建“我的大脑”文件夹，请选择有写入权限的位置。';
        const retry = await dialog.showMessageBox({
          type: 'warning', title: '暂时无法创建', message,
          detail: '没有创建成功前，不会保存新的大脑设置。',
          buttons: ['重新选择', '取消'], defaultId: 0, cancelId: 1
        });
        if (retry.response !== 0) return undefined;
      }
    }
  };
  const saved = await loadDesktopSettings({ userDataDir }).catch(() => undefined);
  const settings = testRoot === undefined
    ? await resolveInitialVaultSettings({ saved, defaultRoot: join(app.getPath('home'), '我的大脑'), validate, chooseDirectory, showInvalidSelection, showInitialChoice, createInitial })
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
    modelBaseUrl: 'https://api.deepseek.com', gateway, adapter: 'filesystem',
    modelCredentials: createModelKeyStore({ directory: join(userDataDir, 'model-credentials'), safeStorage }),
    personalArchiveAddonPath: join(import.meta.dirname, '../native/personal-archive.node')
  });
  window = createMainWindow(started.origin);
  const navigation = createDesktopVaultNavigation({ reader: await nativeReader.create(settings.vaultRoot), shell });
  ipcMain.handle('desktop:get-app-version', (event) => { assertMainSender(event); return app.getVersion(); });
  ipcMain.handle('desktop:assistant-login', async (event, url: unknown) => { assertMainSender(event); await shell.openExternal(validateAssistantLoginUrl(url)); });
  ipcMain.handle('desktop:get-vault-info', (event) => { assertMainSender(event); return navigation.getVaultInfo(); });
  ipcMain.handle('desktop:open-vault-directory', async (event) => { assertMainSender(event); await navigation.openVaultDirectory(); });
  ipcMain.handle('desktop:reveal-document', async (event, relativePath: unknown) => {
    assertMainSender(event);
    await navigation.revealDocument(relativePath);
  });
  const clipperConfigPath = join(userDataDir, 'clipper-bridge.json');
  ipcMain.handle('desktop:open-clipper-install', async (event) => {
    assertMainSender(event);
    const readme = join(process.resourcesPath, 'clipper-extension', 'README.md');
    await shell.openPath(readme);
  });
  ipcMain.handle('desktop:install-clipper-host', async (event) => {
    assertMainSender(event);
    await installClipperHost({ executablePath: process.execPath, configPath: clipperConfigPath, vaultRoot: settings.vaultRoot });
  });
  ipcMain.handle('desktop:clipper-status', async (event) => {
    assertMainSender(event);
    try {
      const config = await readClipperBridgeConfig(clipperConfigPath);
      const paths = clipperPaths();
      const installed = await Promise.all(Object.values(paths).map(async (path) => fs.lstat(path).then(stat => stat.isFile()).catch(() => false))).then(values => values.some(Boolean));
      return { installed, connected: installed && config.vaultRoot === settings.vaultRoot };
    } catch { return { installed: false, connected: false, message: '尚未安装浏览器收藏插件。' }; }
  });
  ipcMain.handle('desktop:choose-vault-directory', async (event) => {
    assertMainSender(event);
    if (choosing) return { selected: false, reason: 'busy' };
    choosing = true;
    try {
      return await changeDesktopVault({
        currentRoot: settings.vaultRoot, chooseDirectory, validate, showInvalidSelection,
        confirmSwitch: async (config) => {
          const result = await dialog.showMessageBox({
            type: 'question', title: '切换大脑文件夹',
            message: `切换到“${basename(config.vaultRoot)}”并重新启动？`,
            detail: `${config.vaultRoot}\n\n应用将重新启动，正在进行的提炼会中断。现有资料不会移动。`,
            buttons: ['切换并重新启动', '取消'], defaultId: 1, cancelId: 1
          });
          return result.response === 0;
        },
        save: (config) => saveDesktopSettings({ userDataDir, config }),
        restart: () => { setTimeout(() => { app.relaunch(); app.quit(); }, 250); }
      });
    } catch { throw new Error('大脑文件夹设置未能保存，请重试。'); }
    finally { choosing = false; }
  });
  await window.loadURL(started.origin);
}

// Editors may cancel window closure in beforeunload. Keep the service alive
// until all windows have accepted closing, including a cancelled Cmd+Q.
app.on('will-quit', (event) => {
  if (quitState === 'ready') return;
  event.preventDefault();
  if (quitState === 'closing') return;
  quitState = 'closing';
  const finishQuit = () => {
    quitState = 'ready';
    setImmediate(() => app.quit());
  };
  void (started?.close() ?? Promise.resolve()).then(finishQuit, finishQuit);
});
app.on('window-all-closed', () => app.quit());
app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });

const isClipperHost = process.argv.includes('--clipper-host');
if (!isClipperHost) void bootstrap().catch(async () => {
  if (process.env.NODE_ENV !== 'test') dialog.showErrorBox('最佳拍档未能启动', '本地服务或大脑文件夹暂不可用。原始资料没有被修改，请重新打开应用或选择有效的大脑文件夹。');
  await started?.close();
  app.exit(1);
});

if (isClipperHost) {
  // Native host mode has no window and must share the desktop user-data namespace.
  // Tests may provide an isolated user-data root; production uses the same path
  // as the regular desktop bootstrap.
  const hostUserData = process.env.NODE_ENV === 'test'
    ? process.env.XIAOZHAO_TEST_USER_DATA
    : join(app.getPath('appData'), '小兆大脑');
  if (hostUserData === undefined || hostUserData.length === 0) {
    app.exit(1);
  } else {
    app.setPath('userData', hostUserData);
    const configPath = join(hostUserData, 'clipper-bridge.json');
    void runClipperHost({ configPath }).then(() => app.exit(0), () => app.exit(1));
  }
}
