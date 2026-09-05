import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareVaultCacheDirectory } from '../../src/electron/vault-cache.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xiaozhao-vault-cache-'));
  roots.push(root);
  const vaultRoot = join(root, 'vault');
  await mkdir(vaultRoot);
  return { root, vaultRoot, userDataDir: join(root, 'appdata'), cacheKey: 'a'.repeat(64) };
}

it('creates private per-vault cache folders and reuses existing data without touching old caches', async () => {
  const input = await fixture();
  const first = prepareVaultCacheDirectory(input);
  expect(first).toBe(join(input.userDataDir, 'vaults', input.cacheKey));
  for (const path of [input.userDataDir, join(input.userDataDir, 'vaults'), first]) {
    expect((await stat(path)).mode & 0o777).toBe(0o700);
  }
  await writeFile(join(first, 'marker'), 'vault A cached data');
  await writeFile(join(input.userDataDir, 'state.sqlite3'), 'untouched old shared cache');
  expect(prepareVaultCacheDirectory(input)).toBe(first);
  const second = prepareVaultCacheDirectory({ ...input, cacheKey: 'b'.repeat(64) });
  expect(second).not.toBe(first);
  expect(await readFile(join(first, 'marker'), 'utf8')).toBe('vault A cached data');
  expect(await readFile(join(input.userDataDir, 'state.sqlite3'), 'utf8')).toBe('untouched old shared cache');
});

it('rejects malformed keys, overlapping state, and symlink namespace directories', async () => {
  const input = await fixture();
  expect(() => prepareVaultCacheDirectory({ ...input, cacheKey: '../vault' })).toThrow('INVALID_VAULT_CACHE_KEY');
  expect(() => prepareVaultCacheDirectory({ ...input, userDataDir: join(input.vaultRoot, 'data') })).toThrow();
  await mkdir(input.userDataDir);
  await symlink(input.vaultRoot, join(input.userDataDir, 'vaults'));
  expect(() => prepareVaultCacheDirectory(input)).toThrow();
});
