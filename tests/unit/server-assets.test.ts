import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('server migration assets', () => {
  it('copies every published migration, including additive migrations, into the bundle layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaozhao-server-assets-'));
    roots.push(root);
    const source = join(root, 'src/server/db/migrations');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, '001_initial.sql'), 'SELECT 1;\n', 'utf8');
    await writeFile(join(source, '002_read_api_jobs.sql'), 'SELECT 2;\n', 'utf8');

    await execFileAsync(
      resolve('node_modules/.bin/tsx'),
      [resolve('scripts/copy-server-assets.ts')],
      { cwd: root }
    );

    await expect(readFile(join(root, 'dist/server/db/migrations/001_initial.sql'), 'utf8'))
      .resolves.toBe('SELECT 1;\n');
    await expect(readFile(join(root, 'dist/server/db/migrations/002_read_api_jobs.sql'), 'utf8'))
      .resolves.toBe('SELECT 2;\n');
  });
});
