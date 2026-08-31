import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import type { StateKernel } from '../db/database.js';
import {
  contractEvidencePassed,
  loadCurrentContractProfileState,
  type ContractFingerprint,
  type StoredContractProfile
} from '../vault/contract-profile-store.js';
import type { VaultGateway } from '../vault/VaultGateway.js';
import type { IndexState } from '../index/index-state.js';

const REQUIRED_CAPABILITIES = [
  'safeRead',
  'safeCreate',
  'safeReplace',
  'safeRestore',
  'safeDelete',
  'rereadVerified',
  'externalMutationObservation',
  'restartPersistence'
] as const;

type RequiredCapability = typeof REQUIRED_CAPABILITIES[number];

export interface HealthSnapshot {
  readonly status: 'ready' | 'recovery-only';
  readonly index: HealthIndexSnapshot;
  readonly writeGate: {
    readonly status: 'blocked' | 'enabled';
    readonly missing: readonly string[];
    readonly fingerprintMatches: boolean;
  };
}

export type HealthIndexSnapshot =
  | { readonly status: 'building'; readonly startedAt: string }
  | { readonly status: 'ready'; readonly version: number; readonly refreshedAt: string }
  | {
    readonly status: 'stale';
    readonly version: number;
    readonly lastSuccessAt: string;
    readonly reason: 'INDEX_STALE';
  }
  | {
    readonly status: 'failed';
    readonly lastSuccessAt?: string;
    readonly reason: 'INDEX_FAILED';
  }
  | {
    readonly status: 'unavailable';
    readonly reason: 'RECOVERY_ONLY' | 'READ_API_UNAVAILABLE';
  };

export interface HealthIndexStateSource {
  snapshot(): IndexState | Extract<HealthIndexSnapshot, { status: 'unavailable' }>;
}

export interface HealthService {
  getSnapshot(): Promise<HealthSnapshot>;
}

function publicIndexSnapshot(
  snapshot: ReturnType<HealthIndexStateSource['snapshot']>
): HealthIndexSnapshot {
  switch (snapshot.status) {
    case 'building':
      return { status: 'building', startedAt: snapshot.startedAt };
    case 'ready':
      return {
        status: 'ready',
        version: snapshot.version,
        refreshedAt: snapshot.refreshedAt
      };
    case 'stale':
      return {
        status: 'stale',
        version: snapshot.version,
        lastSuccessAt: snapshot.lastSuccessAt,
        reason: 'INDEX_STALE'
      };
    case 'failed':
      return {
        status: 'failed',
        ...(snapshot.lastSuccessAt === undefined ? {} : { lastSuccessAt: snapshot.lastSuccessAt }),
        reason: 'INDEX_FAILED'
      };
    case 'unavailable':
      return snapshot;
  }
}

function fieldPassed(profile: StoredContractProfile, capability: RequiredCapability): boolean {
  switch (capability) {
    case 'externalMutationObservation':
    case 'restartPersistence':
      return profile[capability] === 'passed';
    default:
      return profile[capability];
  }
}

function missingCapabilities(profile: StoredContractProfile): RequiredCapability[] {
  return REQUIRED_CAPABILITIES.filter((capability) => (
    !fieldPassed(profile, capability)
    || !contractEvidencePassed(profile.evidence, capability)
  ));
}

async function databaseBlocker(stateKernel: StateKernel): Promise<'database' | 'recovery' | undefined> {
  if (stateKernel.mode === 'recovery-only') return 'database';
  try {
    const before = await lstat(stateKernel.recoveryDir);
    if (before.isSymbolicLink() || !before.isDirectory()) return 'recovery';
    const entries = await readdir(stateKernel.recoveryDir);
    if (entries.length > 0) return 'recovery';
    const after = await lstat(stateKernel.recoveryDir);
    if (
      after.isSymbolicLink()
      || !after.isDirectory()
      || after.dev !== before.dev
      || after.ino !== before.ino
    ) {
      return 'recovery';
    }
    return undefined;
  } catch {
    return 'recovery';
  }
}

async function loadExactProfile(input: {
  readonly gateway: Pick<VaultGateway, 'fingerprint' | 'readOpenApi'>;
  readonly profileDirectory: string;
}): Promise<StoredContractProfile | undefined> {
  try {
    const [plugin, openApi] = await Promise.all([
      input.gateway.fingerprint(),
      input.gateway.readOpenApi()
    ]);
    const fingerprint: ContractFingerprint = {
      ...plugin,
      openApiSha256: createHash('sha256').update(openApi, 'utf8').digest('hex')
    };
    return (await loadCurrentContractProfileState(
      input.profileDirectory,
      fingerprint
    ))?.profile;
  } catch {
    return undefined;
  }
}

export function createHealthService(input: {
  readonly writeEnabled: boolean;
  readonly gateway: Pick<VaultGateway, 'fingerprint' | 'readOpenApi'>;
  readonly profileDirectory: string;
  readonly stateKernel: StateKernel;
  readonly indexState: HealthIndexStateSource;
}): HealthService {
  return {
    getSnapshot: async () => {
      const [profile, blocker] = await Promise.all([
        loadExactProfile(input),
        databaseBlocker(input.stateKernel)
      ]);
      const fingerprintMatches = profile !== undefined;
      const missing: string[] = profile === undefined
        ? ['profile']
        : missingCapabilities(profile);
      if (!input.writeEnabled) missing.push('writeEnabled');
      if (blocker !== undefined) missing.push(blocker);
      return {
        status: blocker === undefined ? 'ready' : 'recovery-only',
        index: blocker === undefined
          ? publicIndexSnapshot(input.indexState.snapshot())
          : { status: 'unavailable', reason: 'RECOVERY_ONLY' },
        writeGate: {
          status: missing.length === 0 ? 'enabled' : 'blocked',
          missing,
          fingerprintMatches
        }
      };
    }
  };
}
