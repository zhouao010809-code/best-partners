import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { VaultGateway } from '../../src/server/vault/VaultGateway.js';
import { assertContractReadVault, assertContractTestVault } from '../helpers/test-vault-guard.js';

const SENTINEL = 'xiaozhao-contract-v1';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  base: string;
  testVaultRoot: string;
  formalVaultRoot: string;
  sourceRoot: string;
  appDataRoot: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'test-vault-guard-'));
  roots.push(base);
  const testVaultRoot = join(base, 'test-vault');
  const formalVaultRoot = join(base, 'formal-vault');
  const sourceRoot = join(base, 'source');
  const appDataRoot = join(base, 'app-data');
  await Promise.all([
    mkdir(testVaultRoot),
    mkdir(formalVaultRoot),
    mkdir(sourceRoot),
    mkdir(appDataRoot)
  ]);
  await writeFile(join(testVaultRoot, '__XIAOZHAO_TEST_VAULT__'), `${SENTINEL}\n`);
  return { base, testVaultRoot, formalVaultRoot, sourceRoot, appDataRoot };
}

function gateway(marker = `${SENTINEL}\n`): VaultGateway {
  return {
    fingerprint: async () => ({ pluginId: 'test', pluginVersion: '5.1.0', obsidianVersion: '1.0.0' }),
    listDirectory: async () => [],
    readOpenApi: async () => '',
    readRaw: async (path) => ({
      path,
      bytes: new TextEncoder().encode(marker),
      rawSha256: 'fake',
      upstreamVersion: 'fake'
    })
  };
}

async function assertFixture(
  current: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Parameters<typeof assertContractTestVault>[0]> = {}
): Promise<void> {
  await assertContractTestVault({
    gateway: gateway(),
    testVaultRoot: current.testVaultRoot,
    formalVaultRoot: current.formalVaultRoot,
    sourceRoot: current.sourceRoot,
    appDataRoot: current.appDataRoot,
    allowWrite: '1',
    ...overrides
  });
}

describe('assertContractTestVault', () => {
  it('requires the exact write arming value before touching roots', async () => {
    const current = await fixture();
    await expect(assertFixture(current, { allowWrite: 'true' }))
      .rejects.toThrowError('CONTRACT_WRITE_NOT_ARMED');
  });

  it('rejects equal roots', async () => {
    const current = await fixture();
    await expect(assertFixture(current, { formalVaultRoot: current.testVaultRoot }))
      .rejects.toThrowError('CONTRACT_ROOTS_NOT_ISOLATED');
  });

  it('rejects a root contained by another root in either argument order', async () => {
    const current = await fixture();
    const child = join(current.formalVaultRoot, 'child');
    await mkdir(child);

    await expect(assertFixture(current, { sourceRoot: child }))
      .rejects.toThrowError('CONTRACT_ROOTS_NOT_ISOLATED');
    await expect(assertFixture(current, {
      formalVaultRoot: child,
      sourceRoot: current.formalVaultRoot
    })).rejects.toThrowError('CONTRACT_ROOTS_NOT_ISOLATED');
  });

  it('rejects symlink aliases after canonicalization', async () => {
    const current = await fixture();
    const alias = join(current.base, 'test-vault-alias');
    await symlink(current.testVaultRoot, alias);

    await expect(assertFixture(current, { formalVaultRoot: alias }))
      .rejects.toThrowError('CONTRACT_ROOTS_NOT_ISOLATED');
  });

  it('fails closed with a sanitized code when any root is missing', async () => {
    const current = await fixture();
    const missing = join(current.base, 'secret-missing-root');
    let thrown: unknown;
    try {
      await assertFixture(current, { appDataRoot: missing });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(new Error('CONTRACT_ROOT_INVALID'));
    expect(String(thrown)).not.toContain(missing);
  });

  it('rejects missing and mismatched REST or disk sentinels without leaking values', async () => {
    const current = await fixture();
    await expect(assertFixture(current, { gateway: gateway('wrong-secret-marker') }))
      .rejects.toThrowError('TEST_VAULT_SENTINEL_MISSING');

    await rm(join(current.testVaultRoot, '__XIAOZHAO_TEST_VAULT__'));
    let thrown: unknown;
    try {
      await assertFixture(current);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(new Error('TEST_VAULT_SENTINEL_MISSING'));
    expect(String(thrown)).not.toContain('wrong-secret-marker');
  });

  it('accepts isolated canonical roots and matching trimmed sentinels', async () => {
    const current = await fixture();
    await expect(assertFixture(current)).resolves.toBeUndefined();
  });

  it('allows the same isolation and sentinel checks for a read-only probe without write arming', async () => {
    const current = await fixture();
    await expect(assertContractReadVault({
      gateway: gateway(),
      testVaultRoot: current.testVaultRoot,
      formalVaultRoot: current.formalVaultRoot,
      sourceRoot: current.sourceRoot,
      appDataRoot: current.appDataRoot
    })).resolves.toBeUndefined();
  });
});
