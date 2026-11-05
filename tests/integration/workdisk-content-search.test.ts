import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createWorkdiskService } from '../../src/server/workdisk/service.js';
import { createWorkdiskSearchContentReader, type WorkdiskSearchContentReader } from '../../src/server/workdisk/content-search.js';
import { createTextPdf, createPasswordPdf } from '../helpers/pdf-fixture.js';

const execute = promisify(execFile);
const parserWorkerPath = new URL('../../src/server/attachments/pdf-worker.mjs', import.meta.url);
const cleanup: string[] = [];
const services: ReturnType<typeof createWorkdiskService>[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(contentReader = createWorkdiskSearchContentReader({ parserWorkerPath })) {
  const base = await mkdtemp(join(tmpdir(), 'workdisk-content-search-')); cleanup.push(base);
  const root = join(base, 'files'); const stateDirectory = join(base, 'state');
  await mkdir(root); const service = createWorkdiskService({ stateDirectory, protectedRoots: [], contentReader }); services.push(service);
  await service.bind(root); return { root, base, service };
}

it('finds a PDF by actual body text with a useful excerpt and reuses the bounded local cache', async () => {
  const reader = vi.fn(createWorkdiskSearchContentReader({ parserWorkerPath })); const f = await setup(reader);
  await writeFile(join(f.root, '123.pdf'), createTextPdf(['Audience research and conversion tracking']));
  expect((await f.service.list()).files).toHaveLength(1); expect(reader).not.toHaveBeenCalled();
  const result = await f.service.list({ query: 'conversion' });
  expect(result.skippedCount).toBe(0); expect(result.files).toHaveLength(1);
  expect(result.files[0]).toMatchObject({ name: '123.pdf', matchedBy: 'content', excerpt: expect.stringContaining('conversion') });
  expect((await f.service.list({ query: 'Audience' })).files).toHaveLength(1); expect(reader).toHaveBeenCalledTimes(1);
  await writeFile(join(f.root, '123.pdf'), createTextPdf(['Completely different material now']));
  expect((await f.service.list({ query: 'conversion' })).files).toHaveLength(0);
  expect((await f.service.list({ query: 'different' })).files).toHaveLength(1); expect(reader).toHaveBeenCalledTimes(2);
});

it('reports scanned, encrypted, broken and oversize files as incomplete while keeping filename search usable', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'scan.pdf'), createTextPdf(['']));
  await writeFile(join(f.root, 'locked.pdf'), createPasswordPdf());
  await writeFile(join(f.root, 'bad.pdf'), 'broken');
  await writeFile(join(f.root, 'large.pdf'), Buffer.alloc(20 * 1024 * 1024 + 1));
  const result = await f.service.list({ query: 'missing' });
  expect(result.files).toEqual([]); expect(result.skippedCount).toBe(4);
  expect((await f.service.list({ query: 'large' })).files.map(file => file.name)).toContain('large.pdf');
});

it('does not reuse text for a replaced file, follow symlinks, or retain extraction after switching disks', async () => {
  const reader = vi.fn<WorkdiskSearchContentReader>(async ({ bytes }) => ({ text: bytes.toString(), partial: false })); const f = await setup(reader);
  await writeFile(join(f.root, '123.png'), 'original needle');
  expect((await f.service.list({ query: 'needle' })).files).toHaveLength(1);
  await rename(join(f.root, '123.png'), join(f.base, 'outside.png'));
  await symlink(join(f.base, 'outside.png'), join(f.root, '123.png'));
  expect((await f.service.list({ query: 'needle' })).files).toEqual([]);
  const second = join(f.base, 'other'); await mkdir(second); await writeFile(join(second, '123.png'), 'new replacement');
  await f.service.bind(second);
  expect((await f.service.list({ query: 'needle' })).files).toEqual([]);
  expect((await f.service.list({ query: 'replacement' })).files).toHaveLength(1);
  expect(reader).toHaveBeenCalledTimes(2);
});

it('rejects extraction if the source changes while it is being read', async () => {
  let root = '';
  const f = await setup(async () => { await writeFile(join(root, '123.pdf'), 'replacement'); return { text: 'old needle', partial: false }; }); root = f.root;
  await writeFile(join(f.root, '123.pdf'), 'original');
  const result = await f.service.list({ query: 'needle' });
  expect(result.files).toEqual([]); expect(result.skippedCount).toBe(1);
});

it('limits extraction bytes per search and progresses through uncached files on the next search', async () => {
  const reader = vi.fn<WorkdiskSearchContentReader>(async () => ({ text: 'needle', partial: false })); const f = await setup(reader);
  for (let index = 0; index < 3; index++) await writeFile(join(f.root, `${index}.png`), Buffer.alloc(12 * 1024 * 1024));
  const first = await f.service.list({ query: 'needle' });
  expect(first.files).toHaveLength(2); expect(first.skippedCount).toBe(1);
  const second = await f.service.list({ query: 'needle' });
  expect(second.files).toHaveLength(3); expect(second.skippedCount).toBe(0); expect(reader).toHaveBeenCalledTimes(3);
});

it.each(['pdf', 'png'])('stops waiting for a %s parser that ignores cancellation when closing', async extension => {
  let started!: () => void; const reached = new Promise<void>(resolve => { started = resolve; });
  const f = await setup(async () => { started(); return new Promise(() => {}); }); await writeFile(join(f.root, `123.${extension}`), 'input');
  const searching = f.service.list({ query: 'needle' }); await reached; await f.service.close();
  const result = await searching; expect(result.files).toEqual([]); expect(result.skippedCount).toBe(1);
});

it('shares cached extraction across overlapping searches without launching duplicate parsers', async () => {
  let started!: () => void; let finish!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; }); const ready = new Promise<void>(resolve => { finish = resolve; });
  const reader = vi.fn<WorkdiskSearchContentReader>(async () => { started(); await ready; return { text: 'needle', partial: false }; });
  const f = await setup(reader); await writeFile(join(f.root, '123.png'), 'input');
  const results = Promise.all([f.service.list({ query: 'needle' }), f.service.list({ query: 'needle' })]);
  await reached; finish();
  expect((await results).map(result => result.files.length)).toEqual([1, 1]); expect(reader).toHaveBeenCalledTimes(1);
});

it('times out a stuck file and continues to later files, remembering the failure briefly', async () => {
  const reader = vi.fn<WorkdiskSearchContentReader>(async ({ name }) => name === 'z.pdf' ? new Promise(() => {}) : { text: 'needle', partial: false });
  const f = await setup(reader); await writeFile(join(f.root, 'z.pdf'), 'stuck'); await writeFile(join(f.root, 'a.pdf'), 'good');
  const first = await f.service.list({ query: 'needle' });
  expect(first.files.map(file => file.name)).toEqual(['a.pdf']); expect(first.skippedCount).toBe(1);
  const second = await f.service.list({ query: 'needle' });
  expect(second.files.map(file => file.name)).toEqual(['a.pdf']); expect(second.skippedCount).toBe(1); expect(reader).toHaveBeenCalledTimes(2);
}, 6000);

it('lets image recognition finish beyond the PDF file deadline within the shared search budget', async () => {
  const reader = vi.fn<WorkdiskSearchContentReader>(async (_source, signal) => {
    await delay(3250, undefined, { signal });
    return { text: '短视频选题与咨询转化方法', partial: false };
  });
  const f = await setup(reader); await writeFile(join(f.root, '123.png'), 'controlled image fixture');
  const result = await f.service.list({ query: '短视频' });
  expect(result.files).toHaveLength(1);
  expect(result.files[0]).toMatchObject({ name: '123.png', matchedBy: 'content', excerpt: expect.stringContaining('短视频') });
  expect(result.skippedCount).toBe(0);
  expect(reader).toHaveBeenCalledOnce();
}, 8000);

let fixtureRoot: string | undefined;
let fixturePath: string;
beforeAll(async () => {
  if (process.platform !== 'darwin') return;
  fixtureRoot = await mkdtemp(join(tmpdir(), 'search-ocr-fixture-')); fixturePath = join(fixtureRoot, 'fixture');
  await execute('xcrun', ['swiftc', resolve('tests/native/fixtures/image-evidence-fixture.swift'), '-o', fixturePath]);
}, 30000);
afterAll(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });
it.skipIf(process.platform !== 'darwin')('finds a randomly named image from real Chinese pixels without any AI connection', async () => {
  const f = await setup(createWorkdiskSearchContentReader({ imageHelperPath: resolve('dist/native/image-evidence-helper') }));
  const bytes = (await execute(fixturePath, ['text', 'public.png'], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 })).stdout;
  await writeFile(join(f.root, '123.png'), bytes);
  const result = await f.service.list({ query: '短视频' });
  expect(result.files).toHaveLength(1); expect(result.files[0]).toMatchObject({ name: '123.png', matchedBy: 'content', excerpt: expect.stringContaining('短视频') });
}, 20000);
