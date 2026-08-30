import {
  buildContractProfile,
  computeContractProfileKey,
  type ContractEvidence,
  type StoredContractProfile
} from '../../src/server/vault/contract-profile-store.js';
import type { VaultCapabilityProfile } from '../../src/server/vault/VaultGateway.js';

export type CapabilityResult = {
  readonly operation: ContractEvidence['operation'];
  readonly primitive: ContractEvidence['primitive'] | undefined;
  readonly status: ContractEvidence['status'];
  readonly reasonCode: string;
  readonly timestamp: string;
  readonly httpStatuses?: number[];
};

export function aggregateSafeCreate(results: ReadonlyArray<CapabilityResult>): {
  readonly passed: boolean;
  readonly complete: boolean;
} {
  const create = results.filter((result) => result.operation === 'safeCreate');
  const primitives = new Set(create.map((result) => result.primitive));
  const complete = primitives.has('PUT_REJECT_IF_CONTENT_PREEXISTS')
    && primitives.has('COPY_ALLOW_OVERWRITE_FALSE');
  return {
    complete,
    passed: complete && create.some((result) => result.status === 'passed')
  };
}

function passed(results: ReadonlyArray<CapabilityResult>, operation: ContractEvidence['operation']): boolean {
  return results.some((result) => result.operation === operation && result.status === 'passed');
}

function evidence(result: CapabilityResult): ContractEvidence {
  return {
    operation: result.operation,
    status: result.status,
    ...(result.httpStatuses === undefined ? {} : { httpStatuses: result.httpStatuses }),
    timestamp: result.timestamp,
    reasonCode: result.reasonCode,
    ...(result.primitive === undefined ? {} : { primitive: result.primitive })
  };
}

function exactVerifiedReadProfile(input: {
  readonly prior: StoredContractProfile | undefined;
  readonly fingerprint: Pick<VaultCapabilityProfile, 'pluginId' | 'pluginVersion' | 'obsidianVersion'>;
  readonly openApiSha256: string;
}): boolean {
  const prior = input.prior;
  if (prior === undefined) return false;
  const expectedKey = computeContractProfileKey({ ...input.fingerprint, openApiSha256: input.openApiSha256 });
  const fingerprintMatches = prior.profileKey === expectedKey
    && prior.pluginId === input.fingerprint.pluginId
    && prior.pluginVersion === input.fingerprint.pluginVersion
    && prior.obsidianVersion === input.fingerprint.obsidianVersion
    && prior.openApiSha256 === input.openApiSha256;
  const latestRead = prior.evidence.filter((record) => record.operation === 'safeRead').at(-1);
  return fingerprintMatches
    && prior.safeRead
    && latestRead?.status === 'passed'
    && latestRead.reasonCode === 'READ_FIDELITY_VERIFIED'
    && latestRead.primitive === 'RAW_REREAD';
}

export async function buildWriteProbeProfile(input: {
  readonly fingerprint: Pick<VaultCapabilityProfile, 'pluginId' | 'pluginVersion' | 'obsidianVersion'>;
  readonly openApiSha256: string;
  readonly checkedAt: string;
  readonly priorReadProfile?: StoredContractProfile;
  readonly results: ReadonlyArray<CapabilityResult>;
  readonly persist: (profile: StoredContractProfile) => Promise<void>;
}): Promise<StoredContractProfile> {
  const create = aggregateSafeCreate(input.results);
  const expectedKey = computeContractProfileKey({ ...input.fingerprint, openApiSha256: input.openApiSha256 });
  const exactPrior = input.priorReadProfile?.profileKey === expectedKey
    ? input.priorReadProfile
    : undefined;
  const safeRead = exactVerifiedReadProfile({
    prior: exactPrior,
    fingerprint: input.fingerprint,
    openApiSha256: input.openApiSha256
  });
  const externalResult = input.results.find((result) => result.operation === 'externalMutationObservation');
  const allEvidence = [
    ...(exactPrior?.evidence ?? []),
    ...input.results.filter((result) => result.operation !== 'safeRead').map(evidence)
  ];
  if (!safeRead) {
    allEvidence.push({
      operation: 'safeRead',
      status: 'unverified',
      timestamp: input.checkedAt,
      reasonCode: 'READ_FIDELITY_PROFILE_UNAVAILABLE',
      primitive: 'RAW_REREAD'
    });
  }
  allEvidence.push({
    operation: 'safeCreate',
    status: create.complete ? (create.passed ? 'passed' : 'failed') : 'unverified',
    timestamp: input.checkedAt,
    reasonCode: create.complete
      ? (create.passed ? 'SAFE_CREATE_CANDIDATE_VERIFIED' : 'SAFE_CREATE_UNPROVEN')
      : 'SAFE_CREATE_PROBE_INCOMPLETE'
  });
  allEvidence.push({
    operation: 'restartPersistence',
    status: 'unverified',
    timestamp: input.checkedAt,
    reasonCode: 'RESTART_NOT_RUN'
  });
  if (!allEvidence.some((record) => record.operation === 'cleanup')) {
    allEvidence.push({
      operation: 'cleanup',
      status: 'unverified',
      timestamp: input.checkedAt,
      reasonCode: 'MANUAL_CLEANUP_REQUIRED',
      primitive: 'DELETE_NON_PERMANENT'
    });
  }
  const profile = buildContractProfile({
    ...input.fingerprint,
    openApiSha256: input.openApiSha256,
    checkedAt: input.checkedAt,
    safeRead,
    safeCreate: create.passed,
    safeReplace: passed(input.results, 'safeReplace'),
    safeRestore: passed(input.results, 'safeRestore'),
    safeDelete: passed(input.results, 'safeDelete'),
    rereadVerified: passed(input.results, 'rereadVerified'),
    externalMutationObservation: externalResult?.status ?? 'unverified',
    restartPersistence: 'unverified',
    evidence: allEvidence
  });
  await input.persist(profile);
  return profile;
}
