import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertClientBundleBudget, CLIENT_ENTRY_MAX_BYTES } from '../../scripts/check-client-bundle.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('client bundle budget', () => {
  it('accepts a client entry below the budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaozhao-client-budget-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'index-test.js'), Buffer.alloc(CLIENT_ENTRY_MAX_BYTES - 1));

    await expect(assertClientBundleBudget(root)).resolves.toMatchObject({
      entry: 'assets/index-test.js',
      bytes: CLIENT_ENTRY_MAX_BYTES - 1,
      maxBytes: CLIENT_ENTRY_MAX_BYTES
    });
  });

  it('rejects an entry above the budget with a stable error code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaozhao-client-budget-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'index-test.js'), Buffer.alloc(CLIENT_ENTRY_MAX_BYTES + 1));

    await expect(assertClientBundleBudget(root)).rejects.toMatchObject({
      code: 'CLIENT_BUNDLE_BUDGET_EXCEEDED',
      bytes: CLIENT_ENTRY_MAX_BYTES + 1,
      maxBytes: CLIENT_ENTRY_MAX_BYTES
    });
  });
});
