import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { PublicApiError } from '../../shared/api/errors.js';
import { skillFolderTrashIdSchema, type SkillFolder, type SkillFolderTrashEntry, type SkillFolderTrashPreview } from '../../shared/api/skills.js';

const identitySchema = z.strictObject({ dev: z.string(), ino: z.string() });
type Identity = z.infer<typeof identitySchema>;
const recordSchema = z.strictObject({
  version: z.literal(1), id: skillFolderTrashIdSchema, folderId: z.string().regex(/^[a-f0-9]{64}$/u),
  name: z.string().min(1).max(255), skillCount: z.number().int().nonnegative(), createdAt: z.iso.datetime(),
  root: identitySchema, folder: identitySchema, container: identitySchema, tree: z.string().regex(/^[a-f0-9]{64}$/u),
  phase: z.enum(['planned', 'trashed', 'restoring', 'restored']), restoredAt: z.iso.datetime().optional()
});
type Record = z.infer<typeof recordSchema>;
type Pending = { preview: SkillFolderTrashPreview; root: Identity; folder: Identity; tree: string };
const ownerSchema = z.strictObject({ format: z.literal('best-partners-skill-folder-trash-v1'), root: identitySchema, directory: identitySchema });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
function fail(code: string, message: string, status = 409): never { throw new PublicApiError(code, message, status); }
function unsafe(): never { return fail('SKILL_FOLDER_TRASH_UNSAFE', '文件夹回收区或记录已变化，现有文件均已保留。请在 Finder 中核对后重试。'); }
function identity(path: string): Identity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe();
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) unsafe();
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally { closeSync(fd); }
}
function writeJson(path: string, value: unknown) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
}
function saveRecord(container: string, record: Record) {
  const staged = join(container, `.metadata-${randomUUID()}`);
  writeJson(staged, record);
  renameSync(staged, join(container, 'metadata.json'));
  syncDirectory(container);
}

/** Observe the complete directory without reading or modifying any Skill file. */
function tree(path: string): { identity: Identity; hash: string; entryCount: number } {
  const rootIdentity = identity(path);
  const rows: unknown[] = [];
  const visit = (current: string, relative: string, depth: number) => {
    if (depth > 64 || rows.length >= 10_000) fail('SKILL_FOLDER_TOO_LARGE', '文件夹内容过多，无法完整核验。请先在 Finder 中整理后重试。');
    const before = lstatSync(current, { bigint: true });
    if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory()) || String(before.dev) !== rootIdentity.dev) {
      fail('SKILL_FOLDER_UNSAFE', '文件夹含符号链接、特殊文件或其他磁盘目录，未移动任何内容。请先在 Finder 中核对。');
    }
    // Renaming changes the root ctime; its inode, mtime and every descendant remain bound.
    rows.push([relative, String(before.dev), String(before.ino), before.isDirectory() ? 'directory' : 'file', String(before.size), String(before.mtimeNs), relative ? String(before.ctimeNs) : '']);
    if (before.isDirectory()) {
      for (const name of readdirSync(current).sort()) visit(join(current, name), relative ? `${relative}/${name}` : name, depth + 1);
    }
    const after = lstatSync(current, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      fail('SKILL_FOLDER_PREVIEW_STALE', '文件夹已变化，请重新预览后再确认。');
    }
  };
  visit(path, '', 0);
  return { identity: rootIdentity, hash: digest(JSON.stringify(rows)), entryCount: readdirSync(path).length };
}

export function createSkillFolderTrashService(input: {
  root(): Promise<string>;
  rootMissing(): Promise<boolean>;
  folders(): Promise<SkillFolder[]>;
  isSafeName(name: unknown): name is string;
  assertRestoreLayout(folderPath: string): Promise<void>;
}) {
  const previews = new Map<string, Pending>();
  let pinnedRoot: Identity | undefined;
  let busy = false;
  function assertRoot(root: string): Identity {
    for (const path of [dirname(dirname(root)), dirname(root), root]) {
      identity(path);
      if (realpathSync(path) !== path) fail('SKILL_FOLDER_ROOT_CHANGED', '当前 Skill 根目录已变化，请重新打开当前大脑后重试。');
    }
    const current = identity(root);
    if (pinnedRoot && !same(pinnedRoot, current)) fail('SKILL_FOLDER_ROOT_CHANGED', '当前 Skill 根目录已被替换，未移动文件。请重新打开当前大脑后重试。');
    pinnedRoot ??= current;
    return current;
  }
  async function rootPath() { const root = await input.root(); assertRoot(root); return root; }
  function recycleRoot(root: string, create: boolean): string | undefined {
    const path = join(root, '.trash');
    if (!exists(path)) {
      if (!create) return undefined;
      mkdirSync(path, { mode: 0o700 });
      writeJson(join(path, 'owner.json'), { format: 'best-partners-skill-folder-trash-v1', root: assertRoot(root), directory: identity(path) });
      syncDirectory(path); syncDirectory(root);
    }
    try {
      const current = identity(path);
      if (realpathSync(path) !== path) unsafe();
      const owner = ownerSchema.parse(readJson(join(path, 'owner.json')));
      if (!same(owner.root, assertRoot(root)) || !same(owner.directory, current)) unsafe();
      return path;
    } catch { return unsafe(); }
  }
  function load(root: string, id: string): { record: Record; container: string; payload: string } {
    if (!skillFolderTrashIdSchema.safeParse(id).success) fail('SKILL_FOLDER_TRASH_INVALID', '回收记录编号无效，请刷新后重试。', 400);
    const area = recycleRoot(root, false);
    if (!area || !exists(join(area, id))) fail('SKILL_FOLDER_TRASH_NOT_FOUND', '未找到这条回收记录，请刷新列表。', 404);
    const container = join(area, id);
    try {
      const current = identity(container);
      if (realpathSync(container) !== container) unsafe();
      const record = recordSchema.parse(readJson(join(container, 'metadata.json')));
      if (record.id !== id || !input.isSafeName(record.name) || digest(record.name) !== record.folderId
        || !same(record.root, assertRoot(root)) || !same(record.container, current)) unsafe();
      return { record, container, payload: join(container, 'folder') };
    } catch { return unsafe(); }
  }
  function entry(root: string, record: Record, payload: string): SkillFolderTrashEntry {
    const base = { id: record.id, folderId: record.folderId, name: record.name, skillCount: record.skillCount, createdAt: record.createdAt };
    try {
      // Completed history is independent of later, legitimate edits or moves in the live catalog.
      if (record.phase === 'restored' && !exists(payload)) return { ...base, status: 'restored', ...(record.restoredAt ? { restoredAt: record.restoredAt } : {}) };
      if (exists(payload)) {
        const snapshot = tree(payload);
        if (same(snapshot.identity, record.folder) && snapshot.hash === record.tree) return { ...base, status: 'trashed' };
      } else if (record.phase !== 'planned' && exists(join(root, record.name))) {
        const snapshot = tree(join(root, record.name));
        if (same(snapshot.identity, record.folder) && snapshot.hash === record.tree) return { ...base, status: 'restored', ...(record.restoredAt ? { restoredAt: record.restoredAt } : {}) };
      }
    } catch { /* Preserve every version and report the mismatch below. */ }
    return { ...base, status: 'needs-review', problem: '文件夹或回收记录已变化，现有内容均已保留。请在 Finder 中核对，勿重复移动。' };
  }
  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (busy) fail('SKILL_FOLDER_TRASH_BUSY', '正在处理文件夹，请稍后重试。');
    busy = true;
    try { return await action(); } catch (error) {
      if (error instanceof PublicApiError) throw error;
      fail('SKILL_FOLDER_TRASH_FAILED', '文件夹操作未完成。现有文件均已保留，请刷新回收列表核对后重试。', 500);
    } finally { busy = false; }
  }
  return {
    async previewFolderTrash(folderId: string): Promise<SkillFolderTrashPreview> {
      if (!/^[a-f0-9]{64}$/u.test(folderId)) fail('SKILL_FOLDER_INVALID', '文件夹编号无效。', 400);
      const root = await rootPath();
      const folder = (await input.folders()).find(value => value.id === folderId);
      if (!folder) fail('SKILL_FOLDER_NOT_FOUND', '未找到这个自定义文件夹，请刷新。未分类不能回收。', 404);
      assertRoot(root);
      const snapshot = tree(join(root, folder.name));
      const preview = { id: randomUUID(), folderId, name: folder.name, skillCount: folder.skillCount, entryCount: snapshot.entryCount, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
      for (const [id, pending] of previews) if (Date.parse(pending.preview.expiresAt) <= Date.now()) previews.delete(id);
      if (previews.size >= 100) previews.delete(previews.keys().next().value!);
      previews.set(preview.id, { preview, root: assertRoot(root), folder: snapshot.identity, tree: snapshot.hash });
      return { ...preview };
    },
    async trashFolder(id: string): Promise<SkillFolderTrashEntry> {
      return exclusive(async () => {
        const root = await rootPath();
        if (!skillFolderTrashIdSchema.safeParse(id).success) fail('SKILL_FOLDER_TRASH_INVALID', '回收记录编号无效。', 400);
        const existingArea = recycleRoot(root, false);
        if (existingArea && exists(join(existingArea, id))) {
          const old = load(root, id); const seen = entry(root, old.record, old.payload);
          if (seen.status !== 'needs-review') return seen;
          fail('SKILL_FOLDER_TRASH_UNSAFE', seen.problem!);
        }
        const pending = previews.get(id);
        if (!pending || Date.parse(pending.preview.expiresAt) <= Date.now()) fail('SKILL_FOLDER_PREVIEW_STALE', '回收预览已过期，请重新预览后再确认。');
        const source = join(root, pending.preview.name);
        const snapshot = tree(source);
        if (!same(assertRoot(root), pending.root) || !same(snapshot.identity, pending.folder) || snapshot.hash !== pending.tree || exists(join(source, 'SKILL.md'))) {
          fail('SKILL_FOLDER_PREVIEW_STALE', '文件夹已变化，请重新预览后再确认。');
        }
        const area = recycleRoot(root, true)!;
        const container = join(area, id);
        mkdirSync(container, { mode: 0o700 });
        const record: Record = { version: 1, id, folderId: pending.preview.folderId, name: pending.preview.name, skillCount: pending.preview.skillCount,
          createdAt: new Date().toISOString(), root: pending.root, folder: pending.folder, container: identity(container), tree: pending.tree, phase: 'planned' };
        writeJson(join(container, 'metadata.json'), record); syncDirectory(container); syncDirectory(area);
        // No application await between the last identity checks, rename and postflight.
        assertRoot(root); recycleRoot(root, false);
        const final = tree(source);
        if (!same(final.identity, pending.folder) || final.hash !== pending.tree || !same(identity(container), record.container)) fail('SKILL_FOLDER_PREVIEW_STALE', '文件夹已变化，请重新预览。');
        const payload = join(container, 'folder');
        if (exists(payload)) unsafe();
        renameSync(source, payload);
        assertRoot(root); recycleRoot(root, false);
        if (!same(identity(container), record.container)) unsafe();
        syncDirectory(root); syncDirectory(container);
        const observed = entry(root, record, payload);
        if (observed.status !== 'trashed') fail('SKILL_FOLDER_TRASH_UNSAFE', observed.problem!);
        record.phase = 'trashed'; saveRecord(container, record);
        previews.delete(id);
        return observed;
      });
    },
    async listFolderTrash(): Promise<{ items: SkillFolderTrashEntry[] }> {
      return exclusive(async () => {
        if (!pinnedRoot && await input.rootMissing()) return { items: [] };
        const root = await rootPath();
        const area = recycleRoot(root, false);
        if (!area) return { items: [] };
        const items: SkillFolderTrashEntry[] = [];
        for (const id of readdirSync(area).filter(name => skillFolderTrashIdSchema.safeParse(name).success).sort()) {
          try {
            const value = load(root, id);
            const observed = entry(root, value.record, value.payload);
            if (observed.status === 'restored' && value.record.phase !== 'restored') {
              // Finish a previously authorized restore before hiding it from the active list.
              value.record.phase = 'restored'; value.record.restoredAt = new Date().toISOString();
              assertRoot(root); recycleRoot(root, false);
              if (!same(identity(value.container), value.record.container)) unsafe();
              saveRecord(value.container, value.record);
              observed.restoredAt = value.record.restoredAt;
            }
            items.push(observed);
          } catch { items.push({ id, folderId: '0'.repeat(64), name: '待核验文件夹', skillCount: 0, createdAt: new Date(0).toISOString(), status: 'needs-review', problem: '回收记录损坏或目录已变化，内容已保留。请在 Finder 中核对。' }); }
        }
        return { items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
      });
    },
    async restoreFolder(id: string): Promise<SkillFolderTrashEntry> {
      return exclusive(async () => {
        const root = await rootPath();
        const value = load(root, id);
        const observed = entry(root, value.record, value.payload);
        if (observed.status === 'restored') {
          if (value.record.phase !== 'restored') {
            value.record.phase = 'restored'; value.record.restoredAt = new Date().toISOString();
            saveRecord(value.container, value.record);
          }
          return { ...observed, ...(value.record.restoredAt ? { restoredAt: value.record.restoredAt } : {}) };
        }
        if (observed.status !== 'trashed') fail('SKILL_FOLDER_TRASH_UNSAFE', observed.problem!);
        const destination = join(root, value.record.name);
        if (exists(destination)) fail('SKILL_FOLDER_RESTORE_CONFLICT', `原位置已有“${value.record.name}”。请先重命名或移走同名文件夹，再恢复；回收内容仍保留。`);
        await input.assertRestoreLayout(value.payload);
        assertRoot(root); recycleRoot(root, false);
        if (!same(identity(value.container), value.record.container)) unsafe();
        // Persist restore intent before moving so a crash after rename can be reconciled.
        value.record.phase = 'restoring'; saveRecord(value.container, value.record);
        assertRoot(root); recycleRoot(root, false);
        if (!same(identity(value.container), value.record.container)) unsafe();
        const final = tree(value.payload);
        if (!same(final.identity, value.record.folder) || final.hash !== value.record.tree || exists(destination)) unsafe();
        // Node has no directory no-replace rename or inode CAS. Adjacent checks
        // reject observed conflicts; they cannot exclude an external writer's syscall race.
        renameSync(value.payload, destination);
        assertRoot(root); recycleRoot(root, false);
        if (!same(identity(value.container), value.record.container)) unsafe();
        syncDirectory(root); syncDirectory(value.container);
        const restored = entry(root, value.record, value.payload);
        if (restored.status !== 'restored') fail('SKILL_FOLDER_TRASH_UNSAFE', restored.problem!);
        value.record.phase = 'restored'; value.record.restoredAt = new Date().toISOString();
        saveRecord(value.container, value.record);
        return { ...restored, restoredAt: value.record.restoredAt };
      });
    }
  };
}
