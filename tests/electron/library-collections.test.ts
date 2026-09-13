import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

const bundle = '01图书馆/来自个人/2026-09/参考资料包';
const finished = `${bundle}/已收录的工具笔记.md`;
const pending = `${bundle}/未提炼的工具笔记.md`;
const unknown = '01图书馆/来自公众号/2026-08/待读资料包/还没有主题.md';
const knowledge = '02知识库/01AI/AI工具/工具整理方法.md';

async function resize(instance: ElectronApplication, page: Page, width: number) {
  await instance.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setMinimumSize(390, 600); win.setSize(size, size === 390 ? 844 : 1050);
  }, width);
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: real collection folders preserve originals and navigate topics, sources, filters and deep links`, async ({}, info) => {
    test.setTimeout(90_000);
    const temp = await realpath(tmpdir());
    const vault = await mkdtemp(join(temp, 'xiaozhao-vault-'));
    const userData = await mkdtemp(join(temp, 'xiaozhao-user-data-'));
    let instance: ElectronApplication | undefined;
    let page: Page | undefined;
    const errors: string[] = [];
    const apiErrors: string[] = [];
    const bodies = new Map<string, Buffer>();
    try {
      await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
      for (const dir of ['00大脑规则', bundle, '01图书馆/来自公众号/2026-08/待读资料包', '02知识库/01AI/AI工具', '03大讲堂']) await mkdir(join(vault, dir), { recursive: true });
      for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vault, path), '# 隔离馆藏测试规则\n只读分类，不修改原始资料。\n');
      const template = await readFile(resolve('tests/fixtures/library-valid.md'), 'utf8');
      for (const path of [finished, pending, unknown]) {
        const title = path.split('/').at(-1)!.slice(0, -3);
        const source = template.replace('一份可提炼的资料', title)
          .replace('处理状态: 未归档', '处理状态: 已归档')
          .replace('来源平台: B站', `来源平台: ${path === unknown ? '公众号' : '个人'}`)
          .replace('知识入库状态: 未提炼', `知识入库状态: ${path === finished ? '已入库' : '未提炼'}`)
          .replace('所属主题: []', path === pending ? '所属主题: ["[[02知识库/01AI/AI工具]]"]' : '所属主题: []')
          .replace('生成知识: ["[[已有知识]]"]', path === finished ? `生成知识: ["[[${knowledge.slice(0, -3)}]]"]` : '生成知识: []');
        bodies.set(path, Buffer.from('\uFEFF' + source.replace(/\n/gu, '\r\n')));
      }
      bodies.set(knowledge, Buffer.from((await readFile(resolve('tests/fixtures/knowledge-valid.md'), 'utf8')).replace('[[一份可提炼的资料]]', `[[${finished.slice(0, -3)}]]`)));
      bodies.set(`${bundle}/证据.bin`, Buffer.from([0, 255, 13, 10, 42]));
      for (const [path, bytes] of bodies) await writeFile(join(vault, path), bytes);
      instance = await electron.launch({
        ...(mode === 'packaged' ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] } : { args: [resolve('dist/electron/main.js')] }),
        env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vault, XIAOZHAO_TEST_USER_DATA: userData }
      });
      page = await instance.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.status() >= 400 && /\/api\/v1\/library/u.test(response.url())) apiErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
      await instance.evaluate(() => { globalThis.fetch = async () => { throw new Error('LIBRARY_TEST_FORBIDS_EXTERNAL_NETWORK'); }; });
      await expect(page.getByTestId('metric-knowledge')).toContainText('1');
      await page.getByRole('link', { name: '原始资料', exact: true }).click();
      await expect(page.getByRole('button', { name: '打开 AI', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '打开 待分类', exact: true })).toBeVisible();
      await resize(instance, page, 1440);
      await page.screenshot({ path: info.outputPath('library-root-1440.png') });
      await page.getByRole('button', { name: '打开 AI', exact: true }).click();
      await page.getByRole('button', { name: '打开 AI工具', exact: true }).click();
      await expect(page.getByRole('button', { name: '查看 已收录的工具笔记 原文', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '查看 未提炼的工具笔记 原文', exact: true })).toBeVisible();
      await page.getByLabel('入库状态', { exact: true }).selectOption('未提炼');
      await expect(page.getByRole('button', { name: '查看 已收录的工具笔记 原文', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: '查看 未提炼的工具笔记 原文', exact: true }).click();
      await expect(page.getByLabel('原始文件内容')).toContainText('正文中的字节必须原样保留');
      expect(new URL(page.url()).searchParams.get('path')).toBe(pending);
      await page.reload();
      await expect(page.getByLabel('原始文件内容')).toContainText('正文中的字节必须原样保留');
      await page.getByRole('button', { name: '关闭原文', exact: true }).click();
      await page.getByRole('button', { name: '返回上一级', exact: true }).click();
      await expect(page.getByRole('button', { name: '打开 AI工具', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '来源目录', exact: true }).click();
      await page.getByRole('button', { name: '打开 个人', exact: true }).click();
      await page.getByRole('button', { name: '打开 2026-09', exact: true }).click();
      await page.getByRole('button', { name: '打开 参考资料包', exact: true }).click();
      await page.reload();
      await expect(page.getByRole('button', { name: '查看 未提炼的工具笔记 原文', exact: true })).toBeVisible();
      for (const width of [1024, 720, 390]) {
        await resize(instance, page, width);
        await expect(page.getByRole('link', { name: '原始资料', exact: true })).toBeVisible();
        await page.screenshot({ path: info.outputPath(`library-files-${width}.png`) });
        if (width === 1024) {
          await page.getByRole('button', { name: '查看 未提炼的工具笔记 原文', exact: true }).click();
          const detail = page.getByRole('dialog', { name: '未提炼的工具笔记 原文' });
          await expect(detail).toBeVisible();
          const detailBox = await detail.boundingBox();
          const listBox = await page.locator('.library-collections-main').boundingBox();
          expect(detailBox!.y + detailBox!.height).toBeLessThanOrEqual(listBox!.y);
          await page.screenshot({ path: info.outputPath('library-original-1024.png') });
          await page.getByRole('button', { name: '关闭原文', exact: true }).click();
        }
      }
      await page.getByRole('link', { name: '原始资料', exact: true }).click();
      await page.getByLabel('资料标题', { exact: true }).fill('还没有主题');
      await expect(page.getByRole('button', { name: '查看 还没有主题 原文', exact: true })).toBeVisible();
      const origin = new URL(page.url()).origin;
      await page.goto(`${origin}/library?${new URLSearchParams({ path: finished })}`);
      await expect(page.getByLabel('原始文件内容')).toContainText('已收录的工具笔记');
      await expect(page.getByRole('link', { name: '返回这份资料的提炼工作台' })).toHaveAttribute('href', `/queue?${new URLSearchParams({ view: 'ready', materialPath: finished })}`);
      for (const [path, bytes] of bodies) expect(await readFile(join(vault, path))).toEqual(bytes);
      expect(errors).toEqual([]); expect(apiErrors).toEqual([]);
    } catch (error) {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: info.outputPath('failure.png') });
        await info.attach('ui', { body: await page.locator('body').innerText(), contentType: 'text/plain' });
      }
      throw error;
    } finally {
      await instance?.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.destroy(); }).catch(() => undefined);
      await instance?.close().catch(() => undefined);
      await rm(vault, { recursive: true, force: true }); await rm(userData, { recursive: true, force: true });
    }
  });
}
