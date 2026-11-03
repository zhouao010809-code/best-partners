import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopWorkdisk } from '../../src/electron/workdisk-controller.js';
import type { WorkdiskBinding } from '../../src/shared/workdisk.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workdisk-desktop-'))); roots.push(root);
  await writeFile(join(root, 'clip.mp4'), '0123456789');
  let binding: WorkdiskBinding | null = { id: 'one', rootPath: root, displayName: '工作盘', connectedAt: new Date().toISOString() };
  const service = {
    status: vi.fn(async () => binding),
    bind: vi.fn(async () => { binding = { ...binding!, id: 'two' }; return binding; }),
    list: vi.fn(async () => ({ binding, files: [], scannedAt: '', skippedCount: 0, truncated: false })),
    importFiles: vi.fn(async () => ({ files: [], failures: [] })),
    createNote: vi.fn(),
    resolveFile: vi.fn(async (path: string) => join(root, path)),
    preview: vi.fn(async () => ({ kind: 'media' as const }))
  };
  const chooseDirectory = vi.fn(async (): Promise<string | undefined> => root);
  const chooseFiles = vi.fn(async (): Promise<string[] | undefined> => [join(root, 'clip.mp4')]);
  const openPath = vi.fn(async () => '');
  const controller = createDesktopWorkdisk({ service, chooseDirectory, chooseFiles, openPath });
  return { root, service, controller, chooseDirectory, chooseFiles, openPath };
}

describe('desktop workdisk controller', () => {
  it('handles cancelled directory and file pickers without writes', async () => {
    const f = await fixture(); f.chooseDirectory.mockResolvedValueOnce(undefined); f.chooseFiles.mockResolvedValueOnce(undefined);
    await expect(f.controller.connect()).resolves.toBeNull();
    await expect(f.controller.importFiles('2026-10-29')).resolves.toBeNull();
    expect(f.service.bind).not.toHaveBeenCalled(); expect(f.service.importFiles).not.toHaveBeenCalled();
  });
  it('prevents overlapping pickers and releases busy state after cancellation', async () => {
    const f = await fixture(); let finish!: (value: undefined) => void;
    f.chooseDirectory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.controller.connect();
    await expect(f.controller.connect()).rejects.toThrow('文件选择窗口');
    finish(undefined); await pending; await expect(f.controller.connect()).resolves.toMatchObject({ id: 'two' });
  });
  it('imports native selection together with the validated date', async () => {
    const f = await fixture(); await f.controller.importFiles('2026-10-29');
    expect(f.service.importFiles).toHaveBeenCalledWith([join(f.root, 'clip.mp4')], '2026-10-29');
    await expect(f.controller.importFiles('2026-02-31')).rejects.toThrow('输入');
    expect(f.chooseFiles).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])('passes the explicit content-naming choice %s through native selection and drop', async nameFromContent => {
    const f = await fixture();
    await f.controller.importFiles('2026-10-29', { nameFromContent });
    expect(f.service.importFiles).toHaveBeenLastCalledWith([join(f.root, 'clip.mp4')], '2026-10-29', { nameFromContent });
    await f.controller.importDroppedFiles([join(f.root, 'article.txt')], '2026-10-28', { nameFromContent });
    expect(f.service.importFiles).toHaveBeenLastCalledWith([join(f.root, 'article.txt')], '2026-10-28', { nameFromContent });
  });
  it('rejects invalid naming options before choosing or reading files', async () => {
    const f = await fixture();
    for (const options of [null, 'yes', { nameFromContent: 'yes' }, { nameFromContent: true, destination: '/elsewhere' }]) {
      await expect(f.controller.importFiles('2026-10-29', options)).rejects.toThrow('输入');
      await expect(f.controller.importDroppedFiles([join(f.root, 'article.txt')], '2026-10-29', options)).rejects.toThrow('输入');
    }
    expect(f.chooseFiles).not.toHaveBeenCalled(); expect(f.service.importFiles).not.toHaveBeenCalled();
  });
  it('rejects unsafe renderer paths and executable opening before touching disk', async () => {
    const f = await fixture();
    for (const path of ['../secret', '/absolute', 'dir/../file', 'a\\b', 'a\u0000b']) await expect(f.controller.preview(path)).rejects.toThrow('输入');
    for (const path of ['../secret.png', '/absolute.png', 'dir/../file.png']) await expect(f.controller.thumbnail(path, 'one')).rejects.toThrow('输入');
    await expect(f.controller.openFile('run.command')).rejects.toThrow('文档');
    expect(f.openPath).not.toHaveBeenCalled(); expect(f.service.resolveFile).not.toHaveBeenCalled();
    await f.controller.openFile('report.pdf'); expect(f.openPath).toHaveBeenCalledWith(join(f.root, 'report.pdf'));
  });
  it('validates list and note fields and removes internal error details', async () => {
    const f = await fixture();
    await expect(f.controller.list({ plan: { terms: [], startDate: 'invalid' } })).rejects.toThrow('输入');
    await expect(f.controller.createNote({ title: '../a', body: 'text', date: '2026-10-29' })).rejects.toThrow('输入');
    f.service.list.mockRejectedValueOnce(new Error('/private/credentials')); 
    await expect(f.controller.list({})).rejects.toThrow('无法读取工作盘');
  });
  it('serves only issued media tickets and honors byte ranges', async () => {
    const f = await fixture(); const preview = await f.controller.preview('clip.mp4');
    expect(preview.url).toMatch(/^workdisk:\/\/file\//);
    const response = await f.controller.media(new Request(preview.url!, { headers: { Range: 'bytes=2-5' } }));
    expect(response.status).toBe(206); expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(response.headers.get('Content-Type')).toBe('video/mp4'); expect(await response.text()).toBe('2345');
    expect((await f.controller.media(new Request('workdisk://file/guess'))).status).toBe(404);
  });
  it('supports suffix, rejects malformed range and invalidates tickets after switching folders', async () => {
    const f = await fixture(); const { url } = await f.controller.preview('clip.mp4');
    const suffix = await f.controller.media(new Request(url!, { headers: { Range: 'bytes=-3' } }));
    expect(await suffix.text()).toBe('789');
    const invalid = await f.controller.media(new Request(url!, { headers: { Range: 'bytes=11-20' } }));
    expect(invalid.status).toBe(416); expect(invalid.headers.get('Content-Range')).toBe('bytes */10');
    expect((await f.controller.media(new Request(url!, { headers: { Range: 'bytes=abc' } }))).status).toBe(416);
    expect((await f.controller.media(new Request(url!, { headers: { Range: 'bytes=0-1,4-5' } }))).status).toBe(416);
    await f.controller.connect(); expect((await f.controller.media(new Request(url!))).status).toBe(404);
  });
  it('does not publish preview content after the folder changes during a read', async () => {
    const f = await fixture();
    f.service.preview.mockImplementationOnce(async () => { await f.controller.connect(); return { kind: 'media' }; });
    await expect(f.controller.preview('clip.mp4')).rejects.toThrow('工作盘已切换');
  });
  it('refuses a media ticket when reconnect happens while resolving its file', async () => {
    const f = await fixture(); const { url } = await f.controller.preview('clip.mp4');
    let release!: (path: string) => void; let entered!: () => void;
    const resolving = new Promise<void>(resolve => { entered = resolve; });
    f.service.resolveFile.mockImplementationOnce(async () => { entered(); return new Promise<string>(resolve => { release = resolve; }); });
    const pending = f.controller.media(new Request(url!));
    await resolving; await f.controller.connect(); release(join(f.root, 'clip.mp4'));
    const response = await pending;
    const content = await response.text();
    expect(response.status).toBe(404); expect(content).toBe('');
  });
  it('does not open a file from a replaced binding after asynchronous resolution', async () => {
    const f = await fixture(); let release!: (path: string) => void; let entered!: () => void;
    const resolving = new Promise<void>(resolve => { entered = resolve; });
    f.service.resolveFile.mockImplementationOnce(async () => { entered(); return new Promise<string>(resolve => { release = resolve; }); });
    const pending = f.controller.openFile('report.pdf');
    const rejected = expect(pending).rejects.toThrow('无法打开');
    await resolving; await f.controller.connect(); release(join(f.root, 'report.pdf'));
    await rejected; expect(f.openPath).not.toHaveBeenCalled();
  });
  it('supports HEAD without a body and rejects non-media files', async () => {
    const f = await fixture(); const { url } = await f.controller.preview('clip.mp4');
    const response = await f.controller.media(new Request(url!, { method: 'HEAD' }));
    expect(response.status).toBe(200); expect(response.headers.get('Content-Length')).toBe('10'); expect(await response.text()).toBe('');
    await expect(f.controller.preview('private.sqlite')).resolves.toEqual({ kind: 'unsupported' });
  });
});
