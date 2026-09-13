import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { openPersonalArchive, type ArchiveIdentity, type ArchiveStat, type PersonalArchivePort } from '../../src/server/archive/sandbox-native.js';

const addon = resolve('dist/native/personal-archive.node');
const id = '24a60c8b-307a-4e80-8a70-5b6670c1d852';
const secondId = '7bb1e982-71b1-4c31-9209-fbb72d703ed3';
const intent = `${id}.intent.json`;
const source = '01图书馆/来自个人/旧资料/原文.md';
const marker = 'personal-trash-contract-v1\n';
const fixtures: string[] = [];
const handles: { close(): void }[] = [];
type Trash = {
  readonly rootIdentity: ArchiveIdentity;
  stat(path: string): ArchiveStat | null;
  read(path: string): Buffer | null;
  statItem(id: string): ArchiveStat | null;
  readItem(id: string): Buffer | null;
  move(path: string, id: string, expected: ArchiveIdentity): void;
  restore(id: string, path: string, expected: ArchiveIdentity): void;
  purge(id: string, expected: ArchiveIdentity, expectedBytes: Buffer): void;
  writeRecovery(name: string, bytes: Buffer): void;
  readRecovery(name: string): Buffer | null;
  listRecovery(): readonly string[];
  close(): void;
};
function fixture() {
  const base = mkdtempSync('/private/tmp/xiaozhao-personal-trash-test-');
  fixtures.push(base); chmodSync(base, 0o700);
  writeFileSync(join(base, '.test-marker'), marker, { mode: 0o600, flag: 'wx' });
  const root = join(base, 'vault'), recovery = join(base, 'intake'), trashRecovery = join(base, 'trash');
  for (const directory of [root, recovery, trashRecovery]) mkdirSync(directory, { mode: 0o700 });
  for (const directory of ['00大脑规则', '01图书馆/小兆clipper', '02知识库', '03大讲堂', '01图书馆/来自个人/旧资料']) mkdirSync(join(root, directory), { recursive: true });
  const archive = openPersonalArchive(root, recovery, addon); handles.push(archive);
  return { base, root, recovery, trashRecovery, archive };
}
function open(archive: PersonalArchivePort, recovery: string): Trash {
  const candidate = archive as PersonalArchivePort & { openTrash?: (path: string) => Trash };
  expect(candidate.openTrash, 'independent native trash port must be available').toBeTypeOf('function');
  const port = candidate.openTrash!(recovery); handles.push(port); return port;
}
function code(action: () => unknown, expected: string) {
  expect(action).toThrow(expect.objectContaining({ code: expected }));
}
function seed(f: ReturnType<typeof fixture>, bytes = Buffer.from('\ufeff原始正文\r\n\u0000尾部')) {
  writeFileSync(join(f.root, source), bytes, { mode: 0o644 });
  return bytes;
}
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/build-sandbox-archive.ts', '--personal']);
});
afterAll(() => {
  for (const handle of handles.reverse()) handle.close();
  for (const base of fixtures.reverse()) {
    if (dirname(base) !== '/private/tmp' || !basename(base).startsWith('xiaozhao-personal-trash-test-')
      || realpathSync(base) !== base || !lstatSync(base).isDirectory()
      || readFileSync(join(base, '.test-marker'), 'utf8') !== marker) throw new Error('REFUSE_UNVERIFIED_TRASH_TEST_CLEANUP');
    rmSync(base, { recursive: true });
  }
});

describe('personal trash native contract in isolated temporary vaults', () => {
  it('moves, restores and purges one nested knowledge markdown while preserving its siblings', () => {
    const f = fixture(), port = open(f.archive, f.trashRecovery), path = '02知识库/主题/知识.md';
    mkdirSync(join(f.root, '02知识库/主题'));
    const bytes = Buffer.from('知识正文\r\n'); writeFileSync(join(f.root, path), bytes);
    writeFileSync(join(f.root, '02知识库/主题/附件.png'), 'keep');
    const identity = port.stat(path)!; port.move(path, id, identity);
    expect(port.readItem(id)).toEqual(bytes); port.restore(id, path, identity);
    expect(port.stat(path)).toEqual(identity); port.move(path, secondId, identity); port.purge(secondId, identity, bytes);
    expect(port.statItem(secondId)).toBeNull(); expect(readFileSync(join(f.root, '02知识库/主题/附件.png'), 'utf8')).toBe('keep');
  });
  it('exposes explicit permanent deletion of one verified trash item', () => {
    const f = fixture(), port = open(f.archive, f.trashRecovery);
    expect(port.purge, 'explicit native trash purge port must be available').toBeTypeOf('function');
  });

  it('purges only the selected item while retaining journals, other slots, original paths, knowledge and attachments', () => {
    const f = fixture(), port = open(f.archive, f.trashRecovery), bytes = seed(f), identity = port.stat(source)!;
    port.move(source, id, identity);
    seed(f, Buffer.from('second trash item')); const secondIdentity = port.stat(source)!; port.move(source, secondId, secondIdentity);
    const current = seed(f, Buffer.from('new original at original path'));
    writeFileSync(join(f.root, '02知识库/知识.md'), 'knowledge');
    const attachment = join(dirname(join(f.root, source)), 'attachment.png'); writeFileSync(attachment, 'attachment');
    port.writeRecovery(intent, Buffer.from('{"move":true}'));
    port.writeRecovery(`${id}.delete.json`, Buffer.from('{"delete":true}'));
    port.purge(id, identity, bytes);
    expect(port.statItem(id)).toBeNull(); expect(port.readItem(id)).toBeNull();
    expect(port.statItem(secondId)).toEqual(secondIdentity); expect(port.readItem(secondId)).toEqual(Buffer.from('second trash item'));
    expect(port.read(source)).toEqual(current);
    expect(readFileSync(join(f.root, '02知识库/知识.md'), 'utf8')).toBe('knowledge');
    expect(readFileSync(attachment, 'utf8')).toBe('attachment');
    expect(port.readRecovery(intent)).toEqual(Buffer.from('{"move":true}'));
    expect(port.readRecovery(`${id}.delete.json`)).toEqual(Buffer.from('{"delete":true}'));
    expect([...port.listRecovery()].sort()).toEqual([`${id}.delete.json`, intent].sort());
    port.close(); const reopened = open(f.archive, f.trashRecovery);
    expect(reopened.statItem(id)).toBeNull(); expect(reopened.readRecovery(`${id}.delete.json`)).toEqual(Buffer.from('{"delete":true}'));
    code(() => reopened.purge(id, identity, bytes), 'NOT_FOUND');
  });

  it('rejects stale purge identities, bytes and invalid arguments without changing the item', () => {
    const f = fixture(), port = open(f.archive, f.trashRecovery), bytes = seed(f), identity = port.stat(source)!;
    port.move(source, id, identity);
    code(() => port.purge(id, { ...identity, ino: '0' }, bytes), 'SOURCE_IDENTITY_CHANGED');
    code(() => port.purge(id, { ...identity, dev: '0' }, bytes), 'SOURCE_IDENTITY_CHANGED');
    code(() => port.purge(id, identity, Buffer.alloc(bytes.length)), 'VERSION_CONFLICT');
    code(() => port.purge(id, identity, Buffer.from('short')), 'VERSION_CONFLICT');
    code(() => port.purge(id, identity, Buffer.alloc(10 * 1024 * 1024 + 1)), 'FILE_TOO_LARGE');
    code(() => port.purge(id, identity, 'not a buffer' as unknown as Buffer), 'INVALID_ARGUMENT');
    for (const invalid of ['../escape', `${id}.md`, `${id}.delete.json`, '24a60c8b-307a-1e80-8a70-5b6670c1d852', id.toUpperCase(), source]) {
      code(() => port.purge(invalid, identity, bytes), 'PATH_NOT_ALLOWED');
    }
    expect(port.statItem(id)).toEqual(identity); expect(port.readItem(id)).toEqual(bytes);
  });

  it.each(['symlink', 'hardlink', 'directory', 'unsafe-mode'] as const)('rejects purge of a %s without deleting any version', (kind) => {
    const f = fixture(), port = open(f.archive, f.trashRecovery), bytes = seed(f), identity = port.stat(source)!;
    port.move(source, id, identity);
    const item = join(f.trashRecovery, `${id}.md`), held = join(f.base, 'held.md');
    if (kind === 'symlink') { renameSync(item, held); symlinkSync(held, item); }
    if (kind === 'hardlink') linkSync(item, held);
    if (kind === 'directory') { renameSync(item, held); mkdirSync(item); writeFileSync(join(item, 'keep.md'), 'child'); }
    if (kind === 'unsafe-mode') chmodSync(item, 0o666);
    code(() => port.purge(id, identity, bytes), 'PATH_NOT_ALLOWED');
    expect(existsSync(item)).toBe(true);
    if (kind === 'directory') expect(readFileSync(join(item, 'keep.md'), 'utf8')).toBe('child');
    else expect(readFileSync(item)).toEqual(bytes);
    if (kind !== 'unsafe-mode') expect(readFileSync(held)).toEqual(bytes);
  });

  it('requires live root and private recovery identities and rejects purge after close', () => {
    const f = fixture(), port = open(f.archive, f.trashRecovery), bytes = seed(f), identity = port.stat(source)!;
    port.move(source, id, identity);
    chmodSync(f.trashRecovery, 0o755); code(() => port.purge(id, identity, bytes), 'RECOVERY_IDENTITY_CHANGED'); chmodSync(f.trashRecovery, 0o700);
    renameSync(f.trashRecovery, `${f.trashRecovery}-held`); mkdirSync(f.trashRecovery, { mode: 0o700 });
    code(() => port.purge(id, identity, bytes), 'RECOVERY_IDENTITY_CHANGED');
    expect(readFileSync(join(`${f.trashRecovery}-held`, `${id}.md`))).toEqual(bytes);
    renameSync(f.root, `${f.root}-held`); mkdirSync(f.root);
    code(() => port.purge(id, identity, bytes), 'ROOT_IDENTITY_CHANGED');
    port.close(); code(() => port.purge(id, identity, bytes), 'HANDLE_CLOSED');
  });

  it('writes deletion confirmation journals once without widening archive or ingestion journal names', () => {
    const f = fixture(), port = open(f.archive, f.trashRecovery), name = `${id}.delete.json`;
    expect(port.readRecovery(name)).toBeNull(); port.writeRecovery(name, Buffer.from('{}'));
    code(() => port.writeRecovery(name, Buffer.from('{"overwrite":true}')), 'TARGET_EXISTS');
    expect(port.readRecovery(name)).toEqual(Buffer.from('{}')); expect(port.listRecovery()).toEqual([name]);
    code(() => f.archive.writeRecovery(name, Buffer.from('{}')), 'PATH_NOT_ALLOWED');
    mkdirSync(join(f.base, 'ingestion'), { mode: 0o700 }); const ingestion = f.archive.openIngestion(join(f.base, 'ingestion')); handles.push(ingestion);
    code(() => ingestion.writeRecovery(name, Buffer.from('{}')), 'PATH_NOT_ALLOWED');
    code(() => port.writeRecovery(`24a60c8b-307a-1e80-8a70-5b6670c1d852.delete.json`, Buffer.from('{}')), 'PATH_NOT_ALLOWED');
  });

  it.each(['replace-preflight', 'fail-unlink', 'recreate-after', 'sync-after'])('preserves the known purge outcome when %s affects the syscall boundary', async (mode) => {
    const f = fixture(), port = open(f.archive, f.trashRecovery), bytes = seed(f, Buffer.from('original'));
    port.move(source, id, port.stat(source)!); port.writeRecovery(`${id}.delete.json`, Buffer.from('{}'));
    port.close(); f.archive.close();
    const dylib = join(f.base, 'purge-race.dylib');
    execFileSync('xcrun', ['clang', '-Wall', '-Wextra', '-Werror', '-dynamiclib', '-x', 'c', '-', '-o', dylib], { input: purgeInterposer });
    const script = `
      const native = require(process.argv[1]);
      const archive = native.openPersonal(process.argv[2], process.argv[3]);
      const trash = native.openTrash(archive, process.argv[4]);
      const expected = native.trashStatItem(trash, process.argv[5]), bytes = native.trashReadItem(trash, process.argv[5]);
      process.env.TRASH_PURGE_ARMED = '1';
      try { native.trashPurge(trash, process.argv[5], expected, bytes); process.stdout.write('UNEXPECTED_SUCCESS'); }
      catch (error) { process.stdout.write(error.code); }
      finally { native.trashClose(trash); native.close(archive); }
    `;
    const item = join(f.trashRecovery, `${id}.md`);
    const result = await promisify(execFile)(process.execPath, ['-e', script, addon, f.root, f.recovery, f.trashRecovery, id], {
      env: { ...process.env, DYLD_INSERT_LIBRARIES: dylib, TRASH_PURGE_RACE: mode, TRASH_PURGE_ITEM: item }
    });
    expect(result.stdout).toBe(mode === 'replace-preflight' ? 'VERSION_CONFLICT' : mode === 'fail-unlink' ? 'IO_ERROR' : 'TRASH_DELETE_NEEDS_REVIEW');
    expect(readFileSync(join(f.trashRecovery, `${id}.delete.json`), 'utf8')).toBe('{}');
    if (mode === 'replace-preflight') {
      expect(readFileSync(item, 'utf8')).toBe('external'); expect(readFileSync(`${item}-held`)).toEqual(bytes);
    } else if (mode === 'fail-unlink') expect(readFileSync(item)).toEqual(bytes);
    else if (mode === 'recreate-after') expect(readFileSync(item, 'utf8')).toBe('external');
    else expect(existsSync(item)).toBe(false);
  });

  it('moves and restores only selected markdown while preserving bytes, inode, mode and attachments', () => {
    const f = fixture(), port = open(f.archive, f.trashRecovery), bytes = seed(f);
    const original = port.stat(source)!;
    writeFileSync(join(dirname(join(f.root, source)), 'attachment.png'), 'attachment');
    port.writeRecovery(intent, Buffer.from('{"operation":"move"}'));
    port.move(source, id, original);
    expect(port.read(source)).toBeNull(); expect(port.stat(source)).toBeNull();
    expect(port.readItem(id)).toEqual(bytes); expect(port.statItem(id)).toEqual(original);
    expect(lstatSync(join(f.trashRecovery, `${id}.md`)).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(dirname(join(f.root, source)), 'attachment.png'), 'utf8')).toBe('attachment');
    expect(port.listRecovery()).toEqual([intent]); expect(f.archive.listRecovery()).toEqual([]);
    port.close(); const reopened = open(f.archive, f.trashRecovery);
    expect(reopened.readItem(id)).toEqual(bytes); expect(reopened.readRecovery(intent)).toEqual(Buffer.from('{"operation":"move"}'));
    reopened.restore(id, source, original);
    expect(reopened.readItem(id)).toBeNull(); expect(reopened.statItem(id)).toBeNull();
    expect(reopened.stat(source)).toEqual(original); expect(reopened.read(source)).toEqual(bytes);
  });

  it('borrows the archive lock, locks recovery separately, and closes idempotently', () => {
    const f = fixture(), port = open(f.archive, f.trashRecovery);
    expect(port.rootIdentity).toEqual(f.archive.rootIdentity);
    code(() => open(f.archive, f.trashRecovery), 'RECOVERY_LOCKED');
    port.close(); code(() => port.stat(source), 'HANDLE_CLOSED');
    code(() => openPersonalArchive(f.root, f.recovery, addon), 'ROOT_LOCKED');
    const second = open(f.archive, f.trashRecovery); f.archive.close();
    code(() => second.readItem(id), 'HANDLE_CLOSED'); second.close(); second.close();
  });

  it('never overwrites move or restore collisions and rejects stale identities', () => {
    const f = fixture(), port = open(f.archive, f.trashRecovery), bytes = seed(f), original = port.stat(source)!;
    code(() => port.move(source, id, { ...original, ino: '0' }), 'SOURCE_IDENTITY_CHANGED');
    expect(port.read(source)).toEqual(bytes); expect(port.readItem(id)).toBeNull();
    port.move(source, id, original); seed(f, Buffer.from('new original'));
    code(() => port.move(source, id, port.stat(source)!), 'TARGET_EXISTS');
    code(() => port.restore(id, source, original), 'TARGET_EXISTS');
    code(() => port.restore(id, source, { ...original, ino: '0' }), 'SOURCE_IDENTITY_CHANGED');
    expect(port.readItem(id)).toEqual(bytes); expect(port.read(source)).toEqual(Buffer.from('new original'));
  });

  it('requires existing restore parents and does not create folders', () => {
    const f = fixture(), port = open(f.archive, f.trashRecovery); seed(f); const original = port.stat(source)!;
    port.move(source, id, original);
    code(() => port.restore(id, '01图书馆/来自个人/missing/原文.md', original), 'NOT_FOUND');
    expect(existsSync(join(f.root, '01图书馆/来自个人/missing'))).toBe(false);
    expect(port.stat('01图书馆/来自个人/missing/原文.md')).toBeNull();
    expect(port.read('01图书馆/来自个人/missing/原文.md')).toBeNull();
    expect(port.statItem(id)).toEqual(original);
  });

  it.each(['01图书馆/小兆clipper/note.md', '01图书馆/来自未知/note.md', '02知识库', '02知识库/主题', '02知识库/a.png', '02知识库/../note.md',
    '00大脑规则/note.md', '03大讲堂/note.md', '01图书馆/来自个人/note.png', '/01图书馆/来自个人/note.md',
    '01图书馆/来自个人/../note.md', '01图书馆/来自个人//note.md', '01图书馆/来自个人/a\\b.md'])('refuses every operation on disallowed path %s', (path) => {
    const f = fixture(), port = open(f.archive, f.trashRecovery);
    for (const action of [() => port.read(path), () => port.stat(path), () => port.move(path, id, { dev: '1', ino: '1' }),
      () => port.restore(id, path, { dev: '1', ino: '1' })]) code(action, 'PATH_NOT_ALLOWED');
  });

  it.each(['../escape', `${id}.md`, '24a60c8b-307a-1e80-8a70-5b6670c1d852', id.toUpperCase(), `${id}\u0000`])('rejects invalid item identifier %s', (invalid) => {
    const f = fixture(), port = open(f.archive, f.trashRecovery); seed(f);
    for (const action of [() => port.readItem(invalid), () => port.statItem(invalid), () => port.move(source, invalid, port.stat(source)!),
      () => port.restore(invalid, source, { dev: '1', ino: '1' })]) code(action, 'PATH_NOT_ALLOWED');
  });

  it.each(['symlink', 'hardlink', 'directory', 'unsafe-mode'] as const)('rejects %s originals and recovered items', (kind) => {
    const f = fixture(), port = open(f.archive, f.trashRecovery); seed(f); const original = port.stat(source)!;
    const target = join(f.root, source), item = join(f.trashRecovery, `${id}.md`), held = join(f.base, 'held.md');
    for (const path of [target, item]) {
      if (path === item) { port.move(source, id, original); }
      if (kind === 'symlink') { renameSync(path, held); symlinkSync(held, path); }
      if (kind === 'hardlink') linkSync(path, held);
      if (kind === 'directory') { renameSync(path, held); mkdirSync(path); }
      if (kind === 'unsafe-mode') chmodSync(path, 0o666);
      const actions = path === target
        ? [() => port.read(source), () => port.stat(source), () => port.move(source, id, original)]
        : [() => port.readItem(id), () => port.statItem(id), () => port.restore(id, source, original)];
      for (const action of actions) code(action, 'PATH_NOT_ALLOWED');
      if (kind === 'symlink' || kind === 'directory') { rmSync(path, { recursive: true }); renameSync(held, path); }
      if (kind === 'hardlink') rmSync(held);
      if (kind === 'unsafe-mode') chmodSync(path, 0o644);
    }
  });

  it('accepts only immutable intent journals and refuses unsafe or unknown recovery entries', () => {
    const f = fixture(), port = open(f.archive, f.trashRecovery);
    expect(port.readRecovery(intent)).toBeNull();
    port.writeRecovery(intent, Buffer.from('{}')); code(() => port.writeRecovery(intent, Buffer.from('changed')), 'TARGET_EXISTS');
    for (const name of [`${id}.md`, `${id}.stage.md`, `${id}.result.json`, '../escape']) {
      code(() => port.writeRecovery(name, Buffer.from('x')), 'PATH_NOT_ALLOWED');
      code(() => port.readRecovery(name), 'PATH_NOT_ALLOWED');
    }
    code(() => port.writeRecovery(`${secondId}.intent.json`, Buffer.alloc(32 * 1024 * 1024 + 1)), 'FILE_TOO_LARGE');
    linkSync(join(f.trashRecovery, intent), join(f.base, 'journal-link')); code(() => port.listRecovery(), 'PATH_NOT_ALLOWED');
    rmSync(join(f.base, 'journal-link')); writeFileSync(join(f.trashRecovery, 'unknown'), 'keep');
    code(() => port.listRecovery(), 'PATH_NOT_ALLOWED'); expect(readFileSync(join(f.trashRecovery, 'unknown'), 'utf8')).toBe('keep');
  });

  it('rejects overlapping, linked or nonprivate recovery and detects replacement', () => {
    const f = fixture();
    for (const path of [f.root, f.recovery, f.base]) code(() => open(f.archive, path), 'PATH_NOT_ALLOWED');
    chmodSync(f.trashRecovery, 0o755); code(() => open(f.archive, f.trashRecovery), 'PATH_NOT_ALLOWED'); chmodSync(f.trashRecovery, 0o700);
    symlinkSync(f.trashRecovery, join(f.base, 'link')); code(() => open(f.archive, join(f.base, 'link')), 'PATH_NOT_ALLOWED');
    const port = open(f.archive, f.trashRecovery);
    renameSync(f.trashRecovery, `${f.trashRecovery}-held`); mkdirSync(f.trashRecovery, { mode: 0o700 });
    code(() => port.listRecovery(), 'RECOVERY_IDENTITY_CHANGED');
  });

  it('detects root or core-parent replacement and refuses symlink ancestors', () => {
    const f = fixture(), port = open(f.archive, f.trashRecovery); seed(f); const original = port.stat(source)!;
    const parent = dirname(join(f.root, source)); renameSync(parent, `${parent}-held`); symlinkSync(`${parent}-held`, parent);
    code(() => port.move(source, id, original), 'PATH_NOT_ALLOWED'); rmSync(parent); renameSync(`${parent}-held`, parent);
    renameSync(join(f.root, '01图书馆'), join(f.root, 'library-held')); mkdirSync(join(f.root, '01图书馆'));
    code(() => port.move(source, id, original), 'PARENT_IDENTITY_CHANGED');
    renameSync(f.root, `${f.root}-held`); mkdirSync(f.root); code(() => port.read(source), 'ROOT_IDENTITY_CHANGED');
  });

  it('keeps trash, ingestion and archive native handles mutually noninterchangeable', () => {
    const f = fixture(); f.archive.close(); mkdirSync(join(f.base, 'ingestion'), { mode: 0o700 });
    const native = createRequire(import.meta.url)(addon), archive = native.openPersonal(f.root, f.recovery);
    const trash = native.openTrash(archive, f.trashRecovery), ingestion = native.openIngestion(archive, join(f.base, 'ingestion'));
    try {
      code(() => native.trashRead(archive, source), 'INVALID_ARGUMENT');
      code(() => native.trashRead(ingestion, source), 'INVALID_ARGUMENT');
      code(() => native.ingestionRead(trash, source), 'INVALID_ARGUMENT');
      code(() => native.read(trash, source), 'INVALID_ARGUMENT');
      code(() => native.openTrash(trash, f.recovery), 'INVALID_ARGUMENT');
    } finally { native.trashClose(trash); native.ingestionClose(ingestion); native.close(archive); }
  });

  it.each(['source-before', 'target-after', 'parent-before', 'root-before', 'target-before'])('preserves every version when %s races the rename syscall', async (mode) => {
    const f = fixture(); seed(f, Buffer.from('original')); f.archive.close();
    const dylib = join(f.base, 'race.dylib');
    execFileSync('xcrun', ['clang', '-Wall', '-Wextra', '-Werror', '-dynamiclib', '-x', 'c', '-', '-o', dylib], { input: raceInterposer });
    const script = `
      const native = require(process.argv[1]);
      const archive = native.openPersonal(process.argv[2], process.argv[3]);
      const trash = native.openTrash(archive, process.argv[4]);
      try { native.trashMove(trash, process.argv[5], process.argv[6], native.trashStat(trash, process.argv[5])); process.stdout.write('UNEXPECTED_SUCCESS'); }
      catch (error) { process.stdout.write(error.code); }
      finally { native.trashClose(trash); native.close(archive); }
    `;
    const result = await promisify(execFile)(process.execPath, ['-e', script, addon, f.root, f.recovery, f.trashRecovery, source, id], {
      env: { ...process.env, DYLD_INSERT_LIBRARIES: dylib, TRASH_CONTRACT_RACE: mode, TRASH_CONTRACT_PARENT: dirname(join(f.root, source)), TRASH_CONTRACT_ROOT: f.root }
    });
    expect(result.stdout).toBe(mode === 'target-before' ? 'TARGET_EXISTS' : 'TRASH_NEEDS_REVIEW');
    const item = join(f.trashRecovery, `${id}.md`);
    if (mode === 'source-before') {
      expect(readFileSync(item, 'utf8')).toBe('external');
      expect(readFileSync(join(dirname(join(f.root, source)), 'external-held.md'), 'utf8')).toBe('original');
    } else if (mode === 'target-after') {
      expect(readFileSync(item, 'utf8')).toBe('external');
      expect(readFileSync(join(f.trashRecovery, 'external-held.md'), 'utf8')).toBe('original');
    } else if (mode === 'target-before') {
      expect(readFileSync(item, 'utf8')).toBe('external'); expect(readFileSync(join(f.root, source), 'utf8')).toBe('original');
    } else expect(readFileSync(item, 'utf8')).toBe('original');
  });
});

// The production addon contains no test hooks. This dylib is compiled into a
// marked temporary fixture and loaded only into the corresponding test child.
const raceInterposer = `
#define _DARWIN_C_SOURCE
#include <sys/stat.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static void external(int parent, const char *name) {
  int fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd < 0 || write(fd, "external", 8) != 8 || fsync(fd)) _exit(70);
  close(fd);
}
static int trash_race(int from, const char *source, int to, const char *target, unsigned flags) {
  const char *mode = getenv("TRASH_CONTRACT_RACE");
  if (!mode) return renameatx_np(from, source, to, target, flags);
  if (!strcmp(mode, "source-before")) { if (renameat(from, source, from, "external-held.md")) _exit(71); external(from, source); }
  if (!strcmp(mode, "target-before")) external(to, target);
  if (!strcmp(mode, "parent-before") || !strcmp(mode, "root-before")) {
    const char *path = getenv(!strcmp(mode, "parent-before") ? "TRASH_CONTRACT_PARENT" : "TRASH_CONTRACT_ROOT");
    char held[4096]; if (snprintf(held, sizeof(held), "%s-held", path) >= (int)sizeof(held) || rename(path, held) || mkdir(path, 0700)) _exit(72);
  }
  int result = renameatx_np(from, source, to, target, flags), saved = errno;
  if (!result && !strcmp(mode, "target-after")) { if (renameat(to, target, to, "external-held.md")) _exit(73); external(to, target); }
  errno = saved; return result;
}
__attribute__((used)) static struct { const void *replacement; const void *original; }
trash_interpose __attribute__((section("__DATA,__interpose"))) = { (const void *)&trash_race, (const void *)&renameatx_np };
`;

const purgeInterposer = `
#define _DARWIN_C_SOURCE
#include <sys/stat.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static int replaced = 0, unlinked = 0;
static const char *mode(void) { return getenv("TRASH_PURGE_ARMED") ? getenv("TRASH_PURGE_RACE") : NULL; }
static void external(const char *name) {
  int fd = open(name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd < 0 || write(fd, "external", 8) != 8) _exit(70);
  close(fd);
}
static int purge_sync(int fd) {
  const char *race = mode();
  if (race && !strcmp(race, "replace-preflight") && !replaced) {
    replaced = 1; const char *path = getenv("TRASH_PURGE_ITEM"); char held[4096];
    if (snprintf(held, sizeof(held), "%s-held", path) >= (int)sizeof(held) || rename(path, held)) _exit(71);
    external(path);
  }
  if (race && !strcmp(race, "sync-after") && unlinked) { errno = EIO; return -1; }
  return fsync(fd);
}
static int purge_unlink(int parent, const char *name, int flags) {
  const char *race = mode();
  if (race && !strcmp(race, "fail-unlink")) { errno = EIO; return -1; }
  int result = unlinkat(parent, name, flags), saved = errno;
  if (!result) {
    unlinked = 1;
    if (race && !strcmp(race, "recreate-after")) external(getenv("TRASH_PURGE_ITEM"));
  }
  errno = saved; return result;
}
__attribute__((used)) static struct { const void *replacement; const void *original; }
purge_interpose[] __attribute__((section("__DATA,__interpose"))) = {
  { (const void *)&purge_sync, (const void *)&fsync },
  { (const void *)&purge_unlink, (const void *)&unlinkat }
};
`;
