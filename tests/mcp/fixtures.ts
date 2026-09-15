import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const KNOWLEDGE_PATH = '02知识库/决策/证据方法.md';
export const OUTDATED_PATH = '02知识库/决策/过时方法.md';
export const INVALID_KNOWLEDGE_PATH = '02知识库/决策/坏笔记.md';
export const SOURCE_PATH = '01图书馆/个人/原始证据.md';

const knowledgeNote = (status: 'AI总结' | '过时', title: string, body: string): string => `---
类型: 知识笔记
来源类型: AI提炼
使用状态: ${status}
知识类型: 方法
所属主题: [决策]
关键词: [证据, 只读]
来源资料: []
适用场景: [检查资料]
核心结论: 先核实证据再行动
关键要点: [阅读原文]
使用边界: 仅适用于可验证资料
备注:
---

# ${title}
${body}
`;

const sourceNote = `---
类型: 原始资料
处理状态: 未归档
来源平台: 个人
原始标题: 原始证据
作者:
原始链接:
采集日期: 2026-09-14
所属主题: [决策]
关键词: [核验]
知识入库状态: 未提炼
生成知识: []
备注:
---

第一行：背景。
第二行：证据需要逐字核验。
第三行：行动前再次检查。
`;

export async function createBrainFixture() {
  const root = await mkdtemp(join(tmpdir(), 'xiaozhao-brain-mcp-'));
  for (const directory of ['00大脑规则', '01图书馆/个人', '02知识库/决策', '03大讲堂']) {
    await mkdir(join(root, directory), { recursive: true });
  }

  await writeFile(join(root, KNOWLEDGE_PATH), knowledgeNote('AI总结', '证据方法', '正文也提到证据链。'));
  await writeFile(join(root, OUTDATED_PATH), knowledgeNote('过时', '过时方法', '旧正文不应默认召回。'));
  await writeFile(join(root, INVALID_KNOWLEDGE_PATH), '---\n类型: 知识笔记\n使用状态: [坏\n---\n无法解析\n');
  await writeFile(join(root, SOURCE_PATH), sourceNote);
  await mkdir(join(root, '02知识库/.隐藏目录'), { recursive: true });
  await writeFile(join(root, '02知识库/.隐藏目录/隐藏.md'), knowledgeNote('AI总结', '隐藏', '不应被扫描。'));
  await writeFile(join(root, '02知识库/决策/.隐藏.md'), knowledgeNote('AI总结', '隐藏', '不应被读取。'));

  let outsideSymlinkPath: string | undefined;
  try {
    outsideSymlinkPath = '02知识库/决策/外链.md';
    await symlink('/tmp', join(root, outsideSymlinkPath));
  } catch {
    outsideSymlinkPath = undefined;
  }

  return {
    root,
    outsideSymlinkPath,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    }
  };
}
