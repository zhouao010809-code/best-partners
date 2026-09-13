import { describe, expect, it } from 'vitest';
import {
  MAX_CONTENT_BYTES,
  MAX_TITLE_LENGTH,
  createClipperPayload,
  validateClipperPayload
} from '../../browser-extension/src/payload.js';
import { createPendingQueue } from '../../browser-extension/src/pending-queue.js';
import { createPendingStore } from '../../browser-extension/src/pending-store.js';

const valid = {
  packetId: 'packet-123',
  title: '一篇可收藏的文章',
  url: 'https://example.com/article',
  content: '正文内容',
  clippedAt: '2026-09-14T00:00:00.000Z'
};

describe('clipper payload schema', () => {
  it('requires packetId, title, url, content and clippedAt', () => {
    expect(validateClipperPayload(valid)).toEqual({ ok: true, value: valid });
    for (const field of ['packetId', 'title', 'url', 'content', 'clippedAt'] as const) {
      const candidate = { ...valid };
      delete candidate[field];
      expect(validateClipperPayload(candidate).ok, field).toBe(false);
    }
  });

  it('bounds title by characters and content by UTF-8 bytes', () => {
    expect(validateClipperPayload({ ...valid, title: '字'.repeat(MAX_TITLE_LENGTH) }).ok).toBe(true);
    expect(validateClipperPayload({ ...valid, title: '字'.repeat(MAX_TITLE_LENGTH + 1) }).ok).toBe(false);
    const under = '字'.repeat(Math.floor(MAX_CONTENT_BYTES / Buffer.byteLength('字')) - 1);
    const over = `${under}字字`;
    expect(Buffer.byteLength(under)).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
    expect(Buffer.byteLength(over)).toBeGreaterThan(MAX_CONTENT_BYTES);
    expect(validateClipperPayload({ ...valid, content: under }).ok).toBe(true);
    expect(validateClipperPayload({ ...valid, content: over }).ok).toBe(false);
  });

  it('rejects absolute paths, script protocols, and missing titles', () => {
    expect(validateClipperPayload({ ...valid, url: '/Users/private/article.md' }).ok).toBe(false);
    expect(validateClipperPayload({ ...valid, url: 'file:///Users/private/article.md' }).ok).toBe(false);
    expect(validateClipperPayload({ ...valid, url: 'javascript:alert(1)' }).ok).toBe(false);
    expect(validateClipperPayload({ ...valid, url: 'data:text/html,hello' }).ok).toBe(false);
    expect(validateClipperPayload({ ...valid, title: '   ' }).ok).toBe(false);
  });

  it('creates a normalized payload from page candidates', () => {
    const payload = createClipperPayload({
      title: '  页面标题  ',
      url: 'https://example.com/a',
      content: '  正文  ',
      clippedAt: '2026-09-14T01:02:03.000Z'
    });
    expect(payload.packetId).toMatch(/^[a-z0-9-]+$/u);
    expect(payload.title).toBe('页面标题');
    expect(payload.content).toBe('正文');
    expect(validateClipperPayload(payload).ok).toBe(true);
  });
});

describe('clipper delivery queue', () => {
  it('serializes concurrent deliver and retry operations without resurrecting sent payloads', async () => {
    const first = { ...valid, packetId: 'first' };
    const second = { ...valid, packetId: 'second' };
    const saved = new Map([[first.packetId, first]]);
    const events: string[] = [];
    const store = {
      async list() { return [...saved.values()]; },
      async save(payload: typeof first) { events.push(`save:${payload.packetId}`); saved.set(payload.packetId, payload); },
      async remove(packetId: string) { events.push(`remove:${packetId}`); saved.delete(packetId); }
    };
    const queue = createPendingQueue({ store, async send(payload: typeof first) {
      events.push(`send:${payload.packetId}`);
      await new Promise((resolve) => setTimeout(resolve, payload.packetId === 'first' ? 5 : 0));
      return { ok: true, packetId: payload.packetId };
    } });

    await Promise.all([queue.deliver(second), queue.retryPending()]);

    expect([...saved.keys()]).toEqual([]);
    expect(events.filter((event) => event.startsWith('send:'))).toEqual(['second', 'first'].map((id) => `send:${id}`));
  });
});

describe('clipper pending persistence', () => {
  it('keeps complete payloads in IndexedDB and only lightweight state in chrome.storage.local', async () => {
    const writes: unknown[] = [];
    const memoryDb = new Map<string, typeof valid>();
    const store = createPendingStore({
      storage: { async get() { return {}; }, async set(value: unknown) { writes.push(value); } },
      database: {
        async list() { return [...memoryDb.values()]; },
        async put(payload: typeof valid) { memoryDb.set(payload.packetId, payload); },
        async remove(packetId: string) { memoryDb.delete(packetId); }
      }
    });
    const large = { ...valid, content: '正文'.repeat(1000) };
    await store.save(large);

    expect(await store.list()).toEqual([large]);
    expect(JSON.stringify(writes)).not.toContain(large.content);
    expect(JSON.stringify(writes)).toContain(large.packetId);
  });
});
