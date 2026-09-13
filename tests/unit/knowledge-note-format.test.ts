import { expect, it } from 'vitest';
import { createKnowledgeNote, mergeKnowledgeNote, patchFrontmatter, patchSource, sourceEvidenceSha } from '../../src/server/ingestion/note-format.js';
import { parseFrontmatter } from '../../src/server/rules/frontmatter.js';
import { parseKnowledgeNote } from '../../src/server/rules/knowledge-schema.js';
import type { CandidateDraft } from '../../src/shared/api/ingestion.js';

const source = '01图书馆/来自个人/原文.md';
const draft: CandidateDraft = { title: '先验证再决策', knowledgeType: '方法', suggestedPath: '02知识库/09学习', topics: [], coreContent: '先验证证据，再决定行动。', value: '判断方法',
  draft: { keywords: ['验证', '证据', '决策'], scenarios: ['判断方案', '选择行动'], conclusion: '先验证证据再决策。', keyPoints: ['核查证据', '再做决策'], boundary: '适用于有证据的判断。', quotes: [], summaries: ['个人总结：判断先于行动。'] } };
const original = Buffer.from('\ufeff---\r\n类型: 原始资料\r\n处理状态: 已归档\r\n来源平台: 个人\r\n原始标题: 原文\r\n自定义: "保持  原样" # comment\r\n知识入库状态: 未提炼\r\n生成知识: []\r\n---\r\n\r\n原文\r\n![附件](./a.png)\r\n');

it('creates a parseable complete knowledge note with source and fixed reusable sections', () => {
  const bytes = createKnowledgeNote(draft, source, '2026-09-07');
  expect(parseKnowledgeNote(bytes).record).toMatchObject({ usageStatus: 'AI总结', sourceMaterials: [source.slice(0, -3)] });
  expect(bytes.toString()).toContain('### 原文引用\n\n暂无可直接引用的原文表达');
  expect(bytes.toString()).toContain('## 知识正文');
});
it('patches only owned source fields preserving BOM, CRLF, unknown YAML and exact body', () => {
  const after = patchSource(original, ['02知识库/09学习/先验证再决策.md'], '部分入库');
  expect(after.subarray(0, 3)).toEqual(original.subarray(0, 3));
  expect(after.toString()).toContain('自定义: "保持  原样" # comment\r\n');
  expect(Buffer.from(parseFrontmatter(after).bodyBytes)).toEqual(Buffer.from(parseFrontmatter(original).bodyBytes));
  expect(parseFrontmatter(after).data.知识入库状态).toBe('部分入库');
  expect(sourceEvidenceSha(after)).toBe(sourceEvidenceSha(original));
  const again = patchSource(after, ['02知识库/09学习/先验证再决策.md'], '已入库');
  expect(parseFrontmatter(again).data.生成知识).toEqual(['[[02知识库/09学习/先验证再决策]]']);
});
it('retains existing sources and adds pending recognition to optimized knowledge', () => {
  const before = createKnowledgeNote(draft, source, '2026-09-06').toString().replace('使用状态: AI总结', '使用状态: 已优化');
  const merged = mergeKnowledgeNote(Buffer.from(before), [draft], '01图书馆/来自个人/新原文.md', '2026-09-07', 'merge');
  const record = parseKnowledgeNote(merged).record!;
  expect(record.usageStatus).toBe('已优化'); expect(record.sourceMaterials).toHaveLength(2);
  expect(merged.toString()).toContain('==AI待认=='); expect(merged.toString()).toContain('## 来源映射');
  expect(record.createdAt).toBe('2026-09-06');
});
it('allows only source additions to conclusions and rejects obsolete merge', () => {
  const before = createKnowledgeNote(draft, source, '2026-09-06').toString();
  expect(() => mergeKnowledgeNote(Buffer.from(before.replace('AI总结', '定论')), [draft], source, '2026-09-07', 'merge')).toThrow();
  const stable = Buffer.from(before.replace('AI总结', '定论'));
  const after = mergeKnowledgeNote(stable, [draft], '01图书馆/来自个人/另一篇.md', '2026-09-07', 'reference');
  expect(parseFrontmatter(after).bodyBytes).toEqual(parseFrontmatter(stable).bodyBytes);
  expect(() => mergeKnowledgeNote(Buffer.from(before.replace('AI总结', '过时')), [draft], source, '2026-09-07', 'merge')).toThrow();
});

it('inserts literal replacement metacharacters without duplicating or rewriting existing knowledge', () => {
  const before = createKnowledgeNote(draft, source, '2026-09-06');
  const literal = "$& / $1 / $` / $'";
  const next = { ...draft, coreContent: `保留字面内容 ${literal}`, draft: { ...draft.draft, quotes: [`字面引用 ${literal}`], summaries: [`字面总结 ${literal}`] } };
  const body = Buffer.from(parseFrontmatter(mergeKnowledgeNote(before, [next], source, '2026-09-07', 'merge')).bodyBytes).toString();
  expect(body).toContain(next.coreContent);
  expect(body).toContain(next.draft.quotes[0]);
  expect(body).toContain(next.draft.summaries[0]);
  expect(body.split('## 可复用表达')).toHaveLength(2);
  expect(body.split(draft.coreContent)).toHaveLength(2);
});

it('places merged quotes and summaries in their fixed sections with local pending recognition', () => {
  const before = Buffer.from(createKnowledgeNote(draft, source, '2026-09-06').toString().replace('使用状态: AI总结', '使用状态: 已优化'));
  const next = { ...draft, coreContent: '新知识正文。', draft: { ...draft.draft, quotes: ['本次真实引用。'], summaries: ['本次新总结。'] } };
  const merged = mergeKnowledgeNote(before, [next], '01图书馆/来自个人/新原文.md', '2026-09-07', 'merge');
  const body = Buffer.from(parseFrontmatter(merged).bodyBytes).toString();
  const knowledge = body.slice(body.indexOf('## 知识正文'), body.indexOf('## 可复用表达'));
  const quotes = body.slice(body.indexOf('### 原文引用'), body.indexOf('### 个人总结'));
  const summaries = body.slice(body.indexOf('### 个人总结'), body.indexOf('## 来源映射'));
  expect(knowledge).toContain('新知识正文。'); expect(knowledge).not.toContain('本次真实引用。');
  expect(quotes).toContain('本次真实引用。'); expect(quotes).not.toContain('暂无可直接引用的原文表达');
  expect(summaries).toContain('本次新总结。');
  for (const section of [knowledge, quotes, summaries]) {
    expect(section).toContain('==AI待认=='); expect(section).toContain('〔S2〕');
  }
  expect(parseFrontmatter(merged).data.核心结论).toEqual(parseFrontmatter(before).data.核心结论);
});

const otherSource = '01图书馆/来自个人/另一原文.md';
function multiSource(mapping = true): Buffer {
  let before = patchFrontmatter(createKnowledgeNote(draft, source, '2026-09-06'), { 来源资料: [`[[${source.slice(0, -3)}]]`, `[[${otherSource.slice(0, -3)}]]`] }).toString();
  if (mapping) {
    before = before.replace('## 知识正文', '## 知识正文 〔综合 S7+S2〕').replace('### 原文引用', '### 原文引用 〔S7〕').replace('### 个人总结', '### 个人总结 〔S7〕');
    before += `\n## 来源映射\n\n- S2：[[${otherSource.slice(0, -3)}]]；补充的例子。\n- S7：[[${source.slice(0, -3)}]]；原有判断。\n`;
  }
  return Buffer.from(before);
}

it('reuses verified mapping identifiers independently from YAML order and allocates max plus one', () => {
  const before = multiSource();
  const same = mergeKnowledgeNote(before, [draft], source, '2026-09-07', 'merge').toString();
  expect(same).toContain('（2026-09-07补充） 〔S7〕');
  expect(same).not.toContain('（2026-09-07补充） 〔S1〕');
  const fresh = mergeKnowledgeNote(before, [draft], '01图书馆/来自个人/最新原文.md', '2026-09-07', 'merge').toString();
  expect(fresh).toContain('（2026-09-07补充） 〔S8〕');
  expect(fresh).toContain('- S8：[[01图书馆/来自个人/最新原文]]');
  expect(fresh).toContain('- S2：[[01图书馆/来自个人/另一原文]]；补充的例子。');
  expect(fresh).toContain('- S7：[[01图书馆/来自个人/原文]]；原有判断。');
});

it('requires explicit confirmation before assigning legacy collective sources without a map', () => {
  const before = multiSource(false);
  expect(() => mergeKnowledgeNote(before, [draft], source, '2026-09-07', 'merge')).toThrow('核对');
  const after = mergeKnowledgeNote(before, [draft], source, '2026-09-07', 'merge', true).toString();
  expect(after).toContain('## 知识正文 〔综合 S1+S2〕');
  expect(after).toContain('### 原文引用 〔综合 S1+S2〕');
  expect(after).toContain('### 个人总结 〔综合 S1+S2〕');
  expect(after).toContain('- S1：[[01图书馆/来自个人/原文]]');
});

it.each(['duplicate-id', 'duplicate-source', 'missing-source', 'unknown-source', 'unknown-marker', 'complex-map', 'unsupported-heading', 'unsupported-marker'] as const)(
  'refuses inconsistent source attribution %s without silently remapping it', (kind) => {
    let before = multiSource().toString();
    if (kind === 'duplicate-id') before = before.replace('- S7：', '- S2：');
    if (kind === 'duplicate-source') before = before.replace('- S2：[[01图书馆/来自个人/另一原文]]', '- S2：[[01图书馆/来自个人/原文]]');
    if (kind === 'missing-source') before = before.replace(/- S2：[^\n]+\n/u, '');
    if (kind === 'unknown-source') before = before.replace('- S2：[[01图书馆/来自个人/另一原文]]', '- S2：[[01图书馆/未登记原文]]');
    if (kind === 'unknown-marker') before = before.replace('〔综合 S7+S2〕', '〔S9〕');
    if (kind === 'complex-map') before += '\n这段映射尚未人工整理。\n';
    if (kind === 'unsupported-heading') before = before.replace('## 来源映射', '## 来源映射（旧）');
    if (kind === 'unsupported-marker') before = before.replace('〔综合 S7+S2〕', '〔综合 S7+S2〕 〔Sx〕');
    expect(() => mergeKnowledgeNote(Buffer.from(before), [draft], source, '2026-09-07', 'merge', true)).toThrow('来源');
  }
);

it('does not interpret fenced examples as real note sections or source maps', () => {
  const existing = { ...draft, coreContent: '正文\n\n```markdown\n## 可复用表达\n## 来源映射\n- S99：[[仅是示例]]；不是真实来源。\n```\n\n保留此段。' };
  const before = createKnowledgeNote(existing, source, '2026-09-06');
  const after = mergeKnowledgeNote(before, [draft], otherSource, '2026-09-07', 'merge').toString();
  expect(after).toContain(existing.coreContent);
  expect(after).toContain('- S2：[[01图书馆/来自个人/另一原文]]');
});

it('preserves earlier source assignments across repeated multi-source merges', () => {
  const before = createKnowledgeNote(draft, source, '2026-09-06');
  const first = mergeKnowledgeNote(before, [{ ...draft, coreContent: '第二来源知识' }], otherSource, '2026-09-07', 'merge');
  const thirdSource = '01图书馆/来自个人/第三原文.md';
  const second = mergeKnowledgeNote(first, [{ ...draft, coreContent: '第三来源知识' }], thirdSource, '2026-09-08', 'merge');
  const body = Buffer.from(parseFrontmatter(second).bodyBytes).toString();
  expect(body).toContain('（2026-09-07补充） 〔S2〕\n\n第二来源知识');
  expect(body).toContain('（2026-09-08补充） 〔S3〕\n\n第三来源知识');
  expect(body).toContain('- S1：[[01图书馆/来自个人/原文]]');
  expect(body).toContain('- S2：[[01图书馆/来自个人/另一原文]]');
  expect(body).toContain('- S3：[[01图书馆/来自个人/第三原文]]');
  expect(parseKnowledgeNote(second).record!.sourceMaterials).toHaveLength(3);
});

it('keeps manual-origin content attributable when the first external source is merged', () => {
  const before = patchFrontmatter(createKnowledgeNote(draft, source, '2026-09-06'), { 来源类型: '人工输入', 来源资料: [] });
  const after = mergeKnowledgeNote(before, [draft], source, '2026-09-07', 'merge').toString();
  expect(after).toContain('## 知识正文 〔人工〕');
  expect(after).toContain('（2026-09-07补充） 〔S1〕');
  expect(after).toContain('- S1：[[01图书馆/来自个人/原文]]');
});

it('preserves exact CRLF source-only body while adding provenance to stable knowledge', () => {
  const before = Buffer.from(createKnowledgeNote(draft, source, '2026-09-06').toString().replace('AI总结', '定论').replace(/\n/gu, '\r\n'));
  const after = mergeKnowledgeNote(before, [draft], otherSource, '2026-09-07', 'reference');
  expect(Buffer.from(parseFrontmatter(after).bodyBytes)).toEqual(Buffer.from(parseFrontmatter(before).bodyBytes));
  expect(parseKnowledgeNote(after).record).toMatchObject({ usageStatus: '定论', sourceMaterials: [source.slice(0, -3), otherSource.slice(0, -3)] });
});

it('keeps literal source notation inside quoted evidence as data', () => {
  const next = { ...draft, draft: { ...draft.draft, quotes: ['文档用〔S99〕作为编号格式示例。'] } };
  const before = createKnowledgeNote(next, source, '2026-09-06');
  const after = mergeKnowledgeNote(before, [next], otherSource, '2026-09-07', 'merge').toString();
  expect(after.match(/> 文档用〔S99〕作为编号格式示例。/gu)).toHaveLength(2);
  expect(after).toContain('- S2：[[01图书馆/来自个人/另一原文]]');
});
