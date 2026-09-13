import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyDefaultVaultTemplate, createInitialVault, resolveDefaultVaultTemplateRoot } from '../../src/electron/settings-store.js';

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'xiaozhao-template-'));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('default vault template distribution', () => {
  it('resolves the repository and packaged template locations explicitly', () => {
    expect(resolveDefaultVaultTemplateRoot({ packaged: false })).toBe(resolve('templates/default-vault'));
    expect(resolveDefaultVaultTemplateRoot({ packaged: true, resourcesPath: '/opt/best-partners/resources' }))
      .toBe('/opt/best-partners/resources/templates/default-vault');
  });

  it('copies the manifest-verified template into an atomic private vault', async () => {
    const parentRoot = await realpath(await root());
    const userDataDir = await root();
    const validate = vi.fn(async (vaultRoot: string) => ({ vaultRoot }));

    const settings = await copyDefaultVaultTemplate({
      parentRoot,
      userDataDir,
      templateRoot: resolve('templates/default-vault'),
      validate
    });

    const vaultRoot = join(parentRoot, '我的大脑');
    expect(settings).toEqual({ vaultRoot });
    expect(validate).toHaveBeenCalledWith(vaultRoot);
    expect(await readFile(join(vaultRoot, 'template-manifest.json'), 'utf8')).toContain('"version": "1.0.0"');
    expect(await readFile(join(vaultRoot, '最佳拍档入门说明.md'), 'utf8')).toContain('示例');
    expect((await readdir(parentRoot)).filter((entry) => entry.startsWith('.我的大脑-'))).toEqual([]);
  });

  it('removes a newly published vault when validation fails', async () => {
    const parentRoot = await realpath(await root());
    const userDataDir = await root();
    await expect(copyDefaultVaultTemplate({
      parentRoot,
      userDataDir,
      templateRoot: resolve('templates/default-vault'),
      validate: vi.fn(async () => { throw new Error('INVALID_TEMPLATE_OUTPUT'); })
    })).rejects.toThrow('INVALID_TEMPLATE_OUTPUT');
    await expect(readFile(join(parentRoot, '我的大脑', '最佳拍档入门说明.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(parentRoot)).filter((entry) => entry.startsWith('.我的大脑-'))).toEqual([]);
  });

  it('rejects a colliding name and leaves the existing directory untouched', async () => {
    const parentRoot = await realpath(await root());
    const userDataDir = await root();
    const existing = join(parentRoot, '我的大脑');
    await mkdir(existing);
    await writeFile(join(existing, 'keep.txt'), 'keep');
    await expect(createInitialVault({ parentRoot, userDataDir, validate: vi.fn() })).rejects.toThrow('INITIAL_VAULT_EXISTS');
    expect(await readFile(join(existing, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('rejects a colliding symlink without touching its target', async () => {
    const parentRoot = await realpath(await root());
    const userDataDir = await root();
    const outside = await root();
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await symlink(outside, join(parentRoot, '我的大脑'));
    await expect(createInitialVault({ parentRoot, userDataDir, validate: vi.fn() })).rejects.toThrow('INITIAL_VAULT_EXISTS');
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('rejects a symlink parent before reading or writing the template', async () => {
    const actual = await root();
    const parentRoot = join((await root()), 'parent-link');
    await symlink(actual, parentRoot);
    const userDataDir = await root();
    await expect(copyDefaultVaultTemplate({
      parentRoot,
      userDataDir,
      templateRoot: resolve('templates/default-vault'),
      validate: vi.fn()
    })).rejects.toThrow('INITIAL_VAULT_PARENT_INVALID');
  });
});
