import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { openPersonalArchive, type PersonalArchivePort } from '../../src/server/archive/sandbox-native.js';

const addon = resolve('dist/native/personal-archive.node');
const stage = '24a60c8b-307a-4e80-8a70-5b6670c1d852.stage.md';
const intent = stage.replace('.stage.md', '.intent.json');
const knowledge = '02知识库/01AI/AI基础/知识.md';
const source = '01图书馆/来自个人/旧资料/原文.md';
const marker = 'personal-ingestion-contract-v1\n';
const fixtures: string[] = [];
const handles: { close(): void }[] = [];
type Ingestion = {
  readonly rootIdentity: { dev: string; ino: string };
  read(path: string): Buffer | null;
  writeRecovery(name: string, bytes: Buffer): void;
  readRecovery(name: string): Buffer | null;
  listRecovery(): readonly string[];
  apply(path: string, stageName: string, before: Buffer | null, after: Buffer): void;
  close(): void;
};
function fixture() {
  const base = mkdtempSync('/private/tmp/xiaozhao-personal-ingestion-test-');
  fixtures.push(base); chmodSync(base, 0o700);
  writeFileSync(join(base, '.test-marker'), marker, { mode: 0o600, flag: 'wx' });
  const root = join(base, 'vault'), recovery = join(base, 'intake'), ingestionRecovery = join(base, 'ingestion');
  for (const directory of [root, recovery, ingestionRecovery]) mkdirSync(directory, { mode: 0o700 });
  for (const directory of ['00大脑规则', '01图书馆/小兆clipper', '02知识库/01AI/AI基础', '03大讲堂', '01图书馆/来自个人/旧资料']) mkdirSync(join(root, directory), { recursive: true });
  const archive = openPersonalArchive(root, recovery, addon); handles.push(archive);
  return { base, root, recovery, ingestionRecovery, archive };
}
function open(archive: PersonalArchivePort, recovery: string): Ingestion {
  const candidate = archive as PersonalArchivePort & { openIngestion?: (path: string) => Ingestion };
  expect(candidate.openIngestion, 'independent native ingestion port must be available').toBeTypeOf('function');
  const port = candidate.openIngestion!(recovery); handles.push(port); return port;
}
function code(action: () => unknown, expected: string) {
  expect(action).toThrow(expect.objectContaining({ code: expected }));
}
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/build-sandbox-archive.ts', '--personal']);
});
afterAll(() => {
  for (const handle of handles.reverse()) handle.close();
  for (const base of fixtures.reverse()) {
    if (dirname(base) !== '/private/tmp' || !basename(base).startsWith('xiaozhao-personal-ingestion-test-')
      || realpathSync(base) !== base || !lstatSync(base).isDirectory()
      || readFileSync(join(base, '.test-marker'), 'utf8') !== marker) throw new Error('REFUSE_UNVERIFIED_INGESTION_TEST_CLEANUP');
    rmSync(base, { recursive: true });
  }
});

describe('personal ingestion native contract in isolated temporary vaults', () => {
  it('borrows the held root lock, separately locks recovery and isolates recovery namespaces', () => {
    const f = fixture(), port = open(f.archive, f.ingestionRecovery);
    expect(port.rootIdentity).toEqual(f.archive.rootIdentity);
    port.writeRecovery(intent, Buffer.from('{}'));
    expect(port.readRecovery(intent)).toEqual(Buffer.from('{}'));
    expect(port.listRecovery()).toEqual([intent]);
    expect(f.archive.listRecovery()).toEqual([]);
    code(() => open(f.archive, f.ingestionRecovery), 'RECOVERY_LOCKED');
    port.close();
    expect(open(f.archive, f.ingestionRecovery).listRecovery()).toEqual([intent]);
    code(() => openPersonalArchive(f.root, f.recovery, addon), 'ROOT_LOCKED');
  });

  it('creates knowledge exclusively and swaps updates while preserving the previous inode and bytes', () => {
    const f = fixture(), port = open(f.archive, f.ingestionRecovery);
    const before = Buffer.from('\ufeff初版\r\n'), after = Buffer.from('新版\n');
    expect(port.read(knowledge)).toBeNull();
    port.writeRecovery(stage, before); port.apply(knowledge, stage, null, before);
    expect(port.read(knowledge)).toEqual(before); expect(port.readRecovery(stage)).toBeNull();
    const old = lstatSync(join(f.root, knowledge));
    port.writeRecovery(stage, after); port.apply(knowledge, stage, before, after);
    expect(port.read(knowledge)).toEqual(after); expect(port.readRecovery(stage)).toEqual(before);
    expect(lstatSync(join(f.ingestionRecovery, stage)).ino).toBe(old.ino);
    port.close(); expect(open(f.archive, f.ingestionRecovery).readRecovery(stage)).toEqual(before);
  });

  it('updates existing archived source markdown without requiring a month directory', () => {
    const f = fixture(), port = open(f.archive, f.ingestionRecovery);
    const before = Buffer.from('原文\r\n'), after = Buffer.from('状态\n原文\r\n');
    writeFileSync(join(f.root, source), before, { mode: 0o644 });
    expect(port.read(source)).toEqual(before);
    port.writeRecovery(stage, after); port.apply(source, stage, before, after);
    expect(port.read(source)).toEqual(after); expect(port.readRecovery(stage)).toEqual(before);
    expect(lstatSync(join(f.ingestionRecovery, stage)).mode & 0o777).toBe(0o644);
  });

  it('does not create sources, folders, overwrite collisions or accept mismatched before/after bytes', () => {
    const f = fixture(), port = open(f.archive, f.ingestionRecovery), after = Buffer.from('after');
    port.writeRecovery(stage, after);
    code(() => port.apply(source, stage, null, after), 'PATH_NOT_ALLOWED');
    code(() => port.apply('02知识库/missing/new.md', stage, null, after), 'NOT_FOUND');
    writeFileSync(join(f.root, knowledge), 'external', { mode: 0o600 });
    code(() => port.apply(knowledge, stage, null, after), 'TARGET_EXISTS');
    code(() => port.apply(knowledge, stage, Buffer.from('stale'), after), 'VERSION_CONFLICT');
    code(() => port.apply(knowledge, stage, Buffer.from('external'), Buffer.from('different')), 'VERSION_CONFLICT');
    expect(port.read(knowledge)).toEqual(Buffer.from('external')); expect(port.readRecovery(stage)).toEqual(after);
    expect(existsSync(join(f.root, '02知识库/missing'))).toBe(false);
  });

  it.each(['01图书馆/小兆clipper/note.md', '01图书馆/来自未知/note.md', '03大讲堂/note.md', '00大脑规则/note.md', '02知识库/../03大讲堂/note.md', '/02知识库/note.md', '02知识库/note.txt', '02知识库/a\\b.md', '02知识库/\u0000.md'])('rejects data path %s and keeps intake allowlists unchanged', (path) => {
    const f = fixture(), port = open(f.archive, f.ingestionRecovery);
    code(() => port.read(path), 'PATH_NOT_ALLOWED');
    code(() => port.apply(path, stage, null, Buffer.from('after')), 'PATH_NOT_ALLOWED');
    code(() => f.archive.read(knowledge), 'PATH_NOT_ALLOWED');
  });

  it.each(['symlink', 'hardlink', 'unsafe-mode'] as const)('rejects an unsafe %s target and stage', (kind) => {
    const f = fixture(), port = open(f.archive, f.ingestionRecovery);
    writeFileSync(join(f.root, knowledge), 'before', { mode: 0o600 }); port.writeRecovery(stage, Buffer.from('after'));
    const target = join(f.root, knowledge), staged = join(f.ingestionRecovery, stage), held = join(f.base, 'held');
    for (const path of [target, staged]) {
      if (kind === 'symlink') { renameSync(path, held); symlinkSync(held, path); }
      if (kind === 'hardlink') linkSync(path, held);
      if (kind === 'unsafe-mode') chmodSync(path, 0o666);
      try { code(() => port.apply(knowledge, stage, Buffer.from('before'), Buffer.from('after')), 'PATH_NOT_ALLOWED'); }
      finally {
        if (kind === 'symlink') { rmSync(path); renameSync(held, path); }
        if (kind === 'hardlink') rmSync(held);
        if (kind === 'unsafe-mode') chmodSync(path, 0o600);
      }
    }
    expect(port.read(knowledge)).toEqual(Buffer.from('before')); expect(port.readRecovery(stage)).toEqual(Buffer.from('after'));
  });

  it('rejects overlapping, linked or nonprivate recovery and detects replacement after opening', () => {
    const f = fixture();
    for (const path of [f.root, f.recovery, f.base]) code(() => open(f.archive, path), 'PATH_NOT_ALLOWED');
    chmodSync(f.ingestionRecovery, 0o755);
    code(() => open(f.archive, f.ingestionRecovery), 'PATH_NOT_ALLOWED'); chmodSync(f.ingestionRecovery, 0o700);
    symlinkSync(f.ingestionRecovery, join(f.base, 'link'));
    code(() => open(f.archive, join(f.base, 'link')), 'PATH_NOT_ALLOWED');
    const port = open(f.archive, f.ingestionRecovery);
    renameSync(f.ingestionRecovery, `${f.ingestionRecovery}-held`); mkdirSync(f.ingestionRecovery, { mode: 0o700 });
    code(() => port.listRecovery(), 'RECOVERY_IDENTITY_CHANGED');
  });

  it('detects changed root identity and refuses symlinks in the complete destination chain', () => {
    const f = fixture(), port = open(f.archive, f.ingestionRecovery);
    const parent = join(f.root, '02知识库/01AI/AI基础');
    renameSync(parent, `${parent}-held`); symlinkSync(`${parent}-held`, parent);
    code(() => port.read(knowledge), 'PATH_NOT_ALLOWED');
    renameSync(f.root, `${f.root}-held`); mkdirSync(f.root);
    code(() => port.read(source), 'ROOT_IDENTITY_CHANGED');
  });

  it('bounds stage bytes, rejects nonstage apply and invalidates child when archive closes', () => {
    const f = fixture(), port = open(f.archive, f.ingestionRecovery);
    code(() => port.writeRecovery(stage, Buffer.alloc(10 * 1024 * 1024 + 1)), 'FILE_TOO_LARGE');
    code(() => port.apply(knowledge, intent, null, Buffer.from('after')), 'PATH_NOT_ALLOWED');
    code(() => port.writeRecovery('../escape', Buffer.from('x')), 'PATH_NOT_ALLOWED');
    f.archive.close(); code(() => port.read(knowledge), 'HANDLE_CLOSED');
    port.close(); port.close();
  });

  it('keeps native ingestion and archive handles mutually noninterchangeable', () => {
    const f = fixture(); f.archive.close();
    const native = createRequire(import.meta.url)(addon);
    const archive = native.openPersonal(f.root, f.recovery), ingestion = native.openIngestion(archive, f.ingestionRecovery);
    try {
      code(() => native.ingestionRead(archive, knowledge), 'INVALID_ARGUMENT');
      code(() => native.read(ingestion, '01图书馆/小兆clipper/test/main.md'), 'INVALID_ARGUMENT');
      code(() => native.swapMain(ingestion, '01图书馆/小兆clipper/test/main.md', stage, {}, {}), 'INVALID_ARGUMENT');
      code(() => native.openIngestion(ingestion, f.recovery), 'INVALID_ARGUMENT');
    } finally { native.ingestionClose(ingestion); native.close(archive); }
  });

  it.each(['replace-before', 'create-before', 'replace-after'])('preserves external versions when %s races the actual rename syscall', async (mode) => {
    const f = fixture(); f.archive.close();
    const dylib = join(f.base, 'race.dylib');
    await promisify(execFile)('xcrun', ['clang', '-Wall', '-Wextra', '-Werror', '-dynamiclib',
      resolve('tests/native/fixtures/ingestion-race-interposer.c'), '-o', dylib]);
    const before = mode === 'create-before' ? null : Buffer.from('before');
    if (before) writeFileSync(join(f.root, knowledge), before, { mode: 0o600 });
    const script = `
      const native = require(process.argv[1]);
      const archive = native.openPersonal(process.argv[2], process.argv[3]);
      const ingestion = native.openIngestion(archive, process.argv[4]);
      native.ingestionWriteRecovery(ingestion, process.argv[5], Buffer.from('after'));
      try {
        native.ingestionApply(ingestion, process.argv[6], process.argv[5],
          process.env.INGESTION_CONTRACT_RACE === 'create-before' ? null : Buffer.from('before'), Buffer.from('after'));
        process.stdout.write('UNEXPECTED_SUCCESS');
      } catch (error) { process.stdout.write(error.code); }
      finally { native.ingestionClose(ingestion); native.close(archive); }
    `;
    const result = await promisify(execFile)(process.execPath, ['-e', script, addon, f.root, f.recovery, f.ingestionRecovery, stage, knowledge], {
      env: { ...process.env, DYLD_INSERT_LIBRARIES: dylib, INGESTION_CONTRACT_RACE: mode }
    });
    expect(result.stdout).toBe(mode === 'create-before' ? 'TARGET_EXISTS' : 'INGESTION_NEEDS_REVIEW');
    const destination = readFileSync(join(f.root, knowledge), 'utf8'), recovered = readFileSync(join(f.ingestionRecovery, stage), 'utf8');
    if (mode === 'replace-before') {
      expect(destination).toBe('after'); expect(recovered).toBe('external-before');
      expect(readFileSync(join(dirname(join(f.root, knowledge)), 'external-held.md'), 'utf8')).toBe('before');
    } else if (mode === 'create-before') {
      expect(destination).toBe('external-create'); expect(recovered).toBe('after');
    } else {
      expect(destination).toBe('external-after'); expect(recovered).toBe('before');
      expect(readFileSync(join(dirname(join(f.root, knowledge)), 'external-held.md'), 'utf8')).toBe('after');
    }
  });
});
