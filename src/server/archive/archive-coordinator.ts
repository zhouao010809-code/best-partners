import { randomUUID } from 'node:crypto';
import { sha256Bytes } from '../vault/raw-bytes.js';
import { captureArchiveTree, parseArchiveIntent, sealArchiveIntent, sameArchiveIdentity,
  validateArchivePaths, type ArchiveIntent } from './archive-snapshot.js';
import type { SandboxArchivePort } from './sandbox-native.js';

export type ArchiveOutcome = { id: string; state: 'not-moved' | 'moved' | 'needs-review'; reason: string };
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const parent = (path: string) => path.slice(0, path.lastIndexOf('/'));
const sameTree = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const identity = (value: { dev: string; ino: string }) => ({ dev: value.dev, ino: value.ino });

function names(id: string) {
  if (!ID.test(id)) throw new Error('ARCHIVE_ID_INVALID');
  return { intent: `${id}.intent.json`, result: `${id}.result.json` };
}

function load(port: SandboxArchivePort, id: string) {
  const bytes = port.readRecovery(names(id).intent);
  if (!bytes) throw new Error('ARCHIVE_INTENT_MISSING');
  const intent = parseArchiveIntent(bytes);
  if (intent.id !== id) throw new Error('ARCHIVE_INTENT_INVALID');
  return { intent, bytes };
}

function resultBytes(id: string, intentBytes: Buffer): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, id, intentSha256: sha256Bytes(intentBytes), state: 'moved' }));
}

function assertParents(port: SandboxArchivePort, intent: ArchiveIntent): void {
  if (!sameArchiveIdentity(port.rootIdentity, intent.root)) throw new Error('ARCHIVE_ROOT_CHANGED');
  for (const [path, expected] of [[parent(intent.source), intent.sourceParent], [parent(intent.target), intent.targetParent]] as const) {
    const actual = port.stat(path);
    if (actual?.kind !== 'directory' || !sameArchiveIdentity(actual, expected)) throw new Error('ARCHIVE_PARENT_CHANGED');
  }
}

function inspect(port: SandboxArchivePort, id: string): ArchiveOutcome {
  const { intent, bytes } = load(port, id);
  assertParents(port, intent);
  const result = port.readRecovery(names(id).result);
  if (result && !result.equals(resultBytes(id, bytes))) throw new Error('ARCHIVE_RESULT_INVALID');
  const source = port.stat(intent.source); const target = port.stat(intent.target);
  if (source !== null && target === null && result === null
    && sameTree(captureArchiveTree(port, intent.source), intent.tree)) {
    assertParents(port, intent);
    if (port.stat(intent.target) !== null) throw new Error('ARCHIVE_STATE_CHANGED');
    return { id, state: 'not-moved', reason: 'SOURCE_INTACT' };
  }
  if (source === null && target !== null
    && sameTree(captureArchiveTree(port, intent.target), intent.tree)) {
    assertParents(port, intent);
    if (port.stat(intent.source) !== null) throw new Error('ARCHIVE_STATE_CHANGED');
    return { id, state: 'moved', reason: 'TARGET_VERIFIED' };
  }
  return { id, state: 'needs-review', reason: 'ARCHIVE_STATE_CHANGED' };
}

function assertNoOtherPending(port: SandboxArchivePort, except: string): void {
  const entries = port.listRecovery();
  for (const entry of entries) {
    const match = /^(.+)\.(intent|result)\.json$/u.exec(entry);
    if (!match || !ID.test(match[1]!) || !entries.includes(`${match[1]}.intent.json`)) throw new Error('ARCHIVE_RECOVERY_REQUIRED');
    if (match[2] === 'intent' && match[1] !== except) {
      try {
        if (!entries.includes(`${match[1]}.result.json`) || inspect(port, match[1]!).state !== 'moved') throw new Error();
      } catch { throw new Error('ARCHIVE_RECOVERY_REQUIRED'); }
    }
  }
}

/** Only the sandbox adapter supplies write authority. No App endpoint calls this. */
export function prepareArchiveMove(port: SandboxArchivePort, request: {
  id?: string; source: string; target: string;
}): ArchiveIntent {
  const id = request.id ?? randomUUID();
  const files = names(id);
  validateArchivePaths(request.source, request.target);
  const existing = port.readRecovery(files.intent);
  if (existing) {
    const intent = parseArchiveIntent(existing);
    if (intent.id !== id || intent.source !== request.source || intent.target !== request.target
      || !sameArchiveIdentity(port.rootIdentity, intent.root)) throw new Error('ARCHIVE_REQUEST_CONFLICT');
    return intent;
  }
  assertNoOtherPending(port, id);
  if (port.readRecovery(files.result)) throw new Error('ARCHIVE_RECOVERY_REQUIRED');
  const sourceParent = port.stat(parent(request.source)); const targetParent = port.stat(parent(request.target));
  if (sourceParent?.kind !== 'directory' || targetParent?.kind !== 'directory') throw new Error('ARCHIVE_PARENT_MISSING');
  if (port.stat(request.target) !== null) throw new Error('ARCHIVE_TARGET_EXISTS');
  const intent: ArchiveIntent = {
    version: 1, id, root: identity(port.rootIdentity), source: request.source, target: request.target,
    sourceParent: identity(sourceParent), targetParent: identity(targetParent), tree: captureArchiveTree(port, request.source)
  };
  assertParents(port, intent);
  if (port.stat(request.target) !== null) throw new Error('ARCHIVE_TARGET_EXISTS');
  const bytes = sealArchiveIntent(intent);
  port.writeRecovery(files.intent, bytes);
  const persisted = port.readRecovery(files.intent);
  if (!persisted?.equals(bytes)) throw new Error('ARCHIVE_INTENT_NOT_DURABLE');
  return parseArchiveIntent(persisted);
}

function failed(id: string, error: unknown): ArchiveOutcome {
  return { id, state: 'needs-review', reason: error instanceof Error ? error.message : 'ARCHIVE_IO_ERROR' };
}

/** Reconstruct from immutable intent and live bytes, never move or roll back data. */
export function recoverArchiveMove(port: SandboxArchivePort, id: string): ArchiveOutcome {
  try {
    const state = inspect(port, id);
    if (state.state !== 'moved') return state;
    const { intent, bytes } = load(port, id);
    port.syncParents(intent.source, intent.target);
    const verified = inspect(port, id);
    if (verified.state !== 'moved') return verified;
    const file = names(id).result;
    if (!port.readRecovery(file)) port.writeRecovery(file, resultBytes(id, bytes));
    if (!port.readRecovery(file)?.equals(resultBytes(id, bytes))) throw new Error('ARCHIVE_RESULT_NOT_DURABLE');
    return inspect(port, id);
  } catch (error) { return failed(id, error); }
}

export function executeArchiveMove(port: SandboxArchivePort, id: string): ArchiveOutcome {
  try {
    assertNoOtherPending(port, id);
    const state = inspect(port, id);
    if (state.state !== 'not-moved') return state.state === 'moved' ? recoverArchiveMove(port, id) : state;
    const { intent } = load(port, id);
    // Native rechecks expected inode and no-follow parents; rename is NOT inode CAS.
    port.move(intent.source, intent.target, identity(intent.tree[0]!));
    const result = recoverArchiveMove(port, id);
    return result.state === 'not-moved' ? { id, state: 'needs-review', reason: 'ARCHIVE_MOVE_NOT_OBSERVED' } : result;
  } catch (error) { return failed(id, error); }
}
