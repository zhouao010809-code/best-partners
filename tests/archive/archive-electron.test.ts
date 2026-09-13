import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createArchiveFixture, archiveSource as source, archiveTarget as target } from '../helpers/archive-fixture.js';

it('runs the journalled move under an actual Electron main process', async () => {
  await promisify(execFile)(process.execPath, ['node_modules/tsup/dist/cli-default.js',
    'tests/helpers/archive-electron-worker.ts', '--format', 'esm', '--platform', 'node', '--target', 'node22',
    '--out-dir', 'dist/sandbox-tests', '--external', 'electron']);
  const value = createArchiveFixture();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const { stdout } = await promisify(execFile)(resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      [resolve('dist/sandbox-tests/archive-electron-worker.js'), value.root, resolve('dist/native/sandbox-archive.node')],
      { env, timeout: 15_000 }).catch((error: { stdout: string; stderr: string; message: string }) => {
        throw new Error(JSON.stringify(error));
      });
    const line = stdout.split('\n').find((entry) => entry.startsWith('ARCHIVE_ELECTRON_RESULT:'));
    expect(line, stdout).toBeDefined();
    expect(JSON.parse(line!.slice('ARCHIVE_ELECTRON_RESULT:'.length))).toMatchObject({ state: 'moved' });
    expect(existsSync(join(value.root, source))).toBe(false);
    expect(readFileSync(join(value.root, target, '原文.md'))).toEqual(value.original);
    expect(readFileSync(join(value.root, target, '附件/原图.bin'))).toEqual(Buffer.from([0, 255, 1, 13, 10]));
    expect(existsSync(join(value.root, target, '附件/空文件夹'))).toBe(true);
  } finally { value.cleanup(); }
});
