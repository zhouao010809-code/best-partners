import { afterEach, expect, it, vi } from 'vitest';
import { link, mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkdiskService } from '../../src/server/workdisk/service.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), open: vi.fn(actual.open) };
});

const cleanup: string[] = [];
afterEach(async () => { vi.mocked(link).mockReset(); vi.mocked(open).mockReset(); await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'workdisk-')); cleanup.push(base);
  const root = join(base, '工作盘'); const vault = join(base, '知识库'); const stateDirectory = join(base, 'state'); const source = join(base, 'source');
  await Promise.all([root, vault, stateDirectory, source].map(path => mkdir(path)));
  const config = { stateDirectory, protectedRoots: [vault] };
  return { base, root, vault, stateDirectory, source, config, service: createWorkdiskService(config) };
}
it('connects an ordinary folder and restores its binding without requiring brain structure', async () => {
  const f = await setup(); expect(await f.service.status()).toBeNull();
  const bound = await f.service.bind(f.root); expect(bound.displayName).toBe('工作盘');
  expect(await createWorkdiskService(f.config).status()).toEqual(bound);
  expect((await f.service.list()).files).toEqual([]);
});
it('copies files into date/type folders without changing sources or overwriting collisions', async () => {
  const f = await setup(); await f.service.bind(f.root);
  const source = join(f.source, '招生.mp4'); await writeFile(source, 'original-video');
  const first = await f.service.importFiles([source], '2026-10-28');
  const second = await f.service.importFiles([source], '2026-10-28');
  expect(first.failures).toEqual([]); expect(second.failures).toEqual([]);
  expect(first.files[0]?.path).toBe('2026-10-28/视频/招生.mp4');
  expect(second.files[0]?.path).not.toBe(first.files[0]?.path);
  expect(await readFile(source, 'utf8')).toBe('original-video');
  expect(await readFile(join(f.root, second.files[0]!.path), 'utf8')).toBe('original-video');
  expect((await f.service.list({ date: '2026-10-28', kind: 'video' })).files).toHaveLength(2);
});
it('saves a note in the actual folder and finds its body using a dated expanded search', async () => {
  const f = await setup(); await f.service.bind(f.root);
  const note = await f.service.createNote({ title: '发布文案', body: '少儿美术体验课，面向一年级家长。', date: '2026-09-28' });
  expect(note.path).toBe('2026-09-28/文档/发布文案.md');
  expect(await readFile(join(f.root, note.path), 'utf8')).toBe('少儿美术体验课，面向一年级家长。');
  const result = await f.service.list({ query: '找上个月28号的招生稿', plan: { terms: ['招生', '美术'], startDate: '2026-09-28', endDate: '2026-09-28', kind: 'document' } });
  expect(result.files).toHaveLength(1); expect(result.files[0]).toMatchObject({ matchedBy: 'content', excerpt: expect.stringContaining('美术') });
  expect((await f.service.preview(note.path)).text).toContain('一年级');
  expect((await f.service.list({ query: '没有的词' })).files).toEqual([]);
});
it('reads existing folders and reflects external additions/removals; dated folders beat modification time', async () => {
  const f = await setup(); await f.service.bind(f.root);
  await mkdir(join(f.root, '2026-09-28')); await writeFile(join(f.root, '2026-09-28', '旧文案.txt'), '作品展');
  await utimes(join(f.root, '2026-09-28', '旧文案.txt'), new Date(), new Date());
  expect((await f.service.list({ date: '2026-09-28' })).files[0]?.name).toBe('旧文案.txt');
  await rm(join(f.root, '2026-09-28', '旧文案.txt'));
  expect((await f.service.list()).files).toEqual([]);
});
it('refuses protected overlap, root symlinks, path traversal and file symlinks', async () => {
  const f = await setup();
  await expect(f.service.bind(f.vault)).rejects.toThrow();
  await expect(f.service.bind(f.base)).rejects.toThrow();
  const alias = join(f.base, 'alias'); await symlink(f.root, alias);
  await expect(f.service.bind(alias)).rejects.toThrow();
  await f.service.bind(f.root);
  await writeFile(join(f.vault, 'secret.txt'), 'secret'); await symlink(join(f.vault, 'secret.txt'), join(f.root, 'secret.txt'));
  await expect(f.service.resolveFile('../知识库/secret.txt')).rejects.toThrow();
  await expect(f.service.preview('secret.txt')).rejects.toThrow();
  expect((await f.service.list()).files).toEqual([]);
  expect((await f.service.list()).skippedCount).toBe(1);
});
it('refuses writes through a replaced date directory and detects a replaced bound root after restart', async () => {
  const f = await setup(); await f.service.bind(f.root);
  await symlink(f.vault, join(f.root, '2026-10-28'));
  await expect(f.service.createNote({ title: '禁止', body: '不得写入知识库', date: '2026-10-28' })).rejects.toThrow();
  expect(await readdir(f.vault)).toEqual([]);
  await rename(f.root, `${f.root}-old`); await mkdir(f.root);
  await expect(createWorkdiskService(f.config).list()).rejects.toThrow();
  expect(await readdir(f.root)).toEqual([]);
});
it('rejects impossible dates, malicious names and invalid search limits before touching files', async () => {
  const f = await setup(); await f.service.bind(f.root);
  await expect(f.service.createNote({ title: '../逃逸', body: 'x', date: '2026-10-28' })).rejects.toThrow();
  await expect(f.service.createNote({ title: 'x', body: 'x', date: '2026-02-30' })).rejects.toThrow();
  await expect(f.service.list({ plan: { terms: ['x'], startDate: '2026-02-30' } })).rejects.toThrow();
  expect(await readdir(f.root)).toEqual([]);
});
it('reports partial import errors and never publishes an incomplete copy', async () => {
  const f = await setup(); await f.service.bind(f.root);
  await writeFile(join(f.source, 'good.txt'), 'good');
  const result = await f.service.importFiles([join(f.source, 'missing.txt'), join(f.source, 'good.txt')], '2026-10-28');
  expect(result.failures).toHaveLength(1); expect(result.files).toHaveLength(1);
  expect(await readdir(join(f.root, '2026-10-28', '文档'))).toEqual(['good.txt']);
});
it('serializes a save before reconnecting and recovers an invalid connection record through an explicit bind', async () => {
  const f = await setup(); await f.service.bind(f.root); const second = join(f.base, 'second'); await mkdir(second);
  const saving = f.service.createNote({ title: '先保存', body: 'original disk', date: '2026-10-28' });
  const reconnecting = f.service.bind(second); await Promise.all([saving, reconnecting]);
  expect(await readFile(join(f.root, '2026-10-28', '文档', '先保存.md'), 'utf8')).toBe('original disk');
  expect(await readdir(second)).toEqual([]);
  await writeFile(join(f.stateDirectory, 'workdisk.json'), '{invalid');
  const restored = createWorkdiskService(f.config); await expect(restored.status()).rejects.toThrow('重新连接');
  await restored.bind(f.root); expect((await restored.list()).files).toHaveLength(1);
});
it('bounds text previews, exposes partial text searching and never renders SVG as an image', async () => {
  const f = await setup(); await f.service.bind(f.root);
  await writeFile(join(f.root, 'large.txt'), 'header\n' + 'a'.repeat(600_000) + 'tail');
  await writeFile(join(f.root, 'unsafe.svg'), '<svg><script>alert(1)</script></svg>');
  const preview = await f.service.preview('large.txt'); expect(preview.truncated).toBe(true); expect(preview.text?.length).toBeLessThanOrEqual(512 * 1024);
  expect(await f.service.preview('unsafe.svg')).toEqual({ kind: 'unsupported' });
  const search = await f.service.list({ query: 'tail' }); expect(search.files).toEqual([]); expect(search.skippedCount).toBe(1);
});
it('waits for already requested writes on shutdown and refuses new saves', async () => {
  const f = await setup(); await f.service.bind(f.root);
  const saving = f.service.createNote({ title: '退出前保存', body: 'complete', date: '2026-10-28' });
  await f.service.close(); await saving;
  expect(await readFile(join(f.root, '2026-10-28', '文档', '退出前保存.md'), 'utf8')).toBe('complete');
  await expect(f.service.createNote({ title: '退出后', body: 'no', date: '2026-10-28' })).rejects.toThrow();
});
it('saves copies and collision variants on filesystems without hard links', async () => {
  const f = await setup(); await f.service.bind(f.root);
  const source = join(f.source, '招生.mp4'); const bytes = Buffer.alloc(2 * 1024 * 1024 + 29, 42); await writeFile(source, bytes);
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' }));
  const first = await f.service.importFiles([source], '2026-10-28');
  const second = await f.service.importFiles([source], '2026-10-28');
  expect(first.failures).toEqual([]); expect(second.failures).toEqual([]);
  expect(first.files[0]?.path).toBe('2026-10-28/视频/招生.mp4');
  expect(second.files[0]?.path).toBe('2026-10-28/视频/招生 (1).mp4');
  expect((await readFile(source)).equals(bytes)).toBe(true);
  for (const file of [first.files[0]!, second.files[0]!]) expect((await readFile(join(f.root, file.path))).equals(bytes)).toBe(true);
  expect(await readdir(join(f.root, '2026-10-28', '视频'))).toEqual(['招生 (1).mp4', '招生.mp4']);
});
it('cleans its incomplete fallback copy after a write failure and preserves the existing collision', async () => {
  const f = await setup(); await f.service.bind(f.root);
  await f.service.createNote({ title: '文案', body: 'existing', date: '2026-10-28' });
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let partialCopyWritten = false;
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('hard links unsupported'), { code: 'EPERM' }));
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (String(args[0]).endsWith('文案 (1).md')) {
      vi.spyOn(handle, 'write').mockImplementationOnce(async (...writeArgs: unknown[]) => {
        const bytes = writeArgs[0] as Buffer;
        await handle.writeFile(bytes.subarray(0, 8));
        partialCopyWritten = true;
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      });
    }
    return handle;
  });
  await expect(f.service.createNote({ title: '文案', body: 'new-content'.repeat(10), date: '2026-10-28' })).rejects.toThrow();
  expect(partialCopyWritten).toBe(true);
  expect(await readFile(join(f.root, '2026-10-28', '文档', '文案.md'), 'utf8')).toBe('existing');
  expect(await readdir(join(f.root, '2026-10-28', '文档'))).toEqual(['文案.md']);
});
