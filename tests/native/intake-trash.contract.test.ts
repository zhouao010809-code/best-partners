import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { openPersonalArchive, type PersonalArchivePort } from '../../src/server/archive/sandbox-native.js';
import type { ArchiveTreeReader } from '../../src/server/archive/archive-snapshot.js';
import type { IntakeTrashPurgeMember } from '../../src/server/trash/intake-trash-native.js';
import { createIntakeTrashService } from '../../src/server/trash/intake-trash-service.js';
import { pathToFileURL } from 'node:url';

const addon = resolve('dist/native/personal-archive.node');
const id = '24a60c8b-307a-4e80-8a70-5b6670c1d852';
const name = '一次采集';
const marker = 'intake-trash-contract-v1\n';
const fixtures: string[] = [], handles: { close(): void }[] = [];
type Identity = { dev: string; ino: string };
type Trash = {
  rootIdentity: Identity; source: ArchiveTreeReader; items: ArchiveTreeReader;
  move(name: string, id: string, expected: Identity): void;
  restore(id: string, name: string, expected: Identity): void;
  purge(id: string, tree: readonly IntakeTrashPurgeMember[]): void;
  writeRecovery(name: string, bytes: Buffer): void;
  readRecovery(name: string): Buffer | null;
  listRecovery(): readonly string[]; close(): void;
};
function fixture() {
  const base = mkdtempSync('/private/tmp/xiaozhao-intake-trash-test-'); fixtures.push(base);
  chmodSync(base, 0o700); writeFileSync(join(base, '.test-marker'), marker, { flag: 'wx', mode: 0o600 });
  const root = join(base, 'vault'), recovery = join(base, 'archive'), trashRoot = join(base, 'intake-trash');
  for (const directory of [root, recovery, trashRoot]) mkdirSync(directory, { mode: 0o700 });
  for (const directory of ['00大脑规则', '01图书馆/小兆clipper', '02知识库', '03大讲堂']) mkdirSync(join(root, directory), { recursive: true });
  const archive = openPersonalArchive(root, recovery, addon); handles.push(archive);
  const intake = join(root, '01图书馆/小兆clipper');
  return { base, root, recovery, trashRoot, archive, intake };
}
function open(archive: PersonalArchivePort, recovery: string): Trash {
  const candidate = archive as PersonalArchivePort & { openIntakeTrash?: (root: string) => Trash };
  expect(candidate.openIntakeTrash, 'bounded whole-packet trash port').toBeTypeOf('function');
  const port = candidate.openIntakeTrash!(recovery); handles.push(port); return port;
}
function code(action: () => unknown, expected: string) { expect(action).toThrow(expect.objectContaining({ code: expected })); }
function packet(f: ReturnType<typeof fixture>) {
  mkdirSync(join(f.intake, name, 'assets'), { recursive: true, mode: 0o750 });
  const bytes = Buffer.from('\ufeff原文\r\n\u0000尾部');
  const attachment = Buffer.from([0, 255, 128, 13, 10, 1]);
  writeFileSync(join(f.intake, name, '原文.md'), bytes, { mode: 0o640 });
  writeFileSync(join(f.intake, name, 'assets/图片.bin'), attachment, { mode: 0o444 });
  writeFileSync(join(f.intake, '其他.md'), 'unselected');
  return { bytes, attachment };
}
function manifest(port: Trash, slot: string): IntakeTrashPurgeMember[] {
  const tree: IntakeTrashPurgeMember[] = [];
  function visit(path: string) {
    const full = path ? `${slot}/${path}` : slot, stat = port.items.stat(full)!;
    const value = { path, dev: stat.dev, ino: stat.ino };
    if (stat.kind === 'file') tree.push({ ...value, kind: 'file', bytes: port.items.read(full) });
    else { tree.push({ ...value, kind: 'directory' }); for (const child of port.items.list(full)) visit(path ? `${path}/${child.name}` : child.name); }
  }
  visit(''); return tree.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
beforeAll(async () => { await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/build-sandbox-archive.ts', '--personal']); });
afterAll(() => {
  for (const handle of handles.reverse()) handle.close();
  for (const base of fixtures.reverse()) {
    if (dirname(base) !== '/private/tmp' || !basename(base).startsWith('xiaozhao-intake-trash-test-')
      || realpathSync(base) !== base || !lstatSync(base).isDirectory()
      || readFileSync(join(base, '.test-marker'), 'utf8') !== marker) throw new Error('REFUSE_UNVERIFIED_INTAKE_TRASH_TEST_CLEANUP');
    rmSync(base, { recursive: true });
  }
});

describe('whole intake packet recycling in isolated temporary vaults', () => {
  it('deletes emoji and fullwidth siblings without changing historical manifest ordering', async () => {
    const f = fixture(); packet(f); writeFileSync(join(f.intake, name, '😀.md'), 'emoji'); writeFileSync(join(f.intake, name, 'Ｚ.md'), 'fullwidth');
    const port = open(f.archive, f.trashRoot), service = createIntakeTrashService({ port, getRuleFingerprint: async () => 'test-rules', assertIdle() {} });
    const preview = await service.preview(name); await service.commit(preview.id);
    const originalIntent = port.readRecovery(`${preview.id}.intent.json`), confirmation = await service.previewDelete(preview.id);
    expect((await service.delete(preview.id, confirmation.token)).status).toBe('deleted');
    expect(port.readRecovery(`${preview.id}.intent.json`)).toEqual(originalIntent); expect(port.items.stat(preview.id)).toBeNull();
  });
  it.each(['exit-first', 'fail-second'] as const)('requires explicit reconfirmation after real native %s interruption and restart', async mode => {
    const f = fixture(); packet(f); mkdirSync(join(f.intake, name, 'empty'));
    const port = open(f.archive, f.trashRoot), makeService = (port: Trash) => createIntakeTrashService({
      port, getRuleFingerprint: async () => 'test-rules', assertIdle: () => {}
    });
    const service = makeService(port), preview = await service.preview(name); await service.commit(preview.id);
    const original = manifest(port, preview.id); await service.close(); f.archive.close();
    const dylib = join(f.base, 'intake-purge.dylib');
    execFileSync('xcrun', ['clang', '-Wall', '-Wextra', '-Werror', '-dynamiclib', resolve('tests/native/fixtures/intake-purge-interposer.c'), '-o', dylib]);
    const script = `
      import { openPersonalArchive } from ${JSON.stringify(pathToFileURL(resolve('src/server/archive/sandbox-native.ts')).href)};
      import { createIntakeTrashService } from ${JSON.stringify(pathToFileURL(resolve('src/server/trash/intake-trash-service.ts')).href)};
      const archive = openPersonalArchive(process.argv[1], process.argv[2], process.argv[4]);
      const service = createIntakeTrashService({port: archive.openIntakeTrash(process.argv[3]), getRuleFingerprint: async () => 'test-rules', assertIdle() {}});
      const preview = await service.previewDelete(process.argv[5]); console.log(preview.token);
      console.log((await service.delete(process.argv[5], preview.token)).status);
      await service.close(); archive.close();
    `;
    let output = '';
    try {
      output = (await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, f.root, f.recovery, f.trashRoot, addon, preview.id], {
        env: { ...process.env, INTAKE_PURGE_TEST_ROOT: f.trashRoot, INTAKE_PURGE_TEST_MODE: mode, DYLD_INSERT_LIBRARIES: dylib }
      })).stdout;
      expect(mode).toBe('fail-second'); expect(output).toContain('deleting');
    } catch (error) {
      expect(mode).toBe('exit-first'); expect(error).toMatchObject({ code: 86 }); output = (error as { stdout: string }).stdout;
    }
    const token = output.trim().split('\n')[0]!;
    const archive = openPersonalArchive(f.root, f.recovery, addon); handles.push(archive);
    const resumedPort = open(archive, f.trashRoot), resumed = makeService(resumedPort), remaining = manifest(resumedPort, preview.id);
    expect(remaining.length).toBe(original.length - 1); await resumed.recover();
    expect(resumed.get(preview.id).status).toBe('deleting'); expect((await resumed.retry(preview.id)).status).toBe('deleting');
    expect((await resumed.restore(preview.id)).status).toBe('deleting'); expect((await resumed.delete(preview.id, token)).status).toBe('deleting');
    expect(manifest(resumedPort, preview.id)).toEqual(remaining);
    const confirmation = await resumed.previewDelete(preview.id);
    expect((await resumed.delete(preview.id, confirmation.token)).status).toBe('deleted'); expect(resumedPort.items.stat(preview.id)).toBeNull();
    expect(readFileSync(join(f.intake, '其他.md'), 'utf8')).toBe('unselected');
  });
  it.each([false, true])('purges a manifest-verified packet or file (single=%s), preserving journals and other originals', single => {
    const f = fixture(), port = open(f.archive, f.trashRoot);
    if (single) writeFileSync(join(f.intake, name), 'single');
    else { packet(f); mkdirSync(join(f.intake, name, 'empty')); }
    port.move(name, id, port.source.stat(name)!); const expected = manifest(port, id);
    port.writeRecovery(`${id}.delete.json`, Buffer.from('{}'));
    expect(port.purge).toBeTypeOf('function'); port.purge(id, expected);
    expect(port.items.stat(id)).toBeNull(); expect(port.readRecovery(`${id}.delete.json`)).toEqual(Buffer.from('{}'));
    if (!single) expect(readFileSync(join(f.intake, '其他.md'), 'utf8')).toBe('unselected');
  });

  it.each(['bytes', 'identity', 'added', 'missing', 'symlink', 'hardlink'] as const)('rejects a %s mutation of a purge manifest before deleting anything', change => {
    const f = fixture(), { bytes } = packet(f), port = open(f.archive, f.trashRoot);
    port.move(name, id, port.source.stat(name)!); const expected = manifest(port, id), item = join(f.trashRoot, `${id}.packet`);
    if (change === 'bytes') (expected.find(member => member.kind === 'file') as { bytes: Buffer }).bytes = Buffer.from('changed');
    if (change === 'identity') expected[0]!.ino = '0';
    if (change === 'added') writeFileSync(join(item, 'extra'), 'new');
    if (change === 'missing') expected.pop();
    if (change === 'symlink') symlinkSync(join(item, '原文.md'), join(item, 'unsafe'));
    if (change === 'hardlink') linkSync(join(item, '原文.md'), join(item, 'unsafe'));
    code(() => port.purge(id, expected), change === 'identity' ? 'SOURCE_IDENTITY_CHANGED' : ['symlink', 'hardlink'].includes(change) ? 'PATH_NOT_ALLOWED' : 'VERSION_CONFLICT');
    expect(readFileSync(join(item, '原文.md'))).toEqual(bytes); expect(existsSync(join(item, 'assets/图片.bin'))).toBe(true);
  });

  it('rejects invalid purge identifiers and detached root ancestry', () => {
    const f = fixture(); packet(f); const port = open(f.archive, f.trashRoot);
    port.move(name, id, port.source.stat(name)!); const expected = manifest(port, id);
    for (const invalid of [`${id}/assets`, `${id}.packet`, '../escape', '01图书馆', '02知识库']) code(() => port.purge(invalid, expected), 'PATH_NOT_ALLOWED');
    renameSync(f.trashRoot, `${f.trashRoot}-held`); mkdirSync(f.trashRoot, { mode: 0o700 });
    code(() => port.purge(id, expected), 'RECOVERY_IDENTITY_CHANGED');
    expect(existsSync(join(`${f.trashRoot}-held`, `${id}.packet/原文.md`))).toBe(true);
  });
  it('moves and restores the selected directory with byte, inode and permission preservation', () => {
    const f = fixture(), { bytes, attachment } = packet(f), port = open(f.archive, f.trashRoot);
    const before = new Map(['', '/assets', '/原文.md', '/assets/图片.bin'].map((child) => [child, lstatSync(join(f.intake, `${name}${child}`))]));
    const identity = port.source.stat(name)!;
    expect(port.rootIdentity).toEqual(f.archive.rootIdentity);
    port.move(name, id, identity);
    expect(port.source.stat(name)).toBeNull(); expect(port.source.stat(`${name}/原文.md`)).toBeNull();
    expect(port.items.stat(id)).toEqual(identity);
    expect(port.items.read(`${id}/原文.md`)).toEqual(bytes);
    expect(port.items.read(`${id}/assets/图片.bin`)).toEqual(attachment);
    expect(port.items.list(id)).toEqual(expect.arrayContaining([{ name: 'assets', kind: 'directory' }, { name: '原文.md', kind: 'file' }]));
    for (const [child, stat] of before) {
      const after = lstatSync(join(f.trashRoot, `${id}.packet${child}`));
      expect([after.dev, after.ino, after.mode]).toEqual([stat.dev, stat.ino, stat.mode]);
    }
    expect(readFileSync(join(f.intake, '其他.md'), 'utf8')).toBe('unselected');
    port.restore(id, name, identity);
    expect(port.items.stat(id)).toBeNull(); expect(port.source.read(`${name}/原文.md`)).toEqual(bytes);
    for (const [child, stat] of before) {
      const after = lstatSync(join(f.intake, `${name}${child}`));
      expect([after.dev, after.ino, after.mode]).toEqual([stat.dev, stat.ino, stat.mode]);
    }
  });

  it('also recycles a standalone intake file and rejects missing reads', () => {
    const f = fixture(), port = open(f.archive, f.trashRoot), bytes = Buffer.from([0, 1, 255, 10]);
    writeFileSync(join(f.intake, '独立文件.bin'), bytes, { mode: 0o640 });
    const identity = port.source.stat('独立文件.bin')!;
    port.move('独立文件.bin', id, identity);
    expect(port.items.read(id)).toEqual(bytes);
    code(() => port.source.read('独立文件.bin'), 'NOT_FOUND');
    port.restore(id, '独立文件.bin', identity);
    expect(port.source.read('独立文件.bin')).toEqual(bytes);
    expect(port.items.stat(`${id}/absent`)).toBeNull();
    code(() => port.items.read(id), 'NOT_FOUND');
  });

  it('keeps both versions when the original intake name is occupied', () => {
    const f = fixture(), { bytes } = packet(f), port = open(f.archive, f.trashRoot), identity = port.source.stat(name)!;
    port.move(name, id, identity); writeFileSync(join(f.intake, name), 'new arrival');
    code(() => port.restore(id, name, identity), 'TARGET_EXISTS');
    expect(port.items.read(`${id}/原文.md`)).toEqual(bytes);
    expect(readFileSync(join(f.intake, name), 'utf8')).toBe('new arrival');
  });

  it('rejects stale identities and existing recovery payloads without movement', () => {
    const f = fixture(); packet(f); const port = open(f.archive, f.trashRoot), identity = port.source.stat(name)!;
    code(() => port.move(name, id, { ...identity, ino: '0' }), 'SOURCE_IDENTITY_CHANGED');
    code(() => port.move(name, id, { ...identity, dev: '0' }), 'SOURCE_IDENTITY_CHANGED');
    writeFileSync(join(f.trashRoot, `${id}.packet`), 'existing payload');
    code(() => port.move(name, id, identity), 'TARGET_EXISTS');
    expect(port.source.stat(name)).toEqual(identity);
    expect(readFileSync(join(f.trashRoot, `${id}.packet`), 'utf8')).toBe('existing payload');
  });

  it('limits source access to a selected top-level name and payload access to UUID v4 slots', () => {
    const f = fixture(); packet(f); const port = open(f.archive, f.trashRoot), identity = port.source.stat(name)!;
    for (const invalid of ['', '.', '..', '../escape', `${name}/../其他.md`, `${name}//child`, `${name}/.`, '.gitkeep', '/absolute', 'bad\\path', '\u0000', '\ud800']) {
      code(() => port.source.stat(invalid), 'PATH_NOT_ALLOWED');
      code(() => port.source.read(invalid), 'PATH_NOT_ALLOWED');
      code(() => port.source.list(invalid), 'PATH_NOT_ALLOWED');
      code(() => port.move(invalid, id, identity), 'PATH_NOT_ALLOWED');
      code(() => port.restore(id, invalid, identity), 'PATH_NOT_ALLOWED');
    }
    code(() => port.move(`${name}/原文.md`, id, identity), 'PATH_NOT_ALLOWED');
    for (const invalid of ['../escape', `${id}.packet`, `${id}.intent.json`, id.toUpperCase(), '24a60c8b-307a-1e80-8a70-5b6670c1d852', `${id}/../escape`]) {
      code(() => port.items.stat(invalid), 'PATH_NOT_ALLOWED');
      code(() => port.items.read(invalid), 'PATH_NOT_ALLOWED');
      code(() => port.items.list(invalid), 'PATH_NOT_ALLOWED');
      code(() => port.move(name, invalid, identity), 'PATH_NOT_ALLOWED');
      code(() => port.restore(invalid, name, identity), 'PATH_NOT_ALLOWED');
    }
    expect(port.source.stat(name)).toEqual(identity);
  });

  it.each(['symlink', 'hardlink'] as const)('rejects a %s child and preserves every packet entry', (kind) => {
    const f = fixture(), { bytes } = packet(f), port = open(f.archive, f.trashRoot), identity = port.source.stat(name)!;
    const target = join(f.base, 'external'); writeFileSync(target, 'outside');
    const unsafe = join(f.intake, name, 'unsafe');
    if (kind === 'symlink') symlinkSync(target, unsafe); else linkSync(target, unsafe);
    code(() => port.move(name, id, identity), 'PATH_NOT_ALLOWED');
    code(() => port.source.read(`${name}/unsafe`), 'PATH_NOT_ALLOWED');
    expect(readFileSync(join(f.intake, name, '原文.md'))).toEqual(bytes);
    expect(readFileSync(target, 'utf8')).toBe('outside'); expect(existsSync(join(f.trashRoot, `${id}.packet`))).toBe(false);
  });

  it('anchors intake ancestry and refuses replacement of the observed intake folder', () => {
    const f = fixture(); packet(f); const port = open(f.archive, f.trashRoot), identity = port.source.stat(name)!;
    renameSync(f.intake, `${f.intake}-held`); mkdirSync(f.intake);
    code(() => port.move(name, id, identity), 'PARENT_IDENTITY_CHANGED');
    expect(readFileSync(join(`${f.intake}-held`, name, '原文.md'))).toBeDefined();
  });

  it('rejects symlink ancestry at open and unsafe private recovery roots', () => {
    const f = fixture(); renameSync(f.intake, `${f.intake}-held`); symlinkSync(`${f.intake}-held`, f.intake);
    code(() => open(f.archive, f.trashRoot), 'PATH_NOT_ALLOWED');
    const g = fixture(); chmodSync(g.trashRoot, 0o755);
    code(() => open(g.archive, g.trashRoot), 'PATH_NOT_ALLOWED');
    code(() => open(g.archive, g.recovery), 'PATH_NOT_ALLOWED');
    code(() => open(g.archive, g.intake), 'PATH_NOT_ALLOWED');
  });

  it('uses immutable intent, restore and restored journals that survive reopening independently of payloads', () => {
    const f = fixture(); packet(f); const port = open(f.archive, f.trashRoot), identity = port.source.stat(name)!;
    for (const journal of [`${id}.intent.json`, `${id}.restore.json`, `${id}.restored.json`, `${id}.delete.json`, `${id}.confirm.json`, `${id}.deleted.json`]) {
      const bytes = Buffer.from(`journal ${journal}`); port.writeRecovery(journal, bytes);
      code(() => port.writeRecovery(journal, Buffer.from('replacement')), 'TARGET_EXISTS');
      expect(port.readRecovery(journal)).toEqual(bytes);
      expect(lstatSync(join(f.trashRoot, journal)).mode & 0o777).toBe(0o600);
    }
    for (const invalid of [`${id}.packet`, `${id}.done.json`, `${id}.result.json`, `${id}.stage.md`, '../escape']) {
      code(() => port.writeRecovery(invalid, Buffer.from('x')), 'PATH_NOT_ALLOWED');
      code(() => port.readRecovery(invalid), 'PATH_NOT_ALLOWED');
    }
    port.move(name, id, identity); port.close();
    const reopened = open(f.archive, f.trashRoot);
    expect([...reopened.listRecovery()].sort()).toEqual([`${id}.intent.json`, `${id}.restore.json`, `${id}.restored.json`, `${id}.delete.json`, `${id}.confirm.json`, `${id}.deleted.json`].sort());
    expect(reopened.readRecovery(`${id}.restored.json`)).toEqual(Buffer.from(`journal ${id}.restored.json`));
    code(() => reopened.writeRecovery(`${id}.restored.json`, Buffer.from('replacement')), 'TARGET_EXISTS');
    expect(reopened.items.stat(id)).toEqual(identity);
    reopened.restore(id, name, identity);
    expect(reopened.readRecovery(`${id}.restore.json`)).toEqual(Buffer.from(`journal ${id}.restore.json`));
  });

  it('rejects mutated roots, closed handles and foreign native handle types without releasing the owner lock', () => {
    const f = fixture(); packet(f); const port = open(f.archive, f.trashRoot), identity = port.source.stat(name)!;
    chmodSync(f.trashRoot, 0o755); code(() => port.move(name, id, identity), 'RECOVERY_IDENTITY_CHANGED'); chmodSync(f.trashRoot, 0o700);
    port.close(); code(() => port.source.stat(name), 'HANDLE_CLOSED'); code(() => port.listRecovery(), 'HANDLE_CLOSED');
    code(() => openPersonalArchive(f.root, f.recovery, addon), 'ROOT_LOCKED');
    const reopened = open(f.archive, f.trashRoot); f.archive.close(); code(() => reopened.source.stat(name), 'HANDLE_CLOSED');
    const native = createRequire(import.meta.url)(addon);
    code(() => native.intakeTrashSourceStat({}, name), 'INVALID_ARGUMENT');
    const g = fixture(); packet(g); const other = open(g.archive, g.trashRoot);
    renameSync(g.root, `${g.root}-held`); mkdirSync(g.root, { mode: 0o700 });
    code(() => other.source.stat(name), 'ROOT_IDENTITY_CHANGED');
  });
});
