import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkdiskThumbnails } from '../../src/electron/workdisk-thumbnails.js';

const directories: string[] = [];
const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workdisk-thumbnails-'))); directories.push(root);
  let binding = 'one';
  for (const name of ['one.png', 'two.mp4', 'three.png']) await writeFile(join(root, name), 'fixture');
  const service = { status: async () => ({ id: binding, rootPath: root, displayName: '', connectedAt: '' }), resolveFile: async (path: string) => join(root, path) };
  const render = vi.fn(async (_fd: number, _kind: 'image' | 'video', _signal: AbortSignal): Promise<string | null> => jpeg);
  return { root, service, render, switchDisk: () => { binding = 'two'; } };
}

describe('workdisk thumbnail isolation and resource lifetime', () => {
  it('caches unchanged pixels and regenerates after the file changes', async () => {
    const f = await fixture(); const thumbnails = createWorkdiskThumbnails(f);
    expect(await thumbnails.thumbnail('one.png', 'one')).toBe(jpeg);
    expect(await thumbnails.thumbnail('one.png', 'one')).toBe(jpeg);
    expect(f.render).toHaveBeenCalledTimes(1);
    await writeFile(join(f.root, 'one.png'), 'changed picture');
    expect(await thumbnails.thumbnail('one.png', 'one')).toBe(jpeg);
    expect(f.render).toHaveBeenCalledTimes(2);
    await thumbnails.close();
  });
  it('rejects unsupported formats, symlinks, and a stale binding before decoding', async () => {
    const f = await fixture(); const thumbnails = createWorkdiskThumbnails(f);
    await symlink(join(f.root, 'one.png'), join(f.root, 'linked.png'));
    expect(await thumbnails.thumbnail('one.png', 'previous')).toBeNull();
    expect(await thumbnails.thumbnail('linked.png', 'one')).toBeNull();
    expect(await thumbnails.thumbnail('secret.txt', 'one')).toBeNull();
    expect(f.render).not.toHaveBeenCalled(); await thumbnails.close();
  });
  it.each(['file', 'binding'])('discards pixels when the %s changes during decoding', async what => {
    const f = await fixture();
    f.render.mockImplementationOnce(async () => {
      if (what === 'binding') f.switchDisk();
      else { await rename(join(f.root, 'one.png'), join(f.root, 'previous.png')); await writeFile(join(f.root, 'one.png'), 'replacement'); }
      return jpeg;
    });
    const thumbnails = createWorkdiskThumbnails(f);
    expect(await thumbnails.thumbnail('one.png', 'one')).toBeNull(); await thumbnails.close();
  });
  it('limits rendering to two jobs and gives a queued job its own decoding timeout', async () => {
    const f = await fixture();
    let calls = 0;
    let active = 0; let peak = 0;
    f.render.mockImplementation(async (_fd, _kind, signal) => {
      calls++; active++; peak = Math.max(active, peak);
      if (calls <= 2) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      active--; return signal.aborted ? null : jpeg;
    });
    const thumbnails = createWorkdiskThumbnails({ ...f, timeoutMs: 80 });
    const result = await Promise.all(['one.png', 'two.mp4', 'three.png'].map(path => thumbnails.thumbnail(path, 'one')));
    expect(result).toEqual([null, null, jpeg]); expect(peak).toBe(2); expect(active).toBe(0);
    await thumbnails.close();
  });
  it('cancels active helpers and queued work when the app closes', async () => {
    const f = await fixture();
    f.render.mockImplementation(async (_fd, _kind, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return null;
    });
    const thumbnails = createWorkdiskThumbnails(f);
    const pending = ['one.png', 'two.mp4', 'three.png'].map(path => thumbnails.thumbnail(path, 'one'));
    await vi.waitFor(() => expect(f.render).toHaveBeenCalledTimes(2));
    await thumbnails.close();
    expect(await Promise.all(pending)).toEqual([null, null, null]);
    expect(await thumbnails.thumbnail('one.png', 'one')).toBeNull();
    expect(f.render).toHaveBeenCalledTimes(2);
  });
});
