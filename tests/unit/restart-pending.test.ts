import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRestartPending, writeRestartPending } from '../helpers/restart-pending.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record() {
  return {
    schemaVersion: 1 as const,
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    root: 'library' as const,
    noteId: 'restart.md',
    rawSha256: 'a'.repeat(64),
    upstreamVersion: 'version-token:1',
    profileKey: 'b'.repeat(64)
  };
}

describe('restart pending store', () => {
  it('atomically writes a sanitized 0600 record in a 0700 directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    await writeRestartPending(directory, record());
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'restart-pending.json'))).mode & 0o777).toBe(0o600);
    await expect(loadRestartPending(directory)).resolves.toEqual(record());
    expect(await readFile(join(directory, 'restart-pending.json'), 'utf8'))
      .not.toContain('/private/vault');
  });

  it('fails closed for missing, malformed, or path-bearing records', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    await expect(loadRestartPending(directory)).resolves.toBeUndefined();
    await expect(writeRestartPending(directory, {
      ...record(),
      noteId: '../private/restart.md'
    })).rejects.toThrowError('RESTART_PENDING_INVALID');
    await writeRestartPending(directory, record());
    await writeFile(join(directory, 'restart-pending.json'), 'secret malformed json');
    await expect(loadRestartPending(directory)).resolves.toBeUndefined();
  });
});
