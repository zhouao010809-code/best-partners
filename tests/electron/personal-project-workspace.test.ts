import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

type Fixture = { vault: string; userData: string; project: string };

async function makeFixture(): Promise<Fixture> {
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  const project = await mkdtemp(join(temporary, 'xiaozhao-client-project-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
  for (const directory of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂']) await mkdir(join(vault, directory), { recursive: true });
  for (const path of RULE_BUNDLE_SOURCE_PATHS) {
    await mkdir(join(vault, dirname(path)), { recursive: true });
    await writeFile(join(vault, path), '# Fixture rule\n');
  }
  await writeFile(join(vault, '02知识库', '全局方法.md'), '# 全局方法\n用证据优化选题。\n');
  await writeFile(join(project, 'brief.md'), '# A项目\n目标受众：代运营客户。\n');
  await writeFile(join(project, 'content-history.md'), '# 内容历史\n已有内容记录。\n');
  await writeFile(join(project, 'unsupported.png'), Buffer.from('fixture'));
  return { vault, userData, project };
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: bind an existing folder and open the isolated project assistant`, async () => {
    test.setTimeout(120_000);
    const fixture = await makeFixture();
    const launchOptions = mode === 'packaged'
      ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
      : { args: [resolve('dist/electron/main.js')] };
    let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      instance = await electron.launch({
        ...launchOptions,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          XIAOZHAO_TEST_VAULT_ROOT: fixture.vault,
          XIAOZHAO_TEST_USER_DATA: fixture.userData,
          XIAOZHAO_TEST_PROJECT_ROOT: fixture.project
        }
      });
      const window = await instance.firstWindow();
      const projectsLink = window.getByRole('link', { name: '我的项目', exact: true });
      await expect(projectsLink).toBeVisible();
      await projectsLink.click();
      await expect(window).toHaveURL(/\/projects$/u);
      await window.getByRole('button', { name: '添加项目', exact: true }).click();
      await expect(window.getByRole('heading', { name: '确认项目文件夹', exact: true })).toBeVisible();
      await expect(window.getByText(/不需要填写客户背景、阶段或目标/u)).toBeVisible();
      expect(await window.getByLabel(/背景|阶段|目标/u).count()).toBe(0);
      await window.getByRole('textbox', { name: '项目显示名（可选）' }).fill('A项目');
      await window.getByRole('button', { name: '确认添加项目', exact: true }).click();

      await expect(window).toHaveURL(/\/projects\/[0-9a-f-]+$/u);
      await expect(window.getByRole('heading', { name: 'A项目', exact: true })).toBeVisible();
      await expect(window.getByRole('heading', { name: '项目语料：已连接', exact: true })).toBeVisible();
      await expect(window.getByText('全局知识库：可检索', { exact: true }).first()).toBeVisible();
      await expect(window.getByText('写入范围：A项目 / AI工作区', { exact: true }).first()).toBeVisible();
      const panel = window.getByRole('complementary', { name: '问问 AI' });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('heading', { name: '项目模式 · A项目', exact: true })).toBeVisible();

      const briefPath = join(fixture.project, 'brief.md');
      const originalBrief = await readFile(briefPath, 'utf8');
      await writeFile(briefPath, `${originalBrief}\n新增事实：下周拍摄。\n`);
      await window.getByRole('button', { name: '刷新索引', exact: true }).click();
      await expect(window.getByRole('heading', { name: '项目语料：已连接', exact: true })).toBeVisible();
      expect(await readFile(briefPath, 'utf8')).toContain('新增事实：下周拍摄。');
      expect(await readFile(briefPath, 'utf8')).not.toContain('AI工作区');
    } finally {
      await instance?.close();
      await rm(fixture.vault, { recursive: true, force: true });
      await rm(fixture.userData, { recursive: true, force: true });
      await rm(fixture.project, { recursive: true, force: true });
    }
  });
}
