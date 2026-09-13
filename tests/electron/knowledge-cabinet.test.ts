import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

const basic = '02知识库/01AI/AI基础/Agent 与工作流的边界.md';
const other = '02知识库/01AI/AI基础/从一次回答走向可以反复验证的完整系统设计.md';
const nested = '02知识库/02触达/公域/02编导/选题/如何设计一个明确的选题.md';
const obsolete = '02知识库/01AI/AI基础/过时方法.md';
const source = '01图书馆/来自个人/参考原文.md';
const title = (path: string) => path.split('/').at(-1)!.slice(0, -3);

async function resize(app: ElectronApplication, page: Page, width: number) {
  await app.evaluate(({BrowserWindow}, width) => {const win = BrowserWindow.getAllWindows()[0]!; win.setMinimumSize(320,600); win.setSize(width, 980);}, width);
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: real bookshelf folders, papers, reading and URL return preserve knowledge`, async ({}, info) => {
    test.setTimeout(90_000);
    const temp = await realpath(tmpdir());
    const vault = await mkdtemp(join(temp, 'xiaozhao-vault-'));
    const userData = await mkdtemp(join(temp, 'xiaozhao-user-data-'));
    let app: ElectronApplication | undefined; let page: Page | undefined;
    const errors: string[] = []; const apiErrors: string[] = []; const originals = new Map<string, Buffer>();
    try {
      await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', {mode: 0o600});
      for (const directory of ['00大脑规则', '01图书馆/来自个人', '03大讲堂',
        ...['00思考','01AI','02触达','03产品','04交付','05设计','06商业','07管理','08教学','09学习','99其他'].map(name => `02知识库/${name}`),
        '02知识库/01AI/AI基础', '02知识库/01AI/AI工具', '02知识库/02触达/私域', '02知识库/02触达/公域/02编导/选题']) await mkdir(join(vault, directory), {recursive: true});
      for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vault, path), '# 隔离知识书柜测试规则\n仅浏览，不修改资料。\n');
      const template = await readFile(resolve('tests/fixtures/knowledge-valid.md'), 'utf8');
      for (const path of [basic, other, nested, obsolete]) {
        const markdown = template.replace('[[一份可提炼的资料]]', `[[${source.slice(0,-3)}]]`)
          .replace('使用状态: AI总结', path === obsolete ? '使用状态: 过时' : '使用状态: 已优化');
        originals.set(path, Buffer.from(markdown));
      }
      originals.set(source, Buffer.from((await readFile(resolve('tests/fixtures/library-valid.md'), 'utf8')).replace('处理状态: 未归档','处理状态: 已归档').replace('来源平台: B站','来源平台: 个人').replace('生成知识: ["[[已有知识]]"]','生成知识: []')));
      for (const [path, bytes] of originals) await writeFile(join(vault,path),bytes);
      app = await electron.launch({...(mode === 'packaged' ? {executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: []} : {args:[resolve('dist/electron/main.js')]}),
        env:{...process.env, NODE_ENV:'test', XIAOZHAO_TEST_VAULT_ROOT:vault, XIAOZHAO_TEST_USER_DATA:userData}});
      page = await app.firstWindow();
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => {if(r.status() >= 400 && /\/api\/v1\/knowledge/u.test(r.url())) apiErrors.push(`${r.status()} ${new URL(r.url()).pathname}`);});
      await app.evaluate(() => {globalThis.fetch = async () => {throw new Error('KNOWLEDGE_TEST_FORBIDS_EXTERNAL_NETWORK');};});
      await page.getByRole('link',{name:'知识库',exact:true}).click();
      await expect(page.locator('.kb-book')).toHaveCount(11);
      await resize(app,page,1440); await page.screenshot({path:info.outputPath('knowledge-shelf-1440.png'),fullPage:true});
      for(const width of [1024,390,320]) {await resize(app,page,width); await expect.poll(() => page.locator('.kb-cabinet').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);}
      await resize(app,page,1440);
      await page.getByRole('button',{name:'打开 AI 收藏册',exact:true}).click();
      await expect(page.getByRole('button',{name:'打开 AI工具 文件夹',exact:true})).toBeVisible();
      await page.getByRole('button',{name:'打开 AI基础 文件夹',exact:true}).click();
      await expect(page.locator('.kb-paper')).toHaveCount(2);
      await expect(page.locator('.kb-folder-tab')).toHaveText('AI基础');
      for(const width of [1440,1024,390,320]) {
        await resize(app,page,width);
        await expect(page.getByRole('link',{name:'知识库',exact:true})).toBeVisible();
        const widths = await page.locator('.kb-folder-case').evaluate(el => [el.clientWidth,el.scrollWidth]); expect(widths[1]).toBeLessThanOrEqual(widths[0]!+1);
        await page.screenshot({path:info.outputPath(`knowledge-papers-${width}.png`),fullPage:true});
      }
      await resize(app,page,1024);
      await page.getByRole('button',{name:`展开 ${title(basic)} 知识纸页`,exact:true}).click();
      await expect(page.getByLabel('知识正文',{exact:true})).toContainText('这是只在打开详情时读取的正文');
      await expect(page.locator('.knowledge-detail__inline-meta')).toContainText('已优化');
      await page.screenshot({path:info.outputPath('knowledge-reader-1024.png'),fullPage:true});
      expect(new URL(page.url()).searchParams.get('path')).toBe(basic);
      await page.reload();
      await expect(page.getByLabel('知识正文',{exact:true})).toContainText('这是只在打开详情时读取的正文');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button',{name:`展开 ${title(basic)} 知识纸页`,exact:true})).toBeFocused();
      await page.getByRole('button',{name:'归架',exact:true}).click();
      await page.getByRole('button',{name:'打开 触达 收藏册',exact:true}).click();
      for(const name of ['公域','编导','选题']) await page.getByRole('button',{name:`打开 ${name} 文件夹`,exact:true}).click();
      await expect(page.getByRole('button',{name:`展开 ${title(nested)} 知识纸页`,exact:true})).toBeVisible();
      await page.goBack(); await expect(page.getByRole('button',{name:'打开 选题 文件夹',exact:true})).toBeVisible();
      await page.goForward(); await expect(page.getByRole('button',{name:`展开 ${title(nested)} 知识纸页`,exact:true})).toBeVisible();
      await page.getByRole('button',{name:'归架',exact:true}).click();
      await page.getByRole('button',{name:'打开 管理 收藏册',exact:true}).click();
      await expect(page.getByText('这个目录暂时没有知识',{exact:true})).toBeVisible();
      const origin = new URL(page.url()).origin;
      await page.goto(`${origin}/knowledge?${new URLSearchParams({folder:'01AI/AI基础',usageStatus:'过时'})}`);
      await expect(page.getByRole('button',{name:`展开 ${title(obsolete)} 知识纸页`,exact:true})).toBeVisible();
      await expect(page.locator('.kb-paper')).toHaveCount(1);
      await page.goto(`${origin}/knowledge?${new URLSearchParams({path:basic})}`);
      await page.getByText('来源与关联知识',{exact:true}).click();
      await page.getByRole('link',{name:'查看原文 · 参考原文',exact:true}).click();
      await expect(page.getByLabel('原始文件内容')).toContainText('正文中的字节必须原样保留');
      for(const [path,bytes] of originals) expect(await readFile(join(vault,path))).toEqual(bytes);
      expect(errors).toEqual([]); expect(apiErrors).toEqual([]);
    } catch(error) {if(page && !page.isClosed()) {await page.screenshot({path:info.outputPath('failure.png'),fullPage:true}); await info.attach('ui',{body:await page.locator('body').innerText(),contentType:'text/plain'});} throw error;
    } finally {
      await app?.evaluate(({BrowserWindow}) => {for(const win of BrowserWindow.getAllWindows()) win.destroy();}).catch(() => undefined);
      await app?.close().catch(() => undefined);
      await rm(vault,{recursive:true,force:true}); await rm(userData,{recursive:true,force:true});
    }
  });
}
