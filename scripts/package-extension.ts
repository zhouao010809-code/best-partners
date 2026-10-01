import { cp, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
async function members(directory: string, prefix = ''): Promise<string[]> {
  const entries: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (!item.isDirectory() && !item.isFile()) throw Error('EXTENSION_MEMBER_UNSAFE');
    if (/[\r\n]/u.test(item.name)) throw Error('EXTENSION_MEMBER_NAME_INVALID');
    const name = `${prefix}${item.name}${item.isDirectory() ? '/' : ''}`;
    entries.push(name);
    if (item.isDirectory()) entries.push(...await members(join(directory, item.name), name));
  }
  return entries.sort();
}
export async function packageExtension(source = resolve('browser-extension'), dist = resolve('dist')): Promise<string> {
  const output = join(dist, 'extension');
  await mkdir(dist, { recursive: true });
  const temporary = await mkdtemp(join(dist, '.extension-'));
  try {
    const staged = join(temporary, 'extension'), zip = join(temporary, 'clipper.zip');
    await cp(source, staged, { recursive: true });
    const expected = await members(staged);
    // A fresh archive prevents zip's update mode from retaining deleted members.
    await exec('zip', ['-qr', zip, '.'], { cwd: staged });
    await exec('unzip', ['-tq', zip]);
    const { stdout } = await exec('unzip', ['-Z1', zip]);
    const actual = stdout.trimEnd().split('\n').sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('EXTENSION_ZIP_MEMBERS_MISMATCH');
    await rm(output, { recursive: true, force: true });
    await rename(staged, output);
    await rename(zip, join(dist, 'best-partners-clipper.zip'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${await packageExtension()}\n`);
}
