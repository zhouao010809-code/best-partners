import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkdiskService } from '../../src/server/workdisk/service.js';

const cleanup: string[] = [];
type Namer = (input: { name: string; bytes: Buffer }) => Promise<{ title?: string; reason: string }>;
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(contentNamer?: Namer) {
  const base = await mkdtemp(join(tmpdir(), 'workdisk-naming-')); cleanup.push(base);
  const root = join(base, '工作盘'), vault = join(base, '知识库'), stateDirectory = join(base, 'state'), source = join(base, 'source');
  await Promise.all([root, vault, stateDirectory, source].map(path => mkdir(path)));
  const service = createWorkdiskService({ stateDirectory, protectedRoots: [vault], ...(contentNamer ? { contentNamer } : {}) });
  await service.bind(root);
  return { base, root, vault, source, service };
}

it('names a copied numeric file from the actual bytes while preserving source, extension and collisions', async () => {
  const namer = vi.fn<Namer>(async () => ({ title: '短视频获客的选题与转化方法', reason: '依据正文命名' }));
  const f = await setup(namer); const source = join(f.source, '83927.MD'); const body = '# 短视频获客\n根据家长需求选择主题，并用具体课程体验承接咨询。';
  await writeFile(source, body);
  const first = await f.service.importFiles([source], '2026-10-29', { nameFromContent: true });
  const second = await f.service.importFiles([source], '2026-10-29', { nameFromContent: true });
  expect(namer.mock.calls[0]?.[0]).toEqual({ name: '83927.MD', bytes: Buffer.from(body) });
  expect(first.files[0]?.path).toBe('2026-10-29/文档/短视频获客的选题与转化方法.MD');
  expect(second.files[0]?.name).toBe('短视频获客的选题与转化方法 (1).MD');
  expect(second.naming).toEqual([{ originalName: '83927.MD', savedName: '短视频获客的选题与转化方法 (1).MD', status: 'renamed', reason: '依据正文命名' }]);
  expect(await readFile(source, 'utf8')).toBe(body);
  expect(await readFile(join(f.root, first.files[0]!.path), 'utf8')).toBe(body);
  expect(await readdir(f.vault)).toEqual([]);
});
it('does not read or request naming when the option is omitted or false', async () => {
  const namer = vi.fn<Namer>(async () => ({ title: '不应出现', reason: 'named' }));
  const f = await setup(namer); const source = join(f.source, '83927.txt'); await writeFile(source, '正文');
  const first = await f.service.importFiles([source], '2026-10-29');
  const second = await f.service.importFiles([source], '2026-10-29', { nameFromContent: false });
  expect(namer).not.toHaveBeenCalled(); expect(first.naming).toBeUndefined(); expect(second.naming).toBeUndefined();
  expect(first.files[0]?.name).toBe('83927.txt');
});
it('keeps the original name and gives a reason when naming is unavailable', async () => {
  const f = await setup(); const source = join(f.source, '83927.txt'); await writeFile(source, '有内容的文件');
  const result = await f.service.importFiles([source], '2026-10-29', { nameFromContent: true });
  expect(result.files[0]?.name).toBe('83927.txt');
  expect(result.naming?.[0]).toMatchObject({ originalName: '83927.txt', savedName: '83927.txt', status: 'kept', reason: expect.stringContaining('未连接') });
});
it('keeps the original name on provider failure or a no-title extraction response', async () => {
  const namer = vi.fn<Namer>().mockRejectedValueOnce(new Error('upstream secret internal error')).mockResolvedValueOnce({ reason: '扫描 PDF 没有可用正文，已保留原名。' });
  const f = await setup(namer); const source = join(f.source, '83927.pdf'); await writeFile(source, 'fixture pdf bytes');
  const first = await f.service.importFiles([source], '2026-10-29', { nameFromContent: true });
  const second = await f.service.importFiles([source], '2026-10-29', { nameFromContent: true });
  expect(first.files[0]?.name).toBe('83927.pdf'); expect(first.naming?.[0]?.status).toBe('kept');
  expect(JSON.stringify(first)).not.toContain('secret');
  expect(second.files[0]?.name).toBe('83927 (1).pdf'); expect(second.naming?.[0]).toMatchObject({ status: 'kept', reason: '扫描 PDF 没有可用正文，已保留原名。' });
});
it.each(['../越界', '/tmp/越界', 'folder\\名称', '执行.sh', '新文件.pdf', '.隐藏', 'con', 'a'.repeat(181), '名'.repeat(61)])('rejects unsafe or extension-bearing model title %s without changing the original extension', async title => {
  const f = await setup(async () => ({ title, reason: '不可信标题' })); const source = join(f.source, '83927.txt'); await writeFile(source, '正文');
  const result = await f.service.importFiles([source], '2026-10-29', { nameFromContent: true });
  expect(result.files[0]?.name).toBe('83927.txt'); expect(result.naming?.[0]?.status).toBe('kept');
  expect(await readdir(f.root)).toEqual(['2026-10-29']);
});
it('does not send unsupported media or files larger than the input limit to naming', async () => {
  const namer = vi.fn<Namer>(async () => ({ title: '不应出现', reason: 'named' })); const f = await setup(namer);
  const media = join(f.source, '83927.mp4'), large = join(f.source, '83927.pdf');
  await writeFile(media, 'video'); await writeFile(large, ''); await truncate(large, 20 * 1024 * 1024 + 1);
  const result = await f.service.importFiles([media, large], '2026-10-29', { nameFromContent: true });
  expect(namer).not.toHaveBeenCalled(); expect(result.files).toHaveLength(2);
  expect(result.naming?.map(value => value.status)).toEqual(['kept', 'kept']);
  expect(result.naming?.[0]?.reason).toContain('格式'); expect(result.naming?.[1]?.reason).toContain('20 MiB');
});
it('refuses to publish when the source is changed while the naming request runs', async () => {
  let source = '';
  const f = await setup(async () => { await writeFile(source, '这是一份完全不同的正文'); return { title: '旧正文总结名称', reason: 'named' }; });
  source = join(f.source, '83927.md'); await writeFile(source, '原始正文');
  const result = await f.service.importFiles([source], '2026-10-29', { nameFromContent: true });
  expect(result.files).toEqual([]); expect(result.naming).toEqual([]); expect(result.failures).toHaveLength(1);
  expect(await readdir(f.root)).toEqual([]);
});
it('refuses to publish when the source path is replaced while its original handle remains open', async () => {
  let source = '';
  const f = await setup(async () => { await rename(source, `${source}.old`); await writeFile(source, '替换的文件内容'); return { title: '旧正文总结名称', reason: 'named' }; });
  source = join(f.source, '83927.md'); await writeFile(source, '原始正文');
  const result = await f.service.importFiles([source], '2026-10-29', { nameFromContent: true });
  expect(result.files).toEqual([]); expect(result.failures).toHaveLength(1); expect(await readdir(f.root)).toEqual([]);
});
it('cancels active naming on close and copies remaining files under their original names without more AI calls', async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: (value: { title: string; reason: string }) => void;
  const pending = new Promise<{ title: string; reason: string }>(resolve => { release = resolve; });
  // Deliberately ignore cancellation: service shutdown must not wait for an uncooperative provider.
  const namer = vi.fn(async (_input: { name: string; bytes: Buffer }, _signal?: AbortSignal) => { entered(); return pending; });
  const f = await setup(namer); const sources = [join(f.source, '001.txt'), join(f.source, '002.txt')];
  await writeFile(sources[0]!, '第一份资料的完整正文'); await writeFile(sources[1]!, '第二份资料的完整正文');
  const importing = f.service.importFiles(sources, '2026-10-29', { nameFromContent: true });
  await started;
  const closing = f.service.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 500); })]);
    expect(completed).toBe(true);
    const result = await importing;
    expect(namer).toHaveBeenCalledTimes(1);
    expect(namer.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(result.files.map(file => file.name)).toEqual(['001.txt', '002.txt']);
    expect(result.naming?.map(item => item.status)).toEqual(['kept', 'kept']);
    expect(result.naming?.every(item => item.reason.includes('关闭'))).toBe(true);
    for (let index = 0; index < sources.length; index++) {
      const original = await readFile(sources[index]!);
      expect((await readFile(join(f.root, result.files[index]!.path))).equals(original)).toBe(true);
    }
  } finally {
    if (timer) clearTimeout(timer);
    release({ title: '迟到的标题', reason: '不得继续使用' });
    await importing; await closing;
  }
});
