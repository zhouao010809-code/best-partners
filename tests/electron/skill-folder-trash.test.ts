import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { skillFolderTrashEntryResponseSchema } from '../../src/shared/api/skills.js';

const folderName = '创作流程';
type Mode = 'development' | 'packaged';
async function snapshot(root: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(item.parentPath, item.name), relative = path.slice(root.length + 1);
    values[relative] = item.isDirectory() ? 'directory' : createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return values;
}
async function launch(mode: Mode, vault: string, userData: string, attempts: string[], errors: string[]) {
  const instance = await electron.launch({
    ...(mode === 'packaged'
      ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
      : { args: [resolve('dist/electron/main.js')] }),
    env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vault, XIAOZHAO_TEST_USER_DATA: userData }
  });
  await instance.evaluate(() => { globalThis.fetch = async () => { throw new Error('ISOLATED_SKILL_TRASH_NO_EXTERNAL_NETWORK'); }; });
  const window = await instance.firstWindow();
  window.on('pageerror', error => errors.push(error.message));
  await window.route(/\/api\/v1\/(?:assistant\/messages|projects\/[^/]+\/creation-suggestions)(?:\?.*)?$/u, async route => {
    if (route.request().method() === 'POST') { attempts.push(route.request().url()); await route.abort('blockedbyclient'); }
    else await route.continue();
  });
  await window.getByRole('link', { name: 'Skill 库', exact: true }).click();
  await expect(window.getByRole('button', { name: '文件夹回收站', exact: true })).toBeVisible();
  return { instance, window };
}
async function resize(instance: ElectronApplication, window: Page, width: number) {
  await instance.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 950), width);
  await expect.poll(() => window.evaluate(() => innerWidth)).toBe(width);
  await expect.poll(() => window.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function confirm(window: Page) {
  const response = window.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === '/api/v1/skills/folder-trash');
  await window.getByRole('button', { name: '确认回收整个文件夹', exact: true }).click();
  const result = await response;
  expect(result.status(), await result.text()).toBe(200);
  const entry = skillFolderTrashEntryResponseSchema.parse(await result.json()).data;
  expect(entry.status).toBe('trashed');
  await expect(window.getByRole('button', { name: '撤销回收', exact: true })).toBeVisible();
  return entry;
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: folder recycling cancels without writes and survives restart with conflict-safe byte-preserving restore`, async ({}, info) => {
    test.setTimeout(150_000);
    const temporary = await realpath(tmpdir());
    const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
    const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
    const skillsRoot = join(vault, '.claude', 'skills'), folder = join(skillsRoot, folderName);
    const attempts: string[] = [], errors: string[] = [];
    let instance: ElectronApplication | undefined;
    try {
      await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
      for (const directory of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂', '.claude/skills']) await mkdir(join(vault, directory), { recursive: true });
      for (const path of RULE_BUNDLE_SOURCE_PATHS) { await mkdir(dirname(join(vault, path)), { recursive: true }); await writeFile(join(vault, path), '# Isolated fixture rule\n'); }
      await mkdir(join(folder, 'writer'), { recursive: true });
      await writeFile(join(folder, 'writer', 'SKILL.md'), '\uFEFF---\r\nname: 隔离写作方法\r\ndescription: 仅用于回收验收\r\n---\r\n# 不改写原文件\r\n');
      await writeFile(join(folder, 'writer', 'REFERENCE.md'), '# 保留参考文档\n');
      await mkdir(join(folder, '未识别目录', '空文件夹'), { recursive: true });
      await writeFile(join(folder, '未识别目录', '附件.bin'), Buffer.from([0, 255, 128, 13, 10, 1]));
      await writeFile(join(folder, '.hidden'), Buffer.from([0, 1, 2, 255]));
      await writeFile(join(folder, '散文件.txt'), '没有 SKILL.md 的内容也必须保留\r\n');
      const originalFolder = await snapshot(folder), originalVault = await snapshot(vault);
      let launched = await launch(mode, vault, userData, attempts, errors);
      instance = launched.instance; let window = launched.window;
      await resize(instance, window, 1360);
      await window.getByRole('button', { name: new RegExp(`^${folderName}\\s`) }).click();
      await window.getByRole('button', { name: '移到回收站', exact: true }).click();
      await expect(window.getByRole('dialog', { name: `回收“${folderName}”？` })).toContainText('隐藏文件和未识别条目');
      await window.screenshot({ path: info.outputPath('skill-trash-confirm-1360.png'), fullPage: true });
      await resize(instance, window, 720);
      await window.screenshot({ path: info.outputPath('skill-trash-confirm-720.png'), fullPage: true });
      await window.getByRole('button', { name: '取消回收', exact: true }).click();
      expect(await snapshot(vault)).toEqual(originalVault);
      await window.getByRole('button', { name: '移到回收站', exact: true }).click();
      const first = await confirm(window);
      expect(await snapshot(join(skillsRoot, '.trash', first.id, 'folder'))).toEqual(originalFolder);
      await window.getByRole('button', { name: '撤销回收', exact: true }).click();
      await expect(window.getByRole('button', { name: new RegExp(`^${folderName}\\s`) })).toHaveAttribute('aria-pressed', 'true');
      expect(await snapshot(folder)).toEqual(originalFolder);
      await window.getByRole('button', { name: '移到回收站', exact: true }).click();
      const recycled = await confirm(window);
      const payload = join(skillsRoot, '.trash', recycled.id, 'folder');
      expect(await snapshot(payload)).toEqual(originalFolder);
      expect(await readdir(skillsRoot)).not.toContain(folderName);
      await instance.close(); instance = undefined;

      launched = await launch(mode, vault, userData, attempts, errors);
      instance = launched.instance; window = launched.window;
      await resize(instance, window, 1360);
      await expect(window.getByRole('button', { name: new RegExp(`^${folderName}\\s`) })).toHaveCount(0);
      await window.getByRole('button', { name: '文件夹回收站', exact: true }).click();
      const restore = window.getByRole('button', { name: `恢复：${folderName}`, exact: true });
      await expect(restore).toBeVisible();
      await mkdir(folder);
      await writeFile(join(folder, '.collision'), 'new folder must not be overwritten');
      const collision = await snapshot(folder);
      const refused = window.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === '/api/v1/skills/folder-trash/restore');
      await restore.click();
      expect((await refused).status()).toBe(409);
      await expect(window.getByRole('alert')).toContainText('请先重命名或移走同名文件夹');
      expect(await snapshot(folder)).toEqual(collision);
      expect(await snapshot(payload)).toEqual(originalFolder);
      await window.screenshot({ path: info.outputPath('skill-trash-restore-conflict-1360.png'), fullPage: true });
      await rename(folder, join(vault, 'held-isolated-collision'));
      await restore.click();
      await expect(window.getByText(`“${folderName}”已恢复到原位置。`, { exact: true })).toBeVisible();
      await expect(window.getByRole('button', { name: new RegExp(`^${folderName}\\s`) })).toHaveAttribute('aria-pressed', 'true');
      expect(await snapshot(folder)).toEqual(originalFolder);
      expect(await snapshot(join(vault, 'held-isolated-collision'))).toEqual(collision);
      for (const [path, hash] of Object.entries(originalVault)) {
        if (hash !== 'directory') expect(createHash('sha256').update(await readFile(join(vault, path))).digest('hex')).toBe(hash);
      }
      await resize(instance, window, 720);
      await window.screenshot({ path: info.outputPath('skill-trash-restored-720.png'), fullPage: true });
      expect(attempts).toEqual([]); expect(errors).toEqual([]);
      await info.attach('preserved-skill-tree', { body: JSON.stringify(originalFolder, null, 2), contentType: 'application/json' });
    } finally {
      await instance?.close();
      await rm(vault, { recursive: true, force: true }); await rm(userData, { recursive: true, force: true });
    }
  });
}
