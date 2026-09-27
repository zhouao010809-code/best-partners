import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

export type Mode = 'development' | 'packaged';
export type BulkFixture = { vault: string; userData: string; project: string };

export async function makeBulkFixture(): Promise<BulkFixture> {
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  const project = await mkdtemp(join(temporary, 'xiaozhao-client-project-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { flag: 'wx', mode: 0o600 });
  for (const path of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂', '.claude/skills']) await mkdir(join(vault, path), { recursive: true });
  for (const path of RULE_BUNDLE_SOURCE_PATHS) { await mkdir(join(vault, dirname(path)), { recursive: true }); await writeFile(join(vault, path), '# 隔离批量操作测试规则\n'); }
  await writeFile(join(project, '合成资料.md'), Buffer.from('\uFEFF# 合成项目\r\n批量回收不能改变项目资料。\r\n'));
  await writeFile(join(project, '素材附件.bin'), Buffer.from([0, 255, 13, 10, 128]));
  return { vault, userData, project };
}

export async function removeBulkFixture(fixture: BulkFixture) {
  await rm(fixture.vault, { recursive: true, force: true });
  await rm(fixture.userData, { recursive: true, force: true });
  await rm(fixture.project, { recursive: true, force: true });
}

export async function treeSnapshot(root: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(item.parentPath, item.name), relative = path.slice(root.length + 1);
    values[relative] = item.isDirectory() ? 'directory' : createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return values;
}

export async function launchBulk(mode: Mode, fixture: BulkFixture, attempts: string[], errors: string[]) {
  const instance = await electron.launch({
    ...(mode === 'packaged' ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] } : { args: [resolve('dist/electron/main.js')] }),
    env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: fixture.vault, XIAOZHAO_TEST_USER_DATA: fixture.userData, XIAOZHAO_TEST_PROJECT_ROOT: fixture.project }
  });
  await instance.evaluate(() => { globalThis.fetch = async () => { throw new Error('ISOLATED_BULK_LIFECYCLE_NO_EXTERNAL_NETWORK'); }; });
  const window = await instance.firstWindow();
  window.on('pageerror', error => errors.push(error.message));
  await window.route(/\/api\/v1\/(?:assistant\/messages|projects\/[^/]+\/creation-suggestions)(?:\?.*)?$/u, async route => {
    if (route.request().method() === 'POST') { attempts.push(route.request().url()); await route.abort('blockedbyclient'); }
    else await route.continue();
  });
  return { instance, window };
}

export async function resizeBulk(instance: ElectronApplication, window: Page, width: number) {
  await instance.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 1000), width);
  await expect.poll(() => window.evaluate(() => innerWidth)).toBe(width);
  await expect.poll(() => window.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1)).toBe(true);
}

export async function fixturePost(window: Page, path: string, body: Record<string, unknown>): Promise<unknown> {
  const result = await window.evaluate(async ({ path, body }) => {
    const bootstrap = await (await fetch('/api/v1/bootstrap')).json();
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': bootstrap.data.csrfToken }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { path, body });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}
