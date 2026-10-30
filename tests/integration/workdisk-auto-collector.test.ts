import { afterEach, expect, it, vi } from 'vitest';
import { appendFile, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkdiskService } from '../../src/server/workdisk/service.js';
import { createWorkdiskAutoCollector } from '../../src/server/workdisk/auto-collector.js';
import type { WorkdiskContentNamer } from '../../src/server/workdisk/content-namer.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(namer?: WorkdiskContentNamer) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'workdisk-auto-')));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const source = join(base, 'Downloads'), root = join(base, '工作盘'), vault = join(base, '知识库'), stateDirectory = join(base, 'state');
  await Promise.all([source, root, vault, stateDirectory].map(path => mkdir(path)));
  const service = createWorkdiskService({ stateDirectory, protectedRoots: [vault], ...(namer ? { contentNamer: namer } : {}) });
  await service.bind(root); cleanups.push(() => service.close());
  const importFiles = vi.fn(service.importFiles);
  const validateBinding = vi.fn(service.validateBinding);
  let time = new Date(2026, 9, 30, 12).getTime();
  const config = { stateDirectory, protectedRoots: [vault], service: { ...service, importFiles, validateBinding }, pollMs: 60_000, settleMs: 3000, now: () => time };
  const make = async () => { const value = createWorkdiskAutoCollector(config); await value.start(); cleanups.push(() => value.close()); return value; };
  const collector = await make();
  return { base, source, root, vault, stateDirectory, service, importFiles, validateBinding, collector, make, tick: async (target = collector) => { time += 3001; await target.poll(); } };
}

const targetUnavailable = () => Object.assign(new Error('private device diagnostic'), { code: 'WORKDISK_UNAVAILABLE' });
it('waits for a temporarily unavailable target then resumes its existing ledger without baselining offline arrivals', async () => {
  const f = await setup(); await writeFile(join(f.source, '旧文件.txt'), 'old'); await f.collector.configure(f.source, { nameFromContent: false });
  await writeFile(join(f.source, '已收好.txt'), 'saved'); await f.collector.poll(); await f.tick();
  await writeFile(join(f.source, '待收.txt'), 'pending'); await f.collector.poll();
  const path = join(f.stateDirectory, 'workdisk-auto.json');
  const before = JSON.parse(await readFile(path, 'utf8'));
  f.validateBinding.mockRejectedValue(targetUnavailable()); await f.tick();
  expect(await f.collector.status()).toMatchObject({ enabled: true, phase: 'waiting', pendingCount: 1, message: '工作盘暂时未连接，接回原硬盘后会继续收纳。' });
  const waiting = JSON.parse(await readFile(path, 'utf8')); expect(waiting.records).toEqual(before.records); expect(waiting.enabled).toBe(true);
  const stamp = await lstat(path); await f.collector.poll(); const repeated = await lstat(path);
  expect([repeated.ino, repeated.mtimeMs, repeated.ctimeMs]).toEqual([stamp.ino, stamp.mtimeMs, stamp.ctimeMs]);
  await writeFile(join(f.source, '离线时新增.txt'), 'new'); expect(f.importFiles).toHaveBeenCalledTimes(1);
  f.validateBinding.mockImplementation(f.service.validateBinding); await f.collector.poll(); await f.tick();
  const resumed = await f.collector.status(); expect(resumed).toMatchObject({ enabled: true, phase: 'watching', pendingCount: 0 }); expect(resumed.message).toBeUndefined();
  expect(resumed.receipts.map(item => item.sourceName).sort()).toEqual(['已收好.txt', '待收.txt', '离线时新增.txt'].sort());
  expect(f.importFiles).toHaveBeenCalledTimes(3); expect(JSON.parse(await readFile(path, 'utf8')).message).toBeUndefined();
  await f.collector.poll(); expect(f.importFiles).toHaveBeenCalledTimes(3);
});
it('retains waiting across restart and honors a manual pause when the original target returns', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  f.validateBinding.mockRejectedValue(targetUnavailable()); await f.collector.poll(); await f.collector.close();
  await writeFile(join(f.source, '重启时新增.txt'), 'new');
  const resumed = await f.make(); expect(await resumed.status()).toMatchObject({ enabled: true, phase: 'waiting' });
  await resumed.setEnabled(false); expect(await resumed.status()).toMatchObject({ enabled: false, phase: 'paused' });
  f.validateBinding.mockImplementation(f.service.validateBinding); await resumed.poll(); await f.tick(resumed); expect(f.importFiles).not.toHaveBeenCalled();
  await resumed.close(); const paused = await f.make(); expect(await paused.status()).toMatchObject({ enabled: false, phase: 'paused' });
  await paused.setEnabled(true); await paused.poll(); await f.tick(paused); expect(f.importFiles).toHaveBeenCalledTimes(1);
});
it('recovers at startup after a waiting target returns without replaying completed receipts', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  await writeFile(join(f.source, '已收好.txt'), 'saved'); await f.collector.poll(); await f.tick();
  f.validateBinding.mockRejectedValue(targetUnavailable()); await f.collector.poll(); await f.collector.close();
  await writeFile(join(f.source, '等待时新增.txt'), 'new'); f.validateBinding.mockImplementation(f.service.validateBinding);
  const resumed = await f.make(); expect(await resumed.status()).toMatchObject({ enabled: true, phase: 'watching' }); expect((await resumed.status()).message).toBeUndefined();
  await resumed.poll(); await f.tick(resumed); expect(f.importFiles).toHaveBeenCalledTimes(2);
});
it('returns a pre-copy processing intent to pending if the target disconnects before import begins', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false }); await writeFile(join(f.source, '待收.txt'), 'pending'); await f.collector.poll();
  const valid = await f.service.validateBinding();
  f.validateBinding.mockResolvedValueOnce(valid).mockResolvedValueOnce(valid).mockRejectedValueOnce(targetUnavailable());
  await f.tick(); expect(f.importFiles).not.toHaveBeenCalled();
  expect(await f.collector.status()).toMatchObject({ phase: 'waiting', pendingCount: 1 });
  const data = JSON.parse(await readFile(join(f.stateDirectory, 'workdisk-auto.json'), 'utf8')); expect(data.records[0].status).toBe('pending');
  await f.tick(); expect(f.importFiles).toHaveBeenCalledTimes(1);
});
it('pauses for a changed target or a source failure instead of treating either as a remount', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  f.validateBinding.mockRejectedValue(targetUnavailable()); await f.collector.poll();
  const other = join(f.base, '其他工作盘'); await mkdir(other); await f.service.bind(other); f.validateBinding.mockImplementation(f.service.validateBinding);
  await f.collector.poll(); expect(await f.collector.status()).toMatchObject({ enabled: false, phase: 'error', message: expect.stringContaining('工作盘已改变') });
  await f.collector.configure(f.source, { nameFromContent: false }); await rename(f.source, `${f.source}-moved`);
  await f.collector.poll(); expect(await f.collector.status()).toMatchObject({ enabled: false, phase: 'error', message: expect.stringContaining('接收文件夹') });
});

it('baselines existing files recursively and copies stable new files while preserving originals', async () => {
  const f = await setup(); await writeFile(join(f.source, '旧资料.txt'), '旧资料');
  await mkdir(join(f.source, '子目录')); await writeFile(join(f.source, '子目录', 'nested-old.txt'), '旧资料不收');
  await f.collector.configure(f.source, { nameFromContent: false });
  expect((await f.collector.status()).phase).toBe('watching');
  await appendFile(join(f.source, '旧资料.txt'), '后续修改也不是新文件');
  await writeFile(join(f.source, '子目录', 'nested.txt'), '新资料要收');
  await writeFile(join(f.source, '新资料.txt'), '完整正文');
  await f.collector.poll(); expect(f.importFiles).not.toHaveBeenCalled(); await f.tick();
  expect(f.importFiles).toHaveBeenCalledTimes(2);
  const state = await f.collector.status(); const top = state.receipts.find(entry => entry.sourceName === '新资料.txt')!;
  expect(top).toMatchObject({ status: 'saved', savedName: '新资料.txt' });
  expect(state.receipts.find(entry => entry.sourceName === '子目录/nested.txt')).toMatchObject({ status: 'saved', savedName: 'nested.txt' });
  expect(await readFile(join(f.root, top.path!), 'utf8')).toBe('完整正文');
  expect(await readFile(join(f.source, '新资料.txt'), 'utf8')).toBe('完整正文');
  await f.tick(); expect(f.importFiles).toHaveBeenCalledTimes(2); expect(await readdir(f.vault)).toEqual([]);
});

it('waits for size and time stability, skips partial/hidden/link/empty files and accepts completed download rename', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  for (const name of ['正在下载.crdownload', 'a.part', 'b.download', 'c.tmp', '.hidden', 'empty.txt']) await writeFile(join(f.source, name), name === 'empty.txt' ? '' : '片段');
  await symlink(join(f.source, '.hidden'), join(f.source, '链接.txt'));
  const download = join(f.source, '正在下载.crdownload');
  await f.collector.poll(); await f.tick(); expect(f.importFiles).not.toHaveBeenCalled();
  await rename(download, join(f.source, '完成.txt')); await f.collector.poll();
  await appendFile(join(f.source, '完成.txt'), '继续下载'); await f.tick(); expect(f.importFiles).not.toHaveBeenCalled();
  await f.tick(); expect(f.importFiles).toHaveBeenCalledTimes(1);
  expect((await f.collector.status()).receipts[0]?.sourceName).toBe('完成.txt');
});

it('persists dedupe across restart and collects files appearing while stopped or paused', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  await writeFile(join(f.source, '已收.txt'), 'A'); await f.collector.poll(); await f.tick(); await f.collector.close();
  await writeFile(join(f.source, '关机时新建.txt'), 'B'); const resumed = await f.make();
  await resumed.poll(); await f.tick(resumed); expect(f.importFiles).toHaveBeenCalledTimes(2);
  await resumed.setEnabled(false); await writeFile(join(f.source, '暂停时新建.txt'), 'C'); await resumed.poll(); await f.tick(resumed);
  expect(f.importFiles).toHaveBeenCalledTimes(2); await resumed.setEnabled(true); await resumed.poll(); await f.tick(resumed);
  expect(f.importFiles).toHaveBeenCalledTimes(3); expect((await resumed.status()).receipts).toHaveLength(3);
});

it('never overlaps polls and pause cancels naming but drains the current copy without starting the next file', async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const namer = vi.fn<WorkdiskContentNamer>(async () => { entered(); await blocked; return { title: '迟到的名称', reason: '迟到' }; });
  const f = await setup(namer); await f.collector.configure(f.source, { nameFromContent: true });
  await writeFile(join(f.source, '1.txt'), '第一篇'); await writeFile(join(f.source, '2.txt'), '第二篇'); await f.collector.poll();
  const processing = f.tick(); await started; const duplicate = f.collector.poll();
  try {
    await f.collector.setEnabled(false); await processing; await duplicate;
    expect(namer).toHaveBeenCalledTimes(1); expect(namer.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(f.importFiles).toHaveBeenCalledTimes(1); expect((await f.collector.status()).enabled).toBe(false);
    expect((await f.collector.status()).receipts[0]?.status).toBe('saved');
    expect(await readFile(join(f.source, '1.txt'), 'utf8')).toBe('第一篇');
  } finally { release(); }
});

it('pauses on replaced source identity or changed destination binding', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  await rename(f.source, `${f.source}-old`); await mkdir(f.source); await writeFile(join(f.source, '陌生文件.txt'), 'X');
  await f.tick(); expect((await f.collector.status()).enabled).toBe(false); await expect(f.collector.resolveSource()).rejects.toThrow();
  expect(f.importFiles).not.toHaveBeenCalled();
  await f.collector.configure(f.source, { nameFromContent: false });
  const other = join(f.base, '另一工作盘'); await mkdir(other); await f.service.bind(other); await f.tick();
  expect((await f.collector.status()).enabled).toBe(false); expect((await f.collector.status()).message).toContain('工作盘');
  await expect(f.collector.setEnabled(true)).rejects.toThrow();
});

it('rejects protected/source-destination overlaps and symlink roots', async () => {
  const f = await setup(); await mkdir(join(f.vault, 'nested')); await mkdir(join(f.root, 'nested'));
  for (const path of [f.vault, join(f.vault, 'nested'), f.root, join(f.root, 'nested'), f.base, f.stateDirectory]) await expect(f.collector.configure(path, { nameFromContent: false })).rejects.toThrow();
  const shortcut = join(f.base, 'shortcut'); await symlink(f.source, shortcut); await expect(f.collector.configure(shortcut, { nameFromContent: false })).rejects.toThrow();
  expect(f.importFiles).not.toHaveBeenCalled();
});

it('records failures once, keeps new files collectable and persists no retry across restarts', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  f.importFiles.mockResolvedValueOnce({ files: [], failures: [{ name: '失败.txt', message: '磁盘不可写' }] });
  await writeFile(join(f.source, '失败.txt'), 'A'); await f.collector.poll(); await f.tick(); await f.tick();
  expect(f.importFiles).toHaveBeenCalledTimes(1); expect((await f.collector.status()).receipts[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('手动') });
  await f.collector.close(); const resumed = await f.make(); await resumed.poll(); await f.tick(resumed); expect(f.importFiles).toHaveBeenCalledTimes(1);
  await writeFile(join(f.source, '后续.txt'), 'B'); await resumed.poll(); await f.tick(resumed); expect(f.importFiles).toHaveBeenCalledTimes(2);
});

it('marks interrupted processing uncertain and never replays it on recovery', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  await writeFile(join(f.source, '可能已收.txt'), 'A'); await f.collector.poll(); await f.tick(); await f.collector.close();
  const path = join(f.stateDirectory, 'workdisk-auto.json'); const stored = JSON.parse(await readFile(path, 'utf8'));
  stored.records.find((entry: { name: string }) => entry.name === '可能已收.txt').status = 'processing'; await writeFile(path, JSON.stringify(stored));
  const resumed = await f.make(); await resumed.poll(); await f.tick(resumed);
  expect(f.importFiles).toHaveBeenCalledTimes(1); expect((await resumed.status()).receipts[0]).toMatchObject({ status: 'uncertain', reason: expect.stringContaining('核对') });
});

it('refuses a symlink state file without following or overwriting its target', async () => {
  const f = await setup(); await f.collector.close(); const target = join(f.base, 'sentinel'); await writeFile(target, 'KEEP');
  await symlink(target, join(f.stateDirectory, 'workdisk-auto.json')); const resumed = await f.make();
  expect((await resumed.status()).phase).toBe('error');
  await expect(resumed.configure(f.source, { nameFromContent: false })).rejects.toThrow(); expect(await readFile(target, 'utf8')).toBe('KEEP');
});

it('closes during uncooperative naming, drains the active copy and leaves the remaining file for restart', async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const namer = vi.fn<WorkdiskContentNamer>(async () => { entered(); await blocked; return { title: '迟到', reason: '迟到' }; });
  const f = await setup(namer); await f.collector.configure(f.source, { nameFromContent: true });
  await writeFile(join(f.source, '1.txt'), '第一份'); await writeFile(join(f.source, '2.txt'), '第二份'); await f.collector.poll();
  const processing = f.tick(); await started;
  try { await f.collector.close(); await processing; expect(f.importFiles).toHaveBeenCalledTimes(1); expect((await f.collector.status()).receipts[0]?.status).toBe('saved'); }
  finally { release(); }
});
it('does not start a queued poll after pause is requested', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  await writeFile(join(f.source, '等待中.txt'), 'A'); await f.collector.poll();
  const processing = f.tick(); const paused = f.collector.setEnabled(false); await Promise.all([processing, paused]);
  expect(f.importFiles).not.toHaveBeenCalled();
  await f.collector.setEnabled(true); await f.tick(); expect(f.importFiles).toHaveBeenCalledTimes(1);
});
it('updates a saved receipt after manual renaming and does not expose old destination receipts after rebinding', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  await writeFile(join(f.source, '编号.txt'), '资料正文'); await f.collector.poll(); await f.tick();
  const first = (await f.collector.status()).receipts[0]!;
  const renamed = await f.collector.renameReceipt(first.id, '我确定的名称');
  expect(renamed.receipts[0]).toMatchObject({ sourceName: '编号.txt', savedName: '我确定的名称.txt', path: '2026-10-30/文档/我确定的名称.txt' });
  expect(await readFile(join(f.source, '编号.txt'), 'utf8')).toBe('资料正文');
  const other = join(f.base, '新目的地'); await mkdir(other); await f.service.bind(other);
  await mkdir(join(other, '2026-10-30', '文档'), { recursive: true }); await writeFile(join(other, renamed.receipts[0]!.path!), '不能被旧记录改名');
  await expect(f.collector.renameReceipt(first.id, '不能修改')).rejects.toThrow();
  await f.collector.configure(f.source, { nameFromContent: false });
  expect((await f.collector.status()).receipts).toEqual([]);
  await expect(f.collector.renameReceipt(first.id, '错误的改名')).rejects.toThrow();
  expect(await readFile(join(other, renamed.receipts[0]!.path!), 'utf8')).toBe('不能被旧记录改名');
  await f.tick(); expect(f.importFiles).toHaveBeenCalledTimes(1);
});
it('keeps bounded receipts without losing dedupe and pauses when the durable ledger reaches its limit', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  await Promise.all(Array.from({ length: 52 }, (_, index) => writeFile(join(f.source, `${index}.txt`), 'A')));
  await f.collector.poll(); await f.tick(); expect((await f.collector.status()).receipts).toHaveLength(50);
  await f.collector.close();
  const path = join(f.stateDirectory, 'workdisk-auto.json'); const data = JSON.parse(await readFile(path, 'utf8'));
  const example = data.records[0];
  while (data.records.length < 10_000) data.records.push({ ...example, key: `old:${data.records.length}` });
  await writeFile(path, JSON.stringify(data));
  const resumed = await f.make(); await writeFile(join(f.source, '超界.txt'), 'B'); await resumed.poll();
  expect((await resumed.status()).enabled).toBe(false); expect((await resumed.status()).message).toContain('上限');
  const persisted = JSON.parse(await readFile(path, 'utf8')); expect(persisted.records).toHaveLength(10_000);
  expect(f.importFiles).toHaveBeenCalledTimes(52);
});
it('returns a recoverable startup error for corrupt state or an unplugged source', async () => {
  const f = await setup(); await f.collector.close(); await writeFile(join(f.stateDirectory, 'workdisk-auto.json'), 'broken json');
  const resumed = await f.make(); expect((await resumed.status()).phase).toBe('error');
  await resumed.configure(f.source, { nameFromContent: false }); await resumed.close(); await rename(f.source, `${f.source}-removed`);
  const unplugged = await f.make(); expect((await unplugged.status()).phase).toBe('error'); expect((await unplugged.status()).enabled).toBe(false);
  await mkdir(f.source); await unplugged.configure(f.source, { nameFromContent: false }); expect((await unplugged.status()).phase).toBe('watching');
});
it('does not rewrite the durable ledger during unchanged polling', async () => {
  const f = await setup(); await writeFile(join(f.source, '旧资料.txt'), 'A'); await f.collector.configure(f.source, { nameFromContent: false });
  const path = join(f.stateDirectory, 'workdisk-auto.json'); const before = await lstat(path);
  await f.collector.poll(); await f.tick(); const after = await lstat(path);
  expect({ ino: after.ino, mtime: after.mtimeMs, ctime: after.ctimeMs }).toEqual({ ino: before.ino, mtime: before.mtimeMs, ctime: before.ctimeMs });
});
it('waits without importing into a replacement at the target path, then resumes only after the original root returns', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  await writeFile(join(f.source, 'A.txt'), 'A'); await writeFile(join(f.source, 'B.txt'), 'B'); await f.collector.poll();
  await rename(f.root, `${f.root}-old`); await mkdir(f.root); await f.tick();
  expect(f.importFiles).not.toHaveBeenCalled(); expect(await f.collector.status()).toMatchObject({ enabled: true, phase: 'waiting' });
  expect((await f.collector.status()).receipts).toEqual([]); expect((await f.collector.status()).pendingCount).toBe(2);
  expect(await readdir(f.root)).toEqual([]);
  await rm(f.root, { recursive: true }); await rename(`${f.root}-old`, f.root);
  await f.tick(); expect(f.importFiles).toHaveBeenCalledTimes(2);
  expect(await f.collector.status()).toMatchObject({ enabled: true, phase: 'watching', pendingCount: 0 });
  expect((await f.collector.status()).message).toBeUndefined();
});
it('persists processing before copying and retains the renamed result after restart', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  await writeFile(join(f.source, '证明.txt'), '正文'); await f.collector.poll();
  let checkpoint: string | undefined;
  f.importFiles.mockImplementationOnce(async (...args) => {
    const data = JSON.parse(await readFile(join(f.stateDirectory, 'workdisk-auto.json'), 'utf8'));
    checkpoint = data.records.find((entry: { name: string }) => entry.name === '证明.txt')?.status;
    return f.service.importFiles(...args);
  });
  await f.tick(); expect(checkpoint).toBe('processing');
  const saved = (await f.collector.status()).receipts[0]!; await f.collector.renameReceipt(saved.id, '审核后的名称'); await f.collector.close();
  const resumed = await f.make(); expect((await resumed.status()).receipts[0]?.savedName).toBe('审核后的名称.txt');
  await resumed.poll(); await f.tick(resumed); expect(f.importFiles).toHaveBeenCalledTimes(1);
});
it('refuses to rename a replacement at a saved receipt path after the original copy was moved away', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  await writeFile(join(f.source, 'A.txt'), '最初收纳的正文'); await f.collector.poll(); await f.tick();
  const saved = (await f.collector.status()).receipts[0]!; const target = join(f.root, saved.path!);
  await rename(target, `${target}.moved`); await writeFile(target, '后来的哨兵，不能改名');
  await f.collector.close(); const resumed = await f.make();
  await expect(resumed.renameReceipt(saved.id, '不要误改')).rejects.toThrow();
  expect(await readFile(target, 'utf8')).toBe('后来的哨兵，不能改名');
  expect(await readFile(`${target}.moved`, 'utf8')).toBe('最初收纳的正文');
  expect(await readFile(join(f.source, 'A.txt'), 'utf8')).toBe('最初收纳的正文');
});
it.each([false, true])('keeps the previous content naming setting %s when persisting a toggle fails', async initial => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: initial });
  const path = join(f.stateDirectory, 'workdisk-auto.json'); const backup = `${path}.backup`;
  await rename(path, backup); await mkdir(path);
  await expect(f.collector.setNaming(!initial)).rejects.toThrow();
  expect((await f.collector.status()).nameFromContent).toBe(initial);
  await rm(path, { recursive: true }); await rename(backup, path);
  await writeFile(join(f.source, '新的资料.txt'), '正文'); await f.collector.poll(); await f.tick();
  expect(f.importFiles.mock.calls[0]?.[2]?.nameFromContent).toBe(initial);
  expect(JSON.parse(await readFile(path, 'utf8')).nameFromContent).toBe(initial);
});
it('does not resume collecting when persisting the enable setting fails', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false }); await f.collector.setEnabled(false);
  const path = join(f.stateDirectory, 'workdisk-auto.json'); const backup = `${path}.backup`;
  await rename(path, backup); await mkdir(path);
  await expect(f.collector.setEnabled(true)).rejects.toThrow();
  expect((await f.collector.status()).enabled).toBe(false);
  await rm(path, { recursive: true }); await rename(backup, path);
  await writeFile(join(f.source, '暂不收纳.txt'), '正文'); await f.collector.poll(); await f.tick();
  expect(f.importFiles).not.toHaveBeenCalled();
});
it('skips hidden, partial, package and symlink directories but accepts a completed directory rename', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false });
  for (const name of ['.hidden', 'file.download', 'file.part', 'Tool.app', 'Data.bundle', 'Code.framework']) {
    await mkdir(join(f.source, name)); await writeFile(join(f.source, name, 'inside.txt'), '不能提前收');
  }
  await writeFile(join(f.base, 'outside.txt'), '外部文件');
  await symlink(f.vault, join(f.source, 'linked-directory')); await symlink(join(f.base, 'outside.txt'), join(f.source, 'linked-file.txt'));
  await f.collector.poll(); await f.tick(); expect(f.importFiles).not.toHaveBeenCalled();
  await rename(join(f.source, 'file.download'), join(f.source, '1029')); await f.collector.poll(); expect(f.importFiles).not.toHaveBeenCalled(); await f.tick();
  expect((await f.collector.status()).receipts[0]?.sourceName).toBe('1029/inside.txt'); expect(f.importFiles).toHaveBeenCalledTimes(1);
});
it('retains nested dedupe across pauses and restarts and keeps same basenames in different folders', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false }); await f.collector.setEnabled(false);
  for (const folder of ['1029', '1030']) { await mkdir(join(f.source, folder)); await writeFile(join(f.source, folder, 'image.png'), folder); }
  await f.collector.close(); const resumed = await f.make(); await resumed.poll(); expect(f.importFiles).not.toHaveBeenCalled();
  await resumed.setEnabled(true); await resumed.poll(); await f.tick(resumed); expect(f.importFiles).toHaveBeenCalledTimes(2);
  expect((await resumed.status()).receipts.map(entry => entry.sourceName).sort()).toEqual(['1029/image.png', '1030/image.png']);
  await resumed.close(); const again = await f.make(); await again.poll(); await f.tick(again); expect(f.importFiles).toHaveBeenCalledTimes(2);
  expect(await readFile(join(f.source, '1029', 'image.png'), 'utf8')).toBe('1029');
});
it('migrates an unmarked ledger by baselining current nested files while preserving paused top-level pending work', async () => {
  const f = await setup(); await writeFile(join(f.source, '旧顶层.txt'), 'old'); await f.collector.configure(f.source, { nameFromContent: false });
  await writeFile(join(f.source, '待收顶层.txt'), 'pending'); await f.collector.poll(); await f.collector.setEnabled(false); await f.collector.close();
  const path = join(f.stateDirectory, 'workdisk-auto.json'); const data = JSON.parse(await readFile(path, 'utf8')); delete data.scanScope; await writeFile(path, JSON.stringify(data));
  await mkdir(join(f.source, '1029')); await writeFile(join(f.source, '1029', '旧子目录.txt'), '不得批量发送');
  const resumed = await f.make(); expect((await resumed.status()).enabled).toBe(false); expect(f.importFiles).not.toHaveBeenCalled();
  const migrated = JSON.parse(await readFile(path, 'utf8'));
  expect(migrated.scanScope).toBe('recursive-v1'); expect(migrated.records.filter((entry: { name: string }) => !entry.name.includes('/'))).toEqual(data.records);
  expect(migrated.records.find((entry: { name: string }) => entry.name === '1029/旧子目录.txt')?.status).toBe('baseline');
  await resumed.setEnabled(true); await f.tick(resumed); expect(f.importFiles).toHaveBeenCalledTimes(1);
  await resumed.close(); await writeFile(join(f.source, '1029', '重启前新文件.txt'), 'new'); const again = await f.make();
  await again.poll(); await f.tick(again); expect(f.importFiles).toHaveBeenCalledTimes(2);
  expect((await again.status()).receipts.map(entry => entry.sourceName).sort()).toEqual(['1029/重启前新文件.txt', '待收顶层.txt']);
});
it.each(['symlink', 'ordinary'])('does not send a nested file when its parent is replaced with a %s directory while service import waits', async replacement => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const namer = vi.fn<WorkdiskContentNamer>(async input => { if (input.name === 'blocker.txt') { entered(); await blocked; } return { title: '测试标题', reason: 'test' }; });
  const f = await setup(namer); await f.collector.configure(f.source, { nameFromContent: true });
  const folder = join(f.source, '1029'); await mkdir(folder); await writeFile(join(folder, 'nested.txt'), '不应发送');
  const alternate = join(f.base, 'alternate'); await mkdir(alternate); await link(join(folder, 'nested.txt'), join(alternate, 'nested.txt'));
  await f.collector.poll();
  const blocker = join(f.base, 'blocker.txt'); await writeFile(blocker, 'blocker');
  const manual = f.service.importFiles([blocker], '2026-10-30', { nameFromContent: true }); await started;
  const processing = f.tick();
  try {
    await vi.waitFor(() => expect(f.importFiles).toHaveBeenCalledTimes(1));
    const moved = join(f.base, 'moved'); await rename(folder, moved);
    if (replacement === 'symlink') await symlink(moved, folder); else await rename(alternate, folder);
  } finally { release(); await manual; await processing; }
  expect(namer).toHaveBeenCalledTimes(1); expect((await f.collector.status()).receipts[0]?.status).toBe('failed');
  expect((await f.service.list()).files).toHaveLength(1);
});
it('refuses to publish if a nested parent becomes a symlink during content naming', async () => {
  let folder = ''; let moved = '';
  const namer = vi.fn<WorkdiskContentNamer>(async () => { await rename(folder, moved); await symlink(moved, folder); return { title: '不应发布', reason: 'test' }; });
  const f = await setup(namer); folder = join(f.source, '1029'); moved = join(f.base, 'moved');
  await f.collector.configure(f.source, { nameFromContent: true }); await mkdir(folder); await writeFile(join(folder, 'nested.txt'), '原文');
  await f.collector.poll(); await f.tick(); expect(namer).toHaveBeenCalledTimes(1);
  expect((await f.collector.status()).receipts[0]?.status).toBe('failed'); expect((await f.service.list()).files).toEqual([]);
  expect(await readFile(join(moved, 'nested.txt'), 'utf8')).toBe('原文');
});
it('pauses on excessive recursive depth without forgetting already pending files', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false }); await writeFile(join(f.source, 'pending.txt'), 'A'); await f.collector.poll();
  const deep = join(f.source, ...Array.from({ length: 17 }, (_, index) => `level${index}`)); await mkdir(deep, { recursive: true }); await writeFile(join(deep, 'deep.txt'), 'deep');
  await f.tick(); expect((await f.collector.status()).enabled).toBe(false); expect((await f.collector.status()).pendingCount).toBe(1); expect(f.importFiles).not.toHaveBeenCalled();
});
it('never starts recursive imports when persisting a legacy scope migration fails', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: true }); await f.collector.close();
  const path = join(f.stateDirectory, 'workdisk-auto.json'); const old = JSON.parse(await readFile(path, 'utf8')); delete old.scanScope; await writeFile(path, JSON.stringify(old));
  await mkdir(join(f.source, '1029')); await writeFile(join(f.source, '1029', '旧图片.png'), '不得发送');
  await chmod(f.stateDirectory, 0o500);
  try {
    const resumed = await f.make(); expect((await resumed.status()).phase).toBe('error'); expect((await resumed.status()).enabled).toBe(false);
    await resumed.poll(); await f.tick(resumed); expect(f.importFiles).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path, 'utf8')).scanScope).toBeUndefined();
  } finally { await chmod(f.stateDirectory, 0o700); }
});
it('applies the scan limit across sibling trees without forgetting already pending files', async () => {
  const f = await setup(); await f.collector.configure(f.source, { nameFromContent: false }); await writeFile(join(f.source, 'pending.txt'), 'A'); await f.collector.poll();
  for (const folder of ['left', 'right']) {
    const parent = join(f.source, folder); await mkdir(parent);
    for (let offset = 0; offset < 5000; offset += 100) await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(parent, `${offset + index}.txt`), '')));
  }
  await f.tick(); expect((await f.collector.status()).enabled).toBe(false); expect((await f.collector.status()).pendingCount).toBe(1); expect(f.importFiles).not.toHaveBeenCalled();
}, 30_000);
