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

export interface ReadVaultGateway {
  listDirectory(path: string, signal?: AbortSignal): Promise<ReadonlyArray<string>>;
  readRaw(path: string, signal?: AbortSignal): Promise<VersionedBytes>;
}

export interface OpenableVaultGateway extends ReadVaultGateway {
  openInObsidian(path: string, signal?: AbortSignal): Promise<void>;
  probeReadiness?(signal?: AbortSignal): Promise<VaultReadiness>;
}

export type VaultReadiness =
  | { readonly status: 'ready' }
  | { readonly status: 'unavailable'; readonly reason: 'VAULT_UNAVAILABLE' | 'VAULT_RULES_MISSING' };

export interface LocalRestContractGateway extends ReadVaultGateway {
  fingerprint(): Promise<Pick<VaultCapabilityProfile, 'pluginId' | 'pluginVersion' | 'obsidianVersion'>>;
  readOpenApi(): Promise<string>;
}

export type VaultGateway = LocalRestContractGateway;
