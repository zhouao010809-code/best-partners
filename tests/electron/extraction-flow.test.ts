import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

const fixtureResult = {
  briefing: { sentences: ['这份资料讨论如何建立学习习惯。', '重点在于把方法转成稳定的步骤。', '结论仍需要结合个人情境验证。'], keyPoints: ['学习需要明确的使用情境'], usefulness: '帮助选择可实践的学习方法' },
  candidates: [{ title: '把学习方法转成可执行步骤', knowledgeType: '方法', suggestedPath: '02知识库/09学习', topics: [], coreContent: '先明确问题，再把方法拆成小步骤，最后记录实践反馈。', value: '让阅读能够转成行动',
    draft: { keywords: ['学习', '执行', '反馈'], scenarios: ['设计学习计划', '复盘实践过程'], conclusion: '通过小步骤与反馈把阅读转成行动。', keyPoints: ['先明确问题', '记录实践反馈'], boundary: '需要可观察的执行反馈。', quotes: [], summaries: ['用一次具体行动验证学到的方法。'] } }]
};

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: configure, explicitly extract, reopen candidates without vault writes or real provider traffic`, async ({}, testInfo) => {
    const temporary = await realpath(tmpdir());
    const vaultRoot = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
    const userDataDir = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
    const launchOptions = mode === 'packaged'
      ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
      : { args: [resolve('dist/electron/main.js')] };
    const env = { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vaultRoot, XIAOZHAO_TEST_USER_DATA: userDataDir };
    let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      await writeFile(join(vaultRoot, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
      for (const directory of ['00大脑规则', '01图书馆/来自个人', '02知识库/09学习', '03大讲堂']) await mkdir(join(vaultRoot, directory), { recursive: true });
      for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vaultRoot, path), '# Fixture rule\n只生成候选，不写入正式知识。\n');
      const original = (await readFile(resolve('tests/fixtures/library-valid.md'), 'utf8'))
        .replace('一份可提炼的资料', '桌面提炼测试资料').replace('处理状态: 未归档', '处理状态: 已归档').replace('来源平台: B站', '来源平台: 个人');
      const sourcePath = '01图书馆/来自个人/桌面提炼测试资料.md';
      await writeFile(join(vaultRoot, sourcePath), original);
      const knowledge = await readFile(resolve('tests/fixtures/knowledge-valid.md'));
      await writeFile(join(vaultRoot, '02知识库/09学习/测试知识.md'), knowledge);
      instance = await electron.launch({ ...launchOptions, env });
      const window = await instance.firstWindow();
      const consoleErrors: string[] = [];
      window.on('pageerror', (error) => consoleErrors.push(error.message));
      await expect(window.getByTestId('metric-materials')).toContainText('1');
      // Replace only the provider transport in this isolated process. No production test hooks or real network calls.
      await instance.evaluate((_electron, result) => {
        const state = globalThis as unknown as { extractionTestCalls: number; extractionTestBody?: Record<string, unknown> };
        state.extractionTestCalls = 0;
        globalThis.fetch = async (input, init) => {
          if (String(input) !== 'https://api.deepseek.com/chat/completions') throw new Error('TEST_NETWORK_FORBIDDEN');
          state.extractionTestCalls += 1;
          state.extractionTestBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ id: 'test-completion', object: 'chat.completion', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }], usage: { prompt_tokens: 30, completion_tokens: 30, total_tokens: 60 } }), { headers: { 'content-type': 'application/json' } });
        };
      }, fixtureResult);
      await window.getByRole('link', { name: '设置', exact: true }).click();
      await window.getByLabel('DeepSeek API Key').fill('sk-electron-isolated-fixture');
      await window.getByRole('button', { name: '保存密钥', exact: true }).click();
      await expect(window.getByText(/密钥已保存在本机，尚未验证连接/u)).toBeVisible();
      await expect(window.getByLabel('DeepSeek API Key')).toHaveValue('');
      await expect(window.getByText('密钥已保存，连接尚未验证。')).toBeVisible();
      expect(await instance.evaluate(() => (globalThis as unknown as { extractionTestCalls: number }).extractionTestCalls)).toBe(0);
      await window.screenshot({ path: testInfo.outputPath('deepseek-settings.png') });
      await window.getByRole('link', { name: '提炼队列', exact: true }).click();
      await window.getByRole('button', { name: '展开待提炼抽屉', exact: true }).click();
      await window.getByRole('button', { name: '打开 桌面提炼测试资料', exact: true }).click();
      await expect(window.getByRole('button', { name: '原文', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await window.screenshot({ path: testInfo.outputPath('queue-original.png') });
      await window.getByRole('button', { name: '开始提炼', exact: true }).click();
      await window.getByRole('button', { name: '预览发送内容' }).click();
      await expect(window.getByRole('heading', { name: '确认发送给 DeepSeek 的内容' })).toBeVisible();
      expect(await instance.evaluate(() => (globalThis as unknown as { extractionTestCalls: number }).extractionTestCalls)).toBe(0);
      await window.screenshot({ path: testInfo.outputPath('extraction-preview.png') });
      await window.getByRole('button', { name: '确认发送并提炼' }).click();
      await expect(window.getByRole('heading', { name: '1. 把学习方法转成可执行步骤' })).toBeVisible({ timeout: 20_000 });
      await expect(window.getByRole('region', { name: '候选审阅与入库' })).toBeVisible();
      await expect(window.getByText('已保存到本机草稿')).toBeVisible();
      await expect(window.getByRole('radio', { name: '稍后处理' })).toBeChecked();
      expect(await instance.evaluate(() => (globalThis as unknown as { extractionTestCalls: number }).extractionTestCalls)).toBe(1);
      expect(await instance.evaluate(() => {
        const body = (globalThis as unknown as { extractionTestBody: Record<string, unknown> }).extractionTestBody;
        return { model: body.model, tools: body.tools, thinking: body.thinking };
      })).toEqual({ model: 'deepseek-v4-pro', tools: undefined, thinking: { type: 'disabled' } });
      expect(await window.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('brain-ingestion-draft:')))).toEqual([]);
      const savedPath = new URL(window.url()).pathname;
      await window.screenshot({ path: testInfo.outputPath('extraction-candidates.png'), fullPage: true });
      await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 800));
      await expect(window.getByRole('button', { name: '资料导航', exact: true })).toBeVisible();
      const bounds = await window.locator('main').boundingBox();
      expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(bounds!.x).toBeGreaterThanOrEqual(72);
      await window.screenshot({ path: testInfo.outputPath('extraction-compact.png'), fullPage: true });
      expect(consoleErrors).toEqual([]);
      await instance.close(); instance = undefined;
      expect(await readFile(join(vaultRoot, sourcePath), 'utf8')).toBe(original);
      expect(await readFile(join(vaultRoot, '02知识库/09学习/测试知识.md'))).toEqual(knowledge);
      instance = await electron.launch({ ...launchOptions, env });
      const reopened = await instance.firstWindow();
      await instance.evaluate(() => { globalThis.fetch = async () => { throw new Error('NO_NETWORK_ON_REOPEN'); }; });
      await reopened.getByRole('link', { name: '提炼队列', exact: true }).click();
      await reopened.getByRole('button', { name: '展开待确认抽屉', exact: true }).click();
      await reopened.getByRole('button', { name: '打开 桌面提炼测试资料', exact: true }).click();
      expect(new URL(reopened.url()).pathname).toBe(savedPath);
      await expect(reopened.getByRole('heading', { name: '1. 把学习方法转成可执行步骤' })).toBeVisible();
      await reopened.getByRole('link', { name: '设置', exact: true }).click();
      await expect(reopened.getByText('密钥已保存，连接尚未验证。')).toBeVisible();
      await reopened.getByRole('button', { name: '移除密钥', exact: true }).click();
      await reopened.getByRole('button', { name: '确认移除密钥', exact: true }).click();
      await expect(reopened.getByText('密钥已从本机移除。已保存的候选不会删除。')).toBeVisible();
      const health = await fetch(`${new URL(reopened.url()).origin}/api/v1/health`).then((response) => response.json());
      expect(health.data.writeGate.status).toBe('blocked');
      expect(health.data.model.status).toBe('unconfigured');
      expect(await readFile(join(vaultRoot, sourcePath), 'utf8')).toBe(original);
      expect(await readFile(join(vaultRoot, '02知识库/09学习/测试知识.md'))).toEqual(knowledge);
    } finally {
      await instance?.close();
      await rm(vaultRoot, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
}
