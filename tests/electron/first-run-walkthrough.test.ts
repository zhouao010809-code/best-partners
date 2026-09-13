import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

for (const mode of ['development', 'packaged'] as const) {
for (const scenario of ['pending-material', 'empty-brain'] as const) {
test(`${mode}/${scenario}: a zero-config user can find the first useful path without hidden setup`, async () => {
  const temporary = await realpath(tmpdir());
  const vaultRoot = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userDataDir = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await writeFile(join(vaultRoot, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
    for (const directory of ['00大脑规则', '01图书馆/来自个人/2026-09', '01图书馆/小兆clipper', '02知识库', '03大讲堂']) {
      await mkdir(join(vaultRoot, directory), { recursive: true });
    }
    for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vaultRoot, path), '# Fixture rule\n');
    if (scenario === 'pending-material') {
      const material = (await readFile(resolve('tests/fixtures/library-valid.md'), 'utf8'))
        .replace('处理状态: 未归档', '处理状态: 已归档')
        .replace('来源平台: B站', '来源平台: 个人')
        .replace('原始标题: 一份可提炼的资料', '原始标题: 首次使用资料');
      await writeFile(join(vaultRoot, '01图书馆/来自个人/2026-09/首次使用资料.md'), material);
    }

    instance = await electron.launch({
      ...(mode === 'packaged'
        ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
        : { args: [resolve('dist/electron/main.js')] }),
      env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vaultRoot, XIAOZHAO_TEST_USER_DATA: userDataDir }
    });
    const window = await instance.firstWindow();
    await expect(window).toHaveTitle('最佳拍档');

    await expect(window.getByText(/把收藏的资料变成可复用的知识/u)).toBeVisible();
    await expect(window.getByText(/“待提炼”表示还没有生成知识候选/u)).toBeVisible();
    const setupPrompt = window.getByRole('link', { name: /开始提炼前需要配置 DeepSeek 密钥/u });
    if (scenario === 'pending-material') {
      await expect(setupPrompt).toBeVisible();
      await setupPrompt.click();
      await expect(window).toHaveURL(/\/settings$/u);
      await expect(window.getByRole('region', { name: 'DeepSeek 设置' })).toBeVisible();
    } else {
      await expect(setupPrompt).not.toBeVisible();
      await expect(window.getByRole('link', { name: '去收件箱整理新收件', exact: true })).toBeVisible();
    }

    if (scenario === 'empty-brain') await window.getByRole('link', { name: '去收件箱整理新收件', exact: true }).click();
    else await window.getByRole('link', { name: '收件箱', exact: true }).click();
    await expect(window.getByRole('heading', { name: '把资料带进来' })).toBeVisible();
    await expect(window.getByText('收件箱接收浏览器剪辑插件保存的收藏', { exact: false })).toBeVisible();
    await expect(window.getByText('文件或粘贴文本请在上方导入', { exact: false })).toBeVisible();
    await window.getByRole('button', { name: '打开收件箱' }).click();
    await expect(window.getByText('收件箱是空的', { exact: true })).toBeVisible();
    await expect(window.getByText('上方选择文件或粘贴文本', { exact: false })).toBeVisible();

    await window.getByRole('link', { name: '大脑总览', exact: true }).click();
    const dashboardIntake = scenario === 'empty-brain'
      ? window.getByRole('link', { name: '去收件箱整理新收件', exact: true })
      : window.getByRole('link', { name: /^整理新收件/u });
    await expect(dashboardIntake).toHaveAttribute('href', '/intake');
  } finally {
    await instance?.close();
    await rm(vaultRoot, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});
}
}
