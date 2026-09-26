import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { trashEntrySchema } from '../../src/shared/api/trash.js';

const title = '可恢复的原始资料';
const sourceFolder = '01图书馆/来自个人/回收测试资料包';
const sourcePath = `${sourceFolder}/${title}.md`;
const knowledgePath = '02知识库/09学习/保留的已有知识.md';

async function resize(instance: ElectronApplication, window: Page, width: number) {
  // The production app keeps a 720px minimum; the isolated window alone also
  // exercises the responsive layout at 390px without changing production code.
  await instance.evaluate(({ BrowserWindow }, size) => { const active = BrowserWindow.getAllWindows()[0]!; active.setMinimumSize(390, 600); active.setSize(size, size === 390 ? 844 : 1000); }, width);
  await expect.poll(() => window.evaluate(() => innerWidth)).toBe(width);
  expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function forbidModel(instance: ElectronApplication) {
  await instance.evaluate(() => { globalThis.fetch = async () => { throw new Error('ISOLATED_MATERIAL_MANAGEMENT_NO_NETWORK'); }; });
}

async function openUnextracted(window: Page, expectedCount = 1) {
  await window.getByRole('link', { name: '档案库', exact: true }).click();
  const cabinet = window.getByRole('region', { name: '档案柜', exact: true });
  await expect(cabinet).toBeVisible();
  // Returning from the recycle bin restores this catalog's remembered state.
  if (await cabinet.getAttribute('data-state') === 'closed') {
    await window.getByRole('button', { name: '打开档案柜', exact: true }).click();
  }
  await expect(cabinet).toHaveAttribute('data-state', 'open');
  await window.getByLabel('入库状态', { exact: true }).selectOption('未提炼');
  await window.getByLabel('资料标题', { exact: true }).fill(title);
  await window.getByRole('button', { name: '搜索档案', exact: true }).click();
  await expect(window.getByRole('region', { name: '档案柜', exact: true })).toHaveAttribute('data-state', 'open');
  await expect(window.getByText(`共 ${expectedCount} 份资料`, { exact: true })).toBeVisible();
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: original material recycle and restore preserve knowledge and attachments; queue removal remains reversible`, async ({}, info) => {
    test.setTimeout(120_000);
    const temporary = await realpath(tmpdir());
    const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
    const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
    const launchOptions = mode === 'packaged'
      ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
      : { args: [resolve('dist/electron/main.js')] };
    const env = { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vault, XIAOZHAO_TEST_USER_DATA: userData };
    let instance: ElectronApplication | undefined; let window: Page | undefined;
    const pageErrors: string[] = []; const apiFailures: { path: string; status: number; body: string }[] = [];
    function watch(page: Page) {
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('response', (response) => { if (response.status() >= 400 && /\/api\/v1\/(trash|extraction-queue)/u.test(response.url())) void response.text().then((body) => apiFailures.push({ path: new URL(response.url()).pathname, status: response.status(), body })).catch(() => undefined); });
    }
    try {
      await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
      for (const directory of ['00大脑规则', '01图书馆/小兆clipper', sourceFolder, `${sourceFolder}/附件`, '02知识库/09学习', '03大讲堂']) await mkdir(join(vault, directory), { recursive: true });
      for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vault, path), '# 隔离测试规则\n只手动回收选中的 Markdown，恢复不覆盖现有文件；附件和知识保留。\n');
      const source = Buffer.from('\uFEFF' + (await readFile(resolve('tests/fixtures/library-valid.md'), 'utf8'))
        .replace('一份可提炼的资料', title).replace('处理状态: 未归档', '处理状态: 已归档').replace('来源平台: B站', '来源平台: 个人')
        .replace('生成知识: ["[[已有知识]]"]', '生成知识: []').replace(/\n/gu, '\r\n') + '\r\n![证据](附件/证据.bin)\r\n', 'utf8');
      const knowledge = Buffer.from((await readFile(resolve('tests/fixtures/knowledge-valid.md'), 'utf8')).replace('[[一份可提炼的资料]]', `[[${sourcePath.replace(/\.md$/u, '')}]]`));
      const attachment = Buffer.from([0, 255, 1, 13, 10, 128, 42]);
      await writeFile(join(vault, sourcePath), source); await writeFile(join(vault, knowledgePath), knowledge); await writeFile(join(vault, sourceFolder, '附件/证据.bin'), attachment);
      const originalIdentity = await stat(join(vault, sourcePath), { bigint: true });
      instance = await electron.launch({ ...launchOptions, env }); window = await instance.firstWindow(); watch(window); await forbidModel(instance);
      await expect(window.getByTestId('metric-materials')).toContainText('1');
      await expect(window.getByTestId('metric-knowledge')).toContainText('1');
      await openUnextracted(window);
      const trashAction = window.getByRole('button', { name: `移入回收站：${title}`, exact: true });
      await expect(trashAction).toBeVisible();
      expect(await trashAction.evaluate((element) => element.parentElement?.closest('button') === null)).toBe(true);
      await trashAction.click();
      let preview = window.getByRole('dialog', { name: '移入回收站', exact: true });
      await expect(preview).toContainText('只移动这份 Markdown');
      await expect(preview).toContainText('附件、目录、知识和提炼历史保持不变');
      await expect(preview.getByRole('link', { name: '保留的已有知识', exact: true })).toBeVisible();
      await preview.getByRole('button', { name: '取消', exact: true }).click();
      expect(await readFile(join(vault, sourcePath))).toEqual(source);
      expect((await stat(join(vault, sourcePath), { bigint: true })).ino).toBe(originalIdentity.ino);
      await trashAction.click(); preview = window.getByRole('dialog', { name: '移入回收站', exact: true });
      await expect(preview.getByRole('button', { name: '确认移入回收站', exact: true })).toBeEnabled();
      for (const width of [1440, 390]) { await resize(instance, window, width); await window.screenshot({ path: info.outputPath(`trash-preview-${width}.png`) }); }
      const moveResponse = window.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/trash/commit');
      await preview.getByRole('button', { name: '确认移入回收站', exact: true }).dblclick();
      const response = await moveResponse; expect(response.ok()).toBe(true); const moved = trashEntrySchema.parse((await response.json()).data);
      expect(moved).toMatchObject({ materialPath: sourcePath, status: 'trashed', indexed: true });
      await expect(window.getByRole('heading', { name: '已移入回收站', exact: true })).toBeVisible();
      await expect(stat(join(vault, sourcePath))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(vault, knowledgePath))).toEqual(knowledge); expect(await readFile(join(vault, sourceFolder, '附件/证据.bin'))).toEqual(attachment);
      await window.getByRole('link', { name: '查看回收站', exact: true }).click();
      await window.getByRole('button', { name: `选择：${title}`, exact: true }).click();
      await expect(window.getByRole('button', { name: `恢复：${title}`, exact: true })).toBeVisible();
      await window.screenshot({ path: info.outputPath('trash-list-390.png') });
      await openUnextracted(window, 0); await expect(window.getByRole('button', { name: `查看 ${title} 原文`, exact: true })).toHaveCount(0);
      await window.getByRole('link', { name: '提炼队列', exact: true }).click();
      await window.getByRole('button', { name: '展开待提炼抽屉', exact: true }).click();
      await expect(window.getByRole('button', { name: `打开 ${title}`, exact: true })).toHaveCount(0);
      await window.getByRole('link', { name: '大脑总览', exact: true }).click();
      await expect(window.getByTestId('metric-materials')).toContainText('0'); await expect(window.getByTestId('metric-knowledge')).toContainText('1');
      await instance.close(); instance = undefined;

      instance = await electron.launch({ ...launchOptions, env }); window = await instance.firstWindow(); watch(window); await forbidModel(instance);
      await window.getByRole('link', { name: '回收站', exact: true }).click();
      await window.getByRole('button', { name: `选择：${title}`, exact: true }).click();
      await expect(window.getByRole('button', { name: `恢复：${title}`, exact: true })).toBeVisible();
      const restoreResponse = window.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/trash/${moved.id}/restore`);
      await window.getByRole('button', { name: `恢复：${title}`, exact: true }).click();
      const restoredResponse = await restoreResponse; expect(restoredResponse.ok()).toBe(true);
      expect(trashEntrySchema.parse((await restoredResponse.json()).data)).toMatchObject({ id: moved.id, status: 'restored', indexed: true });
      await expect(window.getByRole('heading', { name: '已恢复到原路径', exact: true })).toBeVisible();
      expect(await readFile(join(vault, sourcePath))).toEqual(source);
      const restoredIdentity = await stat(join(vault, sourcePath), { bigint: true }); expect([restoredIdentity.dev, restoredIdentity.ino]).toEqual([originalIdentity.dev, originalIdentity.ino]);
      expect(await readFile(join(vault, knowledgePath))).toEqual(knowledge); expect(await readFile(join(vault, sourceFolder, '附件/证据.bin'))).toEqual(attachment);
      await window.getByRole('button', { name: '关闭回收操作', exact: true }).click();
      await expect(window.getByText('回收站为空', { exact: true })).toBeVisible();
      const history = window.locator('details').filter({ has: window.getByText('操作记录 · 1', { exact: true }) });
      await history.getByText('操作记录 · 1', { exact: true }).click();
      await expect(history.getByRole('listitem')).toContainText(title);
      await expect(history.getByRole('listitem')).toContainText(sourcePath);
      await expect(history.getByRole('listitem')).toContainText('已恢复');
      for (const width of [1440, 390]) { await resize(instance, window, width); await window.screenshot({ path: info.outputPath(`trash-restored-${width}.png`) }); }
      await resize(instance, window, 1440);

      // Queue removal changes only visibility, not the restored file or knowledge.
      await window.getByRole('link', { name: '提炼队列', exact: true }).click();
      await window.getByRole('button', { name: '展开待提炼抽屉', exact: true }).click();
      await window.getByRole('button', { name: `打开 ${title}`, exact: true }).click();
      await window.getByRole('button', { name: '移出队列', exact: true }).click();
      await expect(window.getByText('已移出队列，原文和全部提炼记录已保留。', { exact: true })).toBeVisible();
      await window.getByRole('button', { name: '撤销移出', exact: true }).click();
      await expect(window.getByText('已重新加入队列。', { exact: true })).toBeVisible();
      await window.getByRole('button', { name: `打开 ${title}`, exact: true }).click();
      await window.getByRole('button', { name: '移出队列', exact: true }).click();
      await expect(window.getByText('已移出队列，原文和全部提炼记录已保留。', { exact: true })).toBeVisible();
      await window.getByRole('button', { name: '已移出', exact: true }).click();
      await window.getByRole('button', { name: `打开 ${title}`, exact: true }).click();
      await expect(window.getByRole('button', { name: '重新加入', exact: true })).toBeVisible();
      for (const width of [1440, 390]) { await resize(instance, window, width); await window.screenshot({ path: info.outputPath(`queue-removed-${width}.png`) }); }
      expect(await readFile(join(vault, sourcePath))).toEqual(source);
      await window.getByRole('button', { name: '重新加入', exact: true }).click();
      await expect(window.getByText('已重新加入队列。', { exact: true })).toBeVisible();
      await window.getByRole('button', { name: '队列中', exact: true }).click();
      await expect(window.getByRole('button', { name: `打开 ${title}`, exact: true })).toBeVisible();
      await window.getByRole('link', { name: '大脑总览', exact: true }).click(); await expect(window.getByTestId('metric-materials')).toContainText('1');
      expect(await readFile(join(vault, sourcePath))).toEqual(source); expect(await readFile(join(vault, knowledgePath))).toEqual(knowledge); expect(await readFile(join(vault, sourceFolder, '附件/证据.bin'))).toEqual(attachment);
      expect(pageErrors).toEqual([]); expect(apiFailures).toEqual([]);
    } catch (error) {
      if (window && !window.isClosed()) { await info.attach('material-management-ui', { body: await window.locator('body').innerText(), contentType: 'text/plain' }); await window.screenshot({ path: info.outputPath('failure.png') }); }
      await info.attach('material-management-api', { body: JSON.stringify(apiFailures, null, 2), contentType: 'application/json' });
      throw error;
    } finally {
      await instance?.evaluate(({ BrowserWindow }) => { for (const active of BrowserWindow.getAllWindows()) active.destroy(); }).catch(() => undefined);
      await instance?.close().catch(() => undefined);
      await rm(vault, { recursive: true, force: true }); await rm(userData, { recursive: true, force: true });
    }
  });
}
