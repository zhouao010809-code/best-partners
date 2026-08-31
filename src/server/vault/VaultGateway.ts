export type VersionedBytes = {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly rawSha256: string;
  readonly upstreamVersion?: string;
};

export type VaultCapabilityProfile = {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly obsidianVersion: string;
  readonly safeRead: boolean;
  readonly safeReplace: boolean;
  readonly safeCreate: boolean;
  readonly safeRestore: boolean;
  readonly safeDelete: boolean;
  readonly restartPersistence: 'unverified' | 'passed' | 'failed';
  readonly formalWriteGate: 'passed' | 'blocked';
  readonly evidence: ReadonlyArray<string>;
};

export interface VaultGateway {
  fingerprint(): Promise<Pick<VaultCapabilityProfile, 'pluginId' | 'pluginVersion' | 'obsidianVersion'>>;
  listDirectory(path: string, signal?: AbortSignal): Promise<ReadonlyArray<string>>;
  readRaw(path: string, signal?: AbortSignal): Promise<VersionedBytes>;
  readOpenApi(): Promise<string>;
}

export interface OpenableVaultGateway extends VaultGateway {
  openInObsidian(path: string, signal?: AbortSignal): Promise<void>;
}
