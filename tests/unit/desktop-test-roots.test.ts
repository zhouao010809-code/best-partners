import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDesktopTestRoots } from '../../src/electron/test-roots.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const temporary = await realpath(tmpdir());
  const vaultRoot = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userDataDir = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  roots.push(vaultRoot, userDataDir);
  await writeFile(join(vaultRoot, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
  return { vaultRoot, userDataDir };
}
describe('Electron test roots before cache creation', () => {
  it('accepts only already-created private sibling fixtures with exact sentinel', async () => {
    const input = await fixture();
    // Must finish synchronously: Electron can auto-initialize while an async guard yields.
    expect(validateDesktopTestRoots(input)).toEqual(input);
  });
  it('rejects formal or overlapping roots without creating directories', async () => {
    const input = await fixture();
    for (const userDataDir of ['/Users/ao/我的大脑', '/Users/ao/我的大脑/cache', '/Users/ao', input.vaultRoot, join(input.userDataDir, 'nested')]) {
      expect(() => validateDesktopTestRoots({ ...input, userDataDir })).toThrow('TEST_ROOTS_INVALID');
    }
  });
  it('rejects aliases, shared permissions and wrong sentinels', async () => {
    const input = await fixture();
    const alias = join(input.userDataDir, 'alias');
    await symlink(input.vaultRoot, alias);
    expect(() => validateDesktopTestRoots({ ...input, vaultRoot: alias })).toThrow('TEST_ROOTS_INVALID');
    await chmod(input.userDataDir, 0o755);
    expect(() => validateDesktopTestRoots(input)).toThrow('TEST_ROOTS_INVALID');
    await chmod(input.userDataDir, 0o700);
    await writeFile(join(input.vaultRoot, '.xiaozhao-read-test-vault.json'), '{}');
    expect(() => validateDesktopTestRoots(input)).toThrow('TEST_ROOTS_INVALID');
  });
});
