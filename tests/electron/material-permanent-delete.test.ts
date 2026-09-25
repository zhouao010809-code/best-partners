import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { trashDeletePreviewSchema, trashEntrySchema } from '../../src/shared/api/trash.js';

const title = '确认后彻底删除的原始资料';
const sourceFolder = '01图书馆/来自个人/单条删除测试包';
const sourcePath = `${sourceFolder}/${title}.md`;
const knowledgePath = '02知识库/09学习/永久保留的已有知识.md';
const marker = '{"purpose":"read-test"}\n';

async function resize(instance: ElectronApplication, page: Page, width: number) {
  await instance.evaluate(({ BrowserWindow }, size) => {
    const active = BrowserWindow.getAllWindows()[0]!; active.setMinimumSize(390, 600); active.setSize(size, size === 390 ? 844 : 1000);
  }, width);
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
    && [...document.querySelectorAll<HTMLElement>('.material-trash-dialog,.recycle-workspace')].every((element) => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: permanent deletion requires confirmation and remains nonrecoverable after restart`, async ({}, info) => {
    test.setTimeout(120_000);
    const temporary = await realpath(tmpdir());
    const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
    const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
    const launchOptions = mode === 'packaged'
      ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
      : { args: [resolve('dist/electron/main.js')] };
    const env = { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vault, XIAOZHAO_TEST_USER_DATA: userData };
    let instance: ElectronApplication | undefined; let page: Page | undefined;
    const pageErrors: string[] = []; const apiFailures: { path: string; status: number; body: string }[] = [];
    const deletes: { path: string; body: unknown }[] = [];
    async function launch() {
      instance = await electron.launch({ ...launchOptions, env }); page = await instance.firstWindow();
      await instance.evaluate(() => { globalThis.fetch = async () => { throw new Error('ISOLATED_PERMANENT_DELETE_NO_MODEL_NETWORK'); }; });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() === 'POST' && /^\/api\/v1\/trash\/[^/]+\/delete$/u.test(path)) deletes.push({ path, body: request.postDataJSON() });
      });
      page.on('response', (response) => {
        if (response.status() >= 400 && /\/api\/v1\/trash/u.test(response.url())) void response.text().then((body) => apiFailures.push({ path: new URL(response.url()).pathname, status: response.status(), body })).catch(() => undefined);
      });
      return { instance, page };
    }
    try {
      await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), marker, { mode: 0o600, flag: 'wx' });
      for (const directory of ['00大脑规则', '01图书馆/小兆clipper', sourceFolder, `${sourceFolder}/附件`, '02知识库/09学习', '03大讲堂']) await mkdir(join(vault, directory), { recursive: true });
      for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vault, path), '# 隔离测试规则\n只有明确确认才彻底删除单条回收文件；附件、知识和历史保持不变。\n');
      const source = Buffer.from('\uFEFF' + (await readFile(resolve('tests/fixtures/library-valid.md'), 'utf8'))
        .replace('一份可提炼的资料', title).replace('处理状态: 未归档', '处理状态: 已归档').replace('来源平台: B站', '来源平台: 个人')
        .replace('生成知识: ["[[已有知识]]"]', '生成知识: []').replace(/\n/gu, '\r\n') + '\r\n![原始证据](附件/原始证据.bin)\r\n');
      const knowledge = Buffer.from((await readFile(resolve('tests/fixtures/knowledge-valid.md'), 'utf8')).replace('[[一份可提炼的资料]]', `[[${sourcePath.replace(/\.md$/u, '')}]]`));
      const attachment = Buffer.from([0, 255, 13, 10, 128, 42, 1]);
      await writeFile(join(vault, sourcePath), source); await writeFile(join(vault, knowledgePath), knowledge); await writeFile(join(vault, sourceFolder, '附件/原始证据.bin'), attachment);
      const sourceIdentity = await stat(join(vault, sourcePath), { bigint: true });
      const first = await launch(); const firstPage = first.page;
      await expect(firstPage.getByTestId('metric-pending')).toContainText('1');
      await firstPage.getByRole('link', { name: '档案库', exact: true }).click();
      await firstPage.getByRole('button', { name: '打开档案柜', exact: true }).click();
      await expect(firstPage.getByRole('region', { name: '档案柜', exact: true })).toHaveAttribute('data-state', 'open');
      await firstPage.getByLabel('入库状态', { exact: true }).selectOption('未提炼');
      await firstPage.getByLabel('资料标题', { exact: true }).fill(title);
      await firstPage.getByRole('button', { name: '搜索档案', exact: true }).click();
      await expect(firstPage.getByRole('region', { name: '档案柜', exact: true })).toHaveAttribute('data-state', 'open');
      await firstPage.getByRole('button', { name: `移入回收站：${title}`, exact: true }).click();
      const moveResponse = firstPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/trash/commit');
      await firstPage.getByRole('button', { name: '确认移入回收站', exact: true }).click();
      const movedResponse = await moveResponse; expect(movedResponse.ok()).toBe(true);
      const moved = trashEntrySchema.parse((await movedResponse.json()).data); expect(moved.status).toBe('trashed');
      await firstPage.getByRole('link', { name: '查看回收站', exact: true }).click();
      await firstPage.getByRole('button', { name: `选择：${title}`, exact: true }).click();
      const caches = await readdir(join(userData, 'vaults')); expect(caches).toHaveLength(1);
      const slot = join(userData, 'vaults', caches[0]!, 'personal-trash-v1', `${moved.id}.md`);
      expect(await readFile(slot)).toEqual(source); expect((await stat(slot, { bigint: true })).ino).toBe(sourceIdentity.ino);

      // Reading the deletion preview and cancelling must leave both bytes and identity intact.
      const action = firstPage.getByRole('button', { name: `彻底删除：${title}`, exact: true });
      await action.click(); let preview = firstPage.getByRole('dialog', { name: '彻底删除原始资料', exact: true });
      await expect(preview).toContainText('无法从 App 恢复'); await expect(preview).toContainText(sourcePath);
      await expect(preview.getByRole('link', { name: '永久保留的已有知识', exact: true })).toBeVisible();
      await expect(preview).toContainText('附件、目录、知识和提炼历史保持不变');
      await preview.getByRole('button', { name: '取消', exact: true }).click();
      await expect(action).toBeFocused(); expect(deletes).toEqual([]);
      expect(await readFile(slot)).toEqual(source); expect((await stat(slot, { bigint: true })).ino).toBe(sourceIdentity.ino);
      await expect(stat(slot.replace(/\.md$/u, '.delete.json'))).rejects.toMatchObject({ code: 'ENOENT' });

      const previewResponse = firstPage.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/trash/${moved.id}/delete-preview`);
      await action.click(); preview = firstPage.getByRole('dialog', { name: '彻底删除原始资料', exact: true });
      const deletionPreviewResponse = await previewResponse; expect(deletionPreviewResponse.ok()).toBe(true);
      const deletionPreview = trashDeletePreviewSchema.parse((await deletionPreviewResponse.json()).data);
      for (const width of [1440, 390]) { await resize(first.instance, firstPage, width); await firstPage.screenshot({ path: info.outputPath(`permanent-delete-preview-${width}.png`) }); }
      expect(deletes).toEqual([]); const deleteResponse = firstPage.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/trash/${moved.id}/delete`);
      await preview.getByRole('button', { name: '确认彻底删除', exact: true }).dblclick();
      const deletedResponse = await deleteResponse; expect(deletedResponse.ok()).toBe(true);
      const deleted = trashEntrySchema.parse((await deletedResponse.json()).data);
      expect(deleted).toMatchObject({ id: moved.id, status: 'deleted', indexed: true, deletedAt: expect.any(String) });
      expect(deletes).toEqual([{ path: `/api/v1/trash/${moved.id}/delete`, body: { token: deletionPreview.token } }]);
      const receipt = firstPage.getByRole('dialog', { name: '回收操作结果', exact: true });
      await expect(receipt.getByRole('heading', { name: '已彻底删除', exact: true })).toBeVisible();
      await expect(receipt.getByRole('button', { name: '恢复原资料', exact: true })).toHaveCount(0);
      for (const width of [1440, 390]) { await resize(first.instance, firstPage, width); await firstPage.screenshot({ path: info.outputPath(`permanent-delete-receipt-${width}.png`) }); }
      await expect(stat(slot)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(stat(join(vault, sourcePath))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(vault, knowledgePath))).toEqual(knowledge); expect(await readFile(join(vault, sourceFolder, '附件/原始证据.bin'))).toEqual(attachment);
      expect(JSON.parse(await readFile(slot.replace(/\.md$/u, '.delete.json'), 'utf8')).token).toBe(deletionPreview.token);
      await first.instance.close(); instance = undefined;

      const second = await launch(); const secondPage = second.page;
      await secondPage.getByRole('link', { name: '回收站', exact: true }).click();
      await expect(secondPage.getByText('回收站为空', { exact: true })).toBeVisible();
      const summary = secondPage.getByText('操作记录 · 1', { exact: true }); await expect(summary).toBeVisible();
      const history = secondPage.locator('details').filter({ has: summary });
      await expect(history).not.toHaveAttribute('open'); await summary.click();
      await expect(history.getByRole('listitem')).toContainText(title); await expect(history.getByRole('listitem')).toContainText('已彻底删除');
      await expect(history.getByRole('listitem')).toContainText(sourcePath);
      await expect(secondPage.getByRole('button', { name: `恢复：${title}`, exact: true })).toHaveCount(0);
      await expect(secondPage.getByRole('button', { name: `彻底删除：${title}`, exact: true })).toHaveCount(0);
      const persisted = await secondPage.evaluate(async (id) => (await (await fetch(`/api/v1/trash/${id}`)).json()).data, moved.id);
      expect(trashEntrySchema.parse(persisted)).toEqual(deleted);
      for (const width of [1440, 390]) { await resize(second.instance, secondPage, width); await secondPage.screenshot({ path: info.outputPath(`permanent-delete-after-restart-${width}.png`) }); }
      await secondPage.getByRole('link', { name: '大脑总览', exact: true }).click();
      await expect(secondPage.getByTestId('metric-pending')).toContainText('0'); await expect(secondPage.getByTestId('metric-knowledge')).toContainText('1');
      await expect(stat(slot)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(stat(join(vault, sourcePath))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(vault, knowledgePath))).toEqual(knowledge); expect(await readFile(join(vault, sourceFolder, '附件/原始证据.bin'))).toEqual(attachment);
      expect(deletes).toHaveLength(1); expect(pageErrors).toEqual([]); expect(apiFailures).toEqual([]);
    } catch (error) {
      if (page && !page.isClosed()) { await info.attach('permanent-delete-ui', { body: await page.locator('body').innerText(), contentType: 'text/plain' }); await page.screenshot({ path: info.outputPath('failure.png') }); }
      await info.attach('permanent-delete-api', { body: JSON.stringify(apiFailures, null, 2), contentType: 'application/json' }); throw error;
    } finally {
      await instance?.evaluate(({ BrowserWindow }) => { for (const active of BrowserWindow.getAllWindows()) active.destroy(); }).catch(() => undefined);
      await instance?.close().catch(() => undefined);
      if (dirname(vault) !== temporary || !basename(vault).startsWith('xiaozhao-vault-') || await realpath(vault) !== vault
        || await readFile(join(vault, '.xiaozhao-read-test-vault.json'), 'utf8') !== marker
        || dirname(userData) !== temporary || !basename(userData).startsWith('xiaozhao-user-data-') || await realpath(userData) !== userData) throw new Error('REFUSE_UNVERIFIED_PERMANENT_DELETE_FIXTURE_CLEANUP');
      await rm(vault, { recursive: true }); await rm(userData, { recursive: true });
    }
  });
}
