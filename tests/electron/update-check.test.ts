import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { startUpdateFixtureServer } from '../helpers/update-fixture-server.js';

const release = (version: string) => [{
  draft: false,
  prerelease: false,
  tag_name: `v${version}`,
  html_url: `https://github.com/zhouao010809-code/best-partners/releases/tag/v${version}`,
  published_at: '2026-09-18T00:00:00Z',
  body: '修复 Skill 库同步问题',
  assets: [{
    name: `best-partners-${version}-arm64.dmg`,
    browser_download_url: `https://github.com/zhouao010809-code/best-partners/releases/download/v${version}/best-partners-${version}-arm64.dmg`
  }]
}];

function nextPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/u.exec(version);
  if (!match) throw new Error(`Unexpected app version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

async function makeVault() {
  const base = await realpath(tmpdir());
  const vault = await mkdtemp(join(base, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(base, 'xiaozhao-user-data-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
  for (const directory of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂']) await mkdir(join(vault, directory));
  for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vault, path), '# 隔离更新测试规则\n');
  const sentinel = join(vault, '01图书馆', 'sentinel.md');
  await writeFile(sentinel, '# 不应被更新检查修改\n');
  return { vault, userData, sentinel };
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: checks a GitHub release without changing the vault`, async () => {
    test.setTimeout(120_000);
    const fixture = await makeVault();
    const feed = await startUpdateFixtureServer(release('0.1.1'));
    const launchOptions = mode === 'packaged'
      ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
      : { args: [resolve('dist/electron/main.js')] };
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      XIAOZHAO_TEST_VAULT_ROOT: fixture.vault,
      XIAOZHAO_TEST_USER_DATA: fixture.userData,
      XIAOZHAO_TEST_UPDATE_FEED_URL: feed.url
    };
    let instance: ElectronApplication | undefined;
    try {
      const before = await readFile(fixture.sentinel);
      instance = await electron.launch({ ...launchOptions, env });
      const window = await instance.firstWindow();
      const currentVersion = await window.evaluate(() => window.xiaozhaoDesktop.getAppVersion());
      const availableVersion = nextPatch(currentVersion);
      feed.setReleases(release(availableVersion));
      await window.getByRole('link', { name: '设置', exact: true }).click();
      await window.getByRole('button', { name: '检查应用更新', exact: true }).click();
      await expect(window.getByText(`发现新版本 ${availableVersion}`, { exact: true })).toBeVisible();
      await expect(window.getByText('修复 Skill 库同步问题', { exact: true })).toBeVisible();
      expect(await readFile(fixture.sentinel)).toEqual(before);

      feed.setReleases(release(currentVersion));
      await window.getByRole('button', { name: '检查应用更新', exact: true }).click();
      await expect(window.getByText('已是最新版本', { exact: true })).toBeVisible();
      expect(await readFile(fixture.sentinel)).toEqual(before);
    } finally {
      await instance?.close().catch(() => undefined);
      await feed.close().catch(() => undefined);
      await rm(fixture.vault, { recursive: true, force: true });
      await rm(fixture.userData, { recursive: true, force: true });
    }
  });
}
