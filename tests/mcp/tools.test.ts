import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrainToolHandlers } from '../../mcp-server/tools.js';
import { createVaultReader } from '../../mcp-server/vault-reader.js';
import {
  createBrainFixture,
  KNOWLEDGE_PATH,
  OUTDATED_PATH,
  SOURCE_PATH
} from './fixtures.js';

const fixtures: Array<Awaited<ReturnType<typeof createBrainFixture>>> = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function resultValue(result: { content: Array<{ type: string; text?: string }> }): any {
  const text = result.content.find((item) => item.type === 'text')?.text;
  return JSON.parse(text ?? '{}');
}

describe('brain MCP tool handlers', () => {
  it('searches recall fields, excludes outdated notes by default, and reports skipped files', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const handlers = createBrainToolHandlers(await createVaultReader(fixture.root));
    const defaultResult = resultValue(await handlers.search_knowledge({ query: '证据', limit: 20 }));
    expect(defaultResult.items.map((item: { path: string }) => item.path)).toEqual([KNOWLEDGE_PATH]);
    expect(defaultResult.skippedCount).toBe(1);
    expect(defaultResult.truncated).toBe(false);
    expect(defaultResult.scannedBytes).toBeGreaterThan(0);

    const outdatedResult = resultValue(await handlers.search_knowledge({ query: '证据', status: '过时', limit: 20 }));
    expect(outdatedResult.items.map((item: { path: string }) => item.path)).toContain(OUTDATED_PATH);
  });

  it('searches and reads only the active knowledge section of a diary-layout vault', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    for (const directory of ['02日记本', '03知识库', '04大讲堂']) await mkdir(join(fixture.root, directory));
    await writeFile(join(fixture.root, '00大脑规则/03知识库规则.md'), '规则');
    const path = '03知识库/证据.md';
    const note = '---\n类型: 知识笔记\n关键词: [证据]\n核心内容: 核对证据\n关联资料: []\n---\n笔记正文';
    await writeFile(join(fixture.root, path), note);
    await writeFile(join(fixture.root, '03知识库/旧版.md'), note.replace('类型: 知识笔记', '类型: 知识历史记录'));
    const reader = await createVaultReader(fixture.root);
    const handlers = createBrainToolHandlers(reader);
    expect(resultValue(await handlers.search_knowledge({ query: '证据' })).items.map((row: { path: string }) => row.path)).toEqual([path]);
    expect(resultValue(await handlers.search_knowledge({ query: '证据', status: '历史记录' })).items).toHaveLength(1);
    expect(resultValue(await handlers.read_knowledge({ path })).title).toBe('证据');
    await expect(reader.readMarkdown(KNOWLEDGE_PATH)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(reader.readMarkdown('02日记本/日记.md')).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
  });

  it('reads knowledge, source, and evidence through structured JSON', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const handlers = createBrainToolHandlers(await createVaultReader(fixture.root));
    expect(resultValue(await handlers.read_knowledge({ path: KNOWLEDGE_PATH })).record.title).toBe('证据方法');
    expect(resultValue(await handlers.read_source({ path: SOURCE_PATH })).record.sourcePlatform).toBe('个人');
    expect(resultValue(await handlers.get_source_evidence({ path: SOURCE_PATH, query: '逐字核验' })).passages).toHaveLength(1);
  });

  it('searches beyond the public read response limit without silently losing a tail match', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const tailPath = '02知识库/决策/大笔记.md';
    const header = `---
类型: 知识笔记
来源类型: AI提炼
使用状态: AI总结
知识类型: 方法
所属主题: [决策]
关键词: [长文]
来源资料: []
适用场景: [检查资料]
核心结论: 长文测试
关键要点: [长文本]
使用边界: 仅用于搜索边界测试
---

`;
    await writeFile(join(fixture.root, tailPath), `${header}${'前置内容。\n'.repeat(12_000)}TAILQUERY\n`);
    const handlers = createBrainToolHandlers(await createVaultReader(fixture.root));
    const result = resultValue(await handlers.search_knowledge({ query: 'TAILQUERY', limit: 20 }));
    expect(result.items.map((item: { path: string }) => item.path)).toContain(tailPath);
    expect(result.truncated).toBe(false);
  });

  it('returns a safe error for invalid paths and never writes files', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const before = await readFile(`${fixture.root}/${KNOWLEDGE_PATH}`);
    const handlers = createBrainToolHandlers(await createVaultReader(fixture.root));
    const result = await handlers.read_knowledge({ path: '/etc/passwd' });
    expect(result.isError).toBe(true);
    expect(resultValue(result).code).toBe('PATH_NOT_ALLOWED');
    expect(JSON.stringify(result)).not.toContain(fixture.root);
    expect(await readFile(`${fixture.root}/${KNOWLEDGE_PATH}`)).toEqual(before);
  });
});
