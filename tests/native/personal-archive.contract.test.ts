import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PersonalArchivePort } from '../../src/server/archive/sandbox-native.js';

const source = '01图书馆/小兆clipper/package';
const main = `${source}/原始标题.md`;
const stageName = '24a60c8b-307a-4e80-8a70-5b6670c1d852.stage.md';
const marker = '{"purpose":"personal-archive-contract-v1"}\n';
const fixtures: string[] = [];
const handles: PersonalArchivePort[] = [];
const addonPath = resolve('dist/native/personal-archive.node');
let openArchive: ((root: string, recoveryRoot: string, addon: string) => PersonalArchivePort) | undefined;
let native: Record<string, (...args: unknown[]) => unknown>;

function fixture() {
  const base = mkdtempSync('/private/tmp/xiaozhao-personal-archive-test-');
  chmodSync(base, 0o700); fixtures.push(base);
  writeFileSync(join(base, '.test-marker'), marker, { mode: 0o600, flag: 'wx' });
  const root = join(base, 'vault'); const recovery = join(base, 'recovery');
  mkdirSync(root, { mode: 0o755 }); mkdirSync(recovery, { mode: 0o700 });
  for (const name of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂']) mkdirSync(join(root, name));
  mkdirSync(join(root, source), { recursive: true });
  mkdirSync(join(root, '01图书馆/来自个人'));
  return { base, root, recovery };
}
function open(root: string, recovery: string) {
  expect(openArchive, 'personal archive adapter must implement the isolated personal API').toBeTypeOf('function');
  const handle = openArchive!(root, recovery, addonPath); handles.push(handle); return handle;
}
function code(action: () => unknown, expected: string) {
  expect(action).toThrow(expect.objectContaining({ code: expected }));
}
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/build-sandbox-archive.ts', '--personal']);
  const adapter = await import('../../src/server/archive/sandbox-native.js');
  if (!('openPersonalArchive' in adapter)) return;
  openArchive = adapter.openPersonalArchive;
  native = createRequire(import.meta.url)(addonPath);
});
afterAll(() => {
  for (const handle of handles) handle.close();
  for (const base of fixtures.reverse()) {
    if (dirname(base) !== '/private/tmp' || !basename(base).startsWith('xiaozhao-personal-archive-test-')
      || realpathSync(base) !== base || !lstatSync(base).isDirectory()
      || readFileSync(join(base, '.test-marker'), 'utf8') !== marker) throw new Error('REFUSE_UNVERIFIED_PERSONAL_TEST_CLEANUP');
    rmSync(base, { recursive: true });
  }
});

describe('personal archive native contract using independent temporary vaults only', () => {
  it('opens an owned ordinary root and private external recovery while retaining sandbox-only open', () => {
    const { root, recovery } = fixture(); const port = open(root, recovery);
    expect(port.rootIdentity).toEqual({ dev: String(lstatSync(root).dev), ino: String(lstatSync(root).ino) });
    expect(port.listIntake()).toEqual([{ name: 'package', kind: 'directory' }]);
    code(() => native.open!(root), 'PATH_NOT_ALLOWED');
    code(() => open(root, recovery), 'ROOT_LOCKED');
    port.close(); expect(open(root, recovery).stat(source)?.kind).toBe('directory');
  });

  it('cannot produce a personal build with test hooks and contains no pause environment entry', async () => {
    open(fixture().root, fixture().recovery).close();
    await expect(promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/build-sandbox-archive.ts', '--personal', '--test-hooks']))
      .rejects.toThrow('PERSONAL_ARCHIVE_MUST_NOT_INCLUDE_TEST_HOOKS');
    expect(readFileSync(addonPath).includes(Buffer.from('SANDBOX_ARCHIVE_TEST_PAUSE'))).toBe(false);
  });

  it('refuses overlapping recovery, missing core folders, symlinks and unsafe recovery permissions', () => {
    const { root, recovery } = fixture();
    code(() => open(root, root), 'PATH_NOT_ALLOWED');
    mkdirSync(join(root, 'recovery'), { mode: 0o700 });
    code(() => open(root, join(root, 'recovery')), 'PATH_NOT_ALLOWED');
    const core = join(root, '02知识库'); rmdirSync(core);
    try { code(() => open(root, recovery), 'PATH_NOT_ALLOWED'); } finally { mkdirSync(core); }
    chmodSync(recovery, 0o755);
    try { code(() => open(root, recovery), 'PATH_NOT_ALLOWED'); } finally { chmodSync(recovery, 0o700); }
    renameSync(recovery, `${recovery}-held`); symlinkSync(`${recovery}-held`, recovery);
    try { code(() => open(root, recovery), 'PATH_NOT_ALLOWED'); }
    finally { rmSync(recovery); renameSync(`${recovery}-held`, recovery); }
  });

  it('detects external recovery pathname replacement and root replacement after opening', () => {
    const { root, recovery } = fixture(); const port = open(root, recovery);
    renameSync(recovery, `${recovery}-held`); mkdirSync(recovery, { mode: 0o700 });
    try { code(() => port.listRecovery(), 'RECOVERY_IDENTITY_CHANGED'); }
    finally { rmdirSync(recovery); renameSync(`${recovery}-held`, recovery); }
    renameSync(root, `${root}-held`); mkdirSync(root);
    try { code(() => port.listIntake(), 'ROOT_IDENTITY_CHANGED'); }
    finally { rmdirSync(root); renameSync(`${root}-held`, root); }
  });

  it('creates only an allowed pre-existing source platform month and preserves existing directories', () => {
    const { root, recovery } = fixture(); const port = open(root, recovery);
    port.ensureMonth('个人', '2026-09');
    const month = join(root, '01图书馆/来自个人/2026-09');
    const before = lstatSync(month);
    expect(before.mode & 0o777).toBe(0o700);
    port.ensureMonth('个人', '2026-09');
    expect(lstatSync(month).ino).toBe(before.ino);
    code(() => port.ensureMonth('个人/../知识库', '2026-09'), 'PATH_NOT_ALLOWED');
    code(() => port.ensureMonth('个人', '2026-13'), 'PATH_NOT_ALLOWED');
    code(() => port.ensureMonth('个人', '0000-09'), 'PATH_NOT_ALLOWED');
    code(() => port.ensureMonth('个人', '../2026-09'), 'PATH_NOT_ALLOWED');
    code(() => port.ensureMonth('YouTube', '2026-09'), 'NOT_FOUND');
    expect(existsSync(join(root, '01图书馆/来自YouTube'))).toBe(false);
    writeFileSync(join(root, '01图书馆/来自个人/2026-10'), 'occupied');
    expect(() => port.ensureMonth('个人', '2026-10')).toThrow();
    expect(readFileSync(join(root, '01图书馆/来自个人/2026-10'), 'utf8')).toBe('occupied');
    symlinkSync(recovery, join(root, '01图书馆/来自个人/2026-11'));
    code(() => port.ensureMonth('个人', '2026-11'), 'PATH_NOT_ALLOWED');
  });

  it('creates a bounded exclusive stage and reports its native identity', () => {
    const { recovery, root } = fixture(); const port = open(root, recovery);
    expect(port.statRecovery(stageName)).toBeNull();
    const bytes = Buffer.from('\ufeff---\r\n类型: 原始资料\r\n---\r\n未改正文');
    port.writeRecovery(stageName, bytes);
    expect(port.readRecovery(stageName)).toEqual(bytes);
    expect(port.statRecovery(stageName)).toMatchObject({ kind: 'file', size: bytes.length });
    expect(lstatSync(join(recovery, stageName)).mode & 0o777).toBe(0o600);
    code(() => port.writeRecovery(stageName, Buffer.from('overwrite')), 'TARGET_EXISTS');
    code(() => port.writeRecovery(stageName.replace('24a60c8b', '34a60c8b'), Buffer.alloc(10 * 1024 * 1024 + 1)), 'FILE_TOO_LARGE');
  });

  it('swaps only the direct Markdown main with its prepared stage and retains the original inode and raw bytes', () => {
    const { root, recovery } = fixture(); const port = open(root, recovery);
    const original = Buffer.from('\ufeff原始正文\r\n末行'); const prepared = Buffer.from('---\n类型: 原始资料\n---\n原始正文\r\n末行');
    writeFileSync(join(root, main), original, { mode: 0o644 });
    writeFileSync(join(root, source, 'attachment.bin'), Buffer.from([0, 255]));
    port.writeRecovery(stageName, prepared);
    const originalStat = port.stat(main)!; const preparedStat = port.statRecovery(stageName)!;
    port.swapMain(main, stageName, originalStat, preparedStat);
    expect(port.read(main)).toEqual(prepared);
    expect(port.stat(main)).toMatchObject({ dev: preparedStat.dev, ino: preparedStat.ino });
    expect(port.readRecovery(stageName)).toEqual(original);
    expect(port.statRecovery(stageName)).toMatchObject({ dev: originalStat.dev, ino: originalStat.ino });
    expect(lstatSync(join(recovery, stageName)).mode & 0o777).toBe(0o644);
    expect(port.read(`${source}/attachment.bin`)).toEqual(Buffer.from([0, 255]));
    port.close();
    const reopened = open(root, recovery);
    expect(reopened.readRecovery(stageName)).toEqual(original);
    expect(reopened.statRecovery(stageName)).toMatchObject({ dev: originalStat.dev, ino: originalStat.ino });
    expect(reopened.listRecovery()).toEqual([stageName]);
  });

  it('refuses stale main or stage identities and attachment or knowledge destinations before swapping', () => {
    const { root, recovery } = fixture(); const port = open(root, recovery);
    writeFileSync(join(root, main), 'original'); port.writeRecovery(stageName, Buffer.from('prepared'));
    const original = port.stat(main)!; const stage = port.statRecovery(stageName)!;
    code(() => port.swapMain(main, stageName, { ...original, ino: '0' }, stage), 'SOURCE_IDENTITY_CHANGED');
    code(() => port.swapMain(main, stageName, original, { ...stage, ino: '0' }), 'SOURCE_IDENTITY_CHANGED');
    for (const relative of ['02知识库/note.md', `${source}/attachments/note.md`, `${source}/attachment.bin`, '01图书馆/来自个人/2026-09/package/body.md']) {
      code(() => port.swapMain(relative, stageName, original, stage), 'PATH_NOT_ALLOWED');
    }
    expect(port.read(main).toString()).toBe('original'); expect(port.readRecovery(stageName)?.toString()).toBe('prepared');
  });

  it('renames only a direct Markdown main inside its current clipper package without overwrite', () => {
    const { root, recovery } = fixture(); const port = open(root, recovery);
    const renamed = `${source}/20260905｜个人｜原始标题.md`;
    writeFileSync(join(root, main), 'original'); const original = port.stat(main)!;
    port.renameMain(main, renamed, original);
    expect(port.stat(main)).toBeNull();
    expect(port.stat(renamed)).toMatchObject({ ino: original.ino, dev: original.dev });
    expect(port.read(renamed).toString()).toBe('original');
    writeFileSync(join(root, main), 'collision');
    code(() => port.renameMain(renamed, main, original), 'TARGET_EXISTS');
    code(() => port.renameMain(renamed, `${source}/../other/main.md`, original), 'PATH_NOT_ALLOWED');
    code(() => port.renameMain(renamed, `${source}/image.png`, original), 'PATH_NOT_ALLOWED');
    code(() => port.renameMain(renamed, '01图书馆/小兆clipper/other/new.md', original), 'PATH_NOT_ALLOWED');
    expect(port.read(main).toString()).toBe('collision'); expect(port.read(renamed).toString()).toBe('original');
  });

  it.each(['symlink', 'hardlink', 'writable-by-others'] as const)('refuses unsafe %s stages before any swap', (kind) => {
    const { root, recovery, base } = fixture(); const port = open(root, recovery);
    writeFileSync(join(root, main), 'original');
    port.writeRecovery(stageName, Buffer.from('prepared'));
    const original = port.stat(main)!; const stage = port.statRecovery(stageName)!;
    const path = join(recovery, stageName);
    const held = join(base, 'held-stage');
    if (kind === 'symlink') { renameSync(path, held); symlinkSync(join(root, main), path); }
    if (kind === 'hardlink') linkSync(path, held);
    if (kind === 'writable-by-others') chmodSync(path, 0o666);
    try {
      code(() => port.swapMain(main, stageName, original, stage), 'PATH_NOT_ALLOWED');
      code(() => port.readRecovery(stageName), 'PATH_NOT_ALLOWED');
      code(() => port.statRecovery(stageName), 'PATH_NOT_ALLOWED');
      expect(port.read(main).toString()).toBe('original');
    } finally {
      if (kind === 'symlink') { rmSync(path); renameSync(held, path); }
      if (kind === 'hardlink') rmSync(held);
      if (kind === 'writable-by-others') chmodSync(path, 0o600);
    }
  });
});
