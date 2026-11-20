import { expect, it } from 'vitest';
import { parseLibraryNoteForRead, parseKnowledgeNoteForRead } from '../../src/server/rules/read-compatible-notes.js';
import { CURRENT_VAULT_LAYOUT, LEGACY_VAULT_LAYOUT } from '../../src/shared/domain/vault-layout.js';
import { detectVaultLayout } from '../../src/server/vault/vault-layout.js';

it('validates each layout against its own rules and requires the diary folder for current vaults', async () => {
  for (const layout of [CURRENT_VAULT_LAYOUT, LEGACY_VAULT_LAYOUT]) {
    const directories = ['00大脑规则', '01图书馆', layout.knowledgeRoot, layout.outputRoot];
    if (layout.id === 'current') directories.push('02日记本');
    const files = new Set<string>(layout.rulePaths);
    const reader = {
      listDirectory: async () => [...files].map(path => ({ name: path.split('/').at(-1)!, kind: 'file' as const })),
      assertDirectory: async (path: string) => { if (!directories.includes(path)) throw new Error('missing'); },
      assertFile: async (path: string) => { if (!files.has(path)) throw new Error('missing'); }
    };
    expect(await detectVaultLayout(reader)).toEqual(layout);
    files.delete(layout.rulePaths.at(-1)!);
    await expect(detectVaultLayout(reader)).rejects.toThrow('missing');
  }
});

it('indexes current YAML, preserving discussion status, recall text, references and raw Markdown', () => {
  const material = Buffer.from('---\n类型: 原始资料\n标题: 访谈\n资料来源: 个人访谈\n探讨状态: 部分探讨完成\n入馆时间: 2026-11-05-20:10\n关联日记: []\n---\n正文');
  const result = parseLibraryNoteForRead(material, '01图书馆/02个人资料/访谈.md');
  expect(result.record).toMatchObject({ collectedAt: '2026-11-05', title: '访谈', knowledgeStatus: '部分探讨完成', processingStatus: '已归档' });
  expect(Buffer.from(result.bodyBytes).toString()).toBe('正文');
  const note = Buffer.from('---\n类型: 知识历史记录\n关键词: [访谈]\n核心内容: 历史经验\n关联资料: ["[[01图书馆/02个人资料/访谈]]"]\n---\n历史');
  expect(parseKnowledgeNoteForRead(note, '03知识库/档案室/访谈.md').record).toMatchObject({
    usageStatus: '历史记录', sourceType: '未标注', recallFields: { conclusion: '历史经验', keywords: ['访谈'] },
    sourceMaterials: ['01图书馆/02个人资料/访谈']
  });
});
