import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const templateRoot = resolve('templates/default-vault');

async function listTemplateFiles(directory = templateRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTemplateFiles(path));
    else files.push(relative(templateRoot, path));
  }
  return files.sort();
}

async function readTemplate(path: string): Promise<string> {
  return readFile(join(templateRoot, path), 'utf8');
}

describe('公开入门大脑模板', () => {
  it('公开模板包含四个目录、五份规则、示例资料和清单', async () => {
    const entries = await listTemplateFiles();
    expect(entries).toEqual(expect.arrayContaining([
      '00大脑规则/00_大脑规范.md',
      '00大脑规则/01_总路由规则.md',
      '00大脑规则/02_图书馆入馆规则.md',
      '00大脑规则/03_知识库提炼与入库规则.md',
      '00大脑规则/05_链接命名与治理规则.md',
      '01图书馆/小兆clipper/.gitkeep',
      '01图书馆/来自示例/2026-09/示例资料/示例资料.md',
      '02知识库/示例主题/示例知识.md',
      '03大讲堂/.gitkeep',
      '最佳拍档入门说明.md',
      'template-manifest.json',
    ]));
    expect(await readTemplate('最佳拍档入门说明.md')).toContain('示例');
    expect(await readTemplate('00大脑规则/03_知识库提炼与入库规则.md')).toContain('确认入库');
  });

  it('规则和示例用普通语言覆盖安全流程，并明确示例为虚构内容', async () => {
    const ruleFiles = (await listTemplateFiles()).filter((path) => path.startsWith('00大脑规则/') && path.endsWith('.md'));
    const rules = await Promise.all(ruleFiles.map(readTemplate));
    const combinedRules = rules.join('\n');
    for (const phrase of ['原文保留', '预览后归档', '确认后发送', '候选不等于正式知识', '确认入库', '来源可回看']) {
      expect(combinedRules).toContain(phrase);
    }
    expect(await readTemplate('01图书馆/来自示例/2026-09/示例资料/示例资料.md')).toMatch(/示例|虚构/);
    expect(await readTemplate('02知识库/示例主题/示例知识.md')).toMatch(/示例|虚构/);
  });

  it('清单固定为 1.0.0，列出公开文件及 SHA-256 指纹，且不泄露路径或密钥', async () => {
    const manifest = JSON.parse(await readTemplate('template-manifest.json')) as {
      version: string;
      files: Array<{ path: string; sha256: string }>;
    };
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.files).toEqual(expect.any(Array));
    const templateFiles = (await listTemplateFiles()).filter((path) => path !== 'template-manifest.json');
    expect(manifest.files.map((file) => file.path).sort()).toEqual(templateFiles);
    for (const file of manifest.files) {
      const digest = createHash('sha256').update(await readTemplate(file.path)).digest('hex');
      expect(file.sha256).toBe(digest);
      expect(file.path).not.toMatch(/^\//);
    }
    const allText = await Promise.all((await listTemplateFiles()).map(readTemplate));
    expect(allText.join('\n')).not.toMatch(/\/Users\/|\/home\/|API_KEY|SECRET|sk-[A-Za-z0-9]/i);
  });
});
