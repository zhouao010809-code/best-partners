import { contextBridge, ipcRenderer } from 'electron';
import type { XiaozhaoDesktopApi } from '../shared/desktop/bridge.js';

contextBridge.exposeInMainWorld('xiaozhaoDesktop', Object.freeze({
  getAppVersion: () => ipcRenderer.invoke('desktop:get-app-version'),
  chooseVaultDirectory: () => ipcRenderer.invoke('desktop:choose-vault-directory')
} satisfies XiaozhaoDesktopApi));
