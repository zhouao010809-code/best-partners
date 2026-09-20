import type { UpdateCheckResult } from '../../electron/update-check.js';

export interface DesktopVaultSelection {
  readonly selected: boolean;
  readonly displayName?: string;
  readonly reason?: 'cancelled' | 'unchanged' | 'busy';
}

export interface XiaozhaoClipperStatus {
  readonly installed: boolean;
  readonly connected: boolean;
  readonly message?: string;
}

export interface XiaozhaoDesktopApi {
  openAssistantLogin?(url: string): Promise<void>;
  getAppVersion(): Promise<string>;
  chooseVaultDirectory(): Promise<DesktopVaultSelection>;
  getVaultInfo?(): Promise<{ readonly displayName: string; readonly path: string }>;
  openVaultDirectory?(): Promise<void>;
  revealDocument?(relativePath: string): Promise<void>;
  revealSkill?(skillId: string): Promise<void>;
  openClipperInstall?(): Promise<void>;
  installClipperHost?(): Promise<void>;
  getClipperStatus?(test?: boolean): Promise<XiaozhaoClipperStatus>;
  checkForUpdates?(): Promise<UpdateCheckResult>;
  openUpdateDownload?(url: string): Promise<void>;
}
