import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPasswordPdf, createTextPdf } from '../helpers/pdf-fixture.js';
import { scanProjectFolder } from '../../src/server/projects/project-scanner.js';

const race = vi.hoisted(() => ({ noteLstatCount: 0, mutation: 'none' as 'none' | 'replace' | 'delete' | 'rename' }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (path: string) => {
      if (race.mutation !== 'none' && path.endsWith('/note.txt')) {
        race.noteLstatCount += 1;
        // The first scan performs two lstat calls for this file; mutate before
        // the third call, which belongs to the second consistency pass.
        if (race.noteLstatCount === 3) {
          if (race.mutation === 'replace') writeFileSync(path, 'after');
          if (race.mutation === 'delete') unlinkSync(path);
          if (race.mutation === 'rename') renameSync(path, `${path}.renamed`);
        }
      }
      return actual.lstat(path);
    }
  };
});

const temp = (name: string) => mkdtemp(join(tmpdir(), `xiaozhao-scan-${name}-`));
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

afterEach(() => {
  race.noteLstatCount = 0;
  race.mutation = 'none';
});

describe('project scanner', () => {
  it('scans deterministically, parses text/pdf and skips ignored directories', async () => {
    const root = await temp('basic');
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await mkdir(join(root, '.hg'), { recursive: true });
    await mkdir(join(root, '.svn'), { recursive: true });
    await mkdir(join(root, 'system'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, '.git', 'ignored.md'), 'ignored');
    await writeFile(join(root, 'node_modules', 'ignored.txt'), 'ignored');
    await writeFile(join(root, 'docs', 'readme.md'), '# Hello');
    await writeFile(join(root, 'notes.txt'), 'plain text');
    await writeFile(join(root, 'guide.pdf'), createTextPdf(['PDF evidence']));
    await writeFile(join(root, 'image.png'), Buffer.from([0, 1, 2]));
    const result = await scanProjectFolder(root);
    expect(result.sourceRoot).toBe(await realpath(root));
    expect(result.suggestedName).toBe(root.split('/').at(-1));
    expect(result.ignoredCount).toBe(5);
    expect(result.entries.map(entry => entry.relativePath)).toEqual([...result.entries].map(entry => entry.relativePath).sort());
    expect(result.entries.find(entry => entry.relativePath === 'docs/readme.md')).toMatchObject({ parseStatus: 'readable', content: '# Hello' });
    expect(result.entries.find(entry => entry.relativePath === 'notes.txt')).toMatchObject({ parseStatus: 'readable', content: 'plain text' });
    expect(result.entries.find(entry => entry.relativePath === 'guide.pdf')).toMatchObject({ parseStatus: 'readable', content: expect.stringContaining('PDF evidence') });
    expect(result.entries.find(entry => entry.relativePath === 'image.png')).toMatchObject({ parseStatus: 'unsupported', origin: 'source' });
    expect(result.entries.every(entry => entry.origin === 'source')).toBe(true);
    expect(result.entries.find(entry => entry.relativePath === 'notes.txt')?.sha256).toBe(sha256('plain text'));
    expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('records symlinks without following them and protects oversized text', async () => {
    const root = await temp('links');
    const outside = await temp('outside');
    await writeFile(join(outside, 'secret.md'), 'secret');
    await symlink(join(outside, 'secret.md'), join(root, 'secret.md'));
    await writeFile(join(root, 'large.md'), 'x'.repeat(1025));
    const result = await scanProjectFolder(root, { maxIndexedBytes: 1024 });
    expect(result.entries.find(entry => entry.relativePath === 'secret.md')).toBeUndefined();
    expect(result.issues.some(issue => /symlink/i.test(issue))).toBe(true);
    expect(result.entries.find(entry => entry.relativePath === 'large.md')).toMatchObject({ parseStatus: 'too-large' });
  });

  it('records encrypted PDF as a stable failed parse', async () => {
    const root = await temp('encrypted');
    await writeFile(join(root, 'locked.pdf'), createPasswordPdf());
    const result = await scanProjectFolder(root);
    expect(result.entries.find(entry => entry.relativePath === 'locked.pdf')).toMatchObject({ parseStatus: 'failed', problem: expect.any(String) });
  });

  it('rejects protected roots and detects a source change during hashing', async () => {
    const root = await temp('change');
    await writeFile(join(root, 'note.txt'), 'before');
    await expect(scanProjectFolder(root, { protectedRoots: [root] })).rejects.toMatchObject({ code: 'PROJECT_ROOT_PROTECTED' });
    race.mutation = 'replace';
    await expect(scanProjectFolder(root)).rejects.toMatchObject({ code: 'PROJECT_SOURCE_CHANGED' });
  });

  it.each(['delete', 'rename'] as const)('normalizes a source %s during verification', async mutation => {
    const root = await temp(`source-${mutation}`);
    await writeFile(join(root, 'note.txt'), 'before');
    race.mutation = mutation;
    await expect(scanProjectFolder(root)).rejects.toMatchObject({ code: 'PROJECT_SOURCE_CHANGED' });
  });

  it('honors an already-aborted signal', async () => {
    const root = await temp('aborted');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(scanProjectFolder(root, { signal: controller.signal })).rejects.toThrow('cancelled');
  });
});
