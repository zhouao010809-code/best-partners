import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

const sourcePath = '客户资料/项目需求说明.md';
const sourceContent = '# 项目需求说明\n合成资料：先核对项目需求，再安排下周的内容计划。\n';
const refreshedContent = `${sourceContent}\n人工更新：项目需求已确认，周五拍摄。\n`;
const drafts = [
  { category: '内容草稿', title: '项目需求内容草稿', summary: '第一份隔离测试产出', content: '# 项目需求内容草稿\n第一份已经确认的合成产出。\n' },
  { category: '周计划', title: '项目需求周计划', summary: '第二份隔离测试产出', content: '# 项目需求周计划\n第二份已经确认的合成产出。\n' }
] as const;

async function makeFixture() {
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  const project = await mkdtemp(join(temporary, 'xiaozhao-client-project-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
  for (const directory of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂', '.claude/skills']) await mkdir(join(vault, directory), { recursive: true });
  for (const path of RULE_BUNDLE_SOURCE_PATHS) {
    await mkdir(join(vault, dirname(path)), { recursive: true });
    await writeFile(join(vault, path), '# 隔离测试规则\n写入前必须确认。\n');
  }
  await writeFile(join(vault, '02知识库/全局方法.md'), '# 全局方法\n这份合成全局知识不应被项目保存改写。\n');
  await mkdir(join(project, '客户资料'));
  await writeFile(join(project, sourcePath), sourceContent);
  await writeFile(join(project, 'brief.md'), '# 项目背景\n仅供隔离测试使用。\n');
  return { vault, userData, project };
}

async function installProviderFixture(instance: ElectronApplication): Promise<void> {
  await instance.evaluate((_electron, fixtureDrafts) => {
    const state = globalThis as unknown as { projectLiveCompletionCalls: number; projectLiveToolSchema: unknown; projectLiveToolResults: unknown };
    state.projectLiveCompletionCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://api.deepseek.com/models') return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] }), { headers: { 'content-type': 'application/json' } });
      if (url !== 'https://api.deepseek.com/chat/completions') throw new Error('PROJECT_LIVE_UPDATES_NETWORK_FORBIDDEN');
      state.projectLiveCompletionCalls += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        tools?: Array<{ function?: { name?: string; parameters?: { required?: string[]; properties?: Record<string, { enum?: string[] }> } } }>;
        messages?: Array<{ role?: string; content?: string; tool_call_id?: string }>;
      };
      const chunk = (delta: Record<string, unknown>, finishReason: string | null) => `data: ${JSON.stringify({ id: 'project-live-answer', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      if (state.projectLiveCompletionCalls === 1) {
        const schema = body.tools?.find(tool => tool.function?.name === 'save_project_draft')?.function?.parameters;
        state.projectLiveToolSchema = schema ?? body.tools;
        if (!schema || !['category', 'title', 'summary', 'content'].every(key => schema.required?.includes(key))
          || !fixtureDrafts.every(draft => schema.properties?.category?.enum?.includes(draft.category))) throw new Error('PROJECT_LIVE_UPDATES_SAVE_TOOL_SCHEMA_MISSING');
        return new Response(
          chunk({ role: 'assistant', tool_calls: fixtureDrafts.map((draft, index) => ({ index, id: `project-save-${index + 1}`, type: 'function', function: { name: 'save_project_draft', arguments: JSON.stringify(draft) } })) }, null)
          + chunk({}, 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }
        );
      }
      if (state.projectLiveCompletionCalls !== 2) throw new Error('PROJECT_LIVE_UPDATES_UNEXPECTED_MODEL_CALL');
      state.projectLiveToolResults = body.messages?.filter(item => item.role === 'tool');
      for (let index = 0; index < fixtureDrafts.length; index += 1) {
        const message = body.messages?.find(item => item.role === 'tool' && item.tool_call_id === `project-save-${index + 1}`);
        const result = JSON.parse(message?.content ?? '{}') as { status?: string };
        if (result.status !== 'awaiting_confirmation') throw new Error('PROJECT_LIVE_UPDATES_PENDING_PLAN_MISSING');
      }
      return new Response(chunk({ role: 'assistant', content: '两份项目产出已准备好，请分别确认保存。' }, null)
        + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
  }, drafts);
}

async function resize(instance: ElectronApplication, window: Page, width: number): Promise<void> {
  await instance.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size, size === 720 ? 800 : 900), width);
  await expect.poll(() => window.evaluate(() => innerWidth)).toBe(width);
}

async function expectNoHorizontalOverflow(window: Page): Promise<void> {
  await expect.poll(() => window.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const selector of ['.project-files-panel', '.project-saved-files']) {
    await expect.poll(() => window.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: project saves refresh files and the current preview while preserving browsing state and sibling plans`, async ({}, info) => {
    test.setTimeout(120_000);
    const fixture = await makeFixture();
    let instance: ElectronApplication | undefined;
    try {
      const protectedBefore = new Map<string, Buffer>();
      for (const path of [join(fixture.vault, '02知识库/全局方法.md'), join(fixture.project, 'brief.md')]) protectedBefore.set(path, await readFile(path));
      instance = await electron.launch({
        ...(mode === 'packaged'
          ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
          : { args: [resolve('dist/electron/main.js')] }),
        env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: fixture.vault, XIAOZHAO_TEST_USER_DATA: fixture.userData, XIAOZHAO_TEST_PROJECT_ROOT: fixture.project }
      });
      await installProviderFixture(instance);
      const window = await instance.firstWindow();
      await resize(instance, window, 1360);
      let refreshRequests = 0;
      let previewRequests = 0;
      const outputResponses: string[] = [];
      window.on('request', request => {
        const url = new URL(request.url());
        if (request.method() === 'POST' && /^\/api\/v1\/projects\/[^/]+\/refresh$/u.test(url.pathname)) refreshRequests += 1;
        if (request.method() === 'GET' && /^\/api\/v1\/projects\/[^/]+\/file$/u.test(url.pathname) && url.searchParams.get('path') === sourcePath) previewRequests += 1;
      });
      window.on('response', response => {
        const url = new URL(response.url());
        if (response.ok() && /^\/api\/v1\/projects\/[^/]+\/files$/u.test(url.pathname) && url.searchParams.get('origin') === 'output') {
          void response.text().then(body => outputResponses.push(body)).catch(() => undefined);
        }
      });

      await window.getByRole('link', { name: '设置', exact: true }).click();
      await window.getByLabel('DeepSeek API Key').fill('sk-isolated-project-live-updates');
      await window.getByRole('button', { name: '保存密钥', exact: true }).click();
      await expect(window.getByText('密钥已保存，连接尚未验证。')).toBeVisible();
      await window.getByRole('link', { name: '我的项目', exact: true }).click();
      await window.getByRole('button', { name: '添加项目', exact: true }).click();
      await expect(window.getByRole('heading', { name: '确认项目文件夹', exact: true })).toBeVisible();
      await window.getByRole('textbox', { name: '项目显示名（可选）' }).fill('资料同步测试项目');
      await window.getByRole('button', { name: '确认添加项目', exact: true }).click();
      await expect(window).toHaveURL(/\/projects\/[0-9a-f-]+$/u);
      await window.getByRole('tab', { name: '项目资料', exact: true }).click();
      const files = window.getByRole('region', { name: '项目资料与产出', exact: true });
      const sourceTab = files.getByRole('tab', { name: '项目资料', exact: true });
      const sourceFile = files.getByRole('button', { name: `打开文件：${sourcePath}`, exact: true });
      await files.getByRole('button', { name: '展开文件夹：客户资料', exact: true }).click();
      await sourceFile.click();
      await expect(files.locator('pre')).toHaveText(sourceContent);
      const search = files.getByRole('textbox', { name: '搜索项目文件', exact: true });
      await search.fill('项目需求');
      await sourceFile.click();
      await expect(files.locator('pre')).toHaveText(sourceContent);

      // This explicit fixture edit simulates an external editor. The product
      // currently proposes source edits; saving a draft never rewrites sources.
      await writeFile(join(fixture.project, sourcePath), refreshedContent);
      const update = window.getByRole('region', { name: '项目资料状态', exact: true }).getByRole('button', { name: '更新资料', exact: true });
      await update.click();
      await expect(files.locator('pre')).toHaveText(refreshedContent);
      await expect(search).toHaveValue('项目需求');
      await expect(sourceFile).toHaveAttribute('aria-pressed', 'true');
      await expect(update).toBeEnabled();
      const refreshesBeforeSaving = refreshRequests;
      const sourceBytesBeforeSaving = await readFile(join(fixture.project, sourcePath));

      await window.getByRole('button', { name: '讨论项目', exact: true }).click();
      const panel = window.getByRole('complementary', { name: '问问 AI' });
      await expect(panel.getByRole('heading', { name: '项目问问', exact: true })).toBeVisible();
      await expect(panel.getByText('已连接', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      await panel.getByRole('textbox', { name: '发送给问问的消息', exact: true }).fill('请把内容草稿和周计划保存到项目，生成两份文件。');
      await panel.getByRole('button', { name: '发送消息', exact: true }).click();
      const answer = panel.getByText('两份项目产出已准备好，请分别确认保存。', { exact: true });
      await expect(answer.or(panel.getByRole('alert'))).toBeVisible({ timeout: 45_000 });
      await expect(answer).toBeVisible();
      const plans = panel.getByRole('article', { name: '项目输出写入计划', exact: true });
      await expect(plans).toHaveCount(2);
      await expect(panel.getByText('尚未写入项目', { exact: true })).toHaveCount(2);
      expect((await readdir(fixture.project)).includes('AI工作区')).toBe(false);
      const recent = window.getByRole('region', { name: '最近保存的项目文件', exact: true });
      await expect(recent).toHaveCount(0);
      const savedPaths: string[] = [];

      for (let index = 0; index < drafts.length; index += 1) {
        const draft = drafts[index]!;
        const plan = plans.filter({ hasText: draft.summary });
        const targetPath = (await plan.locator('.assistant-project-write__meta code').innerText()).trim();
        savedPaths.push(targetPath);
        expect(targetPath).toMatch(new RegExp(`^AI工作区/${draft.category}/[^/]+\\.md$`, 'u'));
        const readsBeforeSaving = previewRequests;
        await plan.getByRole('button', { name: '确认写入', exact: true }).click();
        const dialog = panel.getByRole('dialog', { name: '确认写入项目', exact: true });
        await expect(dialog.locator('code')).toHaveText(targetPath);
        await dialog.getByRole('button', { name: '最终确认', exact: true }).click();
        await expect(plan.getByText('已保存', { exact: true })).toBeVisible();
        await expect(dialog).toBeHidden();
        await expect(recent.getByRole('listitem')).toHaveCount(index + 1);
        await expect(recent.getByRole('listitem').filter({ hasText: targetPath })).toContainText('已保存');
        await expect.poll(() => outputResponses.some(body => body.includes(targetPath))).toBe(true);
        await expect.poll(() => previewRequests).toBeGreaterThan(readsBeforeSaving);
        await expect(files.locator('pre')).toHaveText(refreshedContent);
        await expect(search).toHaveValue('项目需求');
        await expect(sourceTab).toHaveAttribute('aria-selected', 'true');
        await expect(sourceFile).toHaveAttribute('aria-pressed', 'true');
        expect(await readFile(join(fixture.project, targetPath), 'utf8')).toBe(draft.content);
        expect(refreshRequests).toBe(refreshesBeforeSaving);
        if (index === 0) await expect(plans.filter({ hasText: drafts[1].summary }).getByRole('button', { name: '确认写入', exact: true })).toBeEnabled();
      }
      await expect(panel.getByText('计划已失效', { exact: true })).toHaveCount(0);
      expect(await instance.evaluate(() => (globalThis as unknown as { projectLiveCompletionCalls: number }).projectLiveCompletionCalls)).toBe(2);
      await panel.getByRole('button', { name: '关闭问问', exact: true }).click();
      await recent.scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(window);
      await window.screenshot({ path: info.outputPath('project-live-updates-1360.png') });
      await resize(instance, window, 720);
      await recent.scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(window);
      await expect(files.locator('pre')).toHaveText(refreshedContent);
      await window.screenshot({ path: info.outputPath('project-live-updates-720.png') });
      await resize(instance, window, 1360);

      // The output collection was already refreshed while the source preview
      // stayed open. Switching tabs only displays that saved collection.
      await files.getByRole('tab', { name: '已保存产出', exact: true }).click();
      for (const path of savedPaths) {
        const output = files.getByRole('button', { name: `打开文件：${path}`, exact: true });
        await expect(output).toBeVisible();
        await expect(output.getByText('已保存', { exact: true })).toBeVisible();
        await expect(output).toHaveAttribute('aria-description', '最近已保存');
      }
      await sourceTab.click();
      await search.fill('');
      await expect(files.getByRole('button', { name: '收起文件夹：客户资料', exact: true })).toHaveAttribute('aria-expanded', 'true');
      await expect(sourceFile).toBeVisible();
      expect(await readFile(join(fixture.project, sourcePath))).toEqual(sourceBytesBeforeSaving);
      for (const [path, bytes] of protectedBefore) expect(await readFile(path)).toEqual(bytes);
    } catch (error) {
      if (instance) {
        const diagnostics = await instance.evaluate(() => {
          const state = globalThis as unknown as { projectLiveCompletionCalls: number; projectLiveToolSchema: unknown; projectLiveToolResults: unknown };
          return { calls: state.projectLiveCompletionCalls, toolSchema: state.projectLiveToolSchema, toolResults: state.projectLiveToolResults };
        });
        await info.attach('provider-fixture.json', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' });
      }
      throw error;
    } finally {
      try { await instance?.close(); }
      finally {
        await rm(fixture.vault, { recursive: true, force: true });
        await rm(fixture.userData, { recursive: true, force: true });
        await rm(fixture.project, { recursive: true, force: true });
      }
    }
  });
}
