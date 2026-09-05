import { join } from 'node:path';
import { assertStateRootOutsideVault, ensurePrivateDirectory } from '../server/db/permissions.js';

export function prepareVaultCacheDirectory(input: {
  readonly userDataDir: string;
  readonly vaultRoot: string;
  readonly cacheKey: string;
}): string {
  if (!/^[a-f0-9]{64}$/u.test(input.cacheKey)) throw new Error('INVALID_VAULT_CACHE_KEY');
  const vaults = join(input.userDataDir, 'vaults');
  const directory = join(vaults, input.cacheKey);
  assertStateRootOutsideVault(input.userDataDir, input.vaultRoot);
  assertStateRootOutsideVault(directory, input.vaultRoot);
  for (const path of [input.userDataDir, vaults, directory]) ensurePrivateDirectory(path);
  return directory;
}
