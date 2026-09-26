import { contextBridge, ipcRenderer } from 'electron';
import type { XiaozhaoDesktopApi } from '../shared/desktop/bridge.js';
import type { UpdateSnapshot } from '../shared/desktop/update.js';

contextBridge.exposeInMainWorld('xiaozhaoDesktop', Object.freeze({
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
