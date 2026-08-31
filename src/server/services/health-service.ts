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
  readonly writeGate: {
    readonly status: 'blocked' | 'enabled';
    readonly missing: readonly string[];
    readonly fingerprintMatches: boolean;
  };
}

export interface HealthService {
  getSnapshot(): Promise<HealthSnapshot>;
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
        writeGate: {
          status: missing.length === 0 ? 'enabled' : 'blocked',
          missing,
          fingerprintMatches
        }
      };
    }
  };
}
