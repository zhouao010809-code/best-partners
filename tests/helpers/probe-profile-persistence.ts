import {
  loadAnyCurrentContractProfileState,
  recoverContractProfileActivation,
  writeContractProfile,
  type ContractProfileState,
  type StoredContractProfile
} from '../../src/server/vault/contract-profile-store.js';

export async function loadProbeProfileBaseline(
  directory: string,
  _profileKey: string
): Promise<ContractProfileState | undefined> {
  await recoverContractProfileActivation(directory);
  return loadAnyCurrentContractProfileState(directory);
}

export function persistProbeProfile(
  directory: string,
  baseline: ContractProfileState | undefined,
  profile: StoredContractProfile
): Promise<ContractProfileState> {
  return writeContractProfile(directory, profile, {
    expectedRevision: baseline?.revision ?? null
  });
}
