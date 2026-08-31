import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { VaultGateway, VaultCapabilityProfile, VersionedBytes } from '../../src/server/vault/VaultGateway.js';
import { sha256Bytes } from '../../src/server/vault/raw-bytes.js';
import { parseFrontmatter } from '../../src/server/rules/frontmatter.js';
import {
  KNOWLEDGE_STATUSES,
  SOURCE_PLATFORMS,
  parseLibraryNote
} from '../../src/server/rules/library-schema.js';
import {
  KNOWLEDGE_TYPES,
  USAGE_STATUSES,
  parseKnowledgeNote
} from '../../src/server/rules/knowledge-schema.js';
import { extractWikiLinks } from '../../src/server/rules/wikilinks.js';
import {
  RULE_BUNDLE_SOURCE_PATHS,
  RuleBundleGuard,
  loadRuleBundle
} from '../../src/server/rules/rule-bundle.js';

const encoder = new TextEncoder();
const fixture = (name: string) => readFile(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));

const libraryFrontmatter = (overrides = '') => `---
类型: 原始资料
处理状态: 未归档
来源平台: 个人
原始标题:
作者:
原始链接:
采集日期:
所属主题: []
关键词: []
知识入库状态: 未提炼
生成知识: []
备注:
${overrides}---
正文`;

const knowledgeFrontmatter = (overrides = '') => `---
类型: 知识笔记
来源类型: AI提炼
使用状态: AI总结
知识类型: 方法
所属主题: []
关键词: []
来源资料: []
适用场景: []
核心结论: 有效结论
关键要点: []
使用边界: 有效边界
${overrides}---
正文`;

class RuleGateway implements VaultGateway {
  readonly reads: string[] = [];

  constructor(private readonly files: Map<string, Uint8Array>) {}

  set(path: string, text: string): void {
    this.files.set(path, encoder.encode(text));
  }

  async fingerprint(): Promise<Pick<VaultCapabilityProfile, 'pluginId' | 'pluginVersion' | 'obsidianVersion'>> {
    return { pluginId: 'obsidian-local-rest-api', pluginVersion: '5.1.0', obsidianVersion: '1.9.14' };
  }

  async listDirectory(): Promise<ReadonlyArray<string>> {
    return [];
  }

  async readRaw(path: string): Promise<VersionedBytes> {
    this.reads.push(path);
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error(`missing fixture: ${path}`);
    return { path, bytes, rawSha256: sha256Bytes(bytes), upstreamVersion: 'v1' };
  }

  async readOpenApi(): Promise<string> {
    return '';
  }
}

describe('current frontmatter contracts', () => {
  it('parses a valid library note and preserves the original body byte slice', async () => {
    const original = await fixture('library-valid.md');
    const result = parseLibraryNote(original, '01图书馆/资料.md');
    const delimiter = encoder.encode('---\n');
    const closingStart = original.indexOf(delimiter, delimiter.byteLength);
    const originalBodyBytes = original.subarray(closingStart + delimiter.byteLength);

    expect(result.issues).toEqual([]);
    expect(result.record?.knowledgeStatus).toBe('未提炼');
    expect(result.record?.generatedKnowledge).toEqual(['已有知识']);
    expect(result.bodyBytes).toEqual(originalBodyBytes);
    expect(result.bodyBytes.buffer).toBe(original.buffer);
  });

  it('reports historical note types as schema issues instead of records', async () => {
    const result = parseLibraryNote(
      await fixture('library-schema-anomaly.md'),
      '01图书馆/历史异常资料.md'
    );

    expect(result.record).toBeUndefined();
    expect(result.issues[0]?.code).toBe('UNEXPECTED_TYPE');
  });

  it('parses knowledge recall fields without reading meaning from the body', async () => {
    const result = parseKnowledgeNote(
      await fixture('knowledge-valid.md'),
      '02知识库/知识管理/按需读取正文.md'
    );

    expect(result.issues).toEqual([]);
    expect(result.record?.usageStatus).toBe('AI总结');
    expect(result.record?.title).toBe('按需读取正文');
    expect(result.record?.recallFields.conclusion).toContain('按需读取正文');
    expect(result.record?.sourceMaterials).toEqual(['一份可提炼的资料']);
  });

  it('uses exactly the current enums', () => {
    expect(SOURCE_PLATFORMS).toEqual([
      'B站', 'YouTube', '抖音', '小红书', '公众号', '飞书', 'X推特',
      'Reddit', '小宇宙', '独立站', '个人', '其他'
    ]);
    expect(KNOWLEDGE_STATUSES).toEqual(['未提炼', '部分入库', '已入库']);
    expect(USAGE_STATUSES).toEqual(['AI总结', '已优化', '定论', '过时']);
    expect(KNOWLEDGE_TYPES).toEqual([
      '概念', '原理', '模型', '方法', 'SOP', '标准', '案例', '数据', '观点', '素材'
    ]);
  });

  it('extracts wikilink targets and ignores display labels', () => {
    expect(extractWikiLinks('[[A]] and [[B|label]]')).toEqual(['A', 'B']);
  });

  it('accepts a UTF-8 BOM while preserving the original body view', () => {
    const original = encoder.encode(`\uFEFF${libraryFrontmatter()}`);
    const parsed = parseFrontmatter(original);

    expect(new TextDecoder().decode(parsed.bodyBytes)).toBe('正文');
    expect(parsed.bodyBytes.buffer).toBe(original.buffer);
  });

  it('treats canonical empty optional library scalars as absent', () => {
    const result = parseLibraryNote(
      encoder.encode(libraryFrontmatter()),
      '01图书馆/来自个人/回退标题.md'
    );

    expect(result.issues).toEqual([]);
    expect(result.record?.title).toBe('回退标题');
    expect(result.record).not.toHaveProperty('collectedAt');
  });

  it('projects optional knowledge dates without inventing dates for legacy notes', () => {
    const dated = parseKnowledgeNote(
      encoder.encode(knowledgeFrontmatter(
        '创建日期: "2026-08-30"\n更新日期: "2026-08-31"\n'
      )),
      '02知识库/有日期.md'
    );
    const legacy = parseKnowledgeNote(
      encoder.encode(knowledgeFrontmatter()),
      '02知识库/旧笔记.md'
    );

    expect(dated.issues).toEqual([]);
    expect(dated.record).toMatchObject({
      createdAt: '2026-08-30',
      updatedAt: '2026-08-31'
    });
    expect(legacy.issues).toEqual([]);
    expect(legacy.record).not.toHaveProperty('createdAt');
    expect(legacy.record).not.toHaveProperty('updatedAt');
  });

  it('accepts real leap days and rejects impossible material and knowledge calendar dates', () => {
    const leapDay = libraryFrontmatter().replace(
      '采集日期:\n',
      '采集日期: "2024-02-29"\n'
    );
    const invalidMaterial = libraryFrontmatter().replace(
      '采集日期:\n',
      '采集日期: "2026-02-29"\n'
    );
    const invalidKnowledge = knowledgeFrontmatter('创建日期: "2026-04-31"\n');

    expect(parseLibraryNote(encoder.encode(leapDay)).record?.collectedAt).toBe('2024-02-29');
    expect(parseLibraryNote(encoder.encode(invalidMaterial))).toMatchObject({
      record: undefined,
      issues: [{ code: 'INVALID_FIELD', field: '采集日期' }]
    });
    expect(parseKnowledgeNote(encoder.encode(invalidKnowledge))).toMatchObject({
      record: undefined,
      issues: [{ code: 'INVALID_FIELD', field: '创建日期' }]
    });
  });

  it('rejects missing required structural arrays instead of silently defaulting them', () => {
    const library = libraryFrontmatter().replace('生成知识: []\n', '');
    const knowledge = knowledgeFrontmatter().replace('关键要点: []\n', '');

    expect(parseLibraryNote(encoder.encode(library)).issues[0]?.code).toBe('INVALID_FIELD');
    expect(parseKnowledgeNote(encoder.encode(knowledge)).issues[0]?.code).toBe('INVALID_FIELD');
  });

  it('rejects blank required recall text', () => {
    const blankConclusion = knowledgeFrontmatter().replace('核心结论: 有效结论', '核心结论: ""');
    const blankBoundary = knowledgeFrontmatter().replace('使用边界: 有效边界', '使用边界: "  "');

    expect(parseKnowledgeNote(encoder.encode(blankConclusion)).record).toBeUndefined();
    expect(parseKnowledgeNote(encoder.encode(blankBoundary)).record).toBeUndefined();
  });

  it.each([
    ['missing closing delimiter', '---\n类型: 原始资料\n正文'],
    ['duplicate YAML keys', '---\n类型: 原始资料\n类型: 知识笔记\n---\n正文'],
    ['YAML aliases', '---\n值: &shared [a]\n复制: *shared\n---\n正文'],
    ['non-object YAML roots', '---\n- 原始资料\n---\n正文']
  ])('rejects %s', (_label, source) => {
    expect(() => parseFrontmatter(encoder.encode(source))).toThrow(/FRONTMATTER_/);
  });
});

describe('rule bundle compatibility', () => {
  const makeGateway = () => new RuleGateway(new Map(
    RULE_BUNDLE_SOURCE_PATHS.map((path, index) => [path, encoder.encode(`rule-${index}`)])
  ));

  it('reads only the trusted source paths and exposes a deterministic SHA-256 bundle', async () => {
    const gateway = makeGateway();
    const first = await loadRuleBundle(gateway);
    const second = await loadRuleBundle(makeGateway());

    expect(RULE_BUNDLE_SOURCE_PATHS).toEqual([
      '00大脑规则/00_大脑规范.md',
      '00大脑规则/01_总路由规则.md',
      '00大脑规则/03_知识库提炼与入库规则.md',
      '00大脑规则/05_链接命名与治理规则.md'
    ]);
    expect(gateway.reads).toEqual(RULE_BUNDLE_SOURCE_PATHS);
    expect(first.sources.map((source) => source.path)).toEqual(RULE_BUNDLE_SOURCE_PATHS);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(Object.isFrozen(first.sources)).toBe(true);
    expect(first.sources.every(Object.isFrozen)).toBe(true);
  });

  it('marks candidate generation and write planning stale while keeping reads available', async () => {
    const gateway = makeGateway();
    const guard = await RuleBundleGuard.start(gateway);
    gateway.set(RULE_BUNDLE_SOURCE_PATHS[1], 'changed routing rule');

    await expect(guard.check(gateway)).resolves.toMatchObject({
      status: 'stale',
      readOnlyAvailable: true,
      candidateGenerationAvailable: false,
      writePlanningAvailable: false
    });
  });
});
