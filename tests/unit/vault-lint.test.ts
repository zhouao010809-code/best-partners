import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lintVault } from '../../scripts/vault-lint.js';

const temporaryDirectories: string[] = [];

async function createVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xiaozhao-vault-lint-'));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(join(root, '01图书馆'), { recursive: true }),
    mkdir(join(root, '02知识库'), { recursive: true })
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const validMaterial = `---
类型: 原始资料
处理状态: 未归档
来源平台: B站
所属主题: []
关键词: [测试]
知识入库状态: 未提炼
生成知识: []
---
原始资料
`;

const legacyMaterial = validMaterial.replace('生成知识: []', '生成知识: [[历史知识]]');
const validKnowledge = `---
类型: 知识笔记
来源类型: AI提炼
使用状态: AI总结
知识类型: 方法
所属主题: []
关键词: [测试]
来源资料: []
适用场景: [测试]
核心结论: 结论
关键要点: [要点]
使用边界: 边界
---
知识正文
`;

describe('read-only vault lint', () => {
  it('counts strict notes as valid and legacy-compatible notes as warnings', async () => {
    const root = await createVault();
    await writeFile(join(root, '01图书馆', 'valid.md'), validMaterial);
    await writeFile(join(root, '01图书馆', 'legacy.md'), legacyMaterial);
    await writeFile(join(root, '02知识库', 'knowledge.md'), validKnowledge);

    const report = await lintVault(root);

    expect(report.summary).toEqual({ files: 3, valid: 2, warnings: 1, errors: 0 });
    expect(report.issues).toEqual([
      expect.objectContaining({
        path: '01图书馆/legacy.md',
        severity: 'warning',
        code: 'LEGACY_READ_COMPATIBLE'
      })
    ]);
  });

  it('keeps untyped markdown reportable without failing the default scan', async () => {
    const root = await createVault();
    await writeFile(join(root, '01图书馆', 'source-packet.md'), '# 原始资料\n');

    await expect(lintVault(root)).resolves.toMatchObject({
      summary: { files: 1, valid: 0, warnings: 1, errors: 0 },
      issues: [expect.objectContaining({ code: 'UNCLASSIFIED_MARKDOWN', severity: 'warning' })]
    });
    await expect(lintVault(root, { strictUntyped: true })).resolves.toMatchObject({
      summary: { files: 1, valid: 0, warnings: 0, errors: 1 },
      issues: [expect.objectContaining({ code: 'UNCLASSIFIED_MARKDOWN', severity: 'error' })]
    });
  });

  it.each([
    { directory: '01图书馆', kind: 'material', markdown: validMaterial },
    { directory: '02知识库', kind: 'knowledge', markdown: validKnowledge }
  ])('reports unclosed $kind frontmatter as an error in every mode', async ({ directory, kind, markdown }) => {
    const root = await createVault();
    await writeFile(join(root, directory, 'unclosed.md'), markdown.replace('\n---\n', '\n'));

    for (const options of [{}, { strictUntyped: true }]) {
      await expect(lintVault(root, options)).resolves.toMatchObject({
        summary: { files: 1, valid: 0, warnings: 0, errors: 1 },
        issues: [expect.objectContaining({
          path: `${directory}/unclosed.md`,
          kind,
          code: 'FRONTMATTER_INVALID',
          message: 'FRONTMATTER_CLOSING_DELIMITER_MISSING',
          severity: 'error'
        })]
      });
    }
  });
});
