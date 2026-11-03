import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { createTextPdf } from '../helpers/pdf-fixture.js';

const text = '短视频获客需要先明确目标客户的具体问题，再围绕这个问题选择内容主题。视频里展示真实案例和服务过程，结尾给出清楚的咨询入口，并记录从播放到咨询的转化。';
const textTitle = '短视频获客的选题与转化方法';
const pdfTitle = '用户访谈的证据记录方法';
async function fixture() {
  const base = await realpath(tmpdir());
  const vault = await mkdtemp(join(base, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(base, 'xiaozhao-user-data-'));
  const workdisk = await mkdtemp(join(base, 'xiaozhao-workdisk-'));
  const source = await mkdtemp(join(base, 'xiaozhao-imports-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
  for (const folder of ['00大脑规则', '01图书馆/来自个人', '01图书馆/小兆clipper', '02知识库', '03大讲堂', '.claude/skills']) await mkdir(join(vault, folder), { recursive: true });
  for (const path of RULE_BUNDLE_SOURCE_PATHS) { await mkdir(join(vault, dirname(path)), { recursive: true }); await writeFile(join(vault, path), '# 隔离规则\n保留原文。'); }
  await writeFile(join(vault, '02知识库/哨兵.md'), '# 不修改知识资料\n');
  const names = ['83927.txt', 'x73bf.pdf', '73802.pdf'];
  const bytes = [Buffer.from(text), createTextPdf(['FIELD INTERVIEW EVIDENCE: Record observations and exact quotes separately from interpretations. Compare each finding against the original interview transcript.']), createTextPdf([''])];
  const files = names.map(name => join(source, name));
  for (let index = 0; index < files.length; index++) await writeFile(files[index]!, bytes[index]!);
  return { vault, userData, workdisk, source, files, bytes };
}
async function launch(data: Awaited<ReturnType<typeof fixture>>, mode: 'development' | 'packaged') {
  const target = mode === 'packaged' ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] } : { args: [resolve('dist/electron/main.js')] };
  return electron.launch({ ...target, env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: data.vault, XIAOZHAO_TEST_USER_DATA: data.userData, XIAOZHAO_TEST_WORKDISK_ROOT: data.workdisk, XIAOZHAO_TEST_WORKDISK_IMPORT_JSON: JSON.stringify(data.files) } });
}
async function provider(instance: ElectronApplication) {
  await instance.evaluate((_electron, titles) => {
    const state = globalThis as unknown as { namingInputs: string[]; namingTools: number[] };
    state.namingInputs = []; state.namingTools = [];
    globalThis.fetch = async (input, init) => {
      if (String(input) === 'https://api.deepseek.com/models') return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] }), { headers: { 'content-type': 'application/json' } });
      if (String(input) !== 'https://api.deepseek.com/chat/completions') throw new Error('NAMING_FIXTURE_NETWORK_FORBIDDEN');
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[]; tools?: unknown[] };
      const content = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
      state.namingInputs.push(content); state.namingTools.push(body.tools?.length ?? 0);
      const title = content.includes('FIELD INTERVIEW EVIDENCE') ? titles.pdf : titles.text;
      return new Response(`data: ${JSON.stringify({ id: 'naming-fixture', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ title }) }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: 'naming-fixture', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } })}\n\n` + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
  }, { text: textTitle, pdf: pdfTitle });
}
for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: names TXT and PDF from content, preserves sources, skips scan PDF and respects opt-out`, async ({}, info) => {
    test.setTimeout(120_000); const data = await fixture(); let instance: ElectronApplication | undefined;
    try {
      instance = await launch(data, mode); await provider(instance); let page = await instance.firstWindow();
      await page.getByRole('link', { name: '设置', exact: true }).click();
      await page.getByLabel('DeepSeek API Key').fill('sk-isolated-content-naming');
      await page.getByRole('button', { name: '保存密钥', exact: true }).click();
      await expect(page.getByText('密钥已保存，连接尚未验证。')).toBeVisible();
      await page.getByRole('link', { name: '工作盘', exact: true }).click();
      await page.getByRole('button', { name: '连接本地文件夹', exact: true }).click();
      await page.getByLabel('收纳日期', { exact: true }).fill('2026-10-29');
      await expect(page.getByRole('checkbox', { name: '根据内容命名', exact: true })).toBeChecked();
      await expect(page.getByText('文字与图片识别结果交给已连接的 AI 起名，原件保留。', { exact: true })).toBeVisible();
      await page.getByText('命名说明', { exact: true }).click();
      await expect(page.getByText(/可读正文会发送给已连接的 AI/u)).toBeVisible();
      await page.getByRole('button', { name: '收文件', exact: true }).click();
      await expect(page.getByRole('button', { name: `预览 ${textTitle}.txt`, exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('button', { name: `预览 ${pdfTitle}.pdf`, exact: true })).toBeVisible();
      const receipt = page.getByRole('region', { name: '本次收纳命名结果' });
      await expect(receipt).toContainText('2 份已根据内容命名');
      await expect(receipt).toContainText('83927.txt'); await expect(receipt).toContainText('x73bf.pdf');
      await expect(receipt).toContainText('73802.pdf');
      await expect(receipt).toContainText(/无可读文字|没有可读文字|扫描|OCR/u);
      const sent = await instance.evaluate(() => ({ inputs: (globalThis as unknown as { namingInputs: string[] }).namingInputs, tools: (globalThis as unknown as { namingTools: number[] }).namingTools }));
      expect(sent.inputs).toHaveLength(2); expect(sent.inputs.join('\n')).toContain('短视频获客'); expect(sent.inputs.join('\n')).toContain('FIELD INTERVIEW EVIDENCE');
      expect(sent.inputs.join('\n')).not.toContain('83927'); expect(sent.tools).toEqual([0, 0]);
      await receipt.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('content-naming-wide.png') });
      await page.setViewportSize({ width: 720, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator('.workdisk-naming-help p').evaluate(element => ({
        fits: element.scrollWidth <= element.clientWidth,
        linkFits: element.querySelector('a')!.getBoundingClientRect().right <= element.getBoundingClientRect().right,
        display: getComputedStyle(element).display,
        whiteSpace: getComputedStyle(element).whiteSpace
      }))).toMatchObject({ fits: true, linkFits: true });
      await receipt.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('content-naming-narrow.png') });
      await page.getByRole('checkbox', { name: '根据内容命名', exact: true }).uncheck();
      await page.getByRole('button', { name: '收文件', exact: true }).click();
      await expect(page.getByRole('button', { name: '预览 83927.txt', exact: true })).toBeVisible();
      expect(await instance.evaluate(() => (globalThis as unknown as { namingInputs: string[] }).namingInputs.length)).toBe(2);
      for (let index = 0; index < data.files.length; index++) expect((await readFile(data.files[index]!)).equals(data.bytes[index]!)).toBe(true);
      expect((await readFile(join(data.workdisk, `2026-10-29/文档/${textTitle}.txt`))).equals(data.bytes[0]!)).toBe(true);
      expect((await readFile(join(data.workdisk, `2026-10-29/文档/${pdfTitle}.pdf`))).equals(data.bytes[1]!)).toBe(true);
      expect(await readFile(join(data.vault, '02知识库/哨兵.md'), 'utf8')).toBe('# 不修改知识资料\n');
      await instance.close(); instance = await launch(data, mode); await provider(instance); page = await instance.firstWindow();
      await page.getByRole('link', { name: '工作盘', exact: true }).click();
      await expect(page.getByRole('button', { name: `预览 ${textTitle}.txt`, exact: true })).toBeVisible();
      await page.getByRole('button', { name: `预览 ${textTitle}.txt`, exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText(text);
    } finally { await instance?.close(); for (const path of [data.vault, data.userData, data.workdisk, data.source]) await rm(path, { recursive: true, force: true }); }
  });
}
