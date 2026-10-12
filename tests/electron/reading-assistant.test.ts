import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

const sourcePath = '01图书馆/来自个人/理解与经验.md';
const selectedText = '理解需要把新概念和已有经验联系起来。';
const answer = '例如学习一个新概念时，先找一个自己熟悉的生活场景进行类比。';
async function makeFixture() {
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
  for (const path of ['00大脑规则', '01图书馆/来自个人', '01图书馆/小兆clipper', '02知识库', '03大讲堂', '.claude/skills']) await mkdir(join(vault, path), { recursive: true });
  for (const path of RULE_BUNDLE_SOURCE_PATHS) {
    await mkdir(join(vault, dirname(path)), { recursive: true });
    await writeFile(join(vault, path), '# 隔离测试规则\n保留原文。\n');
  }
  const source = (await readFile('tests/fixtures/library-valid.md', 'utf8')).replace('一份可提炼的资料', '理解与经验').replace('第一段原始正文。', selectedText);
  const sentinel = '# 正式知识哨兵\n本测试不允许改写。\n';
  await writeFile(join(vault, sourcePath), source);
  await writeFile(join(vault, '02知识库/哨兵.md'), sentinel);
  return { vault, userData, source, sentinel };
}
async function launch(fixture: Awaited<ReturnType<typeof makeFixture>>, mode: 'development' | 'packaged') {
  const target = mode === 'packaged' ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] } : { args: [resolve('dist/electron/main.js')] };
  return electron.launch({ ...target, env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: fixture.vault, XIAOZHAO_TEST_USER_DATA: fixture.userData } });
}
async function installProvider(instance: ElectronApplication) {
  await instance.evaluate((_electron, fixture) => {
    const state = globalThis as unknown as { learningCalls: number; learningToolNames: string[][] };
    state.learningCalls = 0; state.learningToolNames = [];
    const stream = (delta: Record<string, unknown>, finish = 'stop') => new Response(
      `data: ${JSON.stringify({ id: 'learning-fixture', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: 'learning-fixture', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } })}\n\n` + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    globalThis.fetch = async (input, init) => {
      if (String(input) === 'https://api.deepseek.com/models') return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] }), { headers: { 'content-type': 'application/json' } });
      if (String(input) !== 'https://api.deepseek.com/chat/completions') throw new Error('LEARNING_TEST_NETWORK_FORBIDDEN');
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] };
      state.learningCalls += 1; state.learningToolNames.push((body.tools ?? []).map(tool => tool.function.name));
      if (body.messages.at(-1)?.role !== 'tool') return stream({ role: 'assistant', tool_calls: [{ index: 0, id: `read-${state.learningCalls}`, type: 'function', function: { name: 'read_document', arguments: JSON.stringify({ path: fixture.sourcePath }) } }] }, 'tool_calls');
      return stream({ role: 'assistant', content: fixture.answer });
    };
  }, { sourcePath, answer });
}
async function openSource(window: Page) {
  await expect(window.getByRole('link', { name: '设置', exact: true })).toBeVisible();
  const origin = await window.evaluate(() => location.origin);
  await window.goto(`${origin}/library?${new URLSearchParams({ path: sourcePath })}`);
  await expect(window.locator('.reading-selection-body').getByText(selectedText, { exact: true })).toBeVisible({ timeout: 20_000 });
}
async function selectSource(window: Page) {
  await window.locator('.reading-selection-body').getByText(selectedText, { exact: true }).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await window.getByRole('button', { name: '问问这段内容', exact: true }).click();
}

for (const mode of ['development', 'packaged'] as const) {
test(`${mode}: reading selection explains, follows up, saves edited understanding and survives restart without rewriting source`, async ({}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await makeFixture(); let instance: ElectronApplication | undefined;
  try {
    instance = await launch(fixture, mode); await installProvider(instance);
    let window = await instance.firstWindow();
    await window.getByRole('link', { name: '设置', exact: true }).click();
    await window.getByLabel('DeepSeek API Key').fill('sk-isolated-reading-assistant');
    await window.getByRole('button', { name: '保存密钥', exact: true }).click();
    await expect(window.getByText('密钥已保存，连接尚未验证。')).toBeVisible();
    await openSource(window); await selectSource(window);
    let panel = window.getByRole('complementary', { name: '问问 AI' });
    await expect(panel.getByRole('region', { name: '你选中的文字', exact: true })).toContainText(selectedText);
    expect(await instance.evaluate(() => (globalThis as unknown as { learningCalls: number }).learningCalls)).toBe(0);
    await panel.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(panel.getByRole('article', { name: '问问的回答' }).last()).toContainText(answer, { timeout: 30_000 });
    await expect(panel.getByRole('button', { name: '停止回答', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '说简单点', exact: true }).click();
    await expect(panel.getByLabel('发送给问问的消息')).toHaveValue('请把你刚才的解释说得更简单一些。');
    await panel.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(panel.getByRole('article', { name: '问问的回答' })).toHaveCount(2);
    await expect(panel.getByRole('article', { name: '问问的回答' }).last()).toContainText(answer);
    await expect(panel.getByRole('button', { name: '停止回答', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '保存理解', exact: true }).last().click();
    await panel.getByLabel('笔记标题', { exact: true }).fill('我的类比学习笔记');
    await panel.getByLabel('笔记正文', { exact: true }).fill('我的理解：用熟悉的经验解释陌生概念，再检查类比的边界。');
    await panel.getByRole('button', { name: '关闭问问', exact: true }).click();
    await window.getByRole('button', { name: '打开问问 AI', exact: true }).click();
    await expect(panel.getByLabel('笔记正文', { exact: true })).toHaveValue('我的理解：用熟悉的经验解释陌生概念，再检查类比的边界。');
    await panel.getByRole('button', { name: '确认保存笔记', exact: true }).click();
    await expect(panel.getByText('已保存为学习笔记', { exact: true })).toBeVisible();
    const toolNames = await instance.evaluate(() => (globalThis as unknown as { learningToolNames: string[][] }).learningToolNames);
    expect(toolNames.length).toBe(4);
    for (const names of toolNames) expect(names.sort()).toEqual(['read_document', 'search_knowledge', 'search_materials']);
    await window.screenshot({ path: testInfo.outputPath('reading-wide.png') });
    await window.setViewportSize({ width: 720, height: 900 });
    await expect(panel.getByRole('button', { name: '已保存理解', exact: true })).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath('reading-narrow.png') });
    await instance.close(); instance = await launch(fixture, mode); await installProvider(instance); window = await instance.firstWindow();
    await openSource(window);
    await window.getByRole('button', { name: '学习笔记', exact: true }).click();
    await window.getByRole('button', { name: '我的类比学习笔记', exact: true }).click();
    await expect(window.getByLabel('笔记正文', { exact: true })).toHaveValue('我的理解：用熟悉的经验解释陌生概念，再检查类比的边界。');
    await window.getByRole('button', { name: '打开问问 AI', exact: true }).click();
    panel = window.getByRole('complementary', { name: '问问 AI' });
    await expect(panel.getByRole('article', { name: '问问的回答' })).toHaveCount(2);
    await expect(panel.getByRole('region', { name: '你选中的文字', exact: true })).toContainText(selectedText);
    expect(await readFile(join(fixture.vault, sourcePath), 'utf8')).toBe(fixture.source);
    expect(await readFile(join(fixture.vault, '02知识库/哨兵.md'), 'utf8')).toBe(fixture.sentinel);
  } finally { await instance?.close(); await rm(fixture.vault, { recursive: true, force: true }); await rm(fixture.userData, { recursive: true, force: true }); }
});

}
