import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createArchiveFixture, archiveSource as source } from '../helpers/archive-fixture.js';
import { openPersonalArchive, type PersonalArchivePort } from '../../src/server/archive/sandbox-native.js';
import { captureArchiveTree } from '../../src/server/archive/archive-snapshot.js';
import { planIntakeMain } from '../../src/server/archive/intake-plan.js';
import { prepareIntakeArchive, executeIntakeArchive, listIntakeArchives } from '../../src/server/archive/intake-archive.js';
import { parseLibraryNote } from '../../src/server/rules/library-schema.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture() {
  const f = createArchiveFixture(); cleanups.push(f.cleanup);
  for (const core of ['00大脑规则', '02知识库', '03大讲堂']) mkdirSync(join(f.root, core), { mode: 0o700 });
  const recovery = mkdtempSync(join(realpathSync(tmpdir()), 'xiaozhao-intake-recovery-'));
  cleanups.push(() => rmSync(recovery, { recursive: true }));
  const open = () => { const p = openPersonalArchive(f.root, recovery, resolve('dist/native/personal-archive.node')); cleanups.push(() => p.close()); return p; };
  const port = open();
  const plan = planIntakeMain({ packageName: '资料包', mainName: '原文.md', bytes: f.original,
    fields: { platform: '个人', title: '资料包', collectedAt: '2026-09-05' } });
  const tree = captureArchiveTree(port, source);
  return { ...f, recovery, port, open, plan, tree };
}
const ruleFingerprint = 'a'.repeat(64);

it('archives canonical metadata while retaining original Markdown and all attachment bytes', () => {
  const f = fixture();
  const intent = prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint });
  expect(executeIntakeArchive(f.port, intent.id, ruleFingerprint)).toMatchObject({ state: 'archived' });
  const final = readFileSync(join(f.root, intent.target, f.plan.mainName));
  expect(parseLibraryNote(final).record).toMatchObject({ processingStatus: '已归档', knowledgeStatus: '未提炼' });
  expect(Buffer.from(parseLibraryNote(final).bodyBytes)).toEqual(Buffer.from(parseLibraryNote(f.original).bodyBytes));
  expect(readFileSync(join(f.recovery, `${intent.id}.stage.md`))).toEqual(f.original);
  expect(readFileSync(join(f.root, intent.target, '附件/原图.bin'))).toEqual(Buffer.from([0,255,1,13,10]));
  expect(executeIntakeArchive(f.port, intent.id, ruleFingerprint)).toMatchObject({ state: 'archived' });
  expect(listIntakeArchives(f.port)).toMatchObject([{ id: intent.id, state: 'archived' }]);
});

it('rejects an arbitrary body prefix before leaving any recovery stage', () => {
  const f = fixture();
  const body = Buffer.from(parseLibraryNote(f.plan.bytes).bodyBytes);
  const plan = { ...f.plan, bytes: Buffer.concat([f.plan.bytes.subarray(0, f.plan.bytes.length - body.length), Buffer.from('未经允许的新正文\n'), body]) };
  expect(() => prepareIntakeArchive(f.port, { source, tree: f.tree, plan, ruleFingerprint })).toThrow('INTAKE_BODY_CHANGED');
  expect(f.port.listRecovery()).toEqual([]);
  expect(readFileSync(join(f.root, source, '原文.md'))).toEqual(f.original);
});

it.each(['swapMain', 'renameMain', 'move'] as const)('recovers retained plugin information after an interruption at %s', (method) => {
  const f = fixture();
  const original = Buffer.from('---\nclipped: 2026-09-05\npublished: 2026-09-04\ndescription: 原始描述\n学习状态: 未学习\n---\n原始正文\n');
  writeFileSync(join(f.root, source, '原文.md'), original);
  const plan = planIntakeMain({ packageName: '资料包', mainName: '原文.md', bytes: original,
    fields: { platform: '个人', title: '资料包', collectedAt: '2026-09-05' } });
  const intent = prepareIntakeArchive(f.port, { source, tree: captureArchiveTree(f.port, source), plan, ruleFingerprint });
  const interrupted = { ...f.port, [method]: (...args: unknown[]) => {
    (f.port[method] as (...args: unknown[]) => void)(...args); throw new Error('INTERRUPTED');
  } } as PersonalArchivePort;
  expect(executeIntakeArchive(interrupted, intent.id, ruleFingerprint).state).toBe('needs-review');
  f.port.close();
  expect(executeIntakeArchive(f.open(), intent.id, ruleFingerprint).state).toBe('archived');
  expect(readFileSync(join(f.root, intent.target, plan.mainName))).toEqual(plan.bytes);
  expect(readFileSync(join(f.recovery, `${intent.id}.stage.md`))).toEqual(original);
});

it.each(['swapMain', 'renameMain', 'move'] as const)('resumes a durable interruption after %s without double-writing', (method) => {
  const f = fixture();
  const intent = prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint });
  const interrupted = { ...f.port, [method]: (...args: unknown[]) => {
    (f.port[method] as (...args: unknown[]) => void)(...args); throw new Error('INTERRUPTED');
  } } as PersonalArchivePort;
  expect(executeIntakeArchive(interrupted, intent.id, ruleFingerprint).state).toBe('needs-review');
  f.port.close();
  expect(executeIntakeArchive(f.open(), intent.id, ruleFingerprint)).toMatchObject({ state: 'archived' });
  expect(readFileSync(join(f.recovery, `${intent.id}.stage.md`))).toEqual(f.original);
});

it('refuses a stale preview before any original mutation', () => {
  const f = fixture(); writeFileSync(join(f.root, source, '附件/原图.bin'), 'changed');
  expect(() => prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint })).toThrow();
  expect(readFileSync(join(f.root, source, '原文.md'))).toEqual(f.original);
});

it('never overwrites an existing destination', () => {
  const f = fixture(); const destination = `01图书馆/来自个人/2026-09/${f.plan.packageName}`;
  mkdirSync(join(f.root, destination), { mode: 0o700 });
  writeFileSync(join(f.root, destination, 'keep.md'), 'keep');
  expect(() => prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint })).toThrow();
  expect(readFileSync(join(f.root, source, '原文.md'))).toEqual(f.original);
  expect(readFileSync(join(f.root, destination, 'keep.md'), 'utf8')).toBe('keep');
});

it('pauses on changed rules or changed source after durable preparation', () => {
  const f = fixture(); const intent = prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint });
  expect(executeIntakeArchive(f.port, intent.id, 'b'.repeat(64)).state).toBe('needs-review');
  writeFileSync(join(f.root, source, '原文.md'), 'new user edit');
  expect(executeIntakeArchive(f.port, intent.id, ruleFingerprint).state).toBe('needs-review');
  expect(readFileSync(join(f.root, source, '原文.md'), 'utf8')).toBe('new user edit');
});

it('does not let incomplete or corrupt journals authorize another archive', () => {
  const f = fixture(); const intent = prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint });
  writeFileSync(join(f.recovery, `${intent.id}.intent.json`), '{');
  expect(() => listIntakeArchives(f.port)).toThrow();
  expect(executeIntakeArchive(f.port, intent.id, ruleFingerprint).state).toBe('needs-review');
  expect(readFileSync(join(f.root, source, '原文.md'))).toEqual(f.original);
});

it('blocks an orphan stage and preserves its bytes for explicit recovery', () => {
  const f = fixture(); const stage = `${randomUUID()}.stage.md`;
  f.port.writeRecovery(stage, f.plan.bytes);
  expect(() => listIntakeArchives(f.port)).toThrow('INTAKE_RECOVERY_REQUIRED');
  expect(() => prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint }))
    .toThrow('INTAKE_RECOVERY_REQUIRED');
  expect(f.port.readRecovery(stage)).toEqual(f.plan.bytes);
  expect(readFileSync(join(f.root, source, '原文.md'))).toEqual(f.original);
});

it('treats an original-inode stage whose intent disappeared as an unresolved recovery', () => {
  const f = fixture(); const intent = prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint });
  const interrupted = { ...f.port, swapMain: (...args: Parameters<PersonalArchivePort['swapMain']>) => {
    f.port.swapMain(...args); throw new Error('INTERRUPTED');
  } };
  expect(executeIntakeArchive(interrupted, intent.id, ruleFingerprint).state).toBe('needs-review');
  renameSync(join(f.recovery, `${intent.id}.intent.json`), join(f.root, 'held-test-intent.json'));
  expect(() => listIntakeArchives(f.port)).toThrow('INTAKE_RECOVERY_REQUIRED');
  expect(f.port.readRecovery(`${intent.id}.stage.md`)).toEqual(f.original);
  expect(f.port.statRecovery(`${intent.id}.stage.md`)?.ino).toBe(f.tree.find((entry) => entry.path === '原文.md')?.ino);
});

it.each(['attachment', 'source-parent', 'target-parent', 'stage-inode'] as const)
  ('refuses further mutation when %s changes after the original was exchanged', (change) => {
    const f = fixture(); const intent = prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint });
    const interrupted = { ...f.port, swapMain: (...args: Parameters<PersonalArchivePort['swapMain']>) => {
      f.port.swapMain(...args); throw new Error('INTERRUPTED');
    } };
    expect(executeIntakeArchive(interrupted, intent.id, ruleFingerprint).state).toBe('needs-review');
    if (change === 'attachment') writeFileSync(join(f.root, source, '附件/原图.bin'), 'producer edit');
    if (change === 'source-parent') {
      const old = join(f.root, '01图书馆/小兆clipper'); const held = join(f.root, '01图书馆/held-clipper');
      renameSync(old, held); mkdirSync(old);
      renameSync(join(held, '资料包'), join(old, '资料包'));
    }
    if (change === 'target-parent') {
      const month = join(f.root, '01图书馆/来自个人/2026-09');
      renameSync(month, `${month}-held`); mkdirSync(month);
    }
    if (change === 'stage-inode') {
      renameSync(join(f.recovery, `${intent.id}.stage.md`), join(f.root, 'held-original.md'));
      writeFileSync(join(f.recovery, `${intent.id}.stage.md`), f.original, { mode: 0o600 });
    }
    let mutations = 0;
    const guarded = { ...f.port,
      swapMain: () => { mutations++; throw new Error('UNEXPECTED_MUTATION'); },
      renameMain: () => { mutations++; throw new Error('UNEXPECTED_MUTATION'); },
      move: () => { mutations++; throw new Error('UNEXPECTED_MUTATION'); },
      writeRecovery: () => { mutations++; throw new Error('UNEXPECTED_MUTATION'); }
    };
    expect(executeIntakeArchive(guarded, intent.id, ruleFingerprint).state).toBe('needs-review');
    expect(mutations).toBe(0);
    expect(readFileSync(join(f.root, source, '原文.md'))).toEqual(f.plan.bytes);
    expect(f.port.readRecovery(`${intent.id}.stage.md`)).toEqual(f.original);
  });

it('keeps a completed receipt historical after a legitimate archived knowledge-status update', () => {
  const f = fixture(); const intent = prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint });
  expect(executeIntakeArchive(f.port, intent.id, ruleFingerprint).state).toBe('archived');
  const file = join(f.root, intent.target, f.plan.mainName);
  const edited = Buffer.from(readFileSync(file, 'utf8').replace('知识入库状态: 未提炼', '知识入库状态: 部分入库')
    .replace('生成知识: []', '生成知识:\n  - "[[02知识库/笔记]]"'));
  expect(parseLibraryNote(edited).record?.knowledgeStatus).toBe('部分入库');
  writeFileSync(file, edited);
  expect(listIntakeArchives(f.port)).toEqual([{ id: intent.id, target: intent.target, state: 'archived' }]);
  expect(executeIntakeArchive(f.port, intent.id, 'b'.repeat(64)).state).toBe('archived');
  expect(readFileSync(file)).toEqual(edited);
});

it('rejects main renaming in a multi-Markdown package before any stage is created', () => {
  const f = fixture(); const sibling = Buffer.from('[[原文]]\r\n');
  writeFileSync(join(f.root, source, '同包笔记.md'), sibling);
  const tree = captureArchiveTree(f.port, source);
  expect(() => prepareIntakeArchive(f.port, { source, tree, plan: f.plan, ruleFingerprint }))
    .toThrow('INTAKE_LINK_REVIEW_REQUIRED');
  expect(f.port.listRecovery()).toEqual([]);
  expect(readFileSync(join(f.root, source, '同包笔记.md'))).toEqual(sibling);
});

it('preserves sibling Markdown when the selected main already has its canonical filename', () => {
  const f = fixture(); const sibling = Buffer.from(`[[${f.plan.mainName.slice(0, -3)}]]\r\n原始同包内容`);
  renameSync(join(f.root, source, '原文.md'), join(f.root, source, f.plan.mainName));
  writeFileSync(join(f.root, source, '同包笔记.md'), sibling);
  const plan = planIntakeMain({ packageName: '资料包', mainName: f.plan.mainName, bytes: f.original,
    fields: { platform: '个人', title: '资料包', collectedAt: '2026-09-05' } });
  const intent = prepareIntakeArchive(f.port, { source, tree: captureArchiveTree(f.port, source), plan, ruleFingerprint });
  let renames = 0;
  const port = { ...f.port, renameMain: () => { renames++; throw new Error('UNEXPECTED_RENAME'); } };
  expect(executeIntakeArchive(port, intent.id, ruleFingerprint).state).toBe('archived');
  expect(renames).toBe(0);
  expect(readFileSync(join(f.root, intent.target, '同包笔记.md'))).toEqual(sibling);
});

it('lists completed history using only bounded receipts and identity stats', () => {
  const f = fixture();
  writeFileSync(join(f.root, source, '附件/large.bin'), Buffer.alloc(1024 * 1024, 42));
  const intent = prepareIntakeArchive(f.port, { source, tree: captureArchiveTree(f.port, source), plan: f.plan, ruleFingerprint });
  expect(executeIntakeArchive(f.port, intent.id, ruleFingerprint).state).toBe('archived');
  const reads: string[] = []; const stats: string[] = []; let bytesRead = 0;
  const bounded = { ...f.port,
    readRecovery: (name: string) => {
      reads.push(name);
      expect(name).toBe(`${intent.id}.result.json`);
      const bytes = f.port.readRecovery(name); bytesRead += bytes?.length ?? 0; return bytes;
    },
    statRecovery: (name: string) => { stats.push(name); return f.port.statRecovery(name); },
    read: () => { throw new Error('HISTORY_MUST_NOT_READ_ARCHIVED_NOTES'); }
  };
  expect(listIntakeArchives(bounded)).toEqual([{ id: intent.id, target: intent.target, state: 'archived' }]);
  expect(reads).toEqual([`${intent.id}.result.json`]);
  expect(bytesRead).toBeLessThanOrEqual(4096);
  expect(stats).toContain(`${intent.id}.intent.json`); expect(stats).toContain(`${intent.id}.stage.md`);
  const receipt = JSON.parse(f.port.readRecovery(`${intent.id}.result.json`)!.toString());
  expect(receipt).toMatchObject({ id: intent.id, root: f.port.rootIdentity, target: intent.target, state: 'archived' });
});

it.each([4097, 32 * 1024 * 1024 + 1])('rejects an oversized %s-byte history receipt before reading its payload', (size) => {
  const f = fixture(); const intent = prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint });
  expect(executeIntakeArchive(f.port, intent.id, ruleFingerprint).state).toBe('archived');
  writeFileSync(join(f.recovery, `${intent.id}.result.json`), Buffer.alloc(size, 32));
  const reads: string[] = [];
  const port = { ...f.port, readRecovery: (name: string) => { reads.push(name); return f.port.readRecovery(name); } };
  expect(() => listIntakeArchives(port)).toThrow('INTAKE_RESULT_TOO_LARGE');
  expect(reads).toEqual([]);
});

it.each(['unknown-field', 'wrong-root', 'wrong-id', 'wrong-target', 'invalid-json', 'invalid-utf8'] as const)
  ('rejects a %s compact receipt without changing archived files', (change) => {
    const f = fixture(); const intent = prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint });
    expect(executeIntakeArchive(f.port, intent.id, ruleFingerprint).state).toBe('archived');
    const path = join(f.recovery, `${intent.id}.result.json`);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (change === 'unknown-field') value.extra = true;
    if (change === 'wrong-root') value.root.ino = '0';
    if (change === 'wrong-id') value.id = randomUUID();
    if (change === 'wrong-target') value.target = '02知识库/not-an-archive';
    writeFileSync(path, change === 'invalid-json' ? Buffer.from('{')
      : change === 'invalid-utf8' ? Buffer.from([255]) : Buffer.from(JSON.stringify(value)));
    expect(() => listIntakeArchives(f.port)).toThrow('INTAKE_RESULT_INVALID');
    expect(executeIntakeArchive(f.port, intent.id, ruleFingerprint).state).toBe('needs-review');
    expect(readFileSync(join(f.root, intent.target, f.plan.mainName))).toEqual(f.plan.bytes);
    expect(f.port.readRecovery(`${intent.id}.stage.md`)).toEqual(f.original);
  });

it.each(['intent.json', 'stage.md'] as const)('requires the historical %s record to remain present', (suffix) => {
  const f = fixture(); const intent = prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint });
  expect(executeIntakeArchive(f.port, intent.id, ruleFingerprint).state).toBe('archived');
  renameSync(join(f.recovery, `${intent.id}.${suffix}`), join(f.root, `held-${suffix}`));
  expect(() => listIntakeArchives(f.port)).toThrow('INTAKE_RECOVERY_REQUIRED');
  expect(executeIntakeArchive(f.port, intent.id, ruleFingerprint).state).toBe('needs-review');
  expect(readFileSync(join(f.root, intent.target, f.plan.mainName))).toEqual(f.plan.bytes);
});

it('never lets an unbound compact historical receipt authorize a new mutation', () => {
  const f = fixture(); const intent = prepareIntakeArchive(f.port, { source, tree: f.tree, plan: f.plan, ruleFingerprint });
  expect(executeIntakeArchive(f.port, intent.id, ruleFingerprint).state).toBe('archived');
  const result = join(f.recovery, `${intent.id}.result.json`);
  const receipt = JSON.parse(readFileSync(result, 'utf8')); receipt.intentSha256 = '0'.repeat(64);
  writeFileSync(result, JSON.stringify(receipt));
  expect(executeIntakeArchive(f.port, intent.id, ruleFingerprint).state).toBe('needs-review');
  mkdirSync(join(f.root, source)); writeFileSync(join(f.root, source, '原文.md'), f.original);
  const tree = captureArchiveTree(f.port, source);
  expect(() => prepareIntakeArchive(f.port, { source, tree, plan: f.plan, ruleFingerprint })).toThrow('INTAKE_RESULT_INVALID');
  expect(readFileSync(join(f.root, source, '原文.md'))).toEqual(f.original);
});

it('rejects nested JSON escaping overflow before creating any recovery file', () => {
  const f = fixture(); const dev = f.port.rootIdentity.dev;
  type Node = { dev: string; ino: string; kind: 'file' | 'directory'; size: number; bytes?: Buffer };
  const nodes = new Map<string, Node>([[source, { ...f.port.stat(source)!, size: 0 }]]);
  const children = new Map<string, { name: string; kind: 'file' | 'directory' }[]>([[source, []]]);
  function add(parent: string, name: string, kind: 'file' | 'directory', ino: string, bytes?: Buffer) {
    const path = `${parent}/${name}`;
    nodes.set(path, { dev, ino, kind, size: bytes?.length ?? 0, ...(bytes ? { bytes } : {}) });
    children.get(parent)!.push({ name, kind });
    if (kind === 'directory') children.set(path, []);
    return path;
  }
  add(source, '原文.md', 'file', '400000', f.original);
  let directory = source;
  for (let index = 0; index < 3; index++) directory = add(directory, '\u0001'.repeat(160), 'directory', String(400001 + index));
  for (let index = 0; index < 9995; index++) add(directory, `${String(index).padStart(5, '0')}${'a'.repeat(115)}`, 'file', String(500000 + index), Buffer.alloc(0));
  let writes = 0;
  // The overflow depends only on serialized names. An in-memory tree exercises
  // the real capture/validation/encoding path without creating 10,000 disk files.
  const port: PersonalArchivePort = { ...f.port,
    stat: (path) => nodes.get(path) ?? f.port.stat(path),
    list: (path) => children.get(path) ?? f.port.list(path),
    read: (path) => nodes.get(path)?.bytes ?? f.port.read(path),
    writeRecovery: (name, bytes) => { writes++; f.port.writeRecovery(name, bytes); }
  };
  const tree = captureArchiveTree(port, source);
  expect(tree).toHaveLength(10_000);
  expect(() => prepareIntakeArchive(port, { source, tree, plan: f.plan, ruleFingerprint })).toThrow('INTAKE_TOO_LARGE');
  expect(writes).toBe(0);
  expect(f.port.listRecovery()).toEqual([]);
  expect(readFileSync(join(f.root, source, '原文.md'))).toEqual(f.original);
});
