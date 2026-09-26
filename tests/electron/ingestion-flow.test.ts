import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { parseFrontmatter } from '../../src/server/rules/frontmatter.js';
import { parseLibraryNote } from '../../src/server/rules/library-schema.js';
import { parseKnowledgeNote } from '../../src/server/rules/knowledge-schema.js';
import { ingestionBatchSchema } from '../../src/shared/api/ingestion.js';
import { extractionRunSchema } from '../../src/shared/api/extraction.js';

const sourceTitle = '隔离闭环资料'; const firstTitle = '把学习目标拆成可执行步骤';
const editedTitle = '先明确学习目标再安排实践'; const secondTitle = '用复盘反馈调整学习节奏';
const knowledgeDirectory = '02知识库/09学习/学习方法';
const fixtureResult = {
  briefing: { sentences: ['这份资料讨论如何让学习形成具体行动。', '首先把目标拆成可观察的步骤。', '随后用复盘反馈调整学习节奏。'], keyPoints: ['目标需要明确', '反馈帮助调整'], usefulness: '帮助形成可验证的学习计划。' },
  candidates: [
    { title: firstTitle, knowledgeType: '方法', suggestedPath: knowledgeDirectory, topics: [], coreContent: '先写下学习目标，再安排一次可以验证的小实践，最后记录结果。', value: '让阅读内容能转化为行动。', draft: { keywords: ['学习目标', '实践', '执行'], scenarios: ['开始学习新技能', '把阅读方法应用到工作'], conclusion: '先明确目标，再通过一次实践验证。', keyPoints: ['写下具体目标', '安排可验证的实践'], boundary: '适用于能够观察实践结果的学习任务。', quotes: ['先明确目标，再安排实践。'], summaries: ['让每次阅读接上一项具体行动。'] } },
    { title: secondTitle, knowledgeType: '方法', suggestedPath: knowledgeDirectory, topics: [], coreContent: '实践后记录遇到的困难与结果，根据反馈缩小下一轮练习范围。', value: '避免重复无效练习。', draft: { keywords: ['学习复盘', '反馈', '练习'], scenarios: ['完成一次练习之后', '学习进度停滞时'], conclusion: '通过复盘反馈调整下一轮练习。', keyPoints: ['记录实际困难', '缩小练习范围'], boundary: '需要来自实际实践的反馈，不能凭空推断结果。', quotes: [], summaries: ['下一步练什么，由上一轮反馈决定。'] } }
  ]
};

async function installProviderFixture(instance: ElectronApplication, allowModel: boolean) {
  await instance.evaluate((_electron, input) => {
    const state = globalThis as unknown as { ingestionModelCalls: number }; state.ingestionModelCalls = 0;
    globalThis.fetch = async (url) => {
      if (!input.allowModel || String(url) !== 'https://api.deepseek.com/chat/completions') throw new Error('ISOLATED_TEST_NETWORK_FORBIDDEN');
      state.ingestionModelCalls += 1;
      return new Response(JSON.stringify({ id: 'ingestion-fixture', object: 'chat.completion', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(input.result) } }], usage: { prompt_tokens: 60, completion_tokens: 60, total_tokens: 120 } }), { headers: { 'content-type': 'application/json' } });
    };
  }, { allowModel, result: fixtureResult });
}

async function openResult(window: Page) {
  await window.getByRole('link', { name: '提炼队列', exact: true }).click();
  await window.getByRole('button', { name: '展开待确认抽屉', exact: true }).click();
  await window.getByRole('button', { name: `打开 ${sourceTitle}`, exact: true }).click();
  await expect(window.getByRole('region', { name: '候选审阅与入库' })).toBeVisible();
}

async function expectNoOverflow(window: Page) {
  expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const main = await window.locator('main').boundingBox(); expect(main).not.toBeNull(); expect(main!.x).toBeGreaterThanOrEqual(0);
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: clipper archive to reviewed knowledge survives restart and finishes partial ingestion without duplicate writes`, async ({}, info) => {
    test.setTimeout(120_000);
    const base = await realpath(tmpdir());
    const vault = await mkdtemp(join(base, 'xiaozhao-vault-')); const userData = await mkdtemp(join(base, 'xiaozhao-user-data-'));
    const launchOptions = mode === 'packaged'
      ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
      : { args: [resolve('dist/electron/main.js')] };
    const env = { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vault, XIAOZHAO_TEST_USER_DATA: userData };
    let instance: ElectronApplication | undefined;
    const pageErrors: string[] = [];
    const apiFailures: { path: string; status: number; body: string }[] = [];
    let currentWindow: Page | undefined;
    function recordWindow(window: Page) {
      currentWindow = window;
      window.on('pageerror', (error) => pageErrors.push(error.message));
      window.on('response', (response) => {
        if (response.url().includes('/api/v1/ingestion/') && response.status() >= 400) {
          void response.text().then((body) => apiFailures.push({ path: new URL(response.url()).pathname, status: response.status(), body })).catch(() => undefined);
        }
      });
    }
    try {
      await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
      for (const path of ['00大脑规则', '01图书馆/小兆clipper', '01图书馆/来自个人', knowledgeDirectory, '03大讲堂']) await mkdir(join(vault, path), { recursive: true });
      for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vault, path), '# 隔离测试规则\n原始资料正文保真；提炼仅生成候选，确认预览后才能正式入库。\n');
      instance = await electron.launch({ ...launchOptions, env }); let window = await instance.firstWindow();
      recordWindow(window); await installProviderFixture(instance, true);
      await window.getByRole('link', { name: '收件箱', exact: true }).click();
      await window.getByRole('button', { name: '打开收件箱', exact: true }).click();
      await expect(window.getByText('收件箱是空的', { exact: true })).toBeVisible();

      // Simulate a plugin saving a source package. Only this isolated vault is touched.
      const clipper = join(vault, '01图书馆/小兆clipper', sourceTitle);
      await mkdir(join(clipper, '附件'), { recursive: true });
      const body = '# 学习实践原文\r\n\r\n先明确目标，再安排实践。\r\n\r\n练习结束后记录反馈，再安排下一轮。\r\n\r\n![原始附件](附件/证据.bin)\r\n';
      const attachment = Buffer.from([0, 1, 255, 13, 10, 88, 90]);
      const pluginBytes = Buffer.from(`\uFEFF---\r\ntitle: ${sourceTitle}\r\nauthor: 隔离测试作者\r\nclipped: 2026-09-07\r\ndescription: 需要保留的原始说明\r\n---\r\n${body}`);
      await writeFile(join(clipper, '原文.md'), pluginBytes); await writeFile(join(clipper, '附件/证据.bin'), attachment);
      await window.getByRole('button', { name: `整理 ${sourceTitle}` }).click({ timeout: 15_000 });
      await window.getByLabel('来源平台', { exact: true }).selectOption('个人');
      await window.getByLabel('采集日期', { exact: true }).fill('2026-09-07');
      await window.getByRole('button', { name: '预览归档结果', exact: true }).click();
      await expect(window.getByLabel('整理后的 Markdown')).toContainText('知识入库状态: 未提炼');
      expect(await readFile(join(clipper, '原文.md'))).toEqual(pluginBytes);
      const archiveResponse = window.waitForResponse((response) => response.url().endsWith('/api/v1/intake/commit'));
      await window.getByRole('button', { name: '确认归档', exact: true }).click();
      const archive = await (await archiveResponse).json(); expect(archive).toMatchObject({ data: { state: 'archived', indexed: true } });
      await expect(window.getByText('收件箱是空的', { exact: true })).toBeVisible();
      const sourceFolder = String(archive.data.target); expect(sourceFolder).toMatch(/^01图书馆\/来自个人\//u);
      const archivedMain = `${sourceFolder.split('/').at(-1)}.md`; const sourcePath = `${sourceFolder}/${archivedMain}`;
      const archivedBytes = await readFile(join(vault, sourcePath)); const archivedBody = Buffer.from(parseFrontmatter(archivedBytes).bodyBytes);
      expect(archivedBytes.subarray(-Buffer.byteLength(body))).toEqual(Buffer.from(body));
      expect(await readFile(join(vault, sourceFolder, '附件/证据.bin'))).toEqual(attachment);
      expect(await readdir(join(vault, knowledgeDirectory))).toEqual([]);

      await window.getByRole('link', { name: '设置', exact: true }).click();
      await window.getByLabel('DeepSeek API Key').fill('sk-isolated-ingestion-fixture');
      await window.getByRole('button', { name: '保存密钥', exact: true }).click();
      await expect(window.getByText('密钥已保存，连接尚未验证。')).toBeVisible();
      await window.getByRole('link', { name: '提炼队列', exact: true }).click();
      await window.getByRole('button', { name: '展开待提炼抽屉', exact: true }).click();
      await window.getByRole('button', { name: `打开 ${sourceTitle}`, exact: true }).click();
      await window.getByRole('button', { name: '开始提炼', exact: true }).click();
      await window.getByRole('button', { name: '预览发送内容', exact: true }).click();
      expect(await instance.evaluate(() => (globalThis as unknown as { ingestionModelCalls: number }).ingestionModelCalls)).toBe(0);
      const startedResponse = window.waitForResponse((response) => response.url().endsWith('/api/v1/extractions/start'));
      await window.getByRole('button', { name: '确认发送并提炼', exact: true }).click();
      const started = extractionRunSchema.parse((await (await startedResponse).json()).data); const runId = started.id;
      await expect(window.getByRole('button', { name: '编辑候选', exact: true })).toHaveCount(1, { timeout: 20_000 });
      await window.getByRole('button', { name: '编辑候选', exact: true }).click();
      await expect(window.getByRole('textbox', { name: '知识标题', exact: true })).toHaveValue(firstTitle);
      expect(await instance.evaluate(() => (globalThis as unknown as { ingestionModelCalls: number }).ingestionModelCalls)).toBe(1);
      expect(await readFile(join(vault, sourcePath))).toEqual(archivedBytes);
      const titleField = window.getByRole('textbox', { name: '知识标题', exact: true });
      await titleField.scrollIntoViewIfNeeded();
      const beforeEditScroll = await window.getByRole('region', { name: '资料工作区', exact: true }).evaluate((pane) => pane.scrollTop);
      const queueUpdated = window.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/extraction-queue');
      const savedResponse = window.waitForResponse((response) => response.url().endsWith(`/api/v1/ingestion/reviews/${runId}/candidates`) && response.request().postDataJSON()?.draft.title === editedTitle);
      await titleField.fill(editedTitle);
      expect((await savedResponse).ok()).toBe(true);
      expect((await queueUpdated).ok()).toBe(true);
      await expect(window.getByText('已保存到本机草稿')).toHaveCount(2);
      const afterEditScroll = await window.getByRole('region', { name: '资料工作区', exact: true }).evaluate((pane) => pane.scrollTop);
      expect(Math.abs(afterEditScroll - beforeEditScroll)).toBeLessThan(100);
      await expect(titleField).toBeInViewport();
      await window.screenshot({ path: info.outputPath('edited-candidate-before-restart.png') });
      const afterScreenshotScroll = await window.getByRole('region', { name: '资料工作区', exact: true }).evaluate((pane) => pane.scrollTop);
      await writeFile(info.outputPath('editing-scroll-position.json'), JSON.stringify({ beforeEditScroll, afterEditScroll, afterScreenshotScroll }, null, 2));
      expect(Math.abs(afterScreenshotScroll - afterEditScroll)).toBeLessThan(1);
      await instance.close(); instance = undefined;

      // A fresh Electron process must load the persisted edited candidate without a model call.
      instance = await electron.launch({ ...launchOptions, env }); window = await instance.firstWindow();
      recordWindow(window); await installProviderFixture(instance, false);
      await openResult(window);
      await window.getByRole('button', { name: `查看候选 1：${editedTitle}`, exact: true }).click();
      await window.getByRole('button', { name: '编辑候选', exact: true }).click();
      await expect(window.getByRole('textbox', { name: '知识标题', exact: true })).toHaveValue(editedTitle);
      await window.getByRole('radio', { name: '选入本批' }).first().check();
      await window.getByRole('button', { name: '预览本批变化', exact: true }).click();
      const preview = window.getByRole('region', { name: '本批入库预览' });
      await expect(preview).toContainText('选入 1 条 · 明确放弃 0 条 · 剩余待处理 1 条');
      await expect(preview).toContainText('原资料入库状态：部分入库');
      await expect(preview.getByRole('heading', { name: /知识入库状态/u })).toHaveCount(0);
      expect(await readdir(join(vault, knowledgeDirectory))).toEqual([]);
      expect(await readFile(join(vault, sourcePath))).toEqual(archivedBytes);
      await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 900));
      await preview.getByRole('heading', { name: '本批将发生的变化' }).scrollIntoViewIfNeeded();
      await expectNoOverflow(window); await window.screenshot({ path: info.outputPath('ingestion-preview-compact.png') });
      await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000));
      await preview.getByRole('heading', { name: '本批将发生的变化' }).scrollIntoViewIfNeeded();
      await expectNoOverflow(window); await window.screenshot({ path: info.outputPath('ingestion-preview-desktop.png') });
      const committedResponse = window.waitForResponse((response) => response.url().endsWith('/api/v1/ingestion/commit'));
      await window.getByRole('button', { name: '确认入库', exact: true }).dblclick();
      const firstCommitResponse = await committedResponse;
      const firstBatch = ingestionBatchSchema.parse((await firstCommitResponse.json()).data);
      const committedCsrf = firstCommitResponse.request().headers()['x-csrf-token']; expect(committedCsrf).toBeTruthy();
      expect(firstBatch).toMatchObject({ status: 'committed', indexed: true, sourceStatus: '部分入库', pendingCount: 1 });
      const knowledgePath = `${knowledgeDirectory}/${editedTitle}.md`; expect(firstBatch.knowledgePaths).toEqual([knowledgePath]);
      await expect(window.getByRole('link', { name: `打开知识：${editedTitle}` })).toBeVisible({ timeout: 20_000 });
      const knowledgeBytes = await readFile(join(vault, knowledgePath)); const knowledgeRecord = parseKnowledgeNote(knowledgeBytes, knowledgePath);
      expect(knowledgeRecord.issues).toEqual([]); expect(knowledgeRecord.record).toMatchObject({ title: editedTitle, usageStatus: 'AI总结', sourceMaterials: [sourcePath.replace(/\.md$/u, '')] });
      expect(knowledgeBytes.toString('utf8')).toContain('## 可复用表达'); expect(knowledgeBytes.toString('utf8')).toContain('先写下学习目标');
      const firstSourceBytes = await readFile(join(vault, sourcePath)); const firstSource = parseLibraryNote(firstSourceBytes, sourcePath);
      expect(firstSource.record).toMatchObject({ knowledgeStatus: '部分入库', generatedKnowledge: [knowledgePath.replace(/\.md$/u, '')] });
      expect(Buffer.from(firstSource.bodyBytes)).toEqual(archivedBody); expect(await readFile(join(vault, sourceFolder, '附件/证据.bin'))).toEqual(attachment);
      expect(await readdir(join(vault, knowledgeDirectory))).toEqual([`${editedTitle}.md`]);

      // Repeating the already confirmed id must not touch either file again.
      const fileIdentity = await Promise.all([stat(join(vault, sourcePath), { bigint: true }), stat(join(vault, knowledgePath), { bigint: true })]);
      const repeated = await window.evaluate(async ({ id, csrf }) => {
        return (await (await fetch('/api/v1/ingestion/commit', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ id }) })).json()).data;
      }, { id: firstBatch.id, csrf: committedCsrf! });
      expect(repeated).toMatchObject({ id: firstBatch.id, status: 'committed' });
      const repeatedIdentity = await Promise.all([stat(join(vault, sourcePath), { bigint: true }), stat(join(vault, knowledgePath), { bigint: true })]);
      expect(repeatedIdentity.map(({ ino, mtimeNs }) => [ino, mtimeNs])).toEqual(fileIdentity.map(({ ino, mtimeNs }) => [ino, mtimeNs]));

      await window.getByRole('link', { name: `打开知识：${editedTitle}` }).click();
      const knowledgeReader = window.getByRole('region', { name: `${editedTitle} 阅读`, exact: true });
      await expect(knowledgeReader).toBeVisible();
      await expect(window.getByRole('region', { name: '知识正文' })).toContainText('先写下学习目标');
      await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 900));
      await knowledgeReader.getByRole('heading', { name: editedTitle, exact: true }).scrollIntoViewIfNeeded();
      await expectNoOverflow(window); await window.screenshot({ path: info.outputPath('knowledge-detail-compact.png') });
      await knowledgeReader.getByText('来源与关联知识', { exact: true }).click();
      await window.getByRole('link', { name: /^查看原文 ·/u }).click();
      await expect(window.getByLabel('原始文件内容')).toContainText('学习实践原文');
      await expect(window.getByLabel('原始 Markdown 与 YAML')).toContainText('部分入库');
      await expectNoOverflow(window); await window.screenshot({ path: info.outputPath('original-source-compact.png') });
      await window.getByRole('link', { name: '返回这份资料的提炼工作台' }).click();
      await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000));
      await window.getByRole('button', { name: `查看候选 2：${secondTitle}`, exact: true }).click();
      await window.getByRole('button', { name: '编辑候选', exact: true }).click();
      await expect(window.getByRole('textbox', { name: '知识标题', exact: true })).toHaveValue(secondTitle);
      await expect(window.getByText(/原资料已变化，请重新核对依据/u)).toHaveCount(0);
      await window.getByRole('radio', { name: '明确放弃', exact: true }).check();
      await window.getByRole('button', { name: '预览本批变化', exact: true }).click();
      await expect(window.getByRole('region', { name: '本批入库预览' })).toContainText('原资料入库状态：已入库');
      const finalResponse = window.waitForResponse((response) => response.url().endsWith('/api/v1/ingestion/commit'));
      await window.getByRole('button', { name: '确认本批取舍', exact: true }).click();
      const finalBatch = ingestionBatchSchema.parse((await (await finalResponse).json()).data);
      expect(finalBatch).toMatchObject({ status: 'committed', indexed: true, sourceStatus: '已入库', pendingCount: 0, knowledgePaths: [] });
      await expect(window.getByText('本轮候选均已完成取舍。')).toBeVisible();
      await expect(window.getByRole('textbox', { name: '知识标题' })).toHaveCount(0);
      const finalSourceBytes = await readFile(join(vault, sourcePath)); const finalSource = parseLibraryNote(finalSourceBytes, sourcePath);
      expect(finalSource.record).toMatchObject({ knowledgeStatus: '已入库', generatedKnowledge: [knowledgePath.replace(/\.md$/u, '')] });
      expect(Buffer.from(finalSource.bodyBytes)).toEqual(archivedBody); expect(await readFile(join(vault, sourceFolder, '附件/证据.bin'))).toEqual(attachment);
      expect(await readFile(join(vault, knowledgePath))).toEqual(knowledgeBytes); expect(await readdir(join(vault, knowledgeDirectory))).toEqual([`${editedTitle}.md`]);
      await window.getByRole('region', { name: '入库结果', exact: true }).scrollIntoViewIfNeeded();
      await window.screenshot({ path: info.outputPath('ingestion-complete.png') });

      await window.getByRole('link', { name: '提炼队列', exact: true }).click();
      await window.getByRole('button', { name: '已处理结果', exact: true }).click();
      await expect(window.getByRole('region', { name: '已处理结果列表', exact: true }).getByRole('button', { name: `打开 ${sourceTitle}`, exact: true })).toContainText('已完成取舍');
      await window.getByRole('link', { name: '大脑总览', exact: true }).click();
      await expect(window.getByTestId('metric-materials')).toContainText('0');
      await expect(window.getByTestId('metric-knowledge')).toContainText('1');
      await expect(window.getByRole('region', { name: '待提炼材料牌堆' }).getByRole('button', { name: new RegExp(sourceTitle, 'u') })).toHaveCount(0);
      await expect(window.getByText('暂无待提炼材料')).toBeVisible();
      await window.getByRole('link', { name: '知识库', exact: true }).click();
      await window.getByLabel('搜索知识', { exact: true }).fill('学习目标');
      await window.getByRole('button', { name: '搜索', exact: true }).click();
      await expect(window.getByRole('button', { name: `展开 ${editedTitle} 知识纸页`, exact: true })).toBeVisible();
      expect(await instance.evaluate(() => (globalThis as unknown as { ingestionModelCalls: number }).ingestionModelCalls)).toBe(0);
      expect(pageErrors).toEqual([]);
      await expectNoOverflow(window);

      // Completed ingestion must survive a new process without regenerating knowledge.
      await instance.close(); instance = undefined;
      instance = await electron.launch({ ...launchOptions, env }); window = await instance.firstWindow();
      recordWindow(window); await installProviderFixture(instance, false);
      await expect(window.getByTestId('metric-materials')).toContainText('0');
      await expect(window.getByTestId('metric-knowledge')).toContainText('1');
      await window.getByRole('link', { name: '知识库', exact: true }).click();
      await window.getByLabel('搜索知识', { exact: true }).fill('学习目标');
      await window.getByRole('button', { name: '搜索', exact: true }).click();
      const persistedKnowledge = window.getByRole('button', { name: `展开 ${editedTitle} 知识纸页`, exact: true });
      await expect(persistedKnowledge).toBeVisible();
      await persistedKnowledge.click();
      await expect(window.getByRole('region', { name: `${editedTitle} 阅读`, exact: true })).toBeVisible();
      await expect(window.getByRole('region', { name: '知识正文', exact: true })).toContainText('先写下学习目标');
      expect(new URL(window.url()).searchParams.get('path')).toBe(knowledgePath);

      const persistedBatches = await window.evaluate(async (ids) => Promise.all(ids.map(async (id) => {
        const response = await fetch(`/api/v1/ingestion/batches/${id}`);
        return { status: response.status, body: await response.json() };
      })), [firstBatch.id, finalBatch.id]);
      for (const [index, expectedBatch] of [firstBatch, finalBatch].entries()) {
        const persisted = persistedBatches[index]!;
        expect(persisted.status).toBe(200);
        expect(ingestionBatchSchema.parse(persisted.body.data)).toEqual(expectedBatch);
      }
      expect(await readFile(join(vault, knowledgePath))).toEqual(knowledgeBytes);
      expect(await readFile(join(vault, sourcePath))).toEqual(finalSourceBytes);
      expect(await readFile(join(vault, sourceFolder, '附件/证据.bin'))).toEqual(attachment);
      expect(await readdir(join(vault, knowledgeDirectory))).toEqual([`${editedTitle}.md`]);
      expect(await instance.evaluate(() => (globalThis as unknown as { ingestionModelCalls: number }).ingestionModelCalls)).toBe(0);
      expect(pageErrors).toEqual([]);
      await expectNoOverflow(window);
      await window.screenshot({ path: info.outputPath('ingestion-persisted-after-final-restart.png') });
    } catch (error) {
      if (currentWindow && !currentWindow.isClosed()) {
        await info.attach('ingestion-ui-failure', { body: await currentWindow.locator('body').innerText(), contentType: 'text/plain' });
        await currentWindow.screenshot({ path: info.outputPath('failure.png') });
      }
      await info.attach('ingestion-api-failures', { body: JSON.stringify(apiFailures, null, 2), contentType: 'application/json' });
      console.error('Isolated ingestion API failures:', JSON.stringify(apiFailures));
      throw error;
    } finally {
      // The fixture owns every window. Destroying them avoids an unsaved-edit
      // beforeunload dialog masking the original assertion during failure cleanup.
      await instance?.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => undefined);
      await instance?.close().catch(() => undefined);
      await rm(vault, { recursive: true, force: true }); await rm(userData, { recursive: true, force: true });
    }
  });
}
