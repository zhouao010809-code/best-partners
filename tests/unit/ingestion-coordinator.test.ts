import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { applyPlan, verifyApplied, type IngestionPlan } from '../../src/server/ingestion/ingestion-coordinator.js';
import { createKnowledgeNote, mergeKnowledgeNote, patchSource } from '../../src/server/ingestion/note-format.js';
import type { PersonalIngestionPort } from '../../src/server/ingestion/ingestion-native.js';
import { sha256Bytes } from '../../src/server/vault/raw-bytes.js';

const source = '01图书馆/来自个人/原文.md', knowledge = '02知识库/09学习/知识.md';
const original = Buffer.from('---\n类型: 原始资料\n处理状态: 已归档\n来源平台: 个人\n原始标题: 原文\n所属主题: []\n关键词: []\n知识入库状态: 未提炼\n生成知识: []\n---\n\n证据核查。\n');
const content = { keywords: ['证据', '判断', '行动'], scenarios: ['决策之前', '复盘时'], conclusion: '核实证据再行动。', keyPoints: ['核查证据', '决定行动'], boundary: '适用于可验证的问题。', quotes: [], summaries: ['个人总结：证据决定行动。'] };
const draft = { title: '知识', knowledgeType: '方法' as const, suggestedPath: '02知识库/09学习', topics: [], coreContent: '旧知识正文。', value: '减少无效行动', draft: content };

function fixture(kind: 'new' | 'update' | 'unchanged' = 'update') {
  const initial = createKnowledgeNote(draft, source, '2026-09-07');
  const after = mergeKnowledgeNote(initial, [{ ...draft, coreContent: '新知识正文。' }], source, '2026-09-07', 'merge');
  const before = kind === 'new' ? null : kind === 'unchanged' ? after : initial;
  const sourceAfter = patchSource(original, [knowledge], '已入库');
  const id = randomUUID(), runId = randomUUID(), stageId = randomUUID();
  const files: IngestionPlan['files'] = [
    { path: knowledge, kind: kind === 'new' ? 'new' : 'update', before: before?.toString() ?? null, after: after.toString(), stageId },
    { path: source, kind: 'source', before: original.toString(), after: sourceAfter.toString(), stageId: randomUUID() }
  ];
  const plan: IngestionPlan = { version: 1, id, journalId: id, runId, materialPath: source, root: { dev: '1', ino: '2' },
    ruleFingerprint: 'rule', reviewStamp: 'stamp', sourceBefore: original.toString(), sourceAfter: sourceAfter.toString(), files,
    decisions: [{ id: 'candidate1', version: 1, state: 'committed', path: knowledge }],
    preview: { id, runId, expiresAt: '2026-09-08T00:00:00.000Z', files: files.map(({ stageId: _stage, ...file }) => file),
      selectedCount: 1, discardedCount: 0, pendingCount: 0, sourceStatus: '已入库' } };
  const saved = new Map<string, Buffer>([[source, original], ...(before ? [[knowledge, before] as [string, Buffer]] : [])]);
  const recovery = new Map<string, Buffer>(); const applied: string[] = []; let afterApply: ((path: string) => void) | undefined;
  const port: PersonalIngestionPort = { rootIdentity: plan.root,
    read: (path) => saved.get(path) ?? null, readRecovery: (name) => recovery.get(name) ?? null,
    writeRecovery: (name, bytes) => { if (recovery.has(name)) throw new Error('TARGET_EXISTS'); recovery.set(name, Buffer.from(bytes)); },
    listRecovery: () => [...recovery.keys()], close: () => {},
    apply: (path, stage, previous, next) => {
      const current = saved.get(path) ?? null;
      if (previous === null ? current !== null : !current?.equals(previous)) throw new Error('VERSION_CONFLICT');
      if (!recovery.get(stage)?.equals(next)) throw new Error('STAGE_INVALID');
      saved.set(path, Buffer.from(next)); if (previous) recovery.set(stage, previous); else recovery.delete(stage);
      applied.push(path); afterApply?.(path);
    }
  };
  return { plan, port, saved, recovery, before, after, applied, stage: `${stageId}.stage.md`,
    afterApply: (action: (path: string) => void) => { afterApply = action; } };
}

it.each(['edited', 'missing'] as const)('refuses success when an earlier preserved version is %s during a later file apply', (change) => {
  const f = fixture(); const external = Buffer.from('external preserved version');
  f.afterApply((path) => { if (path === source) { if (change === 'edited') f.recovery.set(f.stage, external); else f.recovery.delete(f.stage); } });
  expect(() => applyPlan(f.plan, f.port)).toThrow('PRESERVED_VERSION_CHANGED');
  expect(f.saved.get(knowledge)).toEqual(f.after); expect(f.saved.get(source)?.toString()).toBe(f.plan.sourceAfter);
  expect(f.recovery.has(`${f.plan.id}.intent.json`)).toBe(true);
  expect(f.recovery.has(`${f.plan.id}.result.json`)).toBe(false);
  expect(f.recovery.get(f.stage)).toEqual(change === 'edited' ? external : undefined);
  expect(f.recovery.get(`${f.plan.files[1]!.stageId}.stage.md`)).toEqual(original);
});

it('rechecks preserved versions at finalization even when a result receipt was already written', () => {
  const f = fixture(); applyPlan(f.plan, f.port);
  const external = Buffer.from('external changed after receipt'); f.recovery.set(f.stage, external);
  const evidence = [...f.recovery].map(([name, bytes]) => [name, bytes.toString()]);
  expect(() => verifyApplied(f.plan, f.port)).toThrow('PRESERVED_VERSION_CHANGED');
  expect([...f.recovery].map(([name, bytes]) => [name, bytes.toString()])).toEqual(evidence);
  expect(f.saved.get(knowledge)).toEqual(f.after);
});

it('rejects an unexpected reappeared stage for a newly created knowledge file', () => {
  const f = fixture('new');
  f.afterApply((path) => { if (path === source) f.recovery.set(f.stage, Buffer.from('unknown recovery version')); });
  expect(() => applyPlan(f.plan, f.port)).toThrow('PRESERVED_VERSION_CHANGED');
  expect(f.recovery.has(`${f.plan.id}.result.json`)).toBe(false);
  expect(f.recovery.get(f.stage)?.toString()).toBe('unknown recovery version');
});

it('accepts exclusive creation after its stage has been moved to the destination', () => {
  const f = fixture('new'); applyPlan(f.plan, f.port);
  expect(f.recovery.has(f.stage)).toBe(false);
  expect(() => verifyApplied(f.plan, f.port)).not.toThrow();
  applyPlan(f.plan, f.port); expect(f.applied).toEqual([knowledge, source]);
});

it('does not require a newly allocated recovery stage when a reviewed file already equals its after image', () => {
  const f = fixture('unchanged'); applyPlan(f.plan, f.port);
  expect(f.recovery.has(f.stage)).toBe(false); expect(f.applied).toEqual([source]);
  expect(() => verifyApplied(f.plan, f.port)).not.toThrow();
});

it.each(['before-apply', 'during-apply', 'after-receipt'] as const)('rechecks inherited recovery evidence %s without deleting either version', (when) => {
  const f = fixture(), ancestor = randomUUID(), shown = Buffer.from('previously reviewed stage'), newest = Buffer.from('new ancestor evidence');
  f.plan.journalId = randomUUID();
  Object.assign(f.plan, { recoveryReadSet: [{ path: source, stageId: ancestor, expectedSha256: sha256Bytes(shown), beforeSha256: sha256Bytes(original), afterSha256: sha256Bytes(Buffer.from(f.plan.sourceAfter)) }] });
  f.recovery.set(`${ancestor}.stage.md`, shown);
  if (when === 'before-apply') f.recovery.set(`${ancestor}.stage.md`, newest);
  if (when === 'during-apply') f.afterApply((path) => { if (path === knowledge) f.recovery.set(`${ancestor}.stage.md`, newest); });
  if (when === 'after-receipt') {
    applyPlan(f.plan, f.port); f.recovery.set(`${ancestor}.stage.md`, newest);
    expect(() => verifyApplied(f.plan, f.port)).toThrow('RECOVERY_EVIDENCE_CHANGED');
  } else {
    expect(() => applyPlan(f.plan, f.port)).toThrow('RECOVERY_EVIDENCE_CHANGED');
    expect(f.recovery.has(`${f.plan.journalId}.result.json`)).toBe(false);
    if (when === 'before-apply') expect(f.applied).toEqual([]);
    if (when === 'during-apply') expect(f.applied).toEqual([knowledge]);
  }
  expect(f.recovery.get(`${ancestor}.stage.md`)).toEqual(newest);
});
