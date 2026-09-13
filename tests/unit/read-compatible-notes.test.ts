import { describe, expect, it } from 'vitest';
import { parseKnowledgeNote } from '../../src/server/rules/knowledge-schema.js';
import { parseLibraryNote } from '../../src/server/rules/library-schema.js';
import {
  parseKnowledgeNoteForRead,
  parseLibraryNoteForRead
} from '../../src/server/rules/read-compatible-notes.js';
import { sha256Bytes } from '../../src/server/vault/raw-bytes.js';

const encoder = new TextEncoder();
const library = `---
类型: 原始资料
处理状态: 已归档
来源平台: 个人
作者:
采集日期: 2026-06-23
所属主题: []
关键词: []
知识入库状态: 已入库
生成知识: []
备注:
---
原始正文`;
const knowledge = `---
类型: 知识笔记
来源类型: 人工输入
使用状态: AI总结
知识类型: 方法
所属主题: []
关键词: []
来源资料: []
适用场景: []
核心结论: 有效结论
关键要点: []
使用边界: 有效边界
---
知识正文`;

describe('read-only legacy frontmatter compatibility', () => {
  it.each([
    ['生成知识: [[知识甲]]', ['知识甲']],
    ['生成知识:\n  - [[知识甲]]\n  - "[[知识乙|显示名]]"', ['知识甲', '知识乙']],
    ['生成知识: [[知识甲]], [[知识乙|显示名]]', ['知识甲', '知识乙']],
    ['生成知识: [[[知识甲]], [[知识乙]]]', ['知识甲', '知识乙']],
    ['生成知识:\n  - [[含,逗号的标题]]', ['含,逗号的标题']]
  ])('recovers only complete unquoted wikilinks: %s', (replacement, expected) => {
    const bytes = encoder.encode(library.replace('生成知识: []', replacement));
    expect(parseLibraryNote(bytes).record).toBeUndefined();
    const result = parseLibraryNoteForRead(bytes, '01图书馆/来自个人/旧资料.md', 'version-1');
    expect(result.issues).toEqual([]);
    expect(result.record).toMatchObject({
      generatedKnowledge: expected,
      processingStatus: '已归档',
      knowledgeStatus: '已入库',
      rawSha256: sha256Bytes(bytes),
      upstreamVersion: 'version-1'
    });
  });

  it.each([
    ['作者:\n', '作者: @legacy_user\n'],
    ['备注:\n', '备注: 历史归档说明；原始标题: 原标题；保留来源\n']
  ])('reads an unequivocal unquoted legacy scalar without changing other values', (before, after) => {
    const bytes = encoder.encode(library.replace(before, after));
    expect(parseLibraryNote(bytes).record).toBeUndefined();
    expect(parseLibraryNoteForRead(bytes).record).toMatchObject({
      sourcePlatform: '个人',
      collectedAt: '2026-06-23',
      knowledgeStatus: '已入库'
    });
  });

  it('combines scalar and link compatibility while preserving BOM, CRLF and arbitrary body bytes', () => {
    const text = library.replace('作者:\n', '作者: @legacy_user\n')
      .replace('生成知识: []', '生成知识: [[知识甲]]');
    const header = encoder.encode(`\uFEFF${text.slice(0, text.lastIndexOf('---') + 4).replaceAll('\n', '\r\n')}`);
    const body = new Uint8Array([0, 255, 13, 10, 0xef, 0xbb, 0xbf]);
    const bytes = new Uint8Array([...header, ...body]);
    const original = bytes.slice();
    const result = parseLibraryNoteForRead(bytes, '01图书馆/旧资料.md');
    expect(result.record?.rawSha256).toBe(sha256Bytes(original));
    expect(result.bodyBytes).toEqual(body);
    expect(result.bodyBytes.buffer).toBe(bytes.buffer);
    expect(result.bodyBytes.byteOffset).toBe(bytes.byteOffset + header.byteLength);
    expect(bytes).toEqual(original);
  });

  it('supports complete legacy links in knowledge provenance without inferring recall fields', () => {
    const bytes = encoder.encode(knowledge.replace('来源资料: []', '来源资料:\n  - [[来源甲]]'));
    expect(parseKnowledgeNote(bytes).record).toBeUndefined();
    expect(parseKnowledgeNoteForRead(bytes, '02知识库/旧知识.md')).toMatchObject({
      issues: [],
      record: { sourceMaterials: ['来源甲'], usageStatus: 'AI总结', rawSha256: sha256Bytes(bytes) }
    });
  });

  it.each([
    '生成知识: [[ [深层数组] ]]',
    '生成知识: [[甲, 乙], [丙]]',
    '生成知识:\n  - [ [甲] ]',
    '生成知识:\n  - [[甲]]\n  - [乙, 丙]',
    '生成知识: [[甲]], 任意文字',
    '生成知识: [[甲]], [[未闭合',
    '生成知识: []\n生成知识: [[重复键]]',
    '生成知识: &shared [[甲]]\n额外: *shared',
    '生成知识:\n  - !!str [[甲]]'
  ])('leaves ambiguous arrays, malformed YAML, tags and aliases as issues: %s', (replacement) => {
    const bytes = encoder.encode(library.replace('生成知识: []', replacement));
    expect(parseLibraryNoteForRead(bytes)).toEqual(parseLibraryNote(bytes));
    expect(parseLibraryNoteForRead(bytes).record).toBeUndefined();
  });

  it.each([
    library.replace('类型: 原始资料', '类型: 个人画像'),
    library.replace('处理状态: 已归档', '处理状态: AI总结'),
    library.replace('来源平台: 个人\n', ''),
    library.replace('知识入库状态: 已入库\n', ''),
    library.replace('采集日期: 2026-06-23', '采集日期: 2026-02-30'),
    library.replace('关键词: []', '关键词: [[不能自动展平关键词]]'),
    library.replace('所属主题: []\n', ''),
    library.replace('备注:\n', '备注: 说明: 内容 # 含注释的歧义值\n'),
    library.replace('备注:\n', '备注:\n  原始标题: 嵌套映射\n'),
    library.replace(/^---\n/u, ''),
    knowledge.replace('关键要点: []', '关键要点:\n  - 要点一\n- 要点二')
  ])('does not guess missing fields or silently repair unrelated invalid metadata', (source) => {
    const bytes = encoder.encode(source.replace('生成知识: []', '生成知识: [[知识甲]]'));
    const isKnowledge = source.includes('类型: 知识笔记');
    const result = isKnowledge ? parseKnowledgeNoteForRead(bytes) : parseLibraryNoteForRead(bytes);
    expect(result.record).toBeUndefined();
    expect(result.issues).not.toHaveLength(0);
  });

  it('returns the canonical result unchanged and never invents optional dates', () => {
    const bytes = encoder.encode(knowledge);
    expect(parseKnowledgeNoteForRead(bytes)).toEqual(parseKnowledgeNote(bytes));
    expect(parseKnowledgeNoteForRead(bytes).record).not.toHaveProperty('createdAt');
    expect(parseLibraryNoteForRead(encoder.encode(library))).toEqual(parseLibraryNote(encoder.encode(library)));
  });

  it('does not turn YAML aliases inside apparent wikilinks into literal link text', () => {
    const bytes = encoder.encode(library.replace('生成知识: []', '共享: &shared 目标\n生成知识: [[*shared]]'));
    expect(parseLibraryNote(bytes).issues[0]?.message).toBe('FRONTMATTER_ALIAS_FORBIDDEN');
    expect(parseLibraryNoteForRead(bytes)).toEqual(parseLibraryNote(bytes));
  });

  it('does not rewrite apparent field lines inside a multiline flow-mapping scalar', () => {
    const bytes = encoder.encode(`---
{
类型: 原始资料,
处理状态: 已归档,
来源平台: 个人,
原始标题: '旧标题
生成知识: [[这是标题文本]]
末尾',
所属主题: [],
关键词: [],
知识入库状态: 已入库,
生成知识: [],
备注: null,
作者: @legacy_user
}
---
原文`);
    expect(parseLibraryNoteForRead(bytes)).toEqual(parseLibraryNote(bytes));
    expect(parseLibraryNoteForRead(bytes).record).toBeUndefined();
  });

  it.each(['high-bit opening bytes', 'lone CR after closing delimiter'])('does not recover invalid delimiters: %s', (kind) => {
    let bytes = encoder.encode(library.replace('生成知识: []', '生成知识: [[知识甲]]'));
    if (kind === 'high-bit opening bytes') bytes.set([0xad, 0xad, 0xad]);
    else bytes = encoder.encode(new TextDecoder().decode(bytes).replace('---\n原始正文', '---\r'));
    expect(parseLibraryNoteForRead(bytes)).toEqual(parseLibraryNote(bytes));
    expect(parseLibraryNoteForRead(bytes).record).toBeUndefined();
  });
});
