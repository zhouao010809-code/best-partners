import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const READ_TEST_SENTINEL = '.xiaozhao-read-test-vault.json';
export const READ_TEST_SENTINEL_BYTES = '{"purpose":"read-test"}\n';

export async function createFilesystemVaultFixture(): Promise<{ root: string; cleanup(): Promise<void> }> {
  const temporaryRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryRoot, 'xiaozhao-vault-'));
  await chmod(root, 0o700);
  await writeFile(join(root, READ_TEST_SENTINEL), READ_TEST_SENTINEL_BYTES, { mode: 0o600, flag: 'wx' });
  for (const name of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂']) {
    await mkdir(join(root, name), { mode: 0o700 });
  }
  return {
    root,
    async cleanup() {
      if (dirname(root) !== temporaryRoot || !basename(root).startsWith('xiaozhao-vault-')
        || !(await lstat(root)).isDirectory() || await realpath(root) !== root
        || await readFile(join(root, READ_TEST_SENTINEL), 'utf8') !== READ_TEST_SENTINEL_BYTES) {
        throw new Error('UNSAFE_FIXTURE_CLEANUP');
      }
      await rm(root, { recursive: true });
    }
  };
}
