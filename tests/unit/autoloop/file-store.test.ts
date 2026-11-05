import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { withAutoloopLock } from '../../../src/server/autoloop/file-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'autoloop-lock-')); roots.push(root);
  return { root, file: join(root, 'rules.lock') };
}

it('recovers an abandoned empty legacy lock after its creation grace period', async () => {
  const { root, file } = await fixture(); await writeFile(file, '');
  const old = new Date(Date.now() - 60_000); await utimes(file, old, old);
  await expect(withAutoloopLock(file, async () => 'saved')).resolves.toBe('saved');
  expect(await readdir(root)).toEqual([]);
});

it('recovers a dead process owner once while concurrent writers wait', async () => {
  const { root, file } = await fixture();
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
  await writeFile(file, String(child.pid));
  let active = 0; let peak = 0;
  await Promise.all(Array.from({ length: 12 }, () => withAutoloopLock(file, async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
  })));
  expect(peak).toBe(1); expect(await readdir(root)).toEqual([]);
});

it('serializes contenders and releases the lock when an operation fails', async () => {
  const { root, file } = await fixture(); let active = 0; let peak = 0; let completed = 0;
  await Promise.all(Array.from({ length: 16 }, () => withAutoloopLock(file, async () => {
    peak = Math.max(peak, ++active);
    expect(await readFile(file, 'utf8')).toBe(String(process.pid));
    await new Promise(resolve => setTimeout(resolve, 2));
    completed++; active--;
  })));
  expect(peak).toBe(1); expect(completed).toBe(16);
  await expect(withAutoloopLock(file, async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
  await expect(withAutoloopLock(file, async () => 'retried')).resolves.toBe('retried');
  expect(await readdir(root)).toEqual([]);
});

it('does not evict a live owner or an empty lock still being initialized', async () => {
  const { file } = await fixture(); await writeFile(file, String(process.pid));
  const old = new Date(Date.now() - 60_000); await utimes(file, old, old);
  await expect(withAutoloopLock(file, async () => 'unsafe')).rejects.toMatchObject({ code: 'AUTOLOOP_BUSY' });
  expect(await readFile(file, 'utf8')).toBe(String(process.pid));
  await writeFile(file, '');
  await expect(withAutoloopLock(file, async () => 'unsafe')).rejects.toMatchObject({ code: 'AUTOLOOP_BUSY' });
  expect(await readFile(file, 'utf8')).toBe('');
}, 10_000);
