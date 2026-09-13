import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { sha256Bytes } from '../vault/raw-bytes.js';
import { parseLibraryNote } from '../rules/library-schema.js';
import { captureArchiveTree, parseArchiveIntent, sealArchiveIntent, sameArchiveIdentity,
  validateArchivePaths, type ArchiveIntent, type ArchiveTreeEntry } from './archive-snapshot.js';
import type { PersonalArchivePort } from './sandbox-native.js';
import { preserveIntakeBody, type planIntakeMain } from './intake-plan.js';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_RECEIPT_BYTES = 4096;
const receiptSchema = z.strictObject({
  version: z.literal('personal-intake-v1'), id: z.string().regex(ID),
  root: z.strictObject({ dev: z.string().regex(/^(0|[1-9][0-9]{0,19})$/u), ino: z.string().regex(/^(0|[1-9][0-9]{0,19})$/u) }),
  target: z.string().min(1).max(1023), intentSha256: z.string().regex(/^[a-f0-9]{64}$/u), state: z.literal('archived')
});
const schema = z.strictObject({
  version: z.literal('personal-intake-v1'), base: z.string(),
  ruleFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  oldMain: z.string().min(1).max(255), newMain: z.string().min(1).max(255),
  stage: z.strictObject({ dev: z.string().regex(/^\d+$/u), ino: z.string().regex(/^\d+$/u) }),
  newBytes: z.string().max(14 * 1024 * 1024)
});
type Stored = z.infer<typeof schema>;
type Loaded = { value: Stored; base: ArchiveIntent; bytes: Buffer };
export type IntakeArchiveOutcome = { id: string; target: string; state: 'pending' | 'archived' | 'needs-review' };
const identity = (v: { dev: string; ino: string }) => ({ dev: v.dev, ino: v.ino });
const parent = (p: string) => p.slice(0, p.lastIndexOf('/'));
function name(id: string, suffix: 'intent.json' | 'result.json' | 'stage.md') {
  if (!ID.test(id)) throw new Error('INTAKE_ID_INVALID');
  return `${id}.${suffix}`;
}
function originalMain(base: ArchiveIntent, oldMain: string) {
  const entry = base.tree.find((item) => item.path === oldMain);
  if (entry?.kind !== 'file') throw new Error('INTAKE_MAIN_INVALID');
  return entry;
}
function validateStored(value: Stored): ArchiveIntent {
  const base = parseArchiveIntent(Buffer.from(value.base));
  const validMain = (n: string) => !/[\0/\\]/u.test(n) && n.endsWith('.md') && Buffer.byteLength(n) <= 255;
  if (!validMain(value.oldMain) || !validMain(value.newMain)
    || value.newMain !== `${base.target.split('/').at(-1)}.md`
    || value.stage.dev !== base.root.dev) throw new Error('INTAKE_INTENT_INVALID');
  const old = originalMain(base, value.oldMain);
  if (value.newMain !== value.oldMain && base.tree.some((e) => e.path === value.newMain)) throw new Error('INTAKE_MAIN_EXISTS');
  const bytes = Buffer.from(value.newBytes, 'base64');
  if (bytes.toString('base64') !== value.newBytes || bytes.length > 10 * 1024 * 1024) throw new Error('INTAKE_INTENT_INVALID');
  const parsed = parseLibraryNote(bytes, `${base.target}/${value.newMain}`);
  if (!parsed.record || parsed.record.processingStatus !== '已归档' || parsed.record.knowledgeStatus !== '未提炼'
    || parsed.record.generatedKnowledge.length !== 0) throw new Error('INTAKE_MAIN_INVALID');
  const oldBytes = Buffer.from(old.bytesBase64, 'base64');
  const expectedBody = preserveIntakeBody(oldBytes, parsed.record.collectedAt ?? '');
  if (!Buffer.from(parsed.bodyBytes).equals(expectedBody)) throw new Error('INTAKE_BODY_CHANGED');
  return base;
}
function load(port: PersonalArchivePort, id: string): Loaded {
  const bytes = port.readRecovery(name(id, 'intent.json'));
  if (!bytes || bytes.length > 32 * 1024 * 1024) throw new Error('INTAKE_INTENT_MISSING');
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const envelope = z.strictObject({ payload: schema, sha256: z.string() }).parse(JSON.parse(decoded));
  if (JSON.stringify(envelope) !== decoded || envelope.sha256 !== sha256Bytes(Buffer.from(JSON.stringify(envelope.payload)))) {
    throw new Error('INTAKE_INTENT_INVALID');
  }
  const base = validateStored(envelope.payload);
  if (base.id !== id || !sameArchiveIdentity(port.rootIdentity, base.root)) throw new Error('INTAKE_ROOT_CHANGED');
  return { value: envelope.payload, base, bytes };
}
function receipt(loaded: Loaded): Buffer {
  return Buffer.from(JSON.stringify({ version: 'personal-intake-v1', id: loaded.base.id,
    root: identity(loaded.base.root), target: loaded.base.target, intentSha256: sha256Bytes(loaded.bytes), state: 'archived' }));
}
function readReceipt(port: PersonalArchivePort, id: string): z.infer<typeof receiptSchema> | null {
  const file = name(id, 'result.json');
  let before: ReturnType<PersonalArchivePort['statRecovery']>; let bytes: Buffer | null;
  try {
    before = port.statRecovery(file);
    if (!before) return null;
    if (before.size > MAX_RECEIPT_BYTES) throw new Error('INTAKE_RESULT_TOO_LARGE');
    bytes = port.readRecovery(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'FILE_TOO_LARGE') throw new Error('INTAKE_RESULT_TOO_LARGE');
    throw error;
  }
  if (bytes && bytes.length > MAX_RECEIPT_BYTES) throw new Error('INTAKE_RESULT_TOO_LARGE');
  if (!bytes || before.kind !== 'file' || before.size !== bytes.length
    || !sameArchiveIdentity(port.statRecovery(file), before)) throw new Error('INTAKE_RESULT_INVALID');
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const result = receiptSchema.parse(JSON.parse(text));
    if (JSON.stringify(result) !== text || result.id !== id || Buffer.byteLength(result.target) > 1023) throw new Error();
    validateArchivePaths('01图书馆/小兆clipper/history', result.target);
    if (!sameArchiveIdentity(port.rootIdentity, result.root)) throw new Error();
    return result;
  } catch { throw new Error('INTAKE_RESULT_INVALID'); }
}
function hasReceipt(port: PersonalArchivePort, loaded: Loaded): boolean {
  const result = readReceipt(port, loaded.base.id);
  if (result && (result.target !== loaded.base.target || result.intentSha256 !== sha256Bytes(loaded.bytes))) {
    throw new Error('INTAKE_RESULT_INVALID');
  }
  if (result && port.statRecovery(name(loaded.base.id, 'stage.md'))?.kind !== 'file') throw new Error('INTAKE_RECOVERY_REQUIRED');
  return result !== null;
}

/** Completed receipts are history, not a ban on later authorized knowledge-status changes. */
export function listIntakeArchives(port: PersonalArchivePort): IntakeArchiveOutcome[] {
  const names = new Set(port.listRecovery());
  const ids = new Set<string>();
  const results: IntakeArchiveOutcome[] = [];
  for (const file of names) {
    const match = /^(.+)\.(intent\.json|result\.json|stage\.md)$/u.exec(file);
    if (!match || !ID.test(match[1]!)) throw new Error('INTAKE_RECOVERY_REQUIRED');
    const id = match[1]!;
    // A stage may already hold the original inode. Missing its intent is not
    // evidence that exchange never happened, so an orphan always needs review.
    if (!names.has(name(id, 'intent.json')) || !names.has(name(id, 'stage.md'))) throw new Error('INTAKE_RECOVERY_REQUIRED');
    ids.add(id);
  }
  for (const id of ids) {
    for (const suffix of ['intent.json', 'stage.md'] as const) {
      if (port.statRecovery(name(id, suffix))?.kind !== 'file') throw new Error('INTAKE_RECOVERY_REQUIRED');
    }
    const result = readReceipt(port, id);
    if (result) {
      // This compact record is historical display only. Mutation paths below
      // separately bind it to the complete intent; the hash is not a signature.
      results.push({ id, target: result.target, state: 'archived' });
      continue;
    }
    if (names.has(name(id, 'result.json'))) throw new Error('INTAKE_RECOVERY_REQUIRED');
    const loaded = load(port, id);
    let state: IntakeArchiveOutcome['state'] = 'pending';
    try { inspect(port, loaded); } catch { state = 'needs-review'; }
    results.push({ id, target: loaded.base.target, state });
  }
  return results;
}

function assertOtherArchivesComplete(port: PersonalArchivePort, currentId?: string): void {
  for (const operation of listIntakeArchives(port)) {
    if (operation.id === currentId) continue;
    if (operation.state !== 'archived') throw new Error('INTAKE_RECOVERY_REQUIRED');
    // Full binding is intentionally paid only before an actual mutation, not
    // on every inbox poll. A compact display receipt cannot authorize writes.
    if (!hasReceipt(port, load(port, operation.id))) throw new Error('INTAKE_RECOVERY_REQUIRED');
  }
}

export function prepareIntakeArchive(port: PersonalArchivePort, request: {
  source: string; tree: ArchiveTreeEntry[]; plan: ReturnType<typeof planIntakeMain>; ruleFingerprint: string;
}): { id: string; target: string } {
  assertOtherArchivesComplete(port);
  if (!equal(captureArchiveTree(port, request.source), request.tree)) throw new Error('INTAKE_PREVIEW_STALE');
  const p = request.plan;
  // Multi-file packages with renamed Markdown need link-aware review; never rewrite sibling content.
  if (p.mainName !== p.sourceMainName && request.tree.some((e) => e.kind === 'file' && /\.md$/iu.test(e.path) && e.path !== p.sourceMainName)) {
    throw new Error('INTAKE_LINK_REVIEW_REQUIRED');
  }
  port.ensureMonth(p.platform, p.month);
  const target = `01图书馆/来自${p.platform}/${p.month}/${p.packageName}`;
  const sourceParent = port.stat(parent(request.source)); const targetParent = port.stat(parent(target));
  if (sourceParent?.kind !== 'directory' || targetParent?.kind !== 'directory') throw new Error('INTAKE_PARENT_MISSING');
  if (port.stat(target)) throw new Error('INTAKE_TARGET_EXISTS');
  const id = randomUUID();
  const base = sealArchiveIntent({ version: 1, id, root: identity(port.rootIdentity), source: request.source, target,
    sourceParent: identity(sourceParent), targetParent: identity(targetParent), tree: request.tree });
  const draft = schema.parse({ version: 'personal-intake-v1', base: base.toString('utf8'), ruleFingerprint: request.ruleFingerprint,
    oldMain: p.sourceMainName, newMain: p.mainName,
    stage: { dev: port.rootIdentity.dev, ino: '9'.repeat(20) }, newBytes: p.bytes.toString('base64') });
  // The base is itself JSON stored in a JSON string: escaping can expand it.
  // A 20-digit inode and fixed-width digest bound the final native-stage record.
  const upperEnvelope = JSON.stringify({ payload: draft, sha256: '0'.repeat(64) });
  if (Buffer.byteLength(upperEnvelope) > 32 * 1024 * 1024) throw new Error('INTAKE_TOO_LARGE');
  validateStored(draft);
  port.writeRecovery(name(id, 'stage.md'), p.bytes);
  const stage = port.statRecovery(name(id, 'stage.md'));
  if (stage?.kind !== 'file' || !port.readRecovery(name(id, 'stage.md'))?.equals(p.bytes)) throw new Error('INTAKE_STAGE_INVALID');
  const value = schema.parse({ ...draft, stage: identity(stage) });
  validateStored(value);
  const bytes = Buffer.from(JSON.stringify({ payload: value, sha256: sha256Bytes(Buffer.from(JSON.stringify(value))) }));
  if (bytes.length > 32 * 1024 * 1024) throw new Error('INTAKE_TOO_LARGE');
  port.writeRecovery(name(id, 'intent.json'), bytes);
  if (!port.readRecovery(name(id, 'intent.json'))?.equals(bytes)) throw new Error('INTAKE_INTENT_NOT_DURABLE');
  return { id, target };
}

function expectedTree(loaded: Loaded, mainName: string): ArchiveTreeEntry[] {
  return loaded.base.tree.map((entry): ArchiveTreeEntry => entry.path !== loaded.value.oldMain ? entry : {
    path: mainName, kind: 'file', ...loaded.value.stage, bytesBase64: loaded.value.newBytes
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function inspect(port: PersonalArchivePort, loaded: Loaded): 'prepared' | 'swapped' | 'renamed' | 'moved' {
  const { base, value } = loaded;
  for (const [path, expected] of [[parent(base.source), base.sourceParent], [parent(base.target), base.targetParent]] as const) {
    if (!sameArchiveIdentity(port.stat(path), expected)) throw new Error('INTAKE_PARENT_CHANGED');
  }
  const source = port.stat(base.source); const target = port.stat(base.target);
  if ((!source && !target) || (source && target)) throw new Error('INTAKE_STATE_CHANGED');
  const stage = port.statRecovery(name(base.id, 'stage.md')); const bytes = port.readRecovery(name(base.id, 'stage.md'));
  const old = originalMain(base, value.oldMain);
  if (!bytes) throw new Error('INTAKE_STAGE_MISSING');
  const tree = captureArchiveTree(port, source ? base.source : base.target);
  if (source && equal(tree, base.tree) && sameArchiveIdentity(stage, value.stage)
    && bytes.toString('base64') === value.newBytes) return 'prepared';
  if (!sameArchiveIdentity(stage, old) || bytes.toString('base64') !== old.bytesBase64) throw new Error('INTAKE_ORIGINAL_CHANGED');
  if (equal(tree, expectedTree(loaded, value.newMain))) return source ? 'renamed' : 'moved';
  if (source && equal(tree, expectedTree(loaded, value.oldMain))) return 'swapped';
  throw new Error('INTAKE_STATE_CHANGED');
}

/** Resume only the next provably valid phase; never undo or delete a user's files. */
export function executeIntakeArchive(port: PersonalArchivePort, id: string, ruleFingerprint: string): IntakeArchiveOutcome {
  let target = '';
  try {
    const loaded = load(port, id); const { base, value } = loaded; target = base.target;
    if (hasReceipt(port, loaded)) return { id, target, state: 'archived' };
    if (value.ruleFingerprint !== ruleFingerprint) throw new Error('INTAKE_RULES_CHANGED');
    assertOtherArchivesComplete(port, id);
    let phase = inspect(port, loaded);
    if (phase === 'prepared') {
      port.swapMain(`${base.source}/${value.oldMain}`, name(id, 'stage.md'), originalMain(base, value.oldMain), value.stage);
      phase = inspect(port, loaded);
    }
    if (phase === 'swapped') {
      port.renameMain(`${base.source}/${value.oldMain}`, `${base.source}/${value.newMain}`, value.stage);
      phase = inspect(port, loaded);
    }
    if (phase === 'renamed') {
      port.move(base.source, base.target, base.tree[0]!);
      phase = inspect(port, loaded);
    }
    if (phase !== 'moved') throw new Error('INTAKE_STATE_CHANGED');
    port.syncParents(base.source, base.target);
    if (inspect(port, loaded) !== 'moved') throw new Error('INTAKE_STATE_CHANGED');
    port.writeRecovery(name(id, 'result.json'), receipt(loaded));
    if (!hasReceipt(port, loaded)) throw new Error('INTAKE_RESULT_NOT_DURABLE');
    return { id, target, state: 'archived' };
  } catch { return { id, target, state: 'needs-review' }; }
}
