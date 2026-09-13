import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { copyDefaultVaultTemplate, createInitialVault } from '../../src/electron/settings-store.js';

const roots: string[] = [];
async function tempRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), prefix));
  roots.push(path);
  return path;
}

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('first-run creation publishes the complete public template', async () => {
  const parentRoot = await tempRoot('xiaozhao-first-run-parent-');
  const userDataDir = await tempRoot('xiaozhao-first-run-user-');
  const settings = await createInitialVault({
    parentRoot,
    userDataDir,
    validate: async (vaultRoot) => ({ vaultRoot })
  });
  const vaultRoot = join(parentRoot, '我的大脑');
  expect(settings).toEqual({ vaultRoot });
  await expect(readFile(join(vaultRoot, 'template-manifest.json'), 'utf8')).resolves.toContain('"version": "1.0.0"');
  await expect(readFile(join(vaultRoot, '01图书馆/来自示例/2026-09/示例资料/示例资料.md'), 'utf8')).resolves.toMatch(/示例|虚构/u);
  expect((await readdir(parentRoot)).filter((entry) => entry.startsWith('.我的大脑-'))).toEqual([]);
});

test('first-run creation failure leaves no half-published brain', async () => {
  const parentRoot = await tempRoot('xiaozhao-first-run-parent-');
  const userDataDir = await tempRoot('xiaozhao-first-run-user-');
  await expect(copyDefaultVaultTemplate({
    parentRoot,
    userDataDir,
    templateRoot: resolve('templates/default-vault'),
    validate: async () => { throw new Error('VALIDATION_FAILED'); }
  })).rejects.toThrow('VALIDATION_FAILED');
  expect((await readdir(parentRoot)).filter((entry) => entry.startsWith('.我的大脑-'))).toEqual([]);
  await expect(readdir(join(parentRoot, '我的大脑'))).rejects.toMatchObject({ code: 'ENOENT' });
});
