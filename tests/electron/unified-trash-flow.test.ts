import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

const mode = process.env.UNIFIED_TRASH_PACKAGED === '1' ? 'packaged' : 'development';
type Origin = 'intake' | 'library' | 'queue' | 'knowledge';
type Entry = { id: string; title: string; status: string; origin?: Origin };
const labels: Record<Origin, string> = { intake: '收件箱', library: '原始资料', queue: '提炼队列', knowledge: '知识库' };

test(`${mode}: one bin preserves four origins and supports restart, byte-exact restore and permanent deletion`, async ({}, info) => {
  test.setTimeout(240_000);
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  let instance: ElectronApplication | undefined;
  let page: Page;
  const errors: string[] = [];
  const paths: Record<Origin, string> = {
    intake: '01图书馆/小兆clipper/隔离收件包',
    library: '01图书馆/来自个人/从资料页删除.md',
    queue: '01图书馆/来自个人/从队列删除.md',
    knowledge: '02知识库/09学习/从知识库删除.md'
  };
  const originals = new Map<string, Buffer>();
  const entries = new Map<Origin, Entry>();
  const apiBase = (origin: Origin) => origin === 'intake' ? '/api/v1/intake-trash' : '/api/v1/trash';
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await page.evaluate(async ({ path, body }) => {
      const bootstrap = await (await fetch('/api/v1/bootstrap')).json();
      const result = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': bootstrap.data.csrfToken }, body: JSON.stringify(body) });
      return { status: result.status, body: await result.json() };
    }, { path, body });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.data as T;
  }
  async function launch() {
    instance = await electron.launch({
      ...(mode === 'packaged'
        ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
        : { args: [resolve('dist/electron/main.js')] }),
      env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vault, XIAOZHAO_TEST_USER_DATA: userData }
    });
    page = await instance.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await instance.evaluate(() => { globalThis.fetch = async () => { throw Error('ISOLATED_TRASH_NO_MODEL_NETWORK'); }; });
    await expect(page.getByRole('link', { name: '回收站', exact: true })).toBeVisible();
  }
  async function goto(path: string) { await page.goto(new URL(path, page.url()).href); }
  async function recycle(origin: Origin) {
    const base = apiBase(origin);
    const preview = await post<{ id: string }>(`${base}/preview`, origin === 'intake'
      ? { name: paths.intake.split('/').at(-1)! } : { materialPath: paths[origin], origin });
    const entry = await post<Entry>(origin === 'intake' ? `${base}/${preview.id}/commit` : `${base}/commit`, origin === 'intake' ? {} : { id: preview.id });
    expect(entry.status).toBe('trashed');
    if (origin !== 'intake') expect(entry.origin).toBe(origin);
    entries.set(origin, entry);
    await expect(stat(join(vault, paths[origin]))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  async function closeReceipt() {
    await page.getByRole('button', { name: '关闭回收操作', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  async function verifyOriginal(origin: Origin) {
    for (const [path, bytes] of originals) if (path === paths[origin] || path.startsWith(`${paths[origin]}/`)) {
      expect(await readFile(join(vault, path)), path).toEqual(bytes);
    }
  }
  async function resize(width: number, name: string) {
    await instance!.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0]!; window.setMinimumSize(390, 600); window.setSize(width, width === 390 ? 844 : 1000);
    }, width);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${name}-${width}.png`), fullPage: true });
  }
  try {
    await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { flag: 'wx', mode: 0o600 });
    for (const dir of ['00大脑规则', '01图书馆/来自个人', `${paths.intake}/附件/空目录`, '02知识库/09学习', '03大讲堂']) await mkdir(join(vault, dir), { recursive: true });
    for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vault, path), '# 隔离测试规则\n仅选中文档和收件包可经明确确认回收及删除。\n');
    const library = (await readFile(resolve('tests/fixtures/library-valid.md'), 'utf8')).replace('处理状态: 未归档', '处理状态: 已归档').replace('来源平台: B站', '来源平台: 个人').replace('生成知识: ["[[已有知识]]"]', '生成知识: []');
    for (const origin of ['library', 'queue'] as const) originals.set(paths[origin], Buffer.from('\uFEFF' + library.replace('一份可提炼的资料', paths[origin].split('/').at(-1)!.slice(0, -3)).replace(/\n/gu, '\r\n')));
    originals.set(paths.knowledge, await readFile(resolve('tests/fixtures/knowledge-valid.md')));
    originals.set(`${paths.intake}/原文.md`, Buffer.from('\uFEFF# 收件包原文\r\n保持全部字节。\r\n'));
    originals.set(`${paths.intake}/附件/证据.bin`, Buffer.from([0, 255, 128, 13, 10, 1, 42]));
    const untouched = '01图书馆/来自个人/原文附件.bin';
    originals.set(untouched, Buffer.from([33, 0, 99]));
    for (const [path, bytes] of originals) await writeFile(join(vault, path), bytes);
    await launch();
    for (const origin of Object.keys(labels) as Origin[]) await recycle(origin);
    await page.getByRole('link', { name: '回收站', exact: true }).click();
    await expect(page.getByRole('region', { name: '统一回收站', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^选择：/u })).toHaveCount(4);
    await expect(page.getByRole('complementary', { name: '所选资料详情', exact: true })).toHaveCount(0);
    for (const label of Object.values(labels)) await expect(page.getByRole('tab', { name: new RegExp(`${label} 1`, 'u') })).toBeVisible();
    for (const width of [1440, 1024, 390]) await resize(width, 'four-source-bin');
    await instance!.close(); instance = undefined;
    await launch(); await goto('/trash');
    await expect(page.getByRole('button', { name: /^选择：/u })).toHaveCount(4);
    for (const [origin, entry] of entries) {
      await goto(`/trash?origin=${origin}`);
      await expect(page.getByRole('button', { name: /^选择：/u })).toHaveCount(1);
      await page.getByRole('button', { name: `选择：${entry.title}`, exact: true }).click();
      const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `${apiBase(origin)}/${entry.id}/restore`);
      await page.getByRole('button', { name: `恢复：${entry.title}`, exact: true }).click();
      const restored = await response; expect(restored.ok(), await restored.text()).toBe(true);
      expect((await restored.json()).data.status).toBe('restored');
      await closeReceipt(); await verifyOriginal(origin);
    }
    expect(await readdir(join(vault, paths.intake, '附件/空目录'))).toEqual([]);
    await goto(`/knowledge?path=${encodeURIComponent(paths.knowledge)}`);
    await expect(page.getByRole('button', { name: /^移入回收站：/u })).toBeEnabled();
    await page.getByRole('button', { name: /^移入回收站：/u }).click();
    const knowledgeMove = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/trash/commit');
    await page.getByRole('button', { name: '确认移入回收站', exact: true }).click();
    const knowledgeResponse = await knowledgeMove; expect(knowledgeResponse.ok()).toBe(true);
    const knowledgeEntry = (await knowledgeResponse.json()).data as Entry;
    expect(knowledgeEntry.origin).toBe('knowledge'); entries.set('knowledge', knowledgeEntry);
    await closeReceipt();
    for (const origin of ['intake', 'library', 'queue'] as const) await recycle(origin);
    for (const [origin, entry] of entries) {
      await goto(`/trash?origin=${origin}`);
      await page.getByRole('button', { name: `选择：${entry.title}`, exact: true }).click();
      await page.getByRole('button', { name: `彻底删除：${entry.title}`, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: '确认彻底删除', exact: true })).toBeEnabled();
      if (origin === 'intake') await expect(dialog).toContainText('2 个文件');
      if (origin === 'knowledge') await expect(dialog).toContainText('知识');
      const deletedResponse = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `${apiBase(origin)}/${entry.id}/delete`);
      await dialog.getByRole('button', { name: '确认彻底删除', exact: true }).click();
      const deleted = await deletedResponse; expect(deleted.ok(), await deleted.text()).toBe(true);
      expect((await deleted.json()).data.status).toBe('deleted');
      await closeReceipt();
    }
    expect(await readFile(join(vault, untouched))).toEqual(originals.get(untouched));
    await instance!.close(); instance = undefined;
    await launch(); await goto('/trash');
    await expect(page.getByText('回收站为空', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^恢复：/u })).toHaveCount(0);
    for (const [origin, entry] of entries) {
      const persisted = await page.evaluate(async path => (await (await fetch(path)).json()).data, `${apiBase(origin)}/${entry.id}`);
      expect(persisted.status).toBe('deleted');
      if (origin !== 'intake') expect(persisted.origin).toBe(origin);
    }
    expect(errors).toEqual([]);
    await resize(1440, 'empty-after-restart');
  } finally {
    await instance?.close();
    await rm(vault, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
