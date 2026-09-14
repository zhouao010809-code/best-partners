import { cp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const source = resolve('browser-extension');
const output = resolve('dist/extension');
await rm(output, { recursive: true, force: true });
await mkdir(resolve('dist'), { recursive: true });
await cp(source, output, { recursive: true });
await exec('zip', ['-qr', join(resolve('dist'), 'best-partners-clipper.zip'), '.'], { cwd: output });
process.stdout.write(`${output}\n`);
