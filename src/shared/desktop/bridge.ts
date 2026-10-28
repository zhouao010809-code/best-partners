import type { WorkdiskBinding, WorkdiskFile, WorkdiskImportOptions, WorkdiskImportResult, WorkdiskListRequest, WorkdiskPreview, WorkdiskSnapshot } from '../workdisk.js';
import type { UpdateCheckResult, UpdateSnapshot } from './update.js';

export interface DesktopVaultSelection {
  readonly selected: boolean;
  readonly displayName?: string;
  readonly reason?: 'cancelled' | 'unchanged' | 'busy';
}

export interface DesktopProjectDirectorySelection {
  readonly selected: boolean;
  readonly path?: string;
  readonly displayName?: string;
  readonly reason?: 'cancelled' | 'busy' | 'unavailable';
}

export interface XiaozhaoClipperStatus {
  readonly installed: boolean;
  readonly connected: boolean;
  readonly message?: string;
}

export interface DesktopWorkdiskApi {
  status(): Promise<WorkdiskBinding | null>;
  connect(): Promise<WorkdiskBinding | null>;
  list(request?: WorkdiskListRequest): Promise<WorkdiskSnapshot>;
  importFiles(date: string, options?: WorkdiskImportOptions): Promise<WorkdiskImportResult | null>;
  importDroppedFiles?(files: File[], date: string, options?: WorkdiskImportOptions): Promise<WorkdiskImportResult>;
  createNote(input: { title: string; body: string; date: string }): Promise<WorkdiskFile>;
  preview(path: string): Promise<WorkdiskPreview>;
  openFile(path: string): Promise<void>;
}

export interface XiaozhaoDesktopApi {
  readonly workdisk?: DesktopWorkdiskApi;
  openAssistantLogin?(url: string): Promise<void>;
  getAppVersion(): Promise<string>;
  chooseVaultDirectory(): Promise<DesktopVaultSelection>;
  chooseProjectDirectory?(): Promise<DesktopProjectDirectorySelection>;
  getVaultInfo?(): Promise<{ readonly displayName: string; readonly path: string }>;
  openVaultDirectory?(): Promise<void>;
  revealDocument?(relativePath: string): Promise<void>;
  revealSkill?(skillId: string): Promise<void>;
  openClipperInstall?(): Promise<void>;
  installClipperHost?(): Promise<void>;
  getClipperStatus?(test?: boolean): Promise<XiaozhaoClipperStatus>;
  checkForUpdates?(): Promise<UpdateCheckResult>;
  openUpdateDownload?(url: string): Promise<void>;
  getUpdateState?(): Promise<UpdateSnapshot>;
  downloadUpdate?(): Promise<void>;
  cancelUpdate?(): Promise<void>;
  installUpdate?(): Promise<void>;
  onUpdateState?(listener: (state: UpdateSnapshot) => void): () => void;
}
