import { constants, type Stats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { WorkdiskService } from '../server/workdisk/service.js';

const IMAGES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif']);
const VIDEOS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mpeg', '.mpg']);
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
  && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Small, ephemeral previews only. No original bytes or arbitrary file paths reach the renderer. */
export function createWorkdiskThumbnails(input: {
  service: Pick<WorkdiskService, 'status' | 'resolveFile'>;
  render(fd: number, kind: 'image' | 'video', signal: AbortSignal): Promise<string | null>;
  timeoutMs?: number;
}) {
  const cache = new Map<string, { identity: Stats; url: string }>();
  const pending = new Map<string, Promise<string | null>>();
  const queue: (() => void)[] = [];
  const controllers = new Set<AbortController>();
  let closed = false;
  let running = 0;
  let cacheBytes = 0;

  async function read(path: string, bindingId: string, signal: AbortSignal): Promise<string | null> {
    if (signal.aborted || (await input.service.status())?.id !== bindingId) return null;
    const absolute = await input.service.resolveFile(path);
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      const limit = IMAGES.has(extname(path).toLowerCase()) ? 40 * 1024 * 1024 : 4 * 1024 ** 3;
      if (!before.isFile() || before.size === 0 || before.size > limit) return null;
      const resolved = await input.service.resolveFile(path);
      if (resolved !== absolute || !sameFile(before, await stat(resolved)) || (await input.service.status())?.id !== bindingId || signal.aborted) return null;
      const key = `${bindingId}/${path}`;
      const saved = cache.get(key);
      const url = saved && sameFile(saved.identity, before) ? saved.url : await input.render(file.fd, IMAGES.has(extname(path).toLowerCase()) ? 'image' : 'video', signal);
      // Thumbnail generation is asynchronous: never publish a replaced file or a previous disk's result.
      const afterPath = await input.service.resolveFile(path);
      if (afterPath !== absolute || !sameFile(before, await file.stat()) || !sameFile(before, await stat(afterPath))
        || (await input.service.status())?.id !== bindingId || signal.aborted) return null;
      if (!url || url.length > 350_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/u.test(url)) return null;
      const previous = cache.get(key);
      if (previous) { cacheBytes -= previous.url.length; cache.delete(key); }
      cache.set(key, { identity: before, url }); cacheBytes += url.length;
      while (cache.size > 100 || cacheBytes > 16 * 1024 * 1024) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= cache.get(oldest)!.url.length; cache.delete(oldest);
      }
      return url;
    } finally { await file.close(); }
  }

  return {
    clear() { cache.clear(); cacheBytes = 0; },
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...pending.values()]);
      cache.clear(); cacheBytes = 0;
    },
    async thumbnail(path: string, bindingId: string): Promise<string | null> {
      if (closed) return null;
      const extension = extname(path).toLowerCase();
      if (!IMAGES.has(extension) && !VIDEOS.has(extension)) return null;
      const key = `${bindingId}/${path}`;
      const existing = pending.get(key);
      if (existing) return existing;
      if (queue.length >= 32) return null;
      const cancellation = new AbortController();
      controllers.add(cancellation);
      const task = new Promise<string | null>(resolve => {
        const start = () => {
          running++;
          // Queue wait is not decoding time. Cancel only a job that has started.
          const timer = setTimeout(() => cancellation.abort(), input.timeoutMs ?? 8000);
          void read(path, bindingId, cancellation.signal).catch(() => null).then(resolve).finally(() => {
            clearTimeout(timer); controllers.delete(cancellation); running--; queue.shift()?.();
          });
        };
        if (running < 2) start(); else queue.push(start);
      });
      // The timeout kills the bundled helper; its close event releases the native slot.
      const result = task.finally(() => { pending.delete(key); });
      pending.set(key, result);
      return result;
    }
  };
}
