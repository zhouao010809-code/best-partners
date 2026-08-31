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
