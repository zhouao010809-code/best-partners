import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

type Fixture = { vault: string; userData: string; project: string };
const nestedFileName = '非常长但可辨认的项目需求说明与下一阶段内容执行计划.md';
const nestedPath = `客户资料/${nestedFileName}`;
const nestedContent = '# 项目需求说明\n合成资料：先核对客户需求，再安排下周的内容计划。\n';

async function resize(instance: ElectronApplication, window: Page, width: number): Promise<void> {
  await instance.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size, size === 720 ? 800 : 900), width);
  await expect.poll(() => window.evaluate(() => innerWidth)).toBe(width);
}

async function expectNoHorizontalOverflow(window: Page, selector: string): Promise<void> {
  await expect.poll(() => window.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1
    && document.body.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect.poll(() => window.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

async function makeFixture(): Promise<Fixture> {
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  const project = await mkdtemp(join(temporary, 'xiaozhao-client-project-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
  for (const directory of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂']) await mkdir(join(vault, directory), { recursive: true });
  for (const path of RULE_BUNDLE_SOURCE_PATHS) {
    await mkdir(join(vault, dirname(path)), { recursive: true });
    await writeFile(join(vault, path), '# Fixture rule\n');
  }
  await writeFile(join(vault, '02知识库', '全局方法.md'), '# 全局方法\n用证据优化选题。\n');
  await writeFile(join(project, 'brief.md'), '# A项目\n目标受众：代运营客户。\n');
  await writeFile(join(project, 'content-history.md'), '# 内容历史\n已有内容记录。\n');
  await writeFile(join(project, 'unsupported.png'), Buffer.from('fixture'));
  await mkdir(join(project, '客户资料'));
  await writeFile(join(project, nestedPath), nestedContent);
  await mkdir(join(project, '.workbuddy'));
  await writeFile(join(project, '.workbuddy/private.md'), '# 隐藏测试记录\n不应抢占默认资料列表。\n');
  await writeFile(join(project, '.DS_Store'), 'isolated fixture');
  return { vault, userData, project };
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: browse readable project files and prepare a project question without sending it`, async ({}, info) => {
    test.setTimeout(120_000);
    const fixture = await makeFixture();
    const launchOptions = mode === 'packaged'
      ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
      : { args: [resolve('dist/electron/main.js')] };
    let instance: ElectronApplication | undefined;
    try {
      instance = await electron.launch({
        ...launchOptions,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          XIAOZHAO_TEST_VAULT_ROOT: fixture.vault,
          XIAOZHAO_TEST_USER_DATA: fixture.userData,
          XIAOZHAO_TEST_PROJECT_ROOT: fixture.project
        }
      });
      // Only synthetic local data is used. A regression must never reach a
      // real provider, even if a task suggestion accidentally tries to send.
      await instance.evaluate(() => {
        globalThis.fetch = async () => { throw new Error('ISOLATED_PROJECT_READABILITY_NO_NETWORK'); };
      });
      const window = await instance.firstWindow();
      let sendAttempts = 0;
      await window.route('**/api/v1/assistant/messages', async route => {
        if (route.request().method() === 'POST') {
          sendAttempts += 1;
          await route.abort('blockedbyclient');
        } else await route.continue();
      });
      const initialProjectEntries = (await readdir(fixture.project, { recursive: true })).sort();
      const globalKnowledgeBefore = await readFile(join(fixture.vault, '02知识库/全局方法.md'));
      await resize(instance, window, 1360);
      const projectsLink = window.getByRole('link', { name: '我的项目', exact: true });
      await expect(projectsLink).toBeVisible();
      await projectsLink.click();
      await expect(window).toHaveURL(/\/projects$/u);
      await window.getByRole('button', { name: '添加项目', exact: true }).click();
      await expect(window.getByRole('heading', { name: '确认项目文件夹', exact: true })).toBeVisible();
      await expect(window.getByText(/不需要填写客户背景、阶段或目标/u)).toBeVisible();
      expect(await window.getByLabel(/背景|阶段|目标/u).count()).toBe(0);
      await window.getByRole('textbox', { name: '项目显示名（可选）' }).fill('A项目');
      await window.getByRole('button', { name: '确认添加项目', exact: true }).click();

      await expect(window).toHaveURL(/\/projects\/[0-9a-f-]+$/u);
      await expect(window.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(window.getByRole('heading', { level: 1, name: 'A项目', exact: true })).toBeVisible();
      await expect(window.getByRole('heading', { name: 'A项目', exact: true })).toHaveCount(1);
      await expect(window.getByRole('heading', { name: '项目工作区', exact: true })).toHaveCount(0);
      await expect(window.getByText('READ ONLY', { exact: true })).toHaveCount(0);
      const status = window.getByRole('region', { name: '项目资料状态', exact: true });
      await expect(status).toHaveCount(1);
      await expect(status.getByText('资料已连接', { exact: true })).toBeVisible();
      const update = status.getByRole('button', { name: '更新资料', exact: true });
      const ask = window.getByRole('button', { name: '讨论项目', exact: true });
      const panel = window.getByRole('complementary', { name: '问问 AI' });
      await expect(panel).toBeHidden();
      await ask.click();
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('heading', { name: '项目问问', exact: true })).toBeVisible();
      await expect(panel.getByText('A项目', { exact: true })).toHaveCount(1);
      await expect(panel.getByText('项目资料已连接', { exact: true })).toBeVisible();
      const composer = panel.getByRole('textbox', { name: '发送给问问的消息', exact: true });
      await expect(composer).toBeEnabled();
      await expect(composer).toHaveAttribute('placeholder', '想了解这个项目的什么？');
      for (const suggestion of ['梳理项目重点', '找资料回答问题', '起草下一步计划']) {
        await panel.getByRole('button', { name: suggestion, exact: true }).click();
        await expect(composer).toHaveValue(suggestion);
        expect(sendAttempts).toBe(0);
      }
      await expect(panel.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport();
      await expectNoHorizontalOverflow(window, '.assistant-panel');
      await window.screenshot({ path: info.outputPath('project-assistant-1360.png') });
      await panel.getByRole('button', { name: '关闭问问', exact: true }).click();
      await expect(panel).toBeHidden();

      await window.getByRole('tab', { name: '项目资料', exact: true }).click();
      const files = window.getByRole('region', { name: '项目资料与产出', exact: true });
      const sourceTab = files.getByRole('tab', { name: /^项目资料/u });
      const outputTab = files.getByRole('tab', { name: /^已保存产出/u });
      const nestedFile = files.getByRole('button', { name: `打开文件：${nestedPath}`, exact: true });
      const folder = files.getByRole('button', { name: '展开文件夹：客户资料', exact: true });
      await expect(sourceTab).toHaveAttribute('aria-selected', 'true');
      await expect(files.getByRole('button', { name: '打开文件：.DS_Store', exact: true })).toHaveCount(0);
      await expect(files.getByRole('button', { name: '打开文件：.workbuddy/private.md', exact: true })).toHaveCount(0);
      await expect(files.getByRole('button', { name: '展开文件夹：.workbuddy', exact: true })).toHaveCount(0);
      const showHidden = files.getByRole('checkbox', { name: '显示隐藏文件', exact: true });
      await expect(showHidden).not.toBeChecked();
      await showHidden.check();
      await expect(files.getByRole('button', { name: '打开文件：.DS_Store', exact: true })).toBeVisible();
      await showHidden.uncheck();
      await expect(files.getByRole('button', { name: '打开文件：.DS_Store', exact: true })).toHaveCount(0);
      await expect(nestedFile).toHaveCount(0);
      await folder.click();
      await expect(nestedFile).toBeVisible();
      await expect(nestedFile.locator('strong')).toHaveText(nestedFileName);
      await nestedFile.click();
      await expect(files.locator('pre')).toHaveText(nestedContent);
      await ask.scrollIntoViewIfNeeded();
      await expect(ask).toBeInViewport();
      await expect(update).toBeInViewport();
      await expectNoHorizontalOverflow(window, '.project-files-panel');
      await window.screenshot({ path: info.outputPath('project-files-1360.png') });

      const search = files.getByRole('textbox', { name: '搜索项目文件', exact: true });
      await search.fill('核对客户需求');
      await expect(nestedFile).toBeVisible();
      await expect(files.getByRole('button', { name: /^(?:展开|收起)文件夹：/u })).toHaveCount(0);
      await search.fill('不存在的项目资料xyz');
      await expect(files.getByText(/没有找到/u)).toBeVisible();
      await expect(nestedFile).toHaveCount(0);
      await search.fill('');
      await expect(files.getByRole('button', { name: '打开文件：brief.md', exact: true })).toBeVisible();
      await files.getByRole('button', { name: '打开文件：brief.md', exact: true }).click();
      await expect(files.locator('pre')).toContainText('目标受众：代运营客户');
      await outputTab.click();
      await expect(outputTab).toHaveAttribute('aria-selected', 'true');
      await expect(files.getByText(/还没有.*产出/u)).toBeVisible();
      await expect(files.locator('pre')).toHaveCount(0);
      await sourceTab.click();
      await expect(sourceTab).toHaveAttribute('aria-selected', 'true');
      // Switching back must not resurrect the old source preview.
      await expect(files.locator('pre')).toHaveCount(0);
      await expect(files.getByText('选择文件，查看内容', { exact: true })).toBeVisible();

      await search.fill('核对客户需求');
      await expect(files.getByRole('button', { name: /^(?:展开|收起)文件夹：/u })).toHaveCount(0);
      await nestedFile.click();
      await expect(files.locator('pre')).toHaveText(nestedContent);
      await resize(instance, window, 720);
      await ask.scrollIntoViewIfNeeded();
      await expect(ask).toBeInViewport();
      await expect(update).toBeInViewport();
      await expect(sourceTab).toBeVisible();
      await expect(outputTab).toBeVisible();
      await expectNoHorizontalOverflow(window, '.project-files-panel');
      await window.screenshot({ path: info.outputPath('project-files-720.png') });
      await ask.click();
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('heading', { name: '项目问问', exact: true })).toBeInViewport();
      await expect(composer).toHaveValue('起草下一步计划');
      await expect(composer).toBeInViewport();
      await expect(panel.getByRole('button', { name: '关闭问问', exact: true })).toBeInViewport();
      await expect(panel.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport();
      await expectNoHorizontalOverflow(window, '.assistant-panel');
      await window.screenshot({ path: info.outputPath('project-assistant-720.png') });
      expect(sendAttempts).toBe(0);
      await panel.getByRole('button', { name: '关闭问问', exact: true }).click();
      await resize(instance, window, 1360);

      const briefPath = join(fixture.project, 'brief.md');
      const originalBrief = await readFile(briefPath, 'utf8');
      await writeFile(briefPath, `${originalBrief}\n新增事实：下周拍摄。\n`);
      const refreshed = window.waitForResponse(response => response.request().method() === 'POST'
        && /^\/api\/v1\/projects\/[^/]+\/refresh$/u.test(new URL(response.url()).pathname));
      await update.click();
      expect((await refreshed).ok()).toBe(true);
      await expect(update).toBeEnabled();
      await expect(status.getByText('资料已连接', { exact: true })).toBeVisible();
      await search.fill('');
      await files.getByRole('button', { name: '打开文件：brief.md', exact: true }).click();
      await expect(files.locator('pre')).toContainText('新增事实：下周拍摄。');
      expect(await readFile(briefPath, 'utf8')).toContain('新增事实：下周拍摄。');
      expect(await readFile(briefPath, 'utf8')).not.toContain('AI工作区');
      expect(await readFile(join(fixture.project, nestedPath), 'utf8')).toBe(nestedContent);
      expect(await readFile(join(fixture.vault, '02知识库/全局方法.md'))).toEqual(globalKnowledgeBefore);
      expect((await readdir(fixture.project, { recursive: true })).sort()).toEqual(initialProjectEntries);
      expect(sendAttempts).toBe(0);
    } finally {
      await instance?.close();
      await rm(fixture.vault, { recursive: true, force: true });
      await rm(fixture.userData, { recursive: true, force: true });
      await rm(fixture.project, { recursive: true, force: true });
    }
  });
}
