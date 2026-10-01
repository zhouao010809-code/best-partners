import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const cli = resolve('node_modules/tsx/dist/cli.mjs');
const script = resolve('scripts/package-extension.ts');
it('rebuilds the extension ZIP without retaining removed source members', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clipper-extension-package-'));
  try {
    const source = join(root, 'browser-extension'); await mkdir(join(source, 'icons'), { recursive: true });
    await writeFile(join(source, 'manifest.json'), '{"version":"1"}');
    await writeFile(join(source, 'removed.js'), 'removed'); await writeFile(join(source, 'icons', 'kept.svg'), '<svg/>');
    await exec(process.execPath, [cli, script], { cwd: root });
    await rm(join(source, 'removed.js')); await writeFile(join(source, 'manifest.json'), '{"version":"2"}');
    await exec(process.execPath, [cli, script], { cwd: root });
    const zip = join(root, 'dist', 'best-partners-clipper.zip');
    const { stdout } = await exec('unzip', ['-Z1', zip]);
    expect(stdout.trim().split('\n').sort()).toEqual(['icons/', 'icons/kept.svg', 'manifest.json']);
    expect((await exec('unzip', ['-p', zip, 'manifest.json'])).stdout).toBe('{"version":"2"}');
    expect(await readdir(join(root, 'dist'))).toEqual(expect.arrayContaining(['extension', 'best-partners-clipper.zip']));
    expect((await readdir(join(root, 'dist'))).filter(name => name.startsWith('.extension-'))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('keeps the previous published ZIP if a rebuild cannot copy its source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clipper-extension-package-failure-'));
  try {
    const source = join(root, 'browser-extension'); await mkdir(source);
    await writeFile(join(source, 'manifest.json'), '{"version":"1"}');
    await exec(process.execPath, [cli, script], { cwd: root });
    const zip = join(root, 'dist', 'best-partners-clipper.zip'), before = await readFile(zip);
    await rm(source, { recursive: true });
    await expect(exec(process.execPath, [cli, script], { cwd: root })).rejects.toThrow();
    expect(await readFile(zip)).toEqual(before);
    expect((await readdir(join(root, 'dist'))).filter(name => name.startsWith('.extension-'))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
