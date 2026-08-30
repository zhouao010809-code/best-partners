import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { VaultGateway } from '../../src/server/vault/VaultGateway.js';

const SENTINEL_PATH = '__XIAOZHAO_TEST_VAULT__';
const SENTINEL_VALUE = 'xiaozhao-contract-v1';

function contains(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent === ''
    || (fromParent !== '..' && !fromParent.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      && !isAbsolute(fromParent));
}

type ContractVaultContext = {
  gateway: VaultGateway;
  testVaultRoot: string;
  formalVaultRoot: string;
  sourceRoot: string;
  appDataRoot: string;
};

async function assertIsolationAndSentinel(input: ContractVaultContext): Promise<void> {
  let roots: string[];
  try {
    roots = await Promise.all([
      realpath(input.testVaultRoot),
      realpath(input.formalVaultRoot),
      realpath(input.sourceRoot),
      realpath(input.appDataRoot)
    ]);
  } catch {
    throw new Error('CONTRACT_ROOT_INVALID');
  }

  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (contains(roots[left]!, roots[right]!) || contains(roots[right]!, roots[left]!)) {
        throw new Error('CONTRACT_ROOTS_NOT_ISOLATED');
      }
    }
  }

  try {
    const [restMarker, diskMarker] = await Promise.all([
      input.gateway.readRaw(SENTINEL_PATH),
      readFile(join(roots[0]!, SENTINEL_PATH), 'utf8')
    ]);
    const restValue = new TextDecoder().decode(restMarker.bytes).trim();
    const diskValue = diskMarker.trim();
    if (restValue !== SENTINEL_VALUE || diskValue !== SENTINEL_VALUE || restValue !== diskValue) {
      throw new Error('TEST_VAULT_SENTINEL_MISSING');
    }
  } catch {
    throw new Error('TEST_VAULT_SENTINEL_MISSING');
  }
}

export async function assertContractReadVault(input: ContractVaultContext): Promise<void> {
  await assertIsolationAndSentinel(input);
}

export async function assertContractTestVault(input: ContractVaultContext & {
  allowWrite: string | undefined;
}): Promise<void> {
  if (input.allowWrite !== '1') {
    throw new Error('CONTRACT_WRITE_NOT_ARMED');
  }

  await assertIsolationAndSentinel(input);
}
