import { _electron as electron, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

const skillNames = ['root-a', 'root-b', 'root-c', 'root-d'] as const;
const folderName = '通用';
const folderId = createHash('sha256').update(folderName, 'utf8').digest('hex');

function skillBytes(name: string): Buffer {
  return Buffer.from(`---\nname: ${name}\ndescription: 隔离验收 Skill\n---\n\n# ${name}\n\n用于 Electron 验收。\n`, 'utf8');
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: creates, moves, refreshes and reveals local Skills without rewriting bytes`, async () => {
    const temporary = await realpath(tmpdir());
    const vaultRoot = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
    const userDataDir = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
    const skillsRoot = join(vaultRoot, '.claude', 'skills');
    const original = new Map<string, Buffer>();
    let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;

    try {
      await writeFile(join(vaultRoot, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
      for (const directory of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂']) {
        await mkdir(join(vaultRoot, directory), { recursive: true });
      }
      for (const path of RULE_BUNDLE_SOURCE_PATHS) {
        await writeFile(join(vaultRoot, path), '# Fixture rule\n');
      }
      await mkdir(skillsRoot, { recursive: true });
      for (const name of skillNames) {
        const bytes = skillBytes(name);
        original.set(name, bytes);
        await mkdir(join(skillsRoot, name));
        await writeFile(join(skillsRoot, name, 'SKILL.md'), bytes);
      }

      instance = await electron.launch({
        ...(mode === 'packaged'
          ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
          : { args: [resolve('dist/electron/main.js')] }),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          XIAOZHAO_TEST_VAULT_ROOT: vaultRoot,
          XIAOZHAO_TEST_USER_DATA: userDataDir
        }
      });
      const window = await instance.firstWindow();
      const origin = await window.evaluate(() => location.origin);
      await window.getByRole('link', { name: 'Skill 库', exact: true }).click();
      await expect(window).toHaveURL(`${origin}/skills`);
      await expect(window.locator('.skills-card')).toHaveCount(skillNames.length);
      for (const name of skillNames) {
        await expect(window.getByRole('heading', { name, exact: true })).toBeVisible();
      }

      await window.getByRole('button', { name: '新建文件夹', exact: true }).click();
      await window.getByRole('textbox', { name: '文件夹名称' }).fill(folderName);
      await window.getByRole('button', { name: '保存文件夹', exact: true }).click();
      await expect(window.getByRole('button', { name: new RegExp(`^${folderName}\\s`) })).toBeVisible();
      await expect(window.getByRole('button', { name: new RegExp(`^${folderName}\\s`) })).toHaveAttribute('aria-pressed', 'true');
      await window.getByRole('button', { name: /^未分类\s/ }).click();

      for (const name of skillNames) {
        const select = window.getByRole('combobox', { name: `移动到：${name}` });
        await expect(select).toBeVisible();
        await select.selectOption({ label: folderName });
        await expect(window.getByRole('heading', { name, exact: true })).not.toBeVisible();
      }

      await window.getByRole('button', { name: new RegExp(`^${folderName}\\s`) }).click();
      await expect(window.locator('.skills-card')).toHaveCount(skillNames.length);
      for (const name of skillNames) {
        await expect(window.getByRole('heading', { name, exact: true })).toBeVisible();
        await expect(window.getByRole('combobox', { name: `移动到：${name}` })).toHaveValue(folderId);
      }

      const detailCard = window.locator('.skills-card').filter({ has: window.getByRole('heading', { name: 'root-a', exact: true }) });
      await detailCard.getByRole('button', { name: '查看方法：root-a' }).click();
      await window.getByRole('button', { name: '在 Finder 中打开', exact: true }).click();
      await expect(window.getByText('已在 Finder 中打开。', { exact: true })).toBeVisible();

      await instance.close();
      instance = undefined;
      expect(await readdir(skillsRoot)).toEqual([folderName]);
      for (const name of skillNames) {
        await expect(readFile(join(skillsRoot, folderName, name, 'SKILL.md'))).resolves.toEqual(original.get(name));
      }
    } finally {
      await instance?.close();
      await rm(vaultRoot, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
}
