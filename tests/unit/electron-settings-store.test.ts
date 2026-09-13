import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialVault, loadDesktopSettings, resolveInitialVaultSettings, saveDesktopSettings, validateDesktopVault } from '../../src/electron/settings-store.js';

const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), 'xiaozhao-settings-')); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('private desktop configuration', () => {
  it('round-trips a root privately, with no absent-config side effects', async () => {
    const userDataDir = await root();
    expect(await loadDesktopSettings({ userDataDir })).toBeUndefined();
    await saveDesktopSettings({ userDataDir, config: { vaultRoot: '/example/brain' } });
    expect(await loadDesktopSettings({ userDataDir })).toEqual({ vaultRoot: '/example/brain' });
    expect((await stat(join(userDataDir, 'config'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(userDataDir, 'config/app-config.json'))).mode & 0o777).toBe(0o600);
  });
  it('rejects a symlink config without changing its target', async () => {
    const userDataDir = await root();
    const outside = await root();
    await writeFile(join(outside, 'data'), 'protected');
    await symlink(outside, join(userDataDir, 'config'));
    await expect(saveDesktopSettings({ userDataDir, config: { vaultRoot: '/example/brain' } })).rejects.toThrow();
    expect(await readFile(join(outside, 'data'), 'utf8')).toBe('protected');
  });
  it('refuses overlapping vault and app data before constructing a reader', async () => {
    const userDataDir = await root();
    const create = vi.fn();
    await expect(validateDesktopVault({ vaultRoot: userDataDir, userDataDir, nativeReaderFactory: { create } })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it('preserves saved settings and removes its temporary file when sync fails', async () => {
    const userDataDir = await root();
    await saveDesktopSettings({ userDataDir, config: { vaultRoot: '/example/old-brain' } });
    const descriptor = await open(join(userDataDir, 'config/app-config.json'), 'r');
    const sync = vi.spyOn(Object.getPrototypeOf(descriptor), 'sync').mockRejectedValueOnce(new Error('EIO'));
    try {
      await expect(saveDesktopSettings({ userDataDir, config: { vaultRoot: '/example/new-brain' } })).rejects.toThrow('EIO');
      expect(await loadDesktopSettings({ userDataDir })).toEqual({ vaultRoot: '/example/old-brain' });
      expect(await readdir(join(userDataDir, 'config'))).toEqual(['app-config.json']);
    } finally { sync.mockRestore(); await descriptor.close(); }
  });
});

describe('initial vault selection', () => {
  function input(valid: string[]) {
    return {
      saved: { vaultRoot: '/saved' }, defaultRoot: '/default',
      validate: vi.fn(async (vaultRoot: string) => { if (!valid.includes(vaultRoot)) throw new Error('invalid'); return { vaultRoot }; }),
      chooseDirectory: vi.fn(async () => undefined as string | undefined),
      showInvalidSelection: vi.fn(async () => {})
    };
  }
  it('uses valid saved settings before default or picker', async () => {
    const args = input(['/saved', '/default']);
    expect(await resolveInitialVaultSettings(args)).toEqual({ vaultRoot: '/saved' });
    expect(args.chooseDirectory).not.toHaveBeenCalled();
  });
  it('uses a valid default after stale saved settings', async () => {
    const args = input(['/default']);
    expect(await resolveInitialVaultSettings(args)).toEqual({ vaultRoot: '/default' });
  });
  it('retries an invalid selection and accepts the next valid directory', async () => {
    const args = input(['/picked']);
    args.chooseDirectory.mockResolvedValueOnce('/bad').mockResolvedValueOnce('/picked');
    expect(await resolveInitialVaultSettings(args)).toEqual({ vaultRoot: '/picked' });
    expect(args.showInvalidSelection).toHaveBeenCalledOnce();
  });
  it('cancel returns no settings and cannot start any runtime', async () => {
    const args = input([]);
    expect(await resolveInitialVaultSettings(args)).toBeUndefined();
    args.chooseDirectory.mockResolvedValueOnce('/bad').mockResolvedValueOnce(undefined);
    expect(await resolveInitialVaultSettings(args)).toBeUndefined();
  });

  it('lets a first-launch choice create a starter vault before opening the picker', async () => {
    const args = input([]);
    const createInitial = vi.fn(async () => ({ vaultRoot: '/created' }));
    expect(await resolveInitialVaultSettings({
      ...args,
      showInitialChoice: vi.fn(async () => 'create' as const),
      createInitial
    })).toEqual({ vaultRoot: '/created' });
    expect(createInitial).toHaveBeenCalledOnce();
    expect(args.chooseDirectory).not.toHaveBeenCalled();
  });

  it('creates a starter vault only after the user chooses a parent directory', async () => {
    const parentRoot = await realpath(await root());
    const userDataDir = await root();
    const created = await createInitialVault({
      parentRoot,
      userDataDir,
      validate: vi.fn(async (vaultRoot: string) => ({ vaultRoot }))
    });
    expect(created).toEqual({ vaultRoot: join(parentRoot, '我的大脑') });
    expect(await readdir(join(parentRoot, '我的大脑'))).toEqual([
      '00大脑规则', '01图书馆', '02知识库', '03大讲堂', 'template-manifest.json', '最佳拍档入门说明.md'
    ]);
    expect(await readFile(join(parentRoot, '我的大脑', '00大脑规则/00_大脑规范.md'), 'utf8')).toContain('原始资料');
  });

  it('does not overwrite an existing folder when starter creation collides', async () => {
    const parentRoot = await realpath(await root());
    const userDataDir = await root();
    await mkdir(join(parentRoot, '我的大脑'));
    await writeFile(join(parentRoot, '我的大脑', 'keep.txt'), 'keep');
    await expect(createInitialVault({ parentRoot, userDataDir, validate: vi.fn() })).rejects.toThrow('INITIAL_VAULT_EXISTS');
    expect(await readFile(join(parentRoot, '我的大脑', 'keep.txt'), 'utf8')).toBe('keep');
  });
});
