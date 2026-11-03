import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { XiaozhaoDesktopApi } from '../shared/desktop/bridge.js';
import type { UpdateSnapshot } from '../shared/desktop/update.js';

contextBridge.exposeInMainWorld('xiaozhaoDesktop', Object.freeze({
  workdisk: Object.freeze({
    status: () => ipcRenderer.invoke('desktop:workdisk-status'),
    connect: () => ipcRenderer.invoke('desktop:workdisk-connect'),
    list: (request) => ipcRenderer.invoke('desktop:workdisk-list', request),
    importFiles: (date, options) => ipcRenderer.invoke('desktop:workdisk-import', date, options),
    importDroppedFiles: (files, date, options) => ipcRenderer.invoke('desktop:workdisk-drop', files.map(file => webUtils.getPathForFile(file)), date, options),
    createNote: (input) => ipcRenderer.invoke('desktop:workdisk-create-note', input),
    preview: (path) => ipcRenderer.invoke('desktop:workdisk-preview', path),
    thumbnail: (path, bindingId) => ipcRenderer.invoke('desktop:workdisk-thumbnail', path, bindingId),
    openFile: (path) => ipcRenderer.invoke('desktop:workdisk-open', path),
    autoStatus: () => ipcRenderer.invoke('desktop:workdisk-auto-status'),
    chooseAutoSource: (options) => ipcRenderer.invoke('desktop:workdisk-auto-choose', options),
    setAutoEnabled: (enabled) => ipcRenderer.invoke('desktop:workdisk-auto-enable', enabled),
    setAutoNaming: (enabled) => ipcRenderer.invoke('desktop:workdisk-auto-naming', enabled),
    renameAutoReceipt: (id, title) => ipcRenderer.invoke('desktop:workdisk-auto-rename', id, title),
    openAutoSource: () => ipcRenderer.invoke('desktop:workdisk-auto-open')
  } satisfies NonNullable<XiaozhaoDesktopApi['workdisk']>),
  openAssistantLogin: (url) => ipcRenderer.invoke('desktop:assistant-login', url),
  getAppVersion: () => ipcRenderer.invoke('desktop:get-app-version'),
  chooseVaultDirectory: () => ipcRenderer.invoke('desktop:choose-vault-directory'),
  chooseProjectDirectory: () => ipcRenderer.invoke('desktop:choose-project-directory'),
  getVaultInfo: () => ipcRenderer.invoke('desktop:get-vault-info'),
  openVaultDirectory: () => ipcRenderer.invoke('desktop:open-vault-directory'),
  revealDocument: (relativePath) => ipcRenderer.invoke('desktop:reveal-document', relativePath),
  revealSkill: (skillId) => ipcRenderer.invoke('desktop:reveal-skill', skillId),
  openClipperInstall: () => ipcRenderer.invoke('desktop:open-clipper-install'),
  installClipperHost: () => ipcRenderer.invoke('desktop:install-clipper-host'),
  getClipperStatus: (test) => ipcRenderer.invoke('desktop:clipper-status', test),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates'),
  openUpdateDownload: (url) => ipcRenderer.invoke('desktop:open-update-download', url),
  getUpdateState: () => ipcRenderer.invoke('desktop:get-update-state'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:download-update'),
  cancelUpdate: () => ipcRenderer.invoke('desktop:cancel-update'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  onUpdateState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: UpdateSnapshot) => listener(state);
    ipcRenderer.on('desktop:update-state', receive);
    return () => { ipcRenderer.removeListener('desktop:update-state', receive); };
  }
} satisfies XiaozhaoDesktopApi));
