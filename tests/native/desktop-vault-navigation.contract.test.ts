import { execFile } from 'node:child_process';
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createDesktopVaultNavigation } from '../../src/electron/vault-navigation.js';
import { NativeReadVaultPort } from '../../src/server/vault/NativeReadVaultPort.js';
import { createFilesystemVaultFixture } from '../helpers/filesystem-vault-fixture.js';

type Fixture = Awaited<ReturnType<typeof createFilesystemVaultFixture>>;
const fixtures: Fixture[] = [];
let helperPath: string;
async function fixture(): Promise<Fixture> {
  const value = await createFilesystemVaultFixture();
  fixtures.push(value);
  return value;
}
beforeAll(async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('NATIVE_TEST_REQUIRES_MACOS_ARM64');
  const build = await fixture();
  helperPath = join(build.root, 'atomic-file-helper-test');
  await promisify(execFile)('xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-arch', 'arm64',
    '-mmacosx-version-min=13.0', resolve('native/macos/atomic-file-helper.c'), '-o', helperPath]);
});
afterAll(async () => { for (const value of fixtures.reverse()) await value.cleanup(); });

it('refuses symlink escape, missing documents and directories before invoking Finder', async () => {
  const vault = await fixture();
  const outside = await fixture();
  await writeFile(join(outside.root, '01图书馆', 'outside.md'), 'private');
  await symlink(join(outside.root, '01图书馆', 'outside.md'), join(vault.root, '01图书馆', 'link.md'));
  await symlink(join(outside.root, '01图书馆'), join(vault.root, '01图书馆', 'linked-directory'));
  await mkdir(join(vault.root, '01图书馆', 'directory.md'));
  const shell = { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() };
  const reader = await NativeReadVaultPort.create({ root: vault.root, helperPath });
  const navigation = createDesktopVaultNavigation({ reader, shell });
  for (const path of ['01图书馆/link.md', '01图书馆/linked-directory/outside.md', '01图书馆/missing.md', '01图书馆/directory.md']) {
    await expect(navigation.revealDocument(path)).rejects.toThrow('无法定位这份资料');
  }
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
  await writeFile(join(vault.root, '01图书馆', 'actual.md'), 'own file');
  await navigation.revealDocument('01图书馆/actual.md');
  expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(join(vault.root, '01图书馆', 'actual.md'));
});

it('refuses opening or revealing through a replaced active vault root', async () => {
  const vault = await fixture();
  const holder = await fixture();
  await writeFile(join(vault.root, '01图书馆', 'note.md'), 'original');
  const reader = await NativeReadVaultPort.create({ root: vault.root, helperPath });
  const shell = { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() };
  const navigation = createDesktopVaultNavigation({ reader, shell });
  const movedRoot = join(holder.root, 'moved-vault');
  await rename(vault.root, movedRoot);
  await mkdir(vault.root);
  try {
    await expect(navigation.openVaultDirectory()).rejects.toThrow('未能打开当前大脑文件夹');
    await expect(navigation.revealDocument('01图书馆/note.md')).rejects.toThrow('无法定位这份资料');
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  } finally {
    // Restore the fixture's sentinel and root identity for its guarded cleanup.
    const { rmdir } = await import('node:fs/promises');
    await rmdir(vault.root);
    await rename(movedRoot, vault.root);
  }
});
