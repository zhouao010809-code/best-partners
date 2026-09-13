import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SandboxArchivePort } from '../../src/server/archive/sandbox-native.js';

const sentinel = '{"purpose":"archive-test-v1"}\n';
const source = '01图书馆/小兆clipper/package';
const target = '01图书馆/来自个人/2026-09/package';
const intentName = '24a60c8b-307a-4e80-8a70-5b6670c1d852.intent.json';
const fixtures: string[] = [];
const handles: SandboxArchivePort[] = [];
let openArchive: ((root: string, addon: string) => SandboxArchivePort) | undefined;
let addon: Record<string, (...args: unknown[]) => unknown>;
const addonPath = resolve('dist/native/sandbox-archive.node');

function fixture(): string {
  const root = mkdtempSync('/private/tmp/xiaozhao-archive-test-');
  fixtures.push(root);
  chmodSync(root, 0o700);
  writeFileSync(join(root, '.xiaozhao-archive-test.json'), sentinel, { mode: 0o600, flag: 'wx' });
  mkdirSync(join(root, '.archive-recovery'), { mode: 0o700 });
  mkdirSync(join(root, source), { recursive: true });
  mkdirSync(join(root, dirname(target)), { recursive: true });
  return root;
}
function open(root: string): SandboxArchivePort {
  expect(openArchive, 'sandbox archive adapter must provide the native contract').toBeTypeOf('function');
  const handle = openArchive!(root, addonPath);
  handles.push(handle);
  return handle;
}
function code(action: () => unknown, expected: string): void {
  expect(action).toThrow(expect.objectContaining({ code: expected }));
}

beforeAll(async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('NATIVE_TEST_REQUIRES_MACOS_ARM64');
  if (!existsSync(resolve('scripts/build-sandbox-archive.ts'))) return;
  await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/build-sandbox-archive.ts']);
  await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/build-sandbox-archive.ts', '--test-hooks']);
  openArchive = (await import('../../src/server/archive/sandbox-native.js')).openSandboxArchive;
  addon = createRequire(import.meta.url)(addonPath);
});
afterAll(() => {
  for (const handle of handles) handle.close();
  for (const root of fixtures.reverse()) {
    // Cleanup only roots created above, with a checked canonical path and exact marker.
    if (dirname(root) !== '/private/tmp' || !basename(root).startsWith('xiaozhao-archive-test-')
      || realpathSync(root) !== root || !lstatSync(root).isDirectory()
      || readFileSync(join(root, '.xiaozhao-archive-test.json'), 'utf8') !== sentinel) {
      throw new Error('REFUSE_UNVERIFIED_TEST_CLEANUP');
    }
    rmSync(root, { recursive: true });
  }
});

describe('sandbox native archive contract', () => {
  it('preserves raw body, attachments, hidden files, empty directories and source inode', () => {
    const root = fixture();
    const body = Buffer.from('\ufeff---\r\n原始标题: 中文\r\n---\r\n末行');
    const attachment = Buffer.from([0, 255, 127, 10]);
    writeFileSync(join(root, source, 'body.md'), body);
    writeFileSync(join(root, source, '.hidden'), attachment);
    mkdirSync(join(root, source, '附件'));
    writeFileSync(join(root, source, '附件', '原始.bin'), attachment);
    mkdirSync(join(root, source, 'empty'));
    const port = open(root);
    expect(port.root).toBe(root);
    expect(port.rootIdentity).toEqual({ dev: String(lstatSync(root).dev), ino: String(lstatSync(root).ino) });
    const before = port.stat(source)!;
    expect(port.stat(dirname(source))?.kind).toBe('directory');
    expect(port.stat(dirname(target))?.kind).toBe('directory');
    expect(port.read(`${source}/body.md`)).toEqual(body);
    expect(port.list(source).map((entry) => entry.name).sort()).toEqual(['.hidden', 'body.md', 'empty', '附件']);
    port.move(source, target, before);
    expect(port.stat(source)).toBeNull();
    expect(port.stat(target)).toMatchObject({ dev: before.dev, ino: before.ino, kind: 'directory' });
    expect(port.read(`${target}/body.md`)).toEqual(body);
    expect(port.read(`${target}/附件/原始.bin`)).toEqual(attachment);
    expect(port.read(`${target}/.hidden`)).toEqual(attachment);
    expect(port.list(`${target}/empty`)).toEqual([]);
    port.syncParents(source, target);
  });

  it('preserves both packages on destination collision', () => {
    const root = fixture();
    writeFileSync(join(root, source, 'body.md'), 'source');
    mkdirSync(join(root, target));
    writeFileSync(join(root, target, 'body.md'), 'target');
    const port = open(root);
    code(() => port.move(source, target, port.stat(source)!), 'TARGET_EXISTS');
    expect(port.read(`${source}/body.md`).toString()).toBe('source');
    expect(port.read(`${target}/body.md`).toString()).toBe('target');
  });

  it('allows the archive package directory to acquire its final name while preserving members', () => {
    const root = fixture(); const port = open(root);
    writeFileSync(join(root, source, 'body.md'), 'exact original body');
    const renamed = '01图书馆/来自个人/2026-09/20260905｜个人｜资料包';
    const before = port.stat(source)!;
    port.move(source, renamed, before);
    expect(port.stat(source)).toBeNull();
    expect(port.stat(renamed)).toMatchObject({ dev: before.dev, ino: before.ino });
    expect(port.read(`${renamed}/body.md`).toString()).toBe('exact original body');
  });

  it('refuses changed source identity and does not create missing destination months', () => {
    const root = fixture(); const port = open(root); const identity = port.stat(source)!;
    code(() => port.move(source, target, { ...identity, ino: `${BigInt(identity.ino) + 1n}` }), 'SOURCE_IDENTITY_CHANGED');
    code(() => port.move(source, target.replace('2026-09', '2026-10'), identity), 'NOT_FOUND');
    expect(existsSync(join(root, '01图书馆/来自个人/2026-10'))).toBe(false);
    expect(port.stat(source)).toMatchObject(identity);
  });

  it('enforces layout, enum, month, traversal, malformed Unicode and package-only reads in native code', () => {
    const root = fixture(); const port = open(root);
    const invalid = ['/etc/passwd', '', '01图书馆//小兆clipper/package', `${source}/../x`, `${source}/./x`, `${source}/a\\b`, `${source}/a\0b`, `${source}/\ud800`, '02知识库/a.md', '01图书馆/来自不存在/2026-09/package/a', '01图书馆/来自个人/2026-13/package/a'];
    for (const relative of invalid) code(() => port.read(relative), 'PATH_NOT_ALLOWED');
    code(() => port.list(dirname(source)), 'PATH_NOT_ALLOWED');
    code(() => port.read(dirname(target)), 'PATH_NOT_ALLOWED');
    code(() => port.move(target, source, port.stat(source)!), 'PATH_NOT_ALLOWED');
    code(() => addon.open!(root), 'ROOT_LOCKED');
    port.close();
    const raw = addon.open!(root);
    try { for (const relative of invalid) code(() => addon.read!(raw, relative), 'PATH_NOT_ALLOWED'); }
    finally { addon.close!(raw); }
  });

  it('rejects a formal root and unsafe fixture marker or permissions before data access', () => {
    open(fixture()).close();
    code(() => open('/Users/ao/我的大脑'), 'PATH_NOT_ALLOWED');
    const root = fixture();
    chmodSync(root, 0o755);
    try { code(() => open(root), 'PATH_NOT_ALLOWED'); } finally { chmodSync(root, 0o700); }
    writeFileSync(join(root, '.xiaozhao-archive-test.json'), '{}');
    try { code(() => open(root), 'PATH_NOT_ALLOWED'); }
    finally { writeFileSync(join(root, '.xiaozhao-archive-test.json'), sentinel); }
    chmodSync(join(root, '.archive-recovery'), 0o755);
    try { code(() => open(root), 'PATH_NOT_ALLOWED'); }
    finally { chmodSync(join(root, '.archive-recovery'), 0o700); }
  });

  it('requires the exact sentinel-root basename prefix', () => {
    const root = fixture();
    const invalid = root.replace('xiaozhao-archive-test-', 'xiaozhao-archive-testX');
    renameSync(root, invalid);
    try { code(() => open(invalid), 'PATH_NOT_ALLOWED'); }
    finally { renameSync(invalid, root); }
  });

  it('rejects root symlinks and a hardlinked marker', () => {
    const root = fixture(); const outside = fixture(); const held = `${root}-held`;
    renameSync(root, held); symlinkSync(outside, root);
    try { code(() => open(root), 'PATH_NOT_ALLOWED'); }
    finally { rmSync(root); renameSync(held, root); }
    const markerAlias = join(outside, source, 'marker-alias');
    linkSync(join(root, '.xiaozhao-archive-test.json'), markerAlias);
    try { code(() => open(root), 'PATH_NOT_ALLOWED'); }
    finally { rmSync(markerAlias); }
  });

  it('rejects foreign handles and missing native arguments without crashing', () => {
    const port = open(fixture());
    for (const value of [undefined, null, {}, 0, 'handle']) {
      code(() => addon.close!(value), 'INVALID_ARGUMENT');
      code(() => addon.stat!(value, source), 'INVALID_ARGUMENT');
    }
    code(() => addon.open!(), 'INVALID_ARGUMENT');
    for (const value of [undefined, null, 0, 'identity']) {
      code(() => port.move(source, target, value as never), 'INVALID_ARGUMENT');
    }
  });

  it.each(['file-symlink', 'parent-symlink', 'hardlink', 'fifo'] as const)('refuses %s in reads and whole-package moves', async (kind) => {
    const root = fixture(); const other = fixture(); const port = open(root);
    writeFileSync(join(other, source, 'outside'), 'outside');
    const unsafe = join(root, source, 'unsafe');
    if (kind === 'file-symlink') symlinkSync(join(other, source, 'outside'), unsafe);
    if (kind === 'parent-symlink') symlinkSync(join(other, source), unsafe);
    if (kind === 'hardlink') linkSync(join(other, source, 'outside'), unsafe);
    if (kind === 'fifo') await promisify(execFile)('/usr/bin/mkfifo', [unsafe]);
    expect(() => port.read(`${source}/unsafe${kind === 'parent-symlink' ? '/outside' : ''}`)).toThrow();
    expect(() => port.list(source)).toThrow();
    expect(() => port.move(source, target, port.stat(source)!)).toThrow();
    expect(existsSync(join(root, source))).toBe(true);
    expect(existsSync(join(root, target))).toBe(false);
    expect(readFileSync(join(other, source, 'outside'), 'utf8')).toBe('outside');
  });

  it('rejects oversized file reads with bounded allocation', () => {
    const root = fixture(); const port = open(root);
    writeFileSync(join(root, source, 'large'), Buffer.alloc(10 * 1024 * 1024 + 1));
    code(() => port.read(`${source}/large`), 'FILE_TOO_LARGE');
  });

  it('supports exactly 20,000 directory members and rejects overflow', () => {
    const root = fixture(); const port = open(root);
    for (let index = 0; index < 20_000; index++) writeFileSync(join(root, source, `${index}.md`), '');
    expect(port.list(source)).toHaveLength(20_000);
    writeFileSync(join(root, source, 'overflow'), '');
    code(() => port.list(source), 'DIRECTORY_TOO_LARGE');
    code(() => port.move(source, target, port.stat(source)!), 'DIRECTORY_TOO_LARGE');
    expect(existsSync(join(root, source))).toBe(true);
  });

  it('keeps all members readable at the supported package-relative depth of 64', () => {
    const root = fixture(); const port = open(root);
    const relativeParent = Array.from({ length: 63 }, () => 'd').join('/');
    mkdirSync(join(root, source, relativeParent), { recursive: true });
    mkdirSync(join(root, source, relativeParent, 'empty'));
    writeFileSync(join(root, source, relativeParent, 'body'), 'original');
    port.move(source, target, port.stat(source)!);
    expect(port.read(`${target}/${relativeParent}/body`).toString()).toBe('original');
    expect(port.list(`${target}/${relativeParent}/empty`)).toEqual([]);
    expect(port.stat(`${target}/${relativeParent}/body`)?.kind).toBe('file');
  });

  it('rejects destination member paths beyond the byte limit before moving any data', () => {
    const root = fixture(); const port = open(root);
    let remaining = 1023 - Buffer.byteLength(source) - 1;
    const parts: string[] = [];
    while (remaining > 255) { parts.push('a'.repeat(250)); remaining -= 251; }
    parts.push('z'.repeat(remaining));
    const relative = parts.join('/'); const sourceMember = `${source}/${relative}`;
    const longTarget = target.replace('package', 'a-much-longer-archive-package-name');
    expect(Buffer.byteLength(sourceMember)).toBe(1023);
    expect(Buffer.byteLength(`${longTarget}/${relative}`)).toBeGreaterThan(1023);
    // Relative calls create an addressable descriptor-walk fixture without
    // asking a single filesystem call to resolve an absolute path over PATH_MAX.
    const cwd = process.cwd();
    try {
      process.chdir(root);
      mkdirSync(dirname(sourceMember), { recursive: true });
      writeFileSync(sourceMember, 'original');
    } finally { process.chdir(cwd); }
    try {
      expect(port.read(sourceMember).toString()).toBe('original');
      const before = port.stat(source)!;
      code(() => port.move(source, longTarget, before), 'PATH_NOT_ALLOWED');
      expect(port.stat(source)).toMatchObject(before);
      expect(port.stat(longTarget)).toBeNull();
      expect(port.read(sourceMember).toString()).toBe('original');
    } finally {
      // Even the intentionally failing implementation may have renamed the
      // package. Remove this known test leaf with a short relative pathname.
      const packagePath = existsSync(join(root, source)) ? source : longTarget;
      process.chdir(join(root, packagePath, dirname(relative)));
      try { rmSync(basename(relative)); } finally { process.chdir(cwd); }
    }
  });

  it.each(['before-rename', 'after-rename', 'after-sync'] as const)('preserves evidence and reports review when source changes at %s', async (stage) => {
    const root = fixture();
    writeFileSync(join(root, source, 'body.md'), 'original');
    const addonWithHooks = resolve('dist/native/sandbox-archive-test.node');
    const child = spawn(process.execPath, ['-e', `
      const native = require(process.argv[1]);
      const handle = native.open(process.argv[2]);
      try {
        const original = native.stat(handle, ${JSON.stringify(source)});
        native.move(handle, ${JSON.stringify(source)}, ${JSON.stringify(target)}, original);
        process.stdout.write(JSON.stringify({ moved: true }));
      } catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }
      finally { native.close(handle); }
    `, addonWithHooks, root], { env: { ...process.env, SANDBOX_ARCHIVE_TEST_PAUSE: stage }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = []; child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    const completion = new Promise((resolveExit) => child.once('close', resolveExit));
    try {
      const paused = await new Promise<boolean>((resolvePause) => {
        const timer = setTimeout(() => resolvePause(false), 3000);
        child.once('close', () => { clearTimeout(timer); resolvePause(false); });
        child.stderr.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes(`PAUSED:${stage}`)) { clearTimeout(timer); resolvePause(true); }
        });
      });
      expect(paused, 'native test hook must expose the requested race boundary').toBe(true);
      const swappedPath = stage === 'before-rename' ? source : target;
      renameSync(join(root, swappedPath), join(root, `${swappedPath}-original`));
      mkdirSync(join(root, swappedPath));
      writeFileSync(join(root, swappedPath, 'body.md'), 'replacement');
      child.stdin.end('continue');
      await completion;
      expect(JSON.parse(Buffer.concat(output).toString())).toEqual({ code: 'MOVED_NEEDS_REVIEW' });
      expect(readFileSync(join(root, `${swappedPath}-original`, 'body.md'), 'utf8')).toBe('original');
      expect(readFileSync(join(root, target, 'body.md'), 'utf8')).toBe('replacement');
    } finally { child.kill('SIGKILL'); await completion; }
  });

  it('detects a destination parent changed during move and never follows its replacement symlink', async () => {
    const root = fixture(); const outside = fixture();
    writeFileSync(join(root, source, 'body.md'), 'original');
    const outsideParent = join(outside, dirname(target));
    writeFileSync(join(outsideParent, 'outside'), 'outside');
    const child = spawn(process.execPath, ['-e', `
      const native = require(process.argv[1]);
      const handle = native.open(process.argv[2]);
      try { native.move(handle, ${JSON.stringify(source)}, ${JSON.stringify(target)}, native.stat(handle, ${JSON.stringify(source)})); }
      catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }
      finally { native.close(handle); }
    `, resolve('dist/native/sandbox-archive-test.node'), root], {
      env: { ...process.env, SANDBOX_ARCHIVE_TEST_PAUSE: 'before-rename' }, stdio: ['pipe', 'pipe', 'pipe']
    });
    const output: Buffer[] = []; child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    const completion = new Promise((resolveExit) => child.once('close', resolveExit));
    const parent = join(root, dirname(target)); const held = join(root, '.held-target-parent');
    let replaced = false;
    try {
      const paused = await new Promise<boolean>((resolvePause) => {
        const timer = setTimeout(() => resolvePause(false), 3000);
        child.once('close', () => { clearTimeout(timer); resolvePause(false); });
        child.stderr.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('PAUSED:before-rename')) { clearTimeout(timer); resolvePause(true); }
        });
      });
      expect(paused).toBe(true);
      renameSync(parent, held); symlinkSync(outsideParent, parent); replaced = true;
      child.stdin.end('continue'); await completion;
      expect(JSON.parse(Buffer.concat(output).toString())).toEqual({ code: 'MOVED_NEEDS_REVIEW' });
      expect(readFileSync(join(held, 'package', 'body.md'), 'utf8')).toBe('original');
      expect(readFileSync(join(outsideParent, 'outside'), 'utf8')).toBe('outside');
      expect(existsSync(join(outsideParent, 'package'))).toBe(false);
    } finally {
      child.kill('SIGKILL'); await completion;
      if (replaced) { rmSync(parent); renameSync(held, parent); }
    }
  });

  it('refuses a root pathname replaced after open and releases lock on explicit close', () => {
    const root = fixture(); const replacement = fixture(); const port = open(root);
    code(() => open(root), 'ROOT_LOCKED');
    const held = `${root}-held`;
    renameSync(root, held);
    renameSync(replacement, root);
    try {
      code(() => port.stat(source), 'ROOT_IDENTITY_CHANGED');
      code(() => port.move(source, target, { dev: '1', ino: '1' }), 'ROOT_IDENTITY_CHANGED');
      code(() => port.listRecovery(), 'ROOT_IDENTITY_CHANGED');
    } finally { renameSync(root, replacement); renameSync(held, root); }
    port.close();
    code(() => port.stat(source), 'HANDLE_CLOSED');
    code(() => port.listRecovery(), 'HANDLE_CLOSED');
    port.close();
    expect(open(root).stat(source)?.kind).toBe('directory');
  });

  it('writes exclusive private recovery files, reads exact bytes, rejects aliases and replacement', () => {
    const root = fixture(); const port = open(root); const bytes = Buffer.from('{"body":"原始\\r\\n"}\n');
    expect(port.readRecovery(intentName)).toBeNull();
    port.writeRecovery(intentName, bytes);
    expect(port.readRecovery(intentName)).toEqual(bytes);
    expect(port.listRecovery()).toEqual([intentName]);
    expect(lstatSync(join(root, '.archive-recovery', intentName)).mode & 0o777).toBe(0o600);
    code(() => port.writeRecovery(intentName, Buffer.from('replacement')), 'TARGET_EXISTS');
    expect(port.readRecovery(intentName)).toEqual(bytes);
    for (const name of ['../x', 'x', `${intentName}/a`, intentName.replace('4e80', '3e80'), intentName.replace('intent', 'other')]) {
      code(() => port.writeRecovery(name, bytes), 'PATH_NOT_ALLOWED');
      code(() => port.readRecovery(name), 'PATH_NOT_ALLOWED');
    }
    code(() => port.writeRecovery(intentName.replace('intent', 'result'), Buffer.alloc(32 * 1024 * 1024 + 1)), 'FILE_TOO_LARGE');
    const recovery = join(root, '.archive-recovery'); const held = join(root, '.recovery-held');
    renameSync(recovery, held); mkdirSync(recovery, { mode: 0o700 });
    try { code(() => port.listRecovery(), 'RECOVERY_IDENTITY_CHANGED'); }
    finally { rmdirSync(recovery); renameSync(held, recovery); }
  });

  it('rejects recovery symlinks and hardlinks without reading or overwriting their targets', () => {
    const root = fixture(); const outside = fixture(); const port = open(root);
    const outsideFile = join(outside, source, 'outside');
    writeFileSync(outsideFile, 'outside', { mode: 0o600 });
    const name = join(root, '.archive-recovery', intentName);
    for (const alias of ['symlink', 'hardlink'] as const) {
      if (alias === 'symlink') symlinkSync(outsideFile, name); else linkSync(outsideFile, name);
      try {
        code(() => port.readRecovery(intentName), 'PATH_NOT_ALLOWED');
        code(() => port.listRecovery(), 'PATH_NOT_ALLOWED');
        code(() => port.writeRecovery(intentName, Buffer.from('replacement')), 'TARGET_EXISTS');
        expect(readFileSync(outsideFile, 'utf8')).toBe('outside');
      } finally { rmSync(name); }
    }
  });
});
