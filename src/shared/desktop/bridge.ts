export interface XiaozhaoDesktopApi {
  getAppVersion(): Promise<string>;
  chooseVaultDirectory(): Promise<{ readonly selected: boolean; readonly displayName?: string }>;
}
