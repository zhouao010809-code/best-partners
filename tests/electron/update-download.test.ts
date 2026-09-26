import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { startUpdateFixtureServer } from '../helpers/update-fixture-server.js';

type Mode = 'development' | 'packaged';
type DownloadFixtureState = { attempts: number; cancelled: boolean; openedInstallers: string[] };
const installerBytes = Buffer.from('ISOLATED_INSTALLER_TEST_BYTES\n'.repeat(32));

function nextPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/u.exec(version);
  if (!match) throw new Error(`Unexpected app version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function release(version: string) {
  const url = `https://github.com/zhouao010809-code/best-partners/releases/download/v${version}/best-partners-${version}-arm64.dmg`;
  return {
    url,
    releases: [{ draft: false, prerelease: false, tag_name: `v${version}`,
      html_url: `https://github.com/zhouao010809-code/best-partners/releases/tag/v${version}`,
      published_at: '2026-09-26T00:00:00Z', body: '隔离安装包下载测试',
      assets: [{ name: `best-partners-${version}-arm64.dmg`, browser_download_url: url,
        digest: `sha256:${createHash('sha256').update(installerBytes).digest('hex')}`, size: installerBytes.length }] }]
  };
}

async function makeFixture() {
  const base = await realpath(tmpdir());
  const vault = await mkdtemp(join(base, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(base, 'xiaozhao-user-data-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
  for (const directory of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂']) await mkdir(join(vault, directory));
  for (const path of RULE_BUNDLE_SOURCE_PATHS) {
    await mkdir(join(vault, dirname(path)), { recursive: true });
    await writeFile(join(vault, path), '# 隔离下载测试规则\n');
  }
  const sentinel = join(vault, '01图书馆', 'sentinel.md');
  await writeFile(sentinel, '# 下载更新不应改动原始资料\n');
  const settingsSentinel = join(userData, 'update-test-sentinel.json');
  await writeFile(settingsSentinel, '{"keep":"isolated-user-settings"}\n', { mode: 0o600 });
  return { vault, userData, sentinel, settingsSentinel };
}

async function launch(mode: Mode, fixture: Awaited<ReturnType<typeof makeFixture>>, feedUrl: string) {
  return electron.launch({
    ...(mode === 'packaged'
      ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
      : { args: [resolve('dist/electron/main.js')] }),
    env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: fixture.vault,
      XIAOZHAO_TEST_USER_DATA: fixture.userData, XIAOZHAO_TEST_UPDATE_FEED_URL: feedUrl }
  });
}

async function installTransport(instance: ElectronApplication, feedUrl: string, assetUrl: string, scenario: 'corrupt-first' | 'slow-first') {
  await instance.evaluate(({ shell }, input) => {
    const state = globalThis as unknown as DownloadFixtureState;
    state.attempts = 0; state.cancelled = false; state.openedInstallers = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (resource, options) => {
      const url = String(resource);
      if (url === input.feedUrl) return originalFetch(resource, options);
      if (url !== input.assetUrl) throw new Error('UPDATE_DOWNLOAD_TEST_NETWORK_FORBIDDEN');
      state.attempts += 1;
      const bytes = Uint8Array.from(input.bytes);
      const headers = { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) };
      if (state.attempts === 1 && input.scenario === 'corrupt-first') {
        // Preserve byte length: this specifically exercises the hash check.
        bytes[0] = bytes[0]! ^ 0xff;
        return new Response(bytes, { headers });
      }
      if (state.attempts === 1 && input.scenario === 'slow-first') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(bytes.slice(0, Math.floor(bytes.length / 4))); },
          cancel() { state.cancelled = true; }
        }), { headers });
      }
      return new Response(bytes, { headers });
    };
    // Exercise main-process verification and opening without mounting a DMG.
    shell.openPath = async (path: string) => { state.openedInstallers.push(path); return ''; };
  }, { feedUrl, assetUrl, scenario, bytes: [...installerBytes] });
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: verifies an in-app download, retries bad bytes and preserves settings across navigation`, async ({}, info) => {
    test.setTimeout(120_000);
    const fixture = await makeFixture();
    const feed = await startUpdateFixtureServer([]);
    let instance: ElectronApplication | undefined;
    try {
      instance = await launch(mode, fixture, feed.url);
      const window = await instance.firstWindow();
      const version = nextPatch(await instance.evaluate(({ app }) => app.getVersion()));
      const available = release(version); feed.setReleases(available.releases);
      await installTransport(instance, feed.url, available.url, 'corrupt-first');
      await window.getByRole('link', { name: '设置', exact: true }).click();
      const updates = window.getByRole('region', { name: '应用更新', exact: true });
      const configPath = join(fixture.userData, 'config/app-config.json');
      const before = await Promise.all([fixture.sentinel, fixture.settingsSentinel, configPath].map(path => readFile(path)));
      await updates.getByRole('button', { name: '检查应用更新', exact: true }).click();
      await expect(updates.getByText(`发现新版本 ${version}`, { exact: true })).toBeVisible();
      await updates.getByRole('button', { name: '下载更新', exact: true }).click();
      await expect(updates.getByRole('alert')).toContainText('更新下载或校验失败');
      await expect(updates.getByRole('button', { name: '打开安装包', exact: true })).toHaveCount(0);
      expect(await instance.evaluate(() => (globalThis as unknown as DownloadFixtureState).openedInstallers)).toEqual([]);

      await updates.getByRole('button', { name: '重试下载', exact: true }).click();
      await expect(updates.getByText(`更新已下载，版本 ${version}`, { exact: true })).toBeVisible();
      expect(await instance.evaluate(() => (globalThis as unknown as DownloadFixtureState).attempts)).toBe(2);
      await window.getByRole('link', { name: '大脑总览', exact: true }).click();
      await expect(window).toHaveURL(/\/$/u);
      await window.getByRole('link', { name: '设置', exact: true }).click();
      await expect(updates.getByText(`更新已下载，版本 ${version}`, { exact: true })).toBeVisible();
      await expect(updates.getByRole('button', { name: '打开安装包', exact: true })).toBeEnabled();
      await updates.scrollIntoViewIfNeeded();
      await window.screenshot({ path: info.outputPath('verified-update-ready.png') });
      await instance.evaluate(({ BrowserWindow }) => {
        const appWindow = BrowserWindow.getAllWindows()[0]!;
        appWindow.setBounds({ ...appWindow.getBounds(), width: 720, height: 800 });
      });
      const openInstaller = updates.getByRole('button', { name: '打开安装包', exact: true });
      await openInstaller.scrollIntoViewIfNeeded();
      await expect(openInstaller).toBeVisible();
      await expect(openInstaller).toBeInViewport();
      await expect.poll(() => window.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
        && document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(await updates.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await window.screenshot({ path: info.outputPath('verified-update-ready-compact.png') });
      await updates.getByRole('button', { name: '打开安装包', exact: true }).click();
      await expect.poll(async () => instance!.evaluate(() => (globalThis as unknown as DownloadFixtureState).openedInstallers.length)).toBe(1);
      const [installer] = await instance.evaluate(() => (globalThis as unknown as DownloadFixtureState).openedInstallers);
      expect(installer).toBeTruthy();
      expect(relative(fixture.userData, installer!)).not.toMatch(/^(?:\.\.|\/)/u);
      expect(installer).toMatch(/\/update\.dmg$/u);
      expect(await readFile(installer!)).toEqual(installerBytes);
      expect(await Promise.all([fixture.sentinel, fixture.settingsSentinel, configPath].map(path => readFile(path)))).toEqual(before);
    } finally {
      await instance?.close().catch(() => undefined);
      await feed.close().catch(() => undefined);
      await rm(fixture.vault, { recursive: true, force: true });
      await rm(fixture.userData, { recursive: true, force: true });
    }
  });
}

test('development: cancels a partial in-app download and can download again', async () => {
  test.setTimeout(90_000);
  const fixture = await makeFixture();
  const feed = await startUpdateFixtureServer([]);
  let instance: ElectronApplication | undefined;
  try {
    instance = await launch('development', fixture, feed.url);
    const window = await instance.firstWindow();
    const version = nextPatch(await instance.evaluate(({ app }) => app.getVersion()));
    const available = release(version); feed.setReleases(available.releases);
    await installTransport(instance, feed.url, available.url, 'slow-first');
    await window.getByRole('link', { name: '设置', exact: true }).click();
    const updates = window.getByRole('region', { name: '应用更新', exact: true });
    await updates.getByRole('button', { name: '检查应用更新', exact: true }).click();
    await updates.getByRole('button', { name: '下载更新', exact: true }).click();
    await expect(updates.getByRole('progressbar', { name: '更新下载进度' })).toHaveAttribute('value', '25');
    await updates.getByRole('button', { name: '取消下载', exact: true }).click();
    await expect(updates.getByRole('button', { name: '下载更新', exact: true })).toBeEnabled();
    await expect(updates.getByRole('progressbar', { name: '更新下载进度' })).toHaveCount(0);
    await expect.poll(async () => instance!.evaluate(() => (globalThis as unknown as DownloadFixtureState).cancelled)).toBe(true);
    expect(await instance.evaluate(() => (globalThis as unknown as DownloadFixtureState).openedInstallers)).toEqual([]);
    await updates.getByRole('button', { name: '下载更新', exact: true }).click();
    await expect(updates.getByText(`更新已下载，版本 ${version}`, { exact: true })).toBeVisible();
    expect(await instance.evaluate(() => (globalThis as unknown as DownloadFixtureState).attempts)).toBe(2);
    expect(await readFile(fixture.sentinel, 'utf8')).toBe('# 下载更新不应改动原始资料\n');
    expect(await readFile(fixture.settingsSentinel, 'utf8')).toBe('{"keep":"isolated-user-settings"}\n');
  } finally {
    await instance?.close().catch(() => undefined);
    await feed.close().catch(() => undefined);
    await rm(fixture.vault, { recursive: true, force: true });
    await rm(fixture.userData, { recursive: true, force: true });
  }
});
