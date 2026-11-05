import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { WorkdiskAutoReceipt, WorkdiskAutoState } from '../../shared/workdisk-auto.js';
import type { WorkdiskFileIdentity, WorkdiskService } from './service.js';
import { assertRoot, contained, safeRelative, sameIdentity, type FileIdentity } from './paths.js';

const RECORD_LIMIT = 10_000;
const DEPTH_LIMIT = 16;
const STATE_LIMIT = 8 * 1024 * 1024;
const WAITING_MESSAGE = '工作盘暂时未连接，接回原硬盘后会继续收纳。';
class TargetUnavailable extends Error {}
const partialName = /(?:\.(?:crdownload|part|partial|download|tmp|temp|opdownload|filepart)|~)$/iu;
const packageName = /\.(?:app|bundle|framework|plugin|kext|appex|prefpane|pkg|playground|photolibrary|photoslibrary|rtfd|pages|numbers|key)$/iu;
const relativeNameSchema = z.string().min(1).max(2048).refine(value => { try { safeRelative(value); return true; } catch { return false; } });
const sourceSchema = z.object({ rootPath: z.string().min(1).max(4096), displayName: z.string().max(4096), dev: z.number(), ino: z.number() }).strict();
const recordSchema = z.object({
  id: z.uuid(), key: z.string().max(200), name: relativeNameSchema, fingerprint: z.string().max(200), stableSince: z.number().finite(),
  status: z.enum(['baseline', 'pending', 'processing', 'saved', 'failed', 'uncertain'])
}).strict();
const receiptSchema = z.object({
  id: z.uuid(), sourceName: z.string().max(2048), savedName: z.string().max(1024).optional(), path: z.string().max(4096).optional(),
  status: z.enum(['saved', 'failed', 'uncertain']), reason: z.string().max(1000), receivedAt: z.string().max(100),
  savedIdentity: z.object({ dev: z.number(), ino: z.number(), birthtimeMs: z.number() }).strict().optional()
}).strict();
const storedSchema = z.object({
  version: z.literal(1), scanScope: z.literal('recursive-v1').optional(), source: sourceSchema, target: z.object({ id: z.string(), rootPath: z.string().max(4096) }).strict(),
  enabled: z.boolean(), nameFromContent: z.boolean(), waitingForTarget: z.literal(true).optional(),
  records: z.array(recordSchema).max(RECORD_LIMIT), receipts: z.array(receiptSchema).max(50), message: z.string().max(1000).optional()
}).strict();
type Stored = z.infer<typeof storedSchema>;
type RecordEntry = Stored['records'][number];
type Source = Stored['source'];
interface DirectorySnapshot extends WorkdiskFileIdentity { relativePath: string }
interface ScannedFile { name: string; key: string; fingerprint: string; size: number; parents: DirectorySnapshot[] }
function key(info: Stats): string { return `${info.dev}:${info.ino}:${info.birthtimeMs}`; }
function fingerprint(info: Stats): string { return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`; }
function localDate(time: number): string { const date = new Date(time); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function userError(error: unknown, fallback: string): string { return error instanceof Error && !('code' in error) ? error.message.slice(0, 1000) : fallback; }

export function createWorkdiskAutoCollector(config: {
  stateDirectory: string; protectedRoots: string[]; service: Pick<WorkdiskService, 'status' | 'validateBinding' | 'importFiles' | 'renameFile'>;
  pollMs?: number; settleMs?: number; now?: () => number;
}) {
  const now = config.now ?? Date.now;
  const settleMs = Math.max(3000, config.settleMs ?? 3000);
  let stored: Stored | null = null;
  let loaded: Promise<void> | undefined;
  let stateRoot: { path: string; identity: FileIdentity } | undefined;
  let phase: WorkdiskAutoState['phase'] = 'off';
  let message: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false; let closed = false; let generation = 0;
  let active: AbortController | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let polling: Promise<void> | undefined;

  function snapshot(): WorkdiskAutoState {
    return {
      source: stored ? { rootPath: stored.source.rootPath, displayName: stored.source.displayName } : null,
      enabled: stored?.enabled ?? false, nameFromContent: stored?.nameFromContent ?? false, phase,
      pendingCount: stored?.records.filter(record => record.status === 'pending' || record.status === 'processing').length ?? 0,
      ...(message ? { message } : {}), receipts: (stored?.receipts ?? []).map(({ savedName, path, savedIdentity: _identity, ...entry }) => ({ ...entry, ...(savedName !== undefined ? { savedName } : {}), ...(path !== undefined ? { path } : {}) }))
    };
  }
  function queue<T>(action: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error('自动收纳正在关闭，请重新打开应用。'));
    const next = tail.then(action); tail = next.catch(() => undefined); return next;
  }
  function interrupt(): void { generation++; active?.abort(); }
  async function directoryState(): Promise<{ path: string; identity: FileIdentity }> {
    if (!stateRoot) {
      await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
      const before = await lstat(config.stateDirectory);
      if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('自动收纳设置目录无法使用。');
      const path = await realpath(config.stateDirectory); const identity = await lstat(path);
      if (!sameIdentity(before, identity)) throw new Error('自动收纳设置目录发生变化。');
      stateRoot = { path, identity };
    }
    await assertRoot(stateRoot.path, stateRoot.identity); return stateRoot;
  }
  async function checkStateFile(path: string): Promise<void> {
    const info = await lstat(path).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('自动收纳记录不是普通文件，请检查应用设置目录。');
  }
  async function persist(value: Stored): Promise<void> {
    const root = await directoryState(); const path = join(root.path, 'workdisk-auto.json'); await checkStateFile(path);
    const bytes = Buffer.from(JSON.stringify(value));
    if (value.records.length > RECORD_LIMIT || bytes.length > STATE_LIMIT) throw new Error('自动收纳记录已达上限，已暂停；请手动收纳新文件。');
    const temp = join(root.path, `.workdisk-auto-${randomUUID()}.tmp`); let owned: FileIdentity | undefined;
    try {
      const output = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { owned = await output.stat(); await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
      await assertRoot(root.path, root.identity); await checkStateFile(path);
      const ready = await lstat(temp); if (ready.isSymbolicLink() || !sameIdentity(ready, owned)) throw new Error('自动收纳记录保存中断。');
      await rename(temp, path);
      // Persist the processing intent before any copy begins, including across a process crash.
      const parent = await open(root.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    } finally {
      if (owned) { const remaining = await lstat(temp).catch(() => undefined); if (remaining && sameIdentity(remaining, owned) && !remaining.isSymbolicLink()) await unlink(temp); }
    }
  }
  function receipt(entry: WorkdiskAutoReceipt & { savedIdentity?: WorkdiskFileIdentity }): void {
    if (stored) stored.receipts = [entry, ...stored.receipts.filter(item => item.id !== entry.id)].slice(0, 50);
  }
  async function load(): Promise<void> {
    try {
      const root = await directoryState(); const path = join(root.path, 'workdisk-auto.json');
      const before = await lstat(path).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error; });
      if (!before) return;
      if (!before.isFile() || before.isSymbolicLink() || before.size > STATE_LIMIT) throw new Error('invalid state');
      const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await input.stat(); if (!sameIdentity(before, opened)) throw new Error('changed state');
        const bytes = Buffer.alloc(Math.min(before.size + 1, STATE_LIMIT + 1)); let length = 0;
        while (length < bytes.length) { const part = await input.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
        const after = await input.stat(); const current = await lstat(path);
        if (length !== before.size || !sameIdentity(before, current) || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('changed state');
        stored = storedSchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
      } finally { await input.close(); }
      let recovered = false;
      for (const entry of stored.records) {
        if (entry.status !== 'processing') continue;
        entry.status = 'uncertain'; recovered = true;
        receipt({ id: entry.id, sourceName: entry.name, status: 'uncertain', reason: '上次收纳中断，可能已经保存；请核对源文件与工作盘后手动处理，不会自动重试。', receivedAt: new Date(now()).toISOString() });
      }
      message = stored.message; phase = stored.enabled ? stored.waitingForTarget ? 'waiting' : 'watching' : 'paused';
      if (recovered) { message = '有上次中断的收纳记录，请核对源文件与工作盘。'; stored.message = message; await persist(stored); }
      if (!stored.scanScope) {
        try { const next = await upgradeScope(stored); await persist(next); stored = next; }
        catch (error) { await pauseError(error); }
      }
    } catch {
      if (stored) stored.enabled = false;
      phase = 'error'; message = '自动收纳记录无法读取，已停止接收；请重新选择接收文件夹。';
    }
  }
  function ensureLoaded(): Promise<void> { return loaded ??= load(); }
  async function verifySource(source: Source): Promise<string> {
    try { await assertRoot(source.rootPath, source); return source.rootPath; }
    catch { throw new Error('接收文件夹已断开或位置发生变化，请重新选择。'); }
  }
  async function verifyTarget(value: Stored): Promise<void> {
    let target: Awaited<ReturnType<typeof config.service.validateBinding>>;
    try { target = await config.service.validateBinding(); }
    catch (error) {
      // Only failure to validate the intended target is retryable. Source/settings failures stay fatal.
      if (error && typeof error === 'object' && 'code' in error && error.code === 'WORKDISK_UNAVAILABLE') throw new TargetUnavailable(WAITING_MESSAGE);
      throw error;
    }
    if (!target || target.id !== value.target.id || target.rootPath !== value.target.rootPath) throw new Error('工作盘已改变，自动收纳已暂停；请重新确认接收文件夹。');
    await verifySeparation(value.source.rootPath, target.rootPath);
  }
  async function verifySeparation(sourcePath: string, targetPath: string): Promise<void> {
    const state = await directoryState();
    for (const input of [...config.protectedRoots, targetPath, state.path]) {
      let protectedPath: string;
      try { protectedPath = await realpath(input); }
      catch (error) {
        // The validated disk can disconnect before this second path lookup.
        // Missing source, protected, or settings directories must still pause.
        if (input === targetPath && (error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new TargetUnavailable(WAITING_MESSAGE);
        throw error;
      }
      if (contained(protectedPath, sourcePath) || contained(sourcePath, protectedPath)) throw new Error('接收文件夹需要独立，不能与工作盘、知识库或应用设置目录重叠。');
    }
  }
  async function verifyParents(source: Source, parents: DirectorySnapshot[]): Promise<void> {
    await verifySource(source);
    for (const parent of parents) {
      const path = join(source.rootPath, ...safeRelative(parent.relativePath)); const current = await lstat(path);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(parent, current) || parent.birthtimeMs !== current.birthtimeMs || await realpath(path) !== path) throw new Error('接收文件的上级文件夹发生变化，请核对后手动收纳。');
    }
    await verifySource(source);
  }
  function sourceGuard(source: Source, file: ScannedFile): (path: string) => Promise<void> {
    const expectedPath = join(source.rootPath, ...safeRelative(file.name));
    return async path => {
      if (path !== expectedPath) throw new Error('接收文件路径发生变化，请重新选择。');
      await verifyParents(source, file.parents);
      const current = await lstat(path);
      if (!current.isFile() || current.isSymbolicLink() || key(current) !== file.key || fingerprint(current) !== file.fingerprint || await realpath(path) !== path) throw new Error('接收文件发生变化，请核对后手动收纳。');
      await verifyParents(source, file.parents);
    };
  }
  async function scan(source: Source): Promise<ScannedFile[]> {
    const found: ScannedFile[] = []; let count = 0;
    async function visit(parts: string[], parents: DirectorySnapshot[]): Promise<void> {
      await verifyParents(source, parents);
      for await (const entry of await opendir(join(source.rootPath, ...parts))) {
        if (++count > RECORD_LIMIT) throw new Error('接收文件夹项目过多，已暂停；请手动收纳或选择较小的文件夹。');
        if (entry.name.startsWith('.') || partialName.test(entry.name) || entry.isSymbolicLink()) continue;
        const childParts = [...parts, entry.name]; const relativePath = childParts.join('/'); safeRelative(relativePath);
        await verifyParents(source, parents);
        const info = await lstat(join(source.rootPath, ...childParts)).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error; });
        if (!info || info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          if (packageName.test(entry.name)) continue;
          if (childParts.length > DEPTH_LIMIT) throw new Error('接收文件夹层级过深，已暂停；请手动收纳或选择较浅的文件夹。');
          await visit(childParts, [...parents, { relativePath, dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs }]);
        } else if (info.isFile()) found.push({ name: relativePath, key: key(info), fingerprint: fingerprint(info), size: info.size, parents });
      }
      await verifyParents(source, parents);
    }
    await visit([], []);
    const seen = new Set<string>();
    return found.sort((a, b) => a.name.localeCompare(b.name)).filter(file => { if (seen.has(file.key)) return false; seen.add(file.key); return true; });
  }
  async function upgradeScope(value: Stored): Promise<Stored> {
    const records = [...value.records]; const seen = new Set(records.map(entry => entry.key));
    for (const file of await scan(value.source)) {
      if (!file.name.includes('/') || seen.has(file.key)) continue;
      if (records.length >= RECORD_LIMIT) throw new Error('自动收纳记录已达上限，已暂停；请手动收纳新文件。');
      records.push({ id: randomUUID(), key: file.key, name: file.name, fingerprint: file.fingerprint, stableSince: now(), status: 'baseline' }); seen.add(file.key);
    }
    return { ...value, scanScope: 'recursive-v1', records };
  }
  async function pauseError(error: unknown): Promise<void> {
    phase = 'error'; message = userError(error, '自动收纳暂时无法继续，已暂停；请检查接收目录和磁盘后重新开启。');
    if (stored) { stored.enabled = false; delete stored.waitingForTarget; stored.message = message; try { await persist(stored); } catch { /* Keep the known ledger and stop all work. */ } }
  }
  async function pollFailure(error: unknown): Promise<void> {
    if (!(error instanceof TargetUnavailable) || !stored?.enabled) { await pauseError(error); return; }
    phase = 'waiting'; message = WAITING_MESSAGE;
    if (stored.waitingForTarget && stored.message === WAITING_MESSAGE) return;
    const next: Stored = { ...stored, waitingForTarget: true, message: WAITING_MESSAGE };
    try { await persist(next); stored = next; }
    catch (failure) { await pauseError(failure); }
  }
  async function recoverTarget(): Promise<void> {
    if (!stored?.waitingForTarget) return;
    const next = { ...stored }; delete next.waitingForTarget;
    if (next.message === WAITING_MESSAGE) delete next.message;
    await persist(next); stored = next; message = next.message; phase = next.enabled ? 'watching' : 'paused';
  }
  async function runPoll(currentGeneration: number): Promise<void> {
    await ensureLoaded(); if (closed || !stored?.enabled || currentGeneration !== generation) return;
    const controller = new AbortController(); active = controller;
    const running = () => !closed && !controller.signal.aborted && currentGeneration === generation;
    try {
      if (!stored.scanScope) { const next = await upgradeScope(stored); await persist(next); stored = next; }
      await verifySource(stored.source); await verifyTarget(stored); if (!running()) return;
      await recoverTarget(); const files = await scan(stored.source); if (!running()) return;
      const byKey = new Map(stored.records.map(entry => [entry.key, entry])); const present = new Set(files.map(file => file.key));
      let dirty = false;
      // Only disappeared, unprocessed candidates can be forgotten; dedupe history is never evicted.
      const retained = stored.records.filter(entry => entry.status !== 'pending' || present.has(entry.key));
      if (retained.length !== stored.records.length) { stored.records = retained; dirty = true; }
      for (const file of files) {
        if (!file.size) continue;
        const entry = byKey.get(file.key);
        if (!entry) {
          if (stored.records.length >= RECORD_LIMIT) throw new Error('自动收纳记录已达上限，已暂停；请手动收纳新文件。');
          const candidate: RecordEntry = { id: randomUUID(), key: file.key, name: file.name, fingerprint: file.fingerprint, stableSince: now(), status: 'pending' };
          stored.records.push(candidate); byKey.set(file.key, candidate); dirty = true;
        } else if (entry.status === 'pending' && (entry.fingerprint !== file.fingerprint || entry.name !== file.name)) {
          entry.name = file.name; entry.fingerprint = file.fingerprint; entry.stableSince = now(); dirty = true;
        }
      }
      if (dirty) await persist(stored);
      for (const file of files) {
        if (!running()) break;
        const entry = byKey.get(file.key);
        if (!file.size || !entry || entry.status !== 'pending' || now() - entry.stableSince < settleMs) continue;
        await verifySource(stored.source); await verifyTarget(stored); if (!running()) break;
        const sourcePath = join(stored.source.rootPath, ...safeRelative(entry.name)); const guard = sourceGuard(stored.source, file);
        await verifyParents(stored.source, file.parents); const latest = await lstat(sourcePath).catch(() => undefined);
        if (!latest?.isFile() || latest.isSymbolicLink() || key(latest) !== entry.key || fingerprint(latest) !== entry.fingerprint) continue;
        entry.status = 'processing'; await persist(stored);
        try { await verifySource(stored.source); await verifyTarget(stored); }
        catch (error) {
          // The durable intent is reversible until importFiles starts; a disconnection must not strand it.
          entry.status = 'pending'; await persist(stored); throw error;
        }
        if (!running()) { entry.status = 'pending'; await persist(stored); break; }
        phase = 'processing';
        try {
          const result = await config.service.importFiles([sourcePath], localDate(now()), { nameFromContent: stored.nameFromContent }, controller.signal, guard);
          const saved = result.files[0];
          if (saved) {
            entry.status = 'saved'; receipt({ id: entry.id, sourceName: entry.name, savedName: saved.name, path: saved.path, ...(saved.identity ? { savedIdentity: saved.identity } : {}), status: 'saved', reason: result.naming?.[0]?.reason || '已保存到工作盘，原件保留。', receivedAt: new Date(now()).toISOString() });
          } else {
            entry.status = 'failed'; receipt({ id: entry.id, sourceName: entry.name, status: 'failed', reason: `${result.failures[0]?.message || '本次未能保存。'} 请检查后手动收纳，不会自动重试。`.slice(0, 1000), receivedAt: new Date(now()).toISOString() });
          }
        } catch {
          entry.status = 'uncertain'; receipt({ id: entry.id, sourceName: entry.name, status: 'uncertain', reason: '收纳结果无法确认，请核对源文件与工作盘后手动处理，不会自动重试。', receivedAt: new Date(now()).toISOString() });
        }
        await persist(stored);
      }
      phase = stored.enabled ? 'watching' : 'paused';
    } catch (error) { await pollFailure(error); }
    finally { if (active === controller) active = undefined; }
  }
  function poll(): Promise<void> {
    if (closed) return Promise.resolve(); if (polling) return polling;
    const currentGeneration = generation;
    const operation = queue(() => runPoll(currentGeneration)); polling = operation;
    void operation.finally(() => { if (polling === operation) polling = undefined; }).catch(() => undefined); return operation;
  }
  function requireStored(): Stored { if (!stored) throw new Error('请先选择接收文件夹。'); return stored; }
  return {
    async start(): Promise<void> {
      if (closed || started) return; started = true;
      await queue(async () => { await ensureLoaded(); if (stored?.enabled) { try { await verifySource(stored.source); await verifyTarget(stored); await recoverTarget(); } catch (error) { await pollFailure(error); } } });
      if (!closed) { timer = setInterval(() => { void poll().catch(() => undefined); }, Math.max(100, config.pollMs ?? 3000)); timer.unref(); }
    },
    async status(): Promise<WorkdiskAutoState> { await ensureLoaded(); return snapshot(); },
    configure(rootPath: string, options: { nameFromContent: boolean }): Promise<WorkdiskAutoState> {
      interrupt(); return queue(async () => {
        await ensureLoaded();
        if (typeof rootPath !== 'string' || !isAbsolute(rootPath) || rootPath.length > 4096 || typeof options?.nameFromContent !== 'boolean') throw new Error('请选择有效的本地接收文件夹。');
        const info = await lstat(rootPath); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('请选择普通文件夹，不能使用快捷链接。');
        const path = await realpath(rootPath); const identity = await lstat(path); if (!sameIdentity(info, identity)) throw new Error('接收文件夹已改变，请重新选择。');
        const target = await config.service.validateBinding();
        await verifySeparation(path, target.rootPath);
        const source: Source = { rootPath: path, displayName: basename(path), dev: identity.dev, ino: identity.ino };
        const reuse = stored?.source.rootPath === path && sameIdentity(stored.source, source);
        const records = reuse ? (stored!.scanScope ? stored!.records : (await upgradeScope(stored!)).records) : (await scan(source)).map(file => ({ id: randomUUID(), key: file.key, name: file.name, fingerprint: file.fingerprint, stableSince: now(), status: 'baseline' as const }));
        const sameTarget = stored?.target.id === target.id && stored.target.rootPath === target.rootPath;
        const next: Stored = { version: 1, scanScope: 'recursive-v1', source, target: { id: target.id, rootPath: target.rootPath }, enabled: true, nameFromContent: options.nameFromContent, records, receipts: reuse && sameTarget ? stored!.receipts : [] };
        await persist(next); stored = next; message = undefined; phase = 'watching'; return snapshot();
      });
    },
    setEnabled(enabled: boolean): Promise<WorkdiskAutoState> {
      interrupt(); return queue(async () => {
        await ensureLoaded(); if (typeof enabled !== 'boolean') throw new Error('自动收纳开关无效。');
        if (!stored && !enabled) return snapshot(); const value = requireStored();
        if (enabled) { await verifySource(value.source); await verifyTarget(value); }
        const next = { ...value, enabled }; delete next.message; delete next.waitingForTarget;
        // A failed resume must stay paused; a requested pause still stops work if saving fails.
        if (!enabled) { value.enabled = false; phase = 'paused'; }
        await persist(next); stored = next; message = undefined; phase = enabled ? 'watching' : 'paused'; return snapshot();
      });
    },
    setNaming(enabled: boolean): Promise<WorkdiskAutoState> {
      interrupt(); return queue(async () => {
        await ensureLoaded(); if (typeof enabled !== 'boolean') throw new Error('内容命名开关无效。');
        const next = { ...requireStored(), nameFromContent: enabled };
        await persist(next); stored = next; return snapshot();
      });
    },
    async resolveSource(): Promise<string> { await ensureLoaded(); return verifySource(requireStored().source); },
    renameReceipt(id: string, title: string): Promise<WorkdiskAutoState> {
      interrupt(); return queue(async () => {
        await ensureLoaded(); const value = requireStored(); await verifyTarget(value); const item = value.receipts.find(item => item.id === id);
        if (!item || item.status !== 'saved' || !item.path || !item.savedIdentity) throw new Error('这条收纳记录暂时不能改名，请在工作盘查看文件。');
        const changed = await config.service.renameFile(item.path, title, item.savedIdentity);
        item.savedName = changed.name; item.path = changed.path; item.savedIdentity = changed.identity; item.reason = '已按你的修改更新名称，原件保留。';
        await persist(value); return snapshot();
      });
    },
    poll,
    async close(): Promise<void> { if (timer) clearInterval(timer); closed = true; interrupt(); await tail; }
  };
}
