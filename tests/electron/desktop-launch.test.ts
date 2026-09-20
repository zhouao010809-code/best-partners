import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

for (const mode of ['development', 'packaged'] as const) {
const launchOptions = mode === 'packaged'
  ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
  : { args: [resolve('dist/electron/main.js')] };

test(`${mode}: invalid test roots exit before writing app data`, async () => {
  const userDataDir = await mkdtemp(join(await realpath(tmpdir()), 'xiaozhao-user-data-'));
  try {
    await expect(electron.launch({
      ...launchOptions,
      env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: join(userDataDir, 'nested'), XIAOZHAO_TEST_USER_DATA: userDataDir }
    })).rejects.toThrow();
    expect(await readdir(userDataDir)).toEqual([]);
  } finally { await rm(userDataDir, { recursive: true, force: true }); }
});

test(`${mode}: independent read-only desktop, isolated renderer and automatic refresh`, async ({}, testInfo) => {
  const temporary = await realpath(tmpdir());
  const vaultRoot = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userDataDir = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await writeFile(join(vaultRoot, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
    for (const directory of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂']) await mkdir(join(vaultRoot, directory));
    for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vaultRoot, path), '# Fixture rule\n');
    const material = Buffer.from((await readFile(resolve('tests/fixtures/library-valid.md'), 'utf8'))
      .replace('处理状态: 未归档', '处理状态: 已归档')
      .replace('来源平台: B站', '来源平台: 个人'));
    await writeFile(join(vaultRoot, '01图书馆/初始资料.md'), material);
    const legacy = material.toString('utf8')
      .replace('原始标题: 一份可提炼的资料', '原始标题: 旧格式资料')
      .replace('知识入库状态: 未提炼', '知识入库状态: 已入库')
      .replace('生成知识: ["[[已有知识]]"]', '生成知识: [[已有知识]]');
    const originalClip = '# 未填信息的剪藏\n\n![附件](附件.png)\n<script>原样文本</script>\n';
    await writeFile(join(vaultRoot, '01图书馆/旧格式资料.md'), legacy);
    await writeFile(join(vaultRoot, '01图书馆/原始剪藏.md'), originalClip);
    await writeFile(join(vaultRoot, '02知识库/测试知识.md'), await readFile(resolve('tests/fixtures/knowledge-valid.md')));
    instance = await electron.launch({
      ...launchOptions,
      env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vaultRoot, XIAOZHAO_TEST_USER_DATA: userDataDir }
    });
    const window = await instance.firstWindow();
    await expect(window).toHaveTitle('最佳拍档');
    const origin = await window.evaluate(() => location.origin);
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(await window.evaluate(() => ({
      process: typeof (globalThis as unknown as { process?: unknown }).process,
      require: typeof (globalThis as unknown as { require?: unknown }).require,
      bridge: Object.keys((window as unknown as { xiaozhaoDesktop: object }).xiaozhaoDesktop).sort()
    }))).toEqual({ process: 'undefined', require: 'undefined', bridge: ['checkForUpdates', 'chooseVaultDirectory', 'getAppVersion', 'getClipperStatus', 'getVaultInfo', 'installClipperHost', 'openAssistantLogin', 'openClipperInstall', 'openUpdateDownload', 'openVaultDirectory', 'revealDocument', 'revealSkill'] });
    await expect(window.getByTestId('metric-pending')).toContainText('1');
    const health = await fetch(`${origin}/api/v1/health`).then((r) => r.json());
    expect(health.data.vaultSource.adapter).toBe('filesystem');
    expect(health.data.writeGate.status).toBe('blocked');
    await writeFile(join(vaultRoot, '01图书馆/新增资料.md'), material);
    await expect(window.getByTestId('metric-pending')).toContainText('2', { timeout: 30_000 });
    await window.evaluate(() => window.open('https://example.com'));
    expect(instance.windows()).toHaveLength(1);
    await window.evaluate(() => { location.href = 'file:///tmp/forbidden.html'; });
    await expect(window).toHaveURL(new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await expect(window.getByRole('link', { name: '设置', exact: true })).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath('desktop-home.png') });
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 800));
    await expect.poll(async () => window.locator('aside.sidebar').boundingBox()).toMatchObject({ x: 0, y: 0, width: 72 });
    await window.screenshot({ path: testInfo.outputPath('desktop-compact.png') });
    await window.getByRole('link', { name: '设置', exact: true }).click();
    await expect(window).toHaveURL(`${origin}/settings`);
    await expect(window.getByTestId('schema-issue-count')).toContainText('1');
    await window.getByRole('button', { name: '查看待确认资料', exact: true }).click();
    await window.getByRole('button', { name: '查看原文：原始剪藏' }).click();
    await expect(window.getByTestId('document-original')).toHaveText(originalClip);
    expect(await window.getByTestId('document-original').locator('script, img').count()).toBe(0);
    await window.screenshot({ path: testInfo.outputPath('desktop-settings.png') });
    await window.getByRole('link', { name: '档案库', exact: true }).click();
    await window.getByRole('button', { name: '打开档案柜', exact: true }).click();
    const filterBounds = await window.locator('.archive-vault__controls.library-collections').boundingBox();
    const refreshBounds = await window.getByRole('button', { name: '刷新资料' }).boundingBox();
    expect(refreshBounds!.x + refreshBounds!.width).toBeLessThanOrEqual(filterBounds!.x + filterBounds!.width);
    await window.getByLabel('资料标题', { exact: true }).fill('旧格式资料');
    await window.getByRole('button', { name: '查看 旧格式资料 原文' }).click();
    await expect(window.getByLabel('原始 Markdown 与 YAML')).toHaveText(legacy);
    await window.screenshot({ path: testInfo.outputPath('desktop-library.png') });
    await instance.close();
    instance = undefined;
    await expect.poll(async () => fetch(`${origin}/api/v1/health`).then(() => false, () => true)).toBe(true);
    expect(await readFile(join(vaultRoot, '01图书馆/初始资料.md'))).toEqual(material);
    expect(await readFile(join(vaultRoot, '01图书馆/旧格式资料.md'), 'utf8')).toBe(legacy);
    expect(await readFile(join(vaultRoot, '01图书馆/原始剪藏.md'), 'utf8')).toBe(originalClip);
  } finally {
    await instance?.close();
    await rm(vaultRoot, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});
}
