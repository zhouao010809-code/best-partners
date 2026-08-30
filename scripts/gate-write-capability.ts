import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  loadContractProfileByKey,
  type StoredContractProfile
} from '../src/server/vault/contract-profile-store.js';

export type WriteGateMissing = {
  readonly capability: string;
  readonly reasonCode: string;
};

export type WriteGateEvaluation = {
  readonly passed: boolean;
  readonly missing: ReadonlyArray<WriteGateMissing>;
};

export function evaluateWriteCapability(
  profile: StoredContractProfile | undefined,
  expectedProfileKey: string
): WriteGateEvaluation {
  if (profile === undefined) {
    return {
      passed: false,
      missing: [{ capability: 'profile', reasonCode: 'PROFILE_UNAVAILABLE' }]
    };
  }
  if (profile.profileKey !== expectedProfileKey) {
    return {
      passed: false,
      missing: [{ capability: 'profileKey', reasonCode: 'PROFILE_KEY_MISMATCH' }]
    };
  }

  const missing: WriteGateMissing[] = [];
  for (const capability of [
    'safeRead',
    'safeCreate',
    'safeReplace',
    'safeRestore',
    'safeDelete',
    'rereadVerified'
  ] as const) {
    if (!profile[capability]) {
      missing.push({ capability, reasonCode: 'CAPABILITY_NOT_PASSED' });
    }
  }
  if (profile.externalMutationObservation !== 'passed') {
    missing.push({
      capability: 'externalMutationObservation',
      reasonCode: profile.externalMutationObservation === 'failed'
        ? 'EXTERNAL_MUTATION_FAILED'
        : 'EXTERNAL_MUTATION_UNVERIFIED'
    });
  }
  if (profile.restartPersistence !== 'passed') {
    missing.push({
      capability: 'restartPersistence',
      reasonCode: profile.restartPersistence === 'failed'
        ? 'RESTART_FAILED'
        : 'RESTART_UNVERIFIED'
    });
  }
  if (profile.formalWriteGate !== 'passed') {
    missing.push({ capability: 'formalWriteGate', reasonCode: 'FORMAL_GATE_BLOCKED' });
  }
  return { passed: missing.length === 0, missing };
}

export function composeGateOutput(result: WriteGateEvaluation): string {
  if (result.passed) {
    return 'PASSED';
  }
  return `BLOCKED ${result.missing
    .map(({ capability, reasonCode }) => `${capability}:${reasonCode}`)
    .join(' ')}`;
}

export async function runWriteCapabilityGate(input: {
  readonly profileDirectory: string;
  readonly expectedProfileKey: string | undefined;
}): Promise<{ readonly exitCode: 0 | 1; readonly output: string }> {
  if (input.expectedProfileKey === undefined || !/^[a-f0-9]{64}$/.test(input.expectedProfileKey)) {
    return { exitCode: 1, output: 'BLOCKED profile:PROFILE_UNAVAILABLE' };
  }
  const profile = await loadContractProfileByKey(input.profileDirectory, input.expectedProfileKey);
  const evaluation = evaluateWriteCapability(profile, input.expectedProfileKey);
  return {
    exitCode: evaluation.passed ? 0 : 1,
    output: composeGateOutput(evaluation)
  };
}

async function main(): Promise<void> {
  const appDataDir = process.env.APP_DATA_DIR;
  const result = appDataDir === undefined
    ? { exitCode: 1 as const, output: 'BLOCKED profile:PROFILE_UNAVAILABLE' }
    : await runWriteCapabilityGate({
        profileDirectory: join(appDataDir, 'contract-profiles'),
        expectedProfileKey: process.env.OBSIDIAN_CONTRACT_PROFILE_KEY
      });
  process.stdout.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  void main().catch(() => {
    process.stdout.write('BLOCKED profile:PROFILE_UNAVAILABLE\n');
    process.exitCode = 1;
  });
}
