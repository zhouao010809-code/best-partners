import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PublicApiError } from '../../shared/api/errors.js';
import {
  intakeTrashEntrySchema, intakeTrashIdSchema, intakeTrashNameSchema, intakeTrashPreviewSchema, intakeTrashDeletePreviewSchema,
  type IntakeTrashEntry, type IntakeTrashPreview, type IntakeTrashDeletePreview
} from '../../shared/api/intake-trash.js';
import type { ArchiveTreeReader } from '../archive/archive-snapshot.js';
import { sameArchiveIdentity } from '../archive/archive-snapshot.js';
import { sha256Bytes } from '../vault/raw-bytes.js';
import type { PersonalIntakeTrashPort } from './intake-trash-native.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_MEMBERS = 10_000;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const PREVIEW_TTL = 600_000;
const identitySchema = z.strictObject({
  dev: z.string().regex(/^(0|[1-9][0-9]{0,19})$/u),
  ino: z.string().regex(/^(0|[1-9][0-9]{0,19})$/u)
});
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const memberFields = { path: z.string().max(64 * 256), ...identitySchema.shape };
const memberSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...memberFields, kind: z.literal('directory') }),
  z.strictObject({ ...memberFields, kind: z.literal('file'), bytes: z.number().int().nonnegative().max(MAX_FILE_BYTES), sha256: shaSchema })
]);
const ruleSchema = z.string().min(1).max(4096);
const manifestSchema = z.strictObject({
  version: z.literal(1), id: intakeTrashIdSchema, name: intakeTrashNameSchema,
  title: intakeTrashNameSchema, kind: z.enum(['file', 'directory']),
  bytes: z.number().int().nonnegative().max(MAX_BYTES), fileCount: z.number().int().nonnegative().max(MAX_MEMBERS),
  createdAt: z.iso.datetime(), root: identitySchema, ruleFingerprint: ruleSchema,
  tree: z.array(memberSchema).min(1).max(MAX_MEMBERS)
});
const restoreSchema = z.strictObject({
  version: z.literal(1), id: intakeTrashIdSchema, manifestSha256: shaSchema,
  confirmedAt: z.iso.datetime(), ruleFingerprint: ruleSchema
});
const restoredSchema = z.strictObject({
  version: z.literal(1), id: intakeTrashIdSchema, manifestSha256: shaSchema,
  restorationSha256: shaSchema, completedAt: z.iso.datetime(),
  root: identitySchema, source: identitySchema
});
const deletionSchema = z.strictObject({
  version: z.literal(1), id: intakeTrashIdSchema, manifestSha256: shaSchema, startedAt: z.iso.datetime()
});
const confirmationSchema = z.strictObject({
  version: z.literal(1), id: intakeTrashIdSchema, token: intakeTrashIdSchema,
  manifestSha256: shaSchema, deletionSha256: shaSchema, confirmedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  ruleFingerprint: ruleSchema, tree: z.array(memberSchema).max(MAX_MEMBERS)
});
const deletedSchema = z.strictObject({
  version: z.literal(1), id: intakeTrashIdSchema, manifestSha256: shaSchema, deletionSha256: shaSchema,
  confirmationToken: intakeTrashIdSchema, confirmationSha256: shaSchema, completedAt: z.iso.datetime(), root: identitySchema
});
type Member = z.output<typeof memberSchema>;
type Manifest = z.output<typeof manifestSchema>;
type Restoration = z.output<typeof restoreSchema>;
type Record = { manifest: Manifest; bytes: Buffer };
type Observed = {
  entry: IntakeTrashEntry;
  location: 'source' | 'trash' | 'unknown';
  restoration: Restoration | null;
  valid: boolean;
  collision: boolean;
  completed: boolean;
};

function fail(code: string, message: string, status = 409): never {
  throw new PublicApiError(code, message, status);
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sameTree = (a: readonly Member[], b: readonly Member[]) => JSON.stringify(a) === JSON.stringify(b);

/** A bounded observation. Native rename and postflight still guard external writers. */
function capture(reader: ArchiveTreeReader, path: string, rootDev: string): Member[] {
  const tree: Member[] = [];
  let bytes = 0;
  function walk(relative: string, depth: number): void {
    if (depth > 64 || tree.length >= MAX_MEMBERS) throw Error('INTAKE_TRASH_TREE_TOO_LARGE');
    const current = relative ? `${path}/${relative}` : path;
    const before = reader.stat(current);
    if (!before || before.dev !== rootDev) throw Error('INTAKE_TRASH_SOURCE_CHANGED');
    const common = { path: relative, dev: before.dev, ino: before.ino };
    identitySchema.parse({ dev: before.dev, ino: before.ino });
    if (before.kind === 'file') {
      if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_FILE_BYTES || bytes + before.size > MAX_BYTES) throw Error('INTAKE_TRASH_TREE_TOO_LARGE');
      const content = reader.read(current), after = reader.stat(current);
      if (!sameArchiveIdentity(after, before) || after?.kind !== 'file' || after.size !== before.size || content.length !== before.size) throw Error('INTAKE_TRASH_SOURCE_CHANGED');
      bytes += content.length;
      tree.push({ ...common, kind: 'file', bytes: content.length, sha256: sha256Bytes(content) });
      return;
    }
    if (before.kind !== 'directory') throw Error('INTAKE_TRASH_SOURCE_CHANGED');
    tree.push({ ...common, kind: 'directory' });
    const sorted = () => [...reader.list(current)].sort((a, b) => compare(a.name, b.name));
    const children = sorted(), names = new Set<string>();
    for (const child of children) {
      if (!intakeTrashNameSchema.safeParse(child.name).success || names.has(child.name)) throw Error('INTAKE_TRASH_SOURCE_CHANGED');
      names.add(child.name);
      const offset = tree.length;
      walk(relative ? `${relative}/${child.name}` : child.name, depth + 1);
      if (tree[offset]?.kind !== child.kind) throw Error('INTAKE_TRASH_SOURCE_CHANGED');
    }
    const after = reader.stat(current);
    if (!sameArchiveIdentity(after, before) || after?.kind !== 'directory' || JSON.stringify(children) !== JSON.stringify(sorted())) throw Error('INTAKE_TRASH_SOURCE_CHANGED');
  }
  walk('', 0);
  return tree.sort((a, b) => compare(a.path, b.path));
}

function validateManifest(value: unknown): Manifest {
  const data = manifestSchema.parse(value), paths = new Map<string, Member>();
  if (data.title !== data.name || data.tree[0]?.path !== '' || data.tree[0].kind !== data.kind) throw Error('MANIFEST_INVALID');
  let bytes = 0, files = 0, previous: string | undefined;
  for (const member of data.tree) {
    const parts = member.path ? member.path.split('/') : [];
    if (parts.length > 64 || parts.some((name) => !intakeTrashNameSchema.safeParse(name).success)
      || member.dev !== data.root.dev || (previous !== undefined && member.path <= previous)
      || (parts.length && paths.get(parts.slice(0, -1).join('/'))?.kind !== 'directory')) throw Error('MANIFEST_INVALID');
    if (member.kind === 'file') { bytes += member.bytes; files++; }
    previous = member.path; paths.set(member.path, member);
  }
  if (bytes !== data.bytes || files !== data.fileCount || bytes > MAX_BYTES) throw Error('MANIFEST_INVALID');
  return data;
}

function seal(payload: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify({ payload, sha256: sha256Bytes(Buffer.from(JSON.stringify(payload))) }));
  if (bytes.length > MAX_JOURNAL_BYTES) throw Error('INTAKE_TRASH_TREE_TOO_LARGE');
  return bytes;
}

function unseal(bytes: Buffer): unknown {
  if (bytes.length > MAX_JOURNAL_BYTES) throw Error('JOURNAL_INVALID');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const envelope = z.strictObject({ payload: z.unknown(), sha256: shaSchema }).parse(JSON.parse(text));
  if (JSON.stringify(envelope) !== text || sha256Bytes(Buffer.from(JSON.stringify(envelope.payload))) !== envelope.sha256) throw Error('JOURNAL_INVALID');
  return envelope.payload;
}

export function createIntakeTrashService(input: {
  port: PersonalIntakeTrashPort;
  getRuleFingerprint(): Promise<string>;
  assertIdle(name: string): void | Promise<void>;
  now?: () => Date;
}) {
  const port = input.port, now = input.now ?? (() => new Date());
  const previews = new Map<string, { manifest: Manifest; expiresAt: string }>();
  const deletePreviews = new Map<string, { id: string; tree: Member[]; expiresAt: string; ruleFingerprint: string; manifestSha256: string; deletionSha256: string | null }>();
  // A failed native postflight remains visible until an explicit verification.
  // Durable direction and terminal completion come from immutable journal files.
  const uncertain = new Set<string>();
  let closed = false, busy = false, activeId: string | undefined, running: Promise<unknown> | undefined, closing: Promise<void> | undefined;

  async function exclusive<T>(id: string | undefined, task: () => Promise<T>): Promise<T> {
    if (closed) fail('INTAKE_TRASH_CLOSED', '应用正在关闭，请重新打开后操作。');
    if (busy) fail('INTAKE_TRASH_BUSY', '正在处理待归档回收操作，请稍后再试。');
    busy = true; activeId = id;
    const work = task(); running = work;
    try { return await work; }
    finally { busy = false; activeId = undefined; if (running === work) running = undefined; }
  }

  function load(id: string): Record {
    if (!intakeTrashIdSchema.safeParse(id).success) fail('SCHEMA_INVALID', '回收编号格式不正确。', 400);
    const bytes = port.readRecovery(`${id}.intent.json`);
    if (!bytes) fail('INTAKE_TRASH_NOT_FOUND', '本次回收尚未提交，请重新查看预览。', 404);
    try {
      const manifest = validateManifest(unseal(bytes));
      if (manifest.id !== id) throw Error('JOURNAL_INVALID');
      return { manifest, bytes };
    } catch { fail('INTAKE_TRASH_JOURNAL_INVALID', '回收记录不完整或已变化，已保留现有文件，请核验记录。'); }
  }

  function entry(data: Manifest, status: IntakeTrashEntry['status'], problem?: string): IntakeTrashEntry {
    return intakeTrashEntrySchema.parse({
      id: data.id, name: data.name, title: data.title, kind: data.kind, bytes: data.bytes,
      fileCount: data.fileCount, createdAt: data.createdAt, status, ...(problem ? { problem } : {})
    });
  }

  function observe(record: Record): Observed {
    const data = record.manifest;
    let restoration: Restoration | null = null;
    const unknown = (): Observed => ({
      entry: entry(data, 'needs-review', '文件或回收记录暂时无法核验，所有现有版本均已保留。'),
      location: 'unknown', restoration, valid: false, collision: false, completed: false
    });
    try {
      if (!sameArchiveIdentity(port.rootIdentity, data.root)) return unknown();
      const deletion = loadDeletion(record);
      if (deletion) {
        // A deletion direction is permanent, even if no unlink completed. Reads
        // never resume it, and historical restoration receipts cannot override it.
        if (port.readRecovery(`${data.id}.restore.json`) || port.readRecovery(`${data.id}.restored.json`)) return unknown();
        const receiptBytes = port.readRecovery(`${data.id}.deleted.json`);
        if (receiptBytes) {
          const receipt = deletedSchema.parse(unseal(receiptBytes));
          const confirmed = readConfirmation(record, receipt.confirmationToken, deletion);
          if (!confirmed || receipt.id !== data.id || receipt.manifestSha256 !== sha256Bytes(record.bytes)
            || receipt.deletionSha256 !== sha256Bytes(deletion) || receipt.confirmationSha256 !== sha256Bytes(confirmed)
            || !sameArchiveIdentity(receipt.root, data.root)) return unknown();
          return { entry: { ...entry(data, 'deleted'), deletedAt: receipt.completedAt }, location: 'unknown', restoration: null, valid: true, collision: false, completed: true };
        }
        return { entry: entry(data, 'deleting', '彻底删除尚未完成；请重新预览剩余内容并单独确认。已开始删除，不能恢复。'), location: 'unknown', restoration: null, valid: false, collision: false, completed: false };
      }
      if (port.readRecovery(`${data.id}.deleted.json`)) return unknown();
      const restoreBytes = port.readRecovery(`${data.id}.restore.json`);
      if (restoreBytes) {
        restoration = restoreSchema.parse(unseal(restoreBytes));
        if (restoration.id !== data.id || restoration.manifestSha256 !== sha256Bytes(record.bytes)) return unknown();
      }
      const restoredBytes = port.readRecovery(`${data.id}.restored.json`);
      if (restoredBytes) {
        const completed = restoredSchema.parse(unseal(restoredBytes));
        if (!restoration || !restoreBytes || completed.id !== data.id
          || completed.manifestSha256 !== sha256Bytes(record.bytes) || completed.restorationSha256 !== sha256Bytes(restoreBytes)
          || !sameArchiveIdentity(completed.root, data.root) || !sameArchiveIdentity(completed.source, data.tree[0]!)) return unknown();
        // The user may edit, archive, or recycle this source again after restoration.
        // A verified completion record does not depend on its later location.
        return { entry: entry(data, 'restored'), location: 'source', restoration, valid: true, collision: false, completed: true };
      }
      const source = port.source.stat(data.name), item = port.items.stat(data.id);
      const original = data.tree[0]!;
      const sourceMatches = sameArchiveIdentity(source, original) && sameTree(capture(port.source, data.name, data.root.dev), data.tree);
      const itemMatches = sameArchiveIdentity(item, original) && sameTree(capture(port.items, data.id, data.root.dev), data.tree);
      if (sourceMatches && !item) return {
        entry: entry(data, restoration ? 'restoring' : 'moving', restoration ? '文件已回到原位置，尚待写入恢复完成记录。' : undefined),
        location: 'source', restoration, valid: true, collision: false, completed: false
      };
      if (itemMatches && !sourceMatches) return {
        entry: entry(data, restoration ? 'restoring' : 'trashed', restoration && source ? '原位置已有同名资料，请先核对后继续恢复。' : undefined),
        location: 'trash', restoration, valid: true, collision: !!source, completed: false
      };
      return unknown();
    } catch { return unknown(); }
  }

  function currentEntry(record: Record): IntakeTrashEntry {
    const seen = observe(record);
    return uncertain.has(record.manifest.id) && !['deleting', 'deleted'].includes(seen.entry.status)
      ? entry(record.manifest, 'needs-review', '上次操作尚未核验完成，请继续核验；已保留文件及恢复方向。')
      : seen.entry;
  }

  function get(id: string): IntakeTrashEntry {
    if (activeId === id) fail('INTAKE_TRASH_BUSY', '本次确认仍在处理中，请稍后查询同一编号的结果。');
    return currentEntry(load(id));
  }

  function records(): Record[] {
    const result: Record[] = [], ids = new Set<string>();
    for (const name of port.listRecovery()) {
      if (!name.endsWith('.intent.json')) continue;
      const id = name.slice(0, -'.intent.json'.length);
      if (!intakeTrashIdSchema.safeParse(id).success || ids.has(id)) continue;
      ids.add(id);
      try { result.push(load(id)); }
      catch (error) {
        // Do not fabricate a display name for an unreadable orphan journal.
        if (!(error instanceof PublicApiError) || !['INTAKE_TRASH_JOURNAL_INVALID', 'INTAKE_TRASH_NOT_FOUND'].includes(error.code)) throw error;
      }
    }
    return result;
  }

  function list(): { items: IntakeTrashEntry[] } {
    return { items: records().map(currentEntry).sort((a, b) => compare(b.createdAt, a.createdAt) || compare(b.id, a.id)) };
  }

  function assertNoPending(name: string, exceptId?: string): void {
    const source = port.source.stat(name);
    for (const record of records()) {
      if (record.manifest.id === exceptId) continue;
      const status = observe(record).entry.status;
      if (status === 'restored' || status === 'deleted') continue;
      const sameName = record.manifest.name === name;
      const sameSource = sameArchiveIdentity(source, record.manifest.tree[0]!);
      // A later delivery may reuse a filename while the old, different inode
      // remains safely in its own trash UUID. Only unfinished work reserves it.
      if (sameSource || (sameName && (!['trashed', 'deleting'].includes(status) || !source))) {
        fail('INTAKE_TRASH_ALREADY_PENDING', '这份待归档资料已有回收记录，请前往回收站查看或继续核验。');
      }
    }
  }

  async function preview(name: string): Promise<IntakeTrashPreview> {
    return exclusive(undefined, async () => {
      if (!intakeTrashNameSchema.safeParse(name).success) fail('PATH_NOT_ALLOWED', '请选择待归档目录中的一个顶层文件或资料包。', 400);
      await input.assertIdle(name); assertNoPending(name);
      const ruleFingerprint = ruleSchema.parse(await input.getRuleFingerprint());
      await input.assertIdle(name);
      let tree: Member[];
      try { tree = capture(port.source, name, port.rootIdentity.dev); }
      catch (error) {
        if (error instanceof Error && error.message === 'INTAKE_TRASH_TREE_TOO_LARGE') fail('INTAKE_TRASH_TREE_TOO_LARGE', '资料包超出可核验范围，请检查文件大小和数量。');
        fail('INTAKE_TRASH_SOURCE_CHANGED', '资料已变化或无法完整读取，请刷新待归档列表后重新预览。');
      }
      const createdAt = now().toISOString(), expiresAt = new Date(now().getTime() + PREVIEW_TTL).toISOString();
      const manifest = validateManifest({
        version: 1, id: randomUUID(), name, title: name, kind: tree[0]!.kind,
        bytes: tree.reduce((sum, member) => sum + (member.kind === 'file' ? member.bytes : 0), 0),
        fileCount: tree.filter((member) => member.kind === 'file').length,
        createdAt, root: { ...port.rootIdentity }, ruleFingerprint, tree
      });
      // Validate journal capacity before offering a confirmation, without writing.
      seal(manifest);
      for (const [id, value] of previews) if (Date.parse(value.expiresAt) <= now().getTime()) previews.delete(id);
      if (previews.size >= 100) previews.delete(previews.keys().next().value!);
      previews.set(manifest.id, { manifest, expiresAt });
      return intakeTrashPreviewSchema.parse({
        id: manifest.id, name, title: name, kind: manifest.kind, bytes: manifest.bytes, fileCount: manifest.fileCount, expiresAt
      });
    });
  }

  function persist(filename: string, bytes: Buffer): void {
    try {
      if (port.readRecovery(filename)) fail('INTAKE_TRASH_JOURNAL_INVALID', '已有确认记录，未覆盖任何记录。');
      port.writeRecovery(filename, bytes);
      const written = port.readRecovery(filename);
      if (!written?.equals(bytes)) throw Error('WRITE_FAILED');
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      fail('INTAKE_TRASH_JOURNAL_WRITE_FAILED', '确认记录未完整写入；请查询本次回收结果后继续核验，勿重复提交新的操作。');
    }
  }

  /** Only records an already verified restoration; never moves a pending tree. */
  function settleRestoration(record: Record, seen: Observed): IntakeTrashEntry {
    if (!seen.valid || !seen.restoration || seen.location !== 'source' || seen.completed) return seen.entry;
    const data = record.manifest;
    try {
      const restoreBytes = port.readRecovery(`${data.id}.restore.json`);
      if (!restoreBytes || JSON.stringify(restoreSchema.parse(unseal(restoreBytes))) !== JSON.stringify(seen.restoration)) throw Error('JOURNAL_CHANGED');
      const original = data.tree[0]!;
      const receipt = restoredSchema.parse({
        version: 1, id: data.id, manifestSha256: sha256Bytes(record.bytes), restorationSha256: sha256Bytes(restoreBytes),
        completedAt: now().toISOString(), root: data.root, source: { dev: original.dev, ino: original.ino }
      });
      persist(`${data.id}.restored.json`, seal(receipt));
      uncertain.delete(data.id);
      return currentEntry(load(data.id));
    } catch {
      uncertain.add(data.id);
      return currentEntry(record);
    }
  }

  /** Synchronous final verification through rename: no application await gap. */
  function perform(record: Record, direction: 'move' | 'restore'): IntakeTrashEntry {
    const data = record.manifest, seen = observe(record);
    if (!seen.valid) return seen.entry;
    if (direction === 'move' && (seen.restoration || seen.location !== 'source')) return seen.entry;
    if (direction === 'restore' && (!seen.restoration || seen.location !== 'trash')) return seen.entry;
    if (direction === 'restore' && seen.collision) fail('INTAKE_TRASH_RESTORE_CONFLICT', '原位置已有同名文件或资料包，未覆盖；回收站中的资料仍保留。');
    try {
      if (direction === 'move') port.move(data.name, data.id, data.tree[0]!);
      else port.restore(data.id, data.name, data.tree[0]!);
      const after = observe(record);
      if (!after.valid || after.location !== (direction === 'move' ? 'trash' : 'source')) throw Error('INTAKE_TRASH_NEEDS_REVIEW');
      uncertain.delete(data.id);
      return direction === 'restore' ? settleRestoration(record, after) : after.entry;
    } catch {
      uncertain.add(data.id);
      return currentEntry(record);
    }
  }

  async function commit(id: string): Promise<IntakeTrashEntry> {
    return exclusive(id, async () => {
      if (!intakeTrashIdSchema.safeParse(id).success) fail('SCHEMA_INVALID', '回收编号格式不正确。', 400);
      // Duplicate confirmation never performs an already registered operation again.
      if (port.readRecovery(`${id}.intent.json`)) return currentEntry(load(id));
      const pending = previews.get(id);
      if (!pending || Date.parse(pending.expiresAt) <= now().getTime()) fail('INTAKE_TRASH_PREVIEW_STALE', '回收预览已过期，请重新预览。');
      const data = pending.manifest;
      assertNoPending(data.name, id); await input.assertIdle(data.name);
      const rules = await input.getRuleFingerprint(); await input.assertIdle(data.name);
      if (rules !== data.ruleFingerprint || !sameArchiveIdentity(port.rootIdentity, data.root) || Date.parse(pending.expiresAt) <= now().getTime()) fail('INTAKE_TRASH_PREVIEW_STALE', '规则、目录或预览有效期已变化，请重新预览。');
      try { if (!sameTree(capture(port.source, data.name, data.root.dev), data.tree)) throw Error('CHANGED'); }
      catch { fail('INTAKE_TRASH_PREVIEW_STALE', '资料包或附件已变化，请重新预览。'); }
      assertNoPending(data.name, id);
      if (port.items.stat(id) || port.readRecovery(`${id}.restore.json`) || port.readRecovery(`${id}.restored.json`)
        || port.readRecovery(`${id}.delete.json`) || port.readRecovery(`${id}.deleted.json`)) fail('INTAKE_TRASH_JOURNAL_INVALID', '回收编号已有保留内容，未移动文件。');
      persist(`${id}.intent.json`, seal(data)); previews.delete(id);
      return perform(load(id), 'move');
    });
  }

  async function restore(id: string): Promise<IntakeTrashEntry> {
    return exclusive(id, async () => {
      const record = load(id), data = record.manifest;
      let seen = observe(record);
      if (!seen.valid || seen.restoration || seen.location !== 'trash') return settleRestoration(record, seen);
      await input.assertIdle(data.name);
      const ruleFingerprint = ruleSchema.parse(await input.getRuleFingerprint()); await input.assertIdle(data.name);
      seen = observe(record);
      if (!seen.valid || seen.restoration || seen.location !== 'trash') return settleRestoration(record, seen);
      if (seen.collision) fail('INTAKE_TRASH_RESTORE_CONFLICT', '原位置已有同名文件或资料包，未覆盖；回收站中的资料仍保留。');
      const restoration = restoreSchema.parse({ version: 1, id, manifestSha256: sha256Bytes(record.bytes), confirmedAt: now().toISOString(), ruleFingerprint });
      persist(`${id}.restore.json`, seal(restoration)); uncertain.delete(id);
      return perform(load(id), 'restore');
    });
  }

  async function retry(id: string): Promise<IntakeTrashEntry> {
    return exclusive(id, async () => {
      const record = load(id), data = record.manifest;
      uncertain.delete(id);
      const seen = observe(record);
      if (!seen.valid || seen.entry.status === 'trashed' || seen.entry.status === 'restored') return seen.entry;
      if (seen.restoration && seen.location === 'source') return settleRestoration(record, seen);
      await input.assertIdle(data.name);
      const rules = await input.getRuleFingerprint(); await input.assertIdle(data.name);
      if (rules !== (seen.restoration?.ruleFingerprint ?? data.ruleFingerprint)) fail('INTAKE_TRASH_RULES_CHANGED', '确认后的规则已变化，未继续移动，请先核对回收记录。');
      return perform(load(id), seen.restoration ? 'restore' : 'move');
    });
  }

  async function recover(): Promise<void> {
    return exclusive(undefined, async () => {
      uncertain.clear();
      // A receipt may be missing after response loss. Verify its complete source
      // tree before recording completion, without executing a pending direction.
      for (const record of records()) settleRestoration(record, observe(record));
    });
  }

  function loadDeletion(record: Record): Buffer | null {
    const bytes = port.readRecovery(`${record.manifest.id}.delete.json`);
    if (bytes) {
      const value = deletionSchema.parse(unseal(bytes));
      if (value.id !== record.manifest.id || value.manifestSha256 !== sha256Bytes(record.bytes)) throw Error('JOURNAL_INVALID');
    }
    return bytes;
  }

  function readConfirmation(record: Record, token: string, deletion: Buffer): Buffer | null {
    const bytes = port.readRecovery(`${token}.confirm.json`);
    if (bytes) {
      const value = confirmationSchema.parse(unseal(bytes));
      if (value.id !== record.manifest.id || value.token !== token || value.manifestSha256 !== sha256Bytes(record.bytes)
        || value.deletionSha256 !== sha256Bytes(deletion) || Date.parse(value.confirmedAt) >= Date.parse(value.expiresAt)) throw Error('JOURNAL_INVALID');
      const originals = new Map(record.manifest.tree.map(member => [member.path, member]));
      let previous: string | undefined;
      for (const member of value.tree) {
        if ((previous !== undefined && previous >= member.path) || JSON.stringify(member) !== JSON.stringify(originals.get(member.path))) throw Error('JOURNAL_INVALID');
        previous = member.path;
      }
    }
    return bytes;
  }

  function remaining(record: Record, deletion: Buffer | null): Member[] {
    const data = record.manifest;
    try {
      if (!sameArchiveIdentity(port.rootIdentity, data.root) || sameArchiveIdentity(port.source.stat(data.name), data.tree[0]!)) throw Error('SOURCE_CHANGED');
      const tree = port.items.stat(data.id) ? capture(port.items, data.id, data.root.dev) : [];
      const original = new Map(data.tree.map(member => [member.path, member]));
      if ((!deletion && !sameTree(tree, data.tree)) || tree.some(member => JSON.stringify(member) !== JSON.stringify(original.get(member.path)))) throw Error('SOURCE_CHANGED');
      return tree;
    } catch { fail('INTAKE_TRASH_DELETE_CONFLICT', '回收站中的资料包或附件已变化，现有版本已保留，请先核对。'); }
  }

  async function previewDelete(id: string): Promise<IntakeTrashDeletePreview> {
    return exclusive(id, async () => {
      const record = load(id), seen = observe(record);
      if (!['trashed', 'deleting'].includes(seen.entry.status)) fail('INTAKE_TRASH_DELETE_CONFLICT', '当前记录不能彻底删除，请先核对回收状态。');
      await input.assertIdle(record.manifest.name);
      const ruleFingerprint = ruleSchema.parse(await input.getRuleFingerprint()); await input.assertIdle(record.manifest.name);
      if (!load(id).bytes.equals(record.bytes) || !['trashed', 'deleting'].includes(observe(record).entry.status)) fail('INTAKE_TRASH_DELETE_CONFLICT', '确认记录或恢复方向已变化，请重新核对。');
      const deletion = loadDeletion(record), tree = remaining(record, deletion);
      const token = randomUUID(), expiresAt = new Date(now().getTime() + PREVIEW_TTL).toISOString();
      for (const [key, pending] of deletePreviews) if (Date.parse(pending.expiresAt) <= now().getTime()) deletePreviews.delete(key);
      if (deletePreviews.size >= 100) deletePreviews.delete(deletePreviews.keys().next().value!);
      deletePreviews.set(token, { id, tree, expiresAt, ruleFingerprint, manifestSha256: sha256Bytes(record.bytes), deletionSha256: deletion && sha256Bytes(deletion) });
      return intakeTrashDeletePreviewSchema.parse({
        id, token, name: record.manifest.name, title: record.manifest.title, kind: record.manifest.kind, expiresAt,
        bytes: tree.reduce((sum, member) => sum + (member.kind === 'file' ? member.bytes : 0), 0),
        fileCount: tree.filter(member => member.kind === 'file').length
      });
    });
  }

  async function permanentlyDelete(id: string, token: string): Promise<IntakeTrashEntry> {
    return exclusive(id, async () => {
      if (!intakeTrashIdSchema.safeParse(token).success) fail('SCHEMA_INVALID', '删除确认编号格式不正确。', 400);
      const record = load(id), seen = observe(record);
      if (seen.entry.status === 'deleted') return seen.entry;
      let deletion = loadDeletion(record);
      // A used token only queries the same confirmed outcome, including after
      // response loss or restart. It must never continue a partially unlinked tree.
      if (deletion && readConfirmation(record, token, deletion)) return currentEntry(record);
      const pending = deletePreviews.get(token);
      if (!pending || pending.id !== id || Date.parse(pending.expiresAt) <= now().getTime()) fail('INTAKE_TRASH_DELETE_PREVIEW_STALE', '删除预览已过期或不匹配，请重新预览并确认。');
      if (!['trashed', 'deleting'].includes(seen.entry.status)) fail('INTAKE_TRASH_DELETE_CONFLICT', '当前记录不能彻底删除。');
      await input.assertIdle(record.manifest.name);
      const rules = await input.getRuleFingerprint(); await input.assertIdle(record.manifest.name);
      if (!load(id).bytes.equals(record.bytes) || !['trashed', 'deleting'].includes(observe(record).entry.status)) fail('INTAKE_TRASH_DELETE_CONFLICT', '确认记录或恢复方向已变化，未开始删除。');
      deletion = loadDeletion(record);
      if (rules !== pending.ruleFingerprint || sha256Bytes(record.bytes) !== pending.manifestSha256
        || (deletion && sha256Bytes(deletion)) !== pending.deletionSha256 || Date.parse(pending.expiresAt) <= now().getTime()
        || !sameTree(remaining(record, deletion), pending.tree)) fail('INTAKE_TRASH_DELETE_PREVIEW_STALE', '资料、规则或预览有效期已变化，请重新预览并确认。');
      const nativeTree = pending.tree.map(member => {
        const identity = { path: member.path, dev: member.dev, ino: member.ino };
        if (member.kind === 'directory') return { ...identity, kind: 'directory' as const };
        const bytes = port.items.read(member.path ? `${id}/${member.path}` : id);
        if (bytes.length !== member.bytes || sha256Bytes(bytes) !== member.sha256) fail('INTAKE_TRASH_DELETE_CONFLICT', '资料内容已变化，现有版本已保留。');
        return { ...identity, kind: 'file' as const, bytes };
      }).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      if (!deletion) {
        deletion = seal(deletionSchema.parse({ version: 1, id, manifestSha256: sha256Bytes(record.bytes), startedAt: now().toISOString() }));
        persist(`${id}.delete.json`, deletion);
      }
      const confirmation = seal(confirmationSchema.parse({
        version: 1, id, token, manifestSha256: sha256Bytes(record.bytes), deletionSha256: sha256Bytes(deletion),
        confirmedAt: now().toISOString(), expiresAt: pending.expiresAt, ruleFingerprint: pending.ruleFingerprint, tree: pending.tree
      }));
      persist(`${token}.confirm.json`, confirmation); deletePreviews.delete(token);
      try {
        if (!load(id).bytes.equals(record.bytes) || !port.readRecovery(`${id}.delete.json`)?.equals(deletion)
          || !port.readRecovery(`${token}.confirm.json`)?.equals(confirmation)
          || port.readRecovery(`${id}.restore.json`) || port.readRecovery(`${id}.restored.json`)) throw Error('JOURNAL_CHANGED');
        if (nativeTree.length) port.purge(id, nativeTree);
        if (port.items.stat(id)) throw Error('INTAKE_TRASH_DELETE_NEEDS_REVIEW');
        persist(`${id}.deleted.json`, seal(deletedSchema.parse({
          version: 1, id, manifestSha256: sha256Bytes(record.bytes), deletionSha256: sha256Bytes(deletion),
          confirmationToken: token, confirmationSha256: sha256Bytes(confirmation), completedAt: now().toISOString(), root: record.manifest.root
        })));
      } catch { /* Preserve remaining entries and journals; explicit reconfirmation is required. */ }
      return currentEntry(load(id));
    });
  }

  async function close(): Promise<void> {
    if (!closing) {
      closed = true;
      closing = (async () => {
        try { await running; } catch { /* A failed request must not leak the borrowed native handle. */ }
        port.close();
      })();
    }
    return closing;
  }

  return { list, preview, commit, get, restore, retry, recover, close, previewDelete, delete: permanentlyDelete };
}

export type IntakeTrashService = Omit<ReturnType<typeof createIntakeTrashService>, 'previewDelete' | 'delete'>
  & Partial<Pick<ReturnType<typeof createIntakeTrashService>, 'previewDelete' | 'delete'>>;
