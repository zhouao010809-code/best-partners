import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createIntakeTrashService } from '../../src/server/trash/intake-trash-service.js';
import type { PersonalIntakeTrashPort } from '../../src/server/trash/intake-trash-native.js';
import type { ArchiveTreeReader } from '../../src/server/archive/archive-snapshot.js';
import { intakeTrashEntrySchema, intakeTrashNameRequestSchema, intakeTrashPreviewSchema } from '../../src/shared/api/intake-trash.js';

type Node = { kind: 'file' | 'directory'; dev: string; ino: string; bytes: Buffer };
const packet = '无元数据的资料包';

function fixture(name = packet, singleFile = false) {
  const source = new Map<string, Node>();
  const items = new Map<string, Node>();
  const journals = new Map<string, Buffer>();
  let inode = 10, moves = 0, restores = 0, closes = 0, purges = 0;
  let purgeFailure: 'before' | 'partial' | 'after' | undefined;
  let rules = 'a'.repeat(64), busy = false, time = Date.parse('2026-09-07T00:00:00.000Z');
  let moveFailure: 'before' | 'after' | undefined;
  let restoreFailure: 'before' | 'after' | undefined;
  let writeFailure: 'before' | 'partial' | 'after' | undefined;
  let receiptFailure = false;
  let paused: Promise<void> | undefined;
  function add(path: string, kind: Node['kind'], bytes = Buffer.alloc(0)) {
    source.set(path, { kind, dev: '1', ino: String(inode++), bytes });
  }
  if (singleFile) add(name, 'file', Buffer.from('未经归档，也没有 YAML\r\n\0', 'utf8'));
  else {
    add(name, 'directory');
    add(`${name}/原文.md`, 'file', Buffer.from('未经归档，也没有 YAML\r\n', 'utf8'));
    add(`${name}/attachments`, 'directory');
    add(`${name}/attachments/图.png`, 'file', Buffer.from([0, 255, 1, 2, 3]));
    add(`${name}/空目录`, 'directory');
  }
  add('别的资料.md', 'file', Buffer.from('不应移动'));
  function reader(tree: Map<string, Node>): ArchiveTreeReader {
    return {
      stat(path) { const node = tree.get(path); return node ? { kind: node.kind, dev: node.dev, ino: node.ino, size: node.bytes.length } : null; },
      read(path) { const node = tree.get(path); if (!node || node.kind !== 'file') throw Error('NOT_FOUND'); return Buffer.from(node.bytes); },
      list(path) { return [...tree].filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')).map(([key, node]) => ({ name: key.slice(path.length + 1), kind: node.kind })); }
    };
  }
  function moveTree(from: Map<string, Node>, to: Map<string, Node>, a: string, b: string, expected: { dev: string; ino: string }) {
    const node = from.get(a);
    if (!node || node.dev !== expected.dev || node.ino !== expected.ino) throw Error('SOURCE_CHANGED');
    if (to.has(b)) throw Error('TARGET_EXISTS');
    for (const [path, value] of [...from]) if (path === a || path.startsWith(`${a}/`)) { to.set(`${b}${path.slice(a.length)}`, value); from.delete(path); }
  }
  const port: PersonalIntakeTrashPort = {
    rootIdentity: { dev: '1', ino: '2' }, source: reader(source), items: reader(items),
    move(name, id, expected) {
      if (!journals.has(`${id}.intent.json`)) throw Error('MISSING_INTENT');
      if (moveFailure === 'before') throw Error('MOVE_INTERRUPTED');
      moveTree(source, items, name, id, expected); moves++;
      if (moveFailure === 'after') throw Error('INTAKE_TRASH_NEEDS_REVIEW');
    },
    restore(id, name, expected) {
      if (!journals.has(`${id}.restore.json`)) throw Error('MISSING_RESTORE_INTENT');
      if (restoreFailure === 'before') throw Error('RESTORE_INTERRUPTED');
      moveTree(items, source, id, name, expected); restores++;
      if (restoreFailure === 'after') throw Error('INTAKE_TRASH_NEEDS_REVIEW');
    },
    purge(id) {
      if (!journals.has(`${id}.delete.json`)) throw Error('MISSING_DELETE_INTENT');
      purges++;
      if (purgeFailure === 'before') throw Error('PURGE_INTERRUPTED');
      const paths = [...items.keys()].filter(path => path === id || path.startsWith(`${id}/`)).sort().reverse();
      for (const path of paths) { items.delete(path); if (purgeFailure === 'partial') throw Error('INTAKE_TRASH_DELETE_NEEDS_REVIEW'); }
      if (purgeFailure === 'after') throw Error('INTAKE_TRASH_DELETE_NEEDS_REVIEW');
    },
    writeRecovery(filename, bytes) {
      if (journals.has(filename)) throw Error('TARGET_EXISTS');
      if (receiptFailure && filename.endsWith('.restored.json')) throw Error('WRITE_FAILED');
      if (writeFailure === 'before') throw Error('WRITE_FAILED');
      journals.set(filename, Buffer.from(writeFailure === 'partial' ? bytes.subarray(0, 15) : bytes));
      if (writeFailure) throw Error('WRITE_FAILED');
    },
    readRecovery(filename) { const value = journals.get(filename); return value ? Buffer.from(value) : null; },
    listRecovery() { return [...journals.keys()]; },
    close() { closes++; }
  };
  const make = () => createIntakeTrashService({ port, getRuleFingerprint: async () => { if (paused) await paused; return rules; }, assertIdle: () => { if (busy) throw Object.assign(Error('任务进行中'), { code: 'RUN_ALREADY_ACTIVE' }); }, now: () => new Date(time) });
  return {
    service: make(), make, port, source, items, journals, add,
    counts: () => ({ moves, restores, closes }), purgeCount: () => purges, setPurgeFailure: (value: typeof purgeFailure) => { purgeFailure = value; }, setBusy: (value: boolean) => { busy = value; }, setRules: (value: string) => { rules = value; },
    expire: () => { time += 600_001; }, setMoveFailure: (value: typeof moveFailure) => { moveFailure = value; },
    setRestoreFailure: (value: typeof restoreFailure) => { restoreFailure = value; }, setWriteFailure: (value: typeof writeFailure) => { writeFailure = value; },
    setReceiptFailure: (value: boolean) => { receiptFailure = value; },
    pauseRules() { let release!: () => void; paused = new Promise<void>((resolve) => { release = resolve; }); return () => { paused = undefined; release(); }; }
  };
}

describe('intake packet recycle service', () => {
  it.each([false, true])('explicitly purges a complete packet or file (single=%s) and keeps terminal results idempotent', async single => {
    const f = fixture(packet, single), p = await f.service.preview(packet); await f.service.commit(p.id);
    const originals = new Map(f.journals); const d = await f.service.previewDelete(p.id);
    expect(d).toMatchObject({ id: p.id, bytes: p.bytes, fileCount: p.fileCount }); expect(f.journals).toEqual(originals);
    expect(await f.service.delete(p.id, d.token)).toMatchObject({ status: 'deleted', deletedAt: expect.any(String) });
    expect(f.items.size).toBe(0); expect(f.source.size).toBe(1); expect(f.purgeCount()).toBe(1);
    const reopened = f.make(); await reopened.recover();
    expect(await reopened.delete(p.id, d.token)).toMatchObject({ status: 'deleted' });
    expect(await reopened.restore(p.id)).toMatchObject({ status: 'deleted' }); expect(f.purgeCount()).toBe(1);
    expect(f.journals.get(`${p.id}.intent.json`)).toEqual(originals.get(`${p.id}.intent.json`));
  });

  it.each(['token', 'expired', 'changed', 'new-child', 'identity', 'rules', 'wrong-id'])('rejects permanent deletion after %s without deleting any entry', async change => {
    const f = fixture(), p = await f.service.preview(packet); await f.service.commit(p.id); const d = await f.service.previewDelete(p.id);
    if (change === 'expired') f.expire();
    if (change === 'changed') f.items.get(`${p.id}/原文.md`)!.bytes = Buffer.from('changed');
    if (change === 'new-child') f.items.set(`${p.id}/new`, { kind: 'file', bytes: Buffer.from('new'), dev: '1', ino: '888' });
    if (change === 'identity') f.items.get(p.id)!.ino = '999';
    if (change === 'rules') f.setRules('b'.repeat(64));
    await expect(f.service.delete(change === 'wrong-id' ? randomUUID() : p.id, change === 'token' ? randomUUID() : d.token)).rejects.toBeDefined();
    expect(f.purgeCount()).toBe(0); expect(f.journals.size).toBe(1);
  });

  it.each(['before', 'partial', 'after'] as const)('requires a new preview and confirmation after %s interruption, including after restart', async failure => {
    const f = fixture(), p = await f.service.preview(packet); await f.service.commit(p.id); const d = await f.service.previewDelete(p.id);
    f.setPurgeFailure(failure); expect(await f.service.delete(p.id, d.token)).toMatchObject({ status: 'deleting' });
    const remaining = new Map(f.items), reopened = f.make(); f.setPurgeFailure(undefined); await reopened.recover();
    expect(reopened.get(p.id).status).toBe('deleting'); expect(await reopened.retry(p.id)).toMatchObject({ status: 'deleting' });
    expect(await reopened.restore(p.id)).toMatchObject({ status: 'deleting' });
    expect(await reopened.delete(p.id, d.token)).toMatchObject({ status: 'deleting' });
    expect(f.items).toEqual(remaining); expect(f.purgeCount()).toBe(1);
    const d2 = await reopened.previewDelete(p.id); expect(d2.token).not.toBe(d.token);
    expect(await reopened.delete(p.id, d2.token)).toMatchObject({ status: 'deleted' }); expect(f.items.size).toBe(0);
  });

  it('preserves changed remaining versions and blocks a fresh confirmation after partial deletion', async () => {
    const f = fixture(), p = await f.service.preview(packet); await f.service.commit(p.id); const d = await f.service.previewDelete(p.id);
    f.setPurgeFailure('partial'); await f.service.delete(p.id, d.token);
    f.items.get(`${p.id}/原文.md`)!.bytes = Buffer.from('external version');
    await expect(f.make().previewDelete(p.id)).rejects.toMatchObject({ code: 'INTAKE_TRASH_DELETE_CONFLICT' });
    expect(f.purgeCount()).toBe(1); expect(f.items.get(`${p.id}/原文.md`)!.bytes.toString()).toBe('external version');
  });

  it.each(['intent', 'restore'] as const)('rechecks the %s journal after awaiting rules and before writing deletion confirmation', async kind => {
    const f = fixture(), p = await f.service.preview(packet); await f.service.commit(p.id); const d = await f.service.previewDelete(p.id);
    const release = f.pauseRules(), work = f.service.delete(p.id, d.token);
    await Promise.resolve(); await Promise.resolve(); f.journals.set(`${p.id}.${kind}.json`, Buffer.from('{}')); release();
    await expect(work).rejects.toBeDefined(); expect(f.purgeCount()).toBe(0); expect(f.items.size).toBe(5);
    expect(f.journals.has(`${p.id}.delete.json`)).toBe(false);
  });

  it.each(['delete', 'confirm', 'deleted'] as const)('preserves a damaged %s journal and never fabricates a deleted result or resumes removal', async kind => {
    const f = fixture(), p = await f.service.preview(packet); await f.service.commit(p.id); const d = await f.service.previewDelete(p.id);
    await f.service.delete(p.id, d.token);
    const filename = `${kind === 'confirm' ? d.token : p.id}.${kind}.json`; f.journals.set(filename, Buffer.from('{}'));
    const restarted = f.make(); await restarted.recover();
    expect(restarted.get(p.id).status).toBe('needs-review'); expect((await restarted.retry(p.id)).status).toBe('needs-review');
    await expect(restarted.previewDelete(p.id)).rejects.toMatchObject({ code: 'INTAKE_TRASH_DELETE_CONFLICT' });
    expect(f.journals.get(filename)?.toString()).toBe('{}'); expect(f.purgeCount()).toBe(1);
  });

  it('previews an unarchived packet without writing and roundtrips only its complete tree and inodes', async () => {
    const f = fixture(); const originals = new Map(f.source);
    const preview = await f.service.preview(packet);
    expect(intakeTrashPreviewSchema.parse(preview)).toEqual(preview);
    const bytes = [...originals].filter(([path]) => path.startsWith(`${packet}/`)).reduce((sum, [, node]) => sum + node.bytes.length, 0);
    expect(preview).toMatchObject({ name: packet, title: packet, kind: 'directory', fileCount: 2, bytes });
    expect(f.journals.size).toBe(0); expect(f.items.size).toBe(0); expect(f.service.list().items).toEqual([]);
    const entry = await f.service.commit(preview.id);
    expect(intakeTrashEntrySchema.parse(entry)).toEqual(entry); expect(entry.status).toBe('trashed');
    expect(f.source.size).toBe(1); expect(f.items.size).toBe(5);
    expect(f.items.get(`${preview.id}/attachments/图.png`)).toBe(originals.get(`${packet}/attachments/图.png`));
    expect(await f.service.commit(preview.id)).toEqual(entry); expect(f.counts().moves).toBe(1);
    const reopened = f.make(); await reopened.recover();
    expect(await reopened.restore(preview.id)).toMatchObject({ status: 'restored' });
    expect(f.source).toEqual(originals); expect(f.items.size).toBe(0);
    expect(await reopened.restore(preview.id)).toMatchObject({ status: 'restored' }); expect(f.counts().restores).toBe(1);
    expect(JSON.stringify(reopened.list())).not.toMatch(/sha256|bytesBase64|ruleFingerprint|attachments/u);
  });

  it('accepts a top-level file and includes binary bytes without interpreting metadata', async () => {
    const f = fixture('没有归档信息.bin', true); const bytes = Buffer.from(f.source.get('没有归档信息.bin')!.bytes);
    const preview = await f.service.preview('没有归档信息.bin');
    expect(preview).toMatchObject({ kind: 'file', fileCount: 1, bytes: bytes.length });
    await f.service.commit(preview.id); await f.service.restore(preview.id);
    expect(f.source.get('没有归档信息.bin')!.bytes).toEqual(bytes);
  });

  it.each(['../别的资料.md', '01图书馆/小兆clipper/a', '.', '..', 'a/b', 'a\\b', '', 'a\0b', '字'.repeat(86)])('rejects a non-top-level name: %s', async (name) => {
    const f = fixture(); expect(intakeTrashNameRequestSchema.safeParse({ name }).success).toBe(false);
    await expect(f.service.preview(name)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' }); expect(f.journals.size).toBe(0);
  });

  it.each(['bytes', 'attachment', 'rules', 'identity', 'expired', 'root'])('rejects a stale preview after %s changed', async (change) => {
    const f = fixture(); const preview = await f.service.preview(packet);
    if (change === 'bytes') f.source.get(`${packet}/原文.md`)!.bytes = Buffer.from('变更');
    if (change === 'attachment') f.add(`${packet}/attachments/新文件`, 'file', Buffer.from('新附件'));
    if (change === 'rules') f.setRules('b'.repeat(64));
    if (change === 'identity') f.source.get(packet)!.ino = '999';
    if (change === 'expired') f.expire();
    if (change === 'root') f.port.rootIdentity.ino = '999';
    await expect(f.service.commit(preview.id)).rejects.toMatchObject({ code: 'INTAKE_TRASH_PREVIEW_STALE' });
    expect(f.counts().moves).toBe(0); expect(f.journals.size).toBe(0);
  });

  it('blocks duplicate previews from confirming the same packet twice', async () => {
    const f = fixture(); const a = await f.service.preview(packet); const b = await f.service.preview(packet);
    await f.service.commit(a.id);
    await expect(f.service.commit(b.id)).rejects.toMatchObject({ code: 'INTAKE_TRASH_ALREADY_PENDING' });
    expect(f.counts().moves).toBe(1); expect(f.journals.size).toBe(1);
  });

  it('does not overwrite a recreated source name or record an unperformable restore', async () => {
    const f = fixture(); const preview = await f.service.preview(packet); await f.service.commit(preview.id);
    f.add(packet, 'file', Buffer.from('新资料')); const replacement = f.source.get(packet);
    await expect(f.service.restore(preview.id)).rejects.toMatchObject({ code: 'INTAKE_TRASH_RESTORE_CONFLICT' });
    expect(f.source.get(packet)).toBe(replacement); expect(f.items.size).toBe(5); expect(f.journals.size).toBe(1);
    expect(f.service.get(preview.id).status).toBe('trashed');
  });

  it('recycles a new same-name packet into its own UUID and never overwrites either restored version', async () => {
    const f = fixture(); const first = await f.service.preview(packet); await f.service.commit(first.id);
    const original = f.items.get(`${first.id}/原文.md`)!;
    f.add(packet, 'directory'); f.add(`${packet}/第二篇.md`, 'file', Buffer.from('后来收到的另一个资料包'));
    const replacement = f.source.get(`${packet}/第二篇.md`)!;
    const second = await f.service.preview(packet); expect(second.id).not.toBe(first.id);
    expect(await f.service.commit(second.id)).toMatchObject({ status: 'trashed' });
    expect(f.items.get(`${first.id}/原文.md`)).toBe(original); expect(f.items.get(`${second.id}/第二篇.md`)).toBe(replacement);
    const reopened = f.make(); await reopened.recover(); expect(reopened.list().items.map((item) => item.status)).toEqual(['trashed', 'trashed']);
    expect(await reopened.restore(first.id)).toMatchObject({ status: 'restored' });
    await expect(reopened.restore(second.id)).rejects.toMatchObject({ code: 'INTAKE_TRASH_RESTORE_CONFLICT' });
    expect(f.source.get(`${packet}/原文.md`)).toBe(original); expect(f.items.get(`${second.id}/第二篇.md`)).toBe(replacement);
  });

  it('never moves an interrupted pre-move intent automatically and retry continues that intent', async () => {
    const f = fixture(); const preview = await f.service.preview(packet); f.setMoveFailure('before');
    await f.service.commit(preview.id); const reopened = f.make(); await reopened.recover();
    expect(reopened.get(preview.id).status).toBe('moving'); expect(f.counts().moves).toBe(0);
    f.setMoveFailure(undefined); expect(await reopened.commit(preview.id)).toMatchObject({ status: 'moving' });
    expect(f.counts().moves).toBe(0); expect(await reopened.retry(preview.id)).toMatchObject({ status: 'trashed' });
    expect(f.counts().moves).toBe(1);
  });

  it.each(['move', 'restore'] as const)('settles a %s whose response was lost without performing it twice', async (direction) => {
    const f = fixture(); const preview = await f.service.preview(packet);
    if (direction === 'move') f.setMoveFailure('after');
    const moved = await f.service.commit(preview.id);
    if (direction === 'move') expect(moved.status).toBe('needs-review');
    else { f.setRestoreFailure('after'); expect(await f.service.restore(preview.id)).toMatchObject({ status: 'needs-review' }); }
    const reopened = f.make(); await reopened.recover();
    expect(reopened.get(preview.id).status).toBe(direction === 'move' ? 'trashed' : 'restored');
    await reopened.retry(preview.id); expect(f.counts().moves).toBe(1); expect(f.counts().restores).toBe(direction === 'move' ? 0 : 1);
  });

  it('persists restore direction before movement and retries restore after restart', async () => {
    const f = fixture(); const preview = await f.service.preview(packet); await f.service.commit(preview.id); f.setRestoreFailure('before');
    await f.service.restore(preview.id); const reopened = f.make(); await reopened.recover();
    expect(reopened.get(preview.id).status).toBe('restoring'); expect(f.counts().restores).toBe(0);
    f.setRestoreFailure(undefined); expect(await reopened.retry(preview.id)).toMatchObject({ status: 'restored' });
    expect(f.counts()).toMatchObject({ moves: 1, restores: 1 }); expect(f.journals.size).toBe(3);
  });

  it('refuses retry when the saved direction would collide with a new source', async () => {
    const f = fixture(); const preview = await f.service.preview(packet); await f.service.commit(preview.id); f.setRestoreFailure('before');
    await f.service.restore(preview.id); f.setRestoreFailure(undefined); f.add(packet, 'file', Buffer.from('替代物'));
    const reopened = f.make(); await reopened.recover();
    await expect(reopened.retry(preview.id)).rejects.toMatchObject({ code: 'INTAKE_TRASH_RESTORE_CONFLICT' });
    expect(f.counts().restores).toBe(0); expect(f.source.get(packet)!.bytes.toString()).toBe('替代物');
  });

  it.each(['move', 'restore'] as const)('refuses retry of pending %s when the confirmed rules changed', async (direction) => {
    const f = fixture(); const preview = await f.service.preview(packet);
    if (direction === 'move') f.setMoveFailure('before');
    await f.service.commit(preview.id);
    if (direction === 'restore') { f.setRestoreFailure('before'); await f.service.restore(preview.id); }
    f.setRules('b'.repeat(64)); const reopened = f.make(); await reopened.recover();
    await expect(reopened.retry(preview.id)).rejects.toMatchObject({ code: 'INTAKE_TRASH_RULES_CHANGED' });
    expect(f.counts().moves).toBe(direction === 'move' ? 0 : 1); expect(f.counts().restores).toBe(0);
  });

  it('keeps modified recycled attachments and refuses to restore them', async () => {
    const f = fixture(); const preview = await f.service.preview(packet); await f.service.commit(preview.id);
    f.items.get(`${preview.id}/attachments/图.png`)!.bytes = Buffer.from('外部写入');
    expect(await f.service.restore(preview.id)).toMatchObject({ status: 'needs-review' });
    expect(await f.service.retry(preview.id)).toMatchObject({ status: 'needs-review' });
    expect(f.counts().restores).toBe(0); expect(f.items.size).toBe(5);
  });

  it.each(['before', 'partial', 'after'] as const)('does not move when writing intent fails %s writing bytes', async (failure) => {
    const f = fixture(); const preview = await f.service.preview(packet); f.setWriteFailure(failure);
    await f.service.commit(preview.id).catch(() => undefined); expect(f.counts().moves).toBe(0);
    f.setWriteFailure(undefined); const reopened = f.make(); await reopened.recover(); expect(f.counts().moves).toBe(0);
    if (failure === 'after') { expect(reopened.get(preview.id).status).toBe('moving'); await reopened.retry(preview.id); expect(f.counts().moves).toBe(1); }
    if (failure === 'partial') { const bytes = Buffer.from(f.journals.get(`${preview.id}.intent.json`)!); await expect(reopened.retry(preview.id)).rejects.toMatchObject({ code: 'INTAKE_TRASH_JOURNAL_INVALID' }); expect(f.journals.get(`${preview.id}.intent.json`)).toEqual(bytes); }
  });

  it('preserves malformed orphan logs without disabling a valid entry', async () => {
    const f = fixture(); const preview = await f.service.preview(packet); await f.service.commit(preview.id);
    const bad = randomUUID(); f.journals.set(`${bad}.intent.json`, Buffer.from('{')); f.journals.set(`${randomUUID()}.restore.json`, Buffer.from('{}'));
    const reopened = f.make(); await reopened.recover(); expect(reopened.list().items).toHaveLength(1);
    await expect(reopened.retry(bad)).rejects.toMatchObject({ code: 'INTAKE_TRASH_JOURNAL_INVALID' });
    expect(await reopened.restore(preview.id)).toMatchObject({ status: 'restored' }); expect(f.journals.get(`${bad}.intent.json`)!.toString()).toBe('{');
  });

  it.each(['root', 'restore'])('blocks recovery after %s journal binding no longer matches', async (failure) => {
    const f = fixture(); const preview = await f.service.preview(packet); await f.service.commit(preview.id);
    if (failure === 'root') f.port.rootIdentity.ino = '999';
    else f.journals.set(`${preview.id}.restore.json`, Buffer.from('{}'));
    const reopened = f.make(); await reopened.recover(); expect(reopened.get(preview.id).status).toBe('needs-review');
    expect(await reopened.retry(preview.id)).toMatchObject({ status: 'needs-review' }); expect(f.counts().restores).toBe(0);
  });

  it('uses the idle guard on preview, confirm and restore', async () => {
    const f = fixture(); f.setBusy(true); await expect(f.service.preview(packet)).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' });
    f.setBusy(false); const preview = await f.service.preview(packet); f.setBusy(true);
    await expect(f.service.commit(preview.id)).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' }); expect(f.journals.size).toBe(0);
    f.setBusy(false); await f.service.commit(preview.id); f.setBusy(true);
    await expect(f.service.restore(preview.id)).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' }); expect(f.counts().restores).toBe(0);
  });

  it('reports an in-flight confirmation as busy and drains it before closing', async () => {
    const f = fixture(); const preview = await f.service.preview(packet); const release = f.pauseRules(); const pending = f.service.commit(preview.id);
    expect(() => f.service.get(preview.id)).toThrow(expect.objectContaining({ code: 'INTAKE_TRASH_BUSY' }));
    await expect(f.service.preview('别的资料.md')).rejects.toMatchObject({ code: 'INTAKE_TRASH_BUSY' });
    const closing = f.service.close(); expect(f.counts().closes).toBe(0); release(); await pending; await closing;
    await f.service.close(); expect(f.counts().closes).toBe(1);
  });

  it.each(['edited', 'archived', 'recycled'] as const)('retains completed restored history after its source was %s', async (change) => {
    const f = fixture(); const preview = await f.service.preview(packet); await f.service.commit(preview.id); await f.service.restore(preview.id);
    const receipt = f.journals.get(`${preview.id}.restored.json`); expect(receipt).toBeDefined();
    if (change === 'edited') f.source.get(`${packet}/原文.md`)!.bytes = Buffer.from('恢复后的新编辑');
    if (change === 'archived') for (const key of f.source.keys()) if (key === packet || key.startsWith(`${packet}/`)) f.source.delete(key);
    if (change === 'recycled') { const next = await f.service.preview(packet); await f.service.commit(next.id); }
    const reopened = f.make(); await reopened.recover(); expect(reopened.get(preview.id).status).toBe('restored');
    expect(await reopened.retry(preview.id)).toMatchObject({ status: 'restored' });
    expect(f.journals.get(`${preview.id}.restored.json`)).toEqual(receipt);
    expect(f.counts().restores).toBe(1);
  });

  it('keeps restoration pending until its verified completion receipt is durable', async () => {
    const f = fixture(); const preview = await f.service.preview(packet); await f.service.commit(preview.id); f.setReceiptFailure(true);
    expect(await f.service.restore(preview.id)).toMatchObject({ status: 'needs-review' }); expect(f.counts().restores).toBe(1);
    const reopened = f.make(); expect(reopened.get(preview.id).status).toBe('restoring');
    await reopened.recover(); expect(reopened.get(preview.id).status).toBe('needs-review'); expect(f.journals.has(`${preview.id}.restored.json`)).toBe(false);
    f.setReceiptFailure(false); expect(await reopened.retry(preview.id)).toMatchObject({ status: 'restored' });
    expect(f.counts().restores).toBe(1); expect(f.journals.has(`${preview.id}.restored.json`)).toBe(true);
  });

  it('reconstructs a missing restored receipt only after verifying the entire source tree', async () => {
    const f = fixture(); const preview = await f.service.preview(packet); await f.service.commit(preview.id); f.setRestoreFailure('after'); await f.service.restore(preview.id);
    expect(f.journals.has(`${preview.id}.restored.json`)).toBe(false);
    f.source.get(`${packet}/attachments/图.png`)!.bytes = Buffer.from('恢复后、核验前已变化');
    const reopened = f.make(); await reopened.recover(); expect(reopened.get(preview.id).status).toBe('needs-review');
    expect(f.journals.has(`${preview.id}.restored.json`)).toBe(false); expect(f.counts().restores).toBe(1);
  });

  it('never trusts a damaged completion receipt or repairs it by overwriting', async () => {
    const f = fixture(); const preview = await f.service.preview(packet); await f.service.commit(preview.id); await f.service.restore(preview.id);
    f.journals.set(`${preview.id}.restored.json`, Buffer.from('{}'));
    const reopened = f.make(); await reopened.recover(); expect(reopened.get(preview.id).status).toBe('needs-review');
    expect(await reopened.retry(preview.id)).toMatchObject({ status: 'needs-review' });
    expect(f.journals.get(`${preview.id}.restored.json`)!.toString()).toBe('{}'); expect(f.counts().restores).toBe(1);
  });
});
