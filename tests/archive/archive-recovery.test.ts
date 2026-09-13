import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSandboxArchive, type SandboxArchivePort } from '../../src/server/archive/sandbox-native.js';
import { prepareArchiveMove, executeArchiveMove, recoverArchiveMove } from '../../src/server/archive/archive-coordinator.js';
import { captureArchiveTree, parseArchiveIntent } from '../../src/server/archive/archive-snapshot.js';
import { createArchiveFixture, archiveOperationId as id, archiveSource as source, archiveTarget as target } from '../helpers/archive-fixture.js';

const addon = resolve('dist/native/sandbox-archive.node');
const fixtures: ReturnType<typeof createArchiveFixture>[] = [];
const ports: SandboxArchivePort[] = [];
function fixture() { const value = createArchiveFixture(); fixtures.push(value); return value; }
function open(root: string) { const value = openSandboxArchive(root, addon); ports.push(value); return value; }
afterEach(() => { for (const port of ports.splice(0)) port.close(); for (const value of fixtures.splice(0)) value.cleanup(); });

function worker(root: string, checkpoint: string, insideNative = false) {
  return new Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }>((resolveResult, reject) => {
    const binary = insideNative ? resolve('dist/native/sandbox-archive-test.node') : addon;
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/helpers/archive-crash-worker.ts'), root, binary, checkpoint],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(insideNative ? { SANDBOX_ARCHIVE_TEST_PAUSE: 'after-rename' } : {}) } });
    let stdout = ''; let stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('WORKER_TIMEOUT')); }, 15_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (insideNative && stderr.includes('PAUSED:after-rename')) child.kill('SIGKILL');
    });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timeout); resolveResult({ stdout, stderr, code, signal }); });
  });
}

describe('real native archive and process restart', () => {
  it('moves a complete package and replays the same operation without duplication', () => {
    const value = fixture(); const port = open(value.root);
    const before = captureArchiveTree(port, source);
    prepareArchiveMove(port, { id, source, target });
    const outcome = executeArchiveMove(port, id);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ state: 'moved' });
    expect(executeArchiveMove(port, id)).toMatchObject({ state: 'moved' });
    expect(captureArchiveTree(port, target)).toEqual(before);
    expect(existsSync(join(value.root, source))).toBe(false);
    expect(readFileSync(join(value.root, target, '原文.md'))).toEqual(value.original);
    expect(parseArchiveIntent(port.readRecovery(`${id}.intent.json`)!).tree).toEqual(before);
  });

  it.each(['after-intent', 'after-move', 'before-result'])('recovers after SIGKILL at %s', async (checkpoint) => {
    const value = fixture(); const beforePort = open(value.root);
    const before = captureArchiveTree(beforePort, source); beforePort.close();
    const child = await worker(value.root, checkpoint);
    expect(child, child.stderr).toMatchObject({ stdout: `checkpoint:${checkpoint}\n`, signal: 'SIGKILL' });
    const port = open(value.root);
    expect(recoverArchiveMove(port, id)).toMatchObject({ state: checkpoint === 'after-intent' ? 'not-moved' : 'moved' });
    expect(captureArchiveTree(port, checkpoint === 'after-intent' ? source : target)).toEqual(before);
    expect(parseArchiveIntent(port.readRecovery(`${id}.intent.json`)!).tree).toEqual(before);
    expect(executeArchiveMove(port, id)).toMatchObject({ state: 'moved' });
    expect(captureArchiveTree(port, target)).toEqual(before);
  });

  it('refuses another process while one archive handle holds the root lock', async () => {
    const value = fixture(); open(value.root);
    const child = await worker(value.root, 'lock-only');
    expect(child.code).not.toBe(0); expect(child.stderr).toContain('ROOT_LOCKED');
    expect(existsSync(join(value.root, source))).toBe(true);
  });

  it('reconstructs a process killed inside native rename before parent synchronization', async () => {
    const value = fixture(); const beforePort = open(value.root);
    const before = captureArchiveTree(beforePort, source); beforePort.close();
    const child = await worker(value.root, 'after-move', true);
    expect(child.stderr).toContain('PAUSED:after-rename'); expect(child.signal).toBe('SIGKILL');
    const port = open(value.root);
    expect(recoverArchiveMove(port, id)).toMatchObject({ state: 'moved' });
    expect(captureArchiveTree(port, target)).toEqual(before);
    expect(parseArchiveIntent(port.readRecovery(`${id}.intent.json`)!).tree).toEqual(before);
  });

  it('leaves both trees intact on an existing destination', () => {
    const value = fixture(); const port = open(value.root);
    mkdirSync(join(value.root, target), { mode: 0o700 });
    writeFileSync(join(value.root, target, 'existing.md'), 'existing');
    const before = captureArchiveTree(port, source);
    expect(() => prepareArchiveMove(port, { id, source, target })).toThrow('ARCHIVE_TARGET_EXISTS');
    expect(captureArchiveTree(port, source)).toEqual(before);
    expect(readFileSync(join(value.root, target, 'existing.md'), 'utf8')).toBe('existing');
  });

  it.each(['partial-intent', 'missing-intent', 'changed-bytes', 'both-paths', 'parent-replaced', 'journal-symlink'])('pauses without modifying data on %s', (scenario) => {
    const value = fixture(); const port = open(value.root);
    prepareArchiveMove(port, { id, source, target });
    const intentPath = join(value.root, '.archive-recovery', `${id}.intent.json`);
    if (scenario === 'partial-intent') writeFileSync(intentPath, '{');
    if (scenario === 'missing-intent') renameSync(intentPath, join(value.root, 'retained-intent'));
    if (scenario === 'changed-bytes') writeFileSync(join(value.root, source, '原文.md'), '新版本');
    if (scenario === 'both-paths') mkdirSync(join(value.root, target), { mode: 0o700 });
    if (scenario === 'parent-replaced') {
      renameSync(join(value.root, '01图书馆/来自个人/2026-09'), join(value.root, 'retained-month'));
      mkdirSync(join(value.root, '01图书馆/来自个人/2026-09'), { mode: 0o700 });
    }
    if (scenario === 'journal-symlink') {
      renameSync(intentPath, join(value.root, 'retained-intent'));
      symlinkSync(join(value.root, 'retained-intent'), intentPath);
    }
    const bytes = readFileSync(join(value.root, source, '原文.md'));
    expect(executeArchiveMove(port, id)).toMatchObject({ state: 'needs-review' });
    expect(recoverArchiveMove(port, id)).toMatchObject({ state: 'needs-review' });
    expect(readFileSync(join(value.root, source, '原文.md'))).toEqual(bytes);
  });
});
