export interface DesktopVaultSelection {
  readonly selected: boolean;
  readonly displayName?: string;
  readonly reason?: 'cancelled' | 'unchanged' | 'busy';
}

export interface XiaozhaoDesktopApi {
  openAssistantLogin?(url: string): Promise<void>;
  getAppVersion(): Promise<string>;
  chooseVaultDirectory(): Promise<DesktopVaultSelection>;
  getVaultInfo?(): Promise<{ readonly displayName: string; readonly path: string }>;
  openVaultDirectory?(): Promise<void>;
  revealDocument?(relativePath: string): Promise<void>;
}
