import { contextBridge, ipcRenderer } from 'electron';
import type { XiaozhaoDesktopApi } from '../shared/desktop/bridge.js';

contextBridge.exposeInMainWorld('xiaozhaoDesktop', Object.freeze({
  openAssistantLogin: (url) => ipcRenderer.invoke('desktop:assistant-login', url),
  getAppVersion: () => ipcRenderer.invoke('desktop:get-app-version'),
  chooseVaultDirectory: () => ipcRenderer.invoke('desktop:choose-vault-directory'),
  getVaultInfo: () => ipcRenderer.invoke('desktop:get-vault-info'),
  openVaultDirectory: () => ipcRenderer.invoke('desktop:open-vault-directory'),
  revealDocument: (relativePath) => ipcRenderer.invoke('desktop:reveal-document', relativePath),
  revealSkill: (skillId) => ipcRenderer.invoke('desktop:reveal-skill', skillId),
  openClipperInstall: () => ipcRenderer.invoke('desktop:open-clipper-install'),
  installClipperHost: () => ipcRenderer.invoke('desktop:install-clipper-host'),
  getClipperStatus: (test) => ipcRenderer.invoke('desktop:clipper-status', test)
} satisfies XiaozhaoDesktopApi));
