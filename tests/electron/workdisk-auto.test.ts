import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { XiaozhaoDesktopApi } from '../../src/shared/desktop/bridge.js';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

const execute = promisify(execFile);
const text = '访谈时应记录受访者的原话和实际发生的行为，将事实证据与自己的解释分开。整理后回到原始访谈逐条核验，再归纳用户需求，保留原话和结论之间的对应关系。';
const textTitle = '访谈证据记录方法';
const imageTitle = '短视频选题与咨询转化方法';
const renamedTitle = '访谈记录与原话核验';
const textRelative = '1029/001.txt';
const imageRelative = '1029/微信图片/random.png';
const offlineRelative = '1029/离线下载/004.txt';
const sentinel = '# 知识资料保持独立\n';
const quietWindow = 3600; // The collector requires at least three seconds of unchanged source metadata.
let helperRoot: string;
let imageBytes: Buffer;

test.beforeAll(async () => {
  test.setTimeout(30_000);
  helperRoot = await mkdtemp(join(await realpath(tmpdir()), 'xiaozhao-auto-image-'));
  const helper = join(helperRoot, 'image-fixture');
  await execute('xcrun', ['swiftc', resolve('tests/native/fixtures/image-evidence-fixture.swift'), '-o', helper]);
  imageBytes = (await execute(helper, ['text', 'public.png'], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 })).stdout;
});
test.afterAll(async () => { if (helperRoot) await rm(helperRoot, { recursive: true, force: true }); });

async function fixture() {
  const base = await realpath(tmpdir());
  const vault = await mkdtemp(join(base, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(base, 'xiaozhao-user-data-'));
  const workdisk = await mkdtemp(join(base, 'xiaozhao-workdisk-'));
  const downloads = await mkdtemp(join(base, 'xiaozhao-downloads-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
  for (const folder of ['00大脑规则', '01图书馆/来自个人', '01图书馆/小兆clipper', '02知识库', '03大讲堂', '.claude/skills']) await mkdir(join(vault, folder), { recursive: true });
  for (const path of RULE_BUNDLE_SOURCE_PATHS) {
    await mkdir(join(vault, dirname(path)), { recursive: true });
    await writeFile(join(vault, path), '# 隔离测试规则\n原件保留。\n');
  }
  await writeFile(join(vault, '02知识库/哨兵.md'), sentinel);
  await writeFile(join(downloads, 'old.txt'), '连接接收目录以前的下载，不应进入工作盘。');
  await mkdir(join(downloads, '1029'));
  await writeFile(join(downloads, '1029/old.txt'), '连接接收目录以前的子目录下载，也不应进入工作盘。');
  return { vault, userData, workdisk, downloads };
}
async function launch(data: Awaited<ReturnType<typeof fixture>>, mode: 'development' | 'packaged') {
  const target = mode === 'packaged'
    ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
    : { args: [resolve('dist/electron/main.js')] };
  return electron.launch({ ...target, env: {
    ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: data.vault, XIAOZHAO_TEST_USER_DATA: data.userData,
    XIAOZHAO_TEST_WORKDISK_ROOT: data.workdisk, XIAOZHAO_TEST_WORKDISK_AUTO_SOURCE: data.downloads
  } });
}

interface ProviderCapture { urls: string[]; denied: string[]; inputs: string[]; payloads: string[]; tools: number[] }
async function provider(instance: ElectronApplication) {
  await instance.evaluate((_electron, titles) => {
    const state = globalThis as unknown as { autoCollectionProvider: ProviderCapture };
    state.autoCollectionProvider = { urls: [], denied: [], inputs: [], payloads: [], tools: [] };
    globalThis.fetch = async (input, init) => {
      const url = String(input); const capture = state.autoCollectionProvider; capture.urls.push(url);
      if (url === 'https://api.deepseek.com/models') return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] }), { headers: { 'content-type': 'application/json' } });
      if (url !== 'https://api.deepseek.com/chat/completions') { capture.denied.push(url); throw new Error('AUTO_COLLECTION_FIXTURE_NETWORK_FORBIDDEN'); }
      const payload = String(init?.body); const body = JSON.parse(payload) as { messages: { role: string; content: string }[]; tools?: unknown[]; thinking?: { type: string }; reasoning_effort?: string };
      if (body.thinking?.type !== 'disabled' || body.reasoning_effort !== undefined) throw new Error('AUTO_COLLECTION_FIXTURE_NAMING_MODE_INVALID');
      const content = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
      capture.inputs.push(content); capture.payloads.push(payload); capture.tools.push(body.tools?.length ?? 0);
      const title = content.includes('Audience research') ? titles.image : content.includes('访谈') ? titles.text : undefined;
      if (!title) throw new Error('AUTO_COLLECTION_FIXTURE_UNEXPECTED_CONTENT');
      return new Response(`data: ${JSON.stringify({ id: 'auto-collection-fixture', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ title }) }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: 'auto-collection-fixture', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } })}\n\n` +
        'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
  }, { text: textTitle, image: imageTitle });
}
async function captured(instance: ElectronApplication): Promise<ProviderCapture> {
  return instance.evaluate(() => (globalThis as unknown as { autoCollectionProvider: ProviderCapture }).autoCollectionProvider);
}
async function listed(page: Page) {
  return page.evaluate(async () => {
    const disk = (window as Window & { xiaozhaoDesktop?: XiaozhaoDesktopApi }).xiaozhaoDesktop?.workdisk;
    if (!disk) throw new Error('WORKDISK_BRIDGE_UNAVAILABLE');
    return disk.list();
  });
}
async function state(page: Page) {
  return page.evaluate(async () => {
    const autoStatus = (window as Window & { xiaozhaoDesktop?: XiaozhaoDesktopApi }).xiaozhaoDesktop?.workdisk?.autoStatus;
    if (!autoStatus) throw new Error('AUTO_COLLECTION_BRIDGE_UNAVAILABLE');
    return autoStatus();
  });
}
async function names(page: Page) { return (await listed(page)).files.map(file => file.name).sort(); }
async function received(page: Page, name: string) {
  await expect.poll(async () => (await listed(page)).files.filter(file => file.name === name).length, { timeout: 30_000 }).toBe(1);
  return (await listed(page)).files.find(file => file.name === name)!;
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: recovers automatic collection after the same disk returns, including an offline restart`, async () => {
    test.setTimeout(90_000);
    const data = await fixture(); const disconnected = `${data.workdisk}-disconnected`; let instance: ElectronApplication | undefined;
    try {
      instance = await launch(data, mode); await provider(instance); let page = await instance.firstWindow();
      await page.getByRole('link', { name: '工作盘', exact: true }).click();
      await page.getByRole('button', { name: '连接本地文件夹', exact: true }).click();
      let auto = page.getByRole('region', { name: '自动收纳', exact: true });
      await auto.getByRole('checkbox', { name: '自动根据内容命名', exact: true }).uncheck();
      await auto.getByRole('button', { name: '开启自动收纳', exact: true }).click();
      await expect.poll(() => state(page)).toMatchObject({ enabled: true, phase: 'watching', nameFromContent: false });

      // Move only this isolated fixture, preserving its directory identity for reconnect verification.
      await rename(data.workdisk, disconnected);
      await expect.poll(() => state(page)).toMatchObject({ enabled: true, phase: 'waiting' });
      const source = join(data.downloads, '1029/断开期间下载.txt'); const bytes = Buffer.from('硬盘重新连接后应自动补收一次，下载原件仍保留。');
      await writeFile(source, bytes);
      await page.getByRole('link', { name: '设置', exact: true }).click();
      await page.getByRole('link', { name: '工作盘', exact: true }).click();
      await expect(page.getByText(data.workdisk, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: '自动收纳', exact: true })).toContainText('等待工作盘连接');
      await expect(page.getByRole('button', { name: '连接本地文件夹', exact: true })).toHaveCount(0);
      await expect(page.locator('.workdisk-online')).toHaveCount(0);
      await instance.close(); instance = undefined;

      instance = await launch(data, mode); await provider(instance); page = await instance.firstWindow();
      await page.getByRole('link', { name: '工作盘', exact: true }).click();
      auto = page.getByRole('region', { name: '自动收纳', exact: true });
      await expect(auto).toContainText('等待工作盘连接');
      await expect.poll(() => state(page)).toMatchObject({ enabled: true, phase: 'waiting', receipts: [] });
      await page.waitForTimeout(quietWindow);
      expect((await captured(instance)).inputs).toEqual([]);

      await rename(disconnected, data.workdisk);
      const saved = await received(page, '断开期间下载.txt');
      await expect(page.getByRole('button', { name: '预览 断开期间下载.txt', exact: true })).toBeVisible();
      await expect(auto).not.toContainText('等待工作盘连接');
      await expect(page.getByRole('button', { name: '更换', exact: true })).toBeVisible();
      expect((await readFile(join(data.workdisk, saved.path))).equals(bytes)).toBe(true);
      expect((await readFile(source)).equals(bytes)).toBe(true);
      await page.waitForTimeout(quietWindow);
      expect(await names(page)).toEqual(['断开期间下载.txt']);
      expect((await state(page)).receipts).toHaveLength(1);
      const beforeReconnect = await state(page);
      const bindingId = (await listed(page)).binding!.id;
      await page.getByRole('button', { name: '更换', exact: true }).click();
      await expect.poll(() => state(page)).toMatchObject({ enabled: true, phase: 'watching', receipts: beforeReconnect.receipts });
      expect((await listed(page)).binding?.id).toBe(bindingId);
      await page.waitForTimeout(quietWindow);
      expect(await names(page)).toEqual(['断开期间下载.txt']);
      expect((await state(page)).receipts).toEqual(beforeReconnect.receipts);
      expect((await captured(instance)).inputs).toEqual([]); expect((await captured(instance)).denied).toEqual([]);
    } finally {
      await instance?.close();
      for (const path of [data.vault, data.userData, data.workdisk, disconnected, data.downloads]) await rm(path, { recursive: true, force: true });
    }
  });
  test(`${mode}: collects top-level and nested downloads in the background, names pixels and text, edits copies, pauses and resumes after restart`, async ({}, info) => {
    test.setTimeout(180_000);
    const data = await fixture(); let instance: ElectronApplication | undefined;
    try {
      instance = await launch(data, mode); await provider(instance); let page = await instance.firstWindow();
      await page.getByRole('link', { name: '设置', exact: true }).click();
      await page.getByLabel('DeepSeek API Key').fill('sk-isolated-auto-collection');
      await page.getByRole('button', { name: '保存密钥', exact: true }).click();
      await expect(page.getByText('密钥已保存，连接尚未验证。')).toBeVisible();
      await page.getByRole('link', { name: '工作盘', exact: true }).click();
      await page.getByRole('button', { name: '连接本地文件夹', exact: true }).click();
      let auto = page.getByRole('region', { name: '自动收纳', exact: true });
      await expect(auto.getByRole('checkbox', { name: '自动根据内容命名', exact: true })).toBeChecked();
      await expect(auto).toContainText('文字和图片识别结果会发送给已连接的 AI');
      await expect(auto).toContainText('原图留在本机');
      await expect(auto).toContainText('仅接收启用后新增的文件');
      await auto.getByRole('button', { name: '开启自动收纳', exact: true }).click();
      await expect(auto.getByRole('button', { name: '暂停自动收纳', exact: true })).toBeVisible();
      await expect.poll(() => state(page)).toMatchObject({ enabled: true, nameFromContent: true, source: { rootPath: data.downloads } });

      const articleBytes = Buffer.from(text);
      const partial = join(data.downloads, '1029/partial.crdownload'); const textSource = join(data.downloads, textRelative);
      await writeFile(partial, articleBytes);
      // A negative observation must span the real settle interval, not merely the first empty scan.
      await page.waitForTimeout(quietWindow);
      expect(await names(page)).toEqual([]); expect((await captured(instance)).inputs).toEqual([]);
      await rename(partial, textSource);
      const article = await received(page, `${textTitle}.txt`);
      expect(article.path).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}/文档/${textTitle}\\.txt$`, 'u'));
      expect((await readFile(join(data.workdisk, article.path))).equals(articleBytes)).toBe(true);
      expect((await readFile(textSource)).equals(articleBytes)).toBe(true);

      await page.getByRole('link', { name: '设置', exact: true }).click();
      await expect(page).toHaveURL(/\/settings$/u);
      // The first-level folder existed at enablement; this second-level folder is created afterwards.
      const imageSource = join(data.downloads, imageRelative);
      await mkdir(dirname(imageSource), { recursive: true }); await writeFile(imageSource, imageBytes);
      const picture = await received(page, `${imageTitle}.png`);
      await expect(page).toHaveURL(/\/settings$/u);
      expect(picture.path).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}/图片/${imageTitle}\\.png$`, 'u'));
      expect((await readFile(join(data.workdisk, picture.path))).equals(imageBytes)).toBe(true);
      expect((await readFile(imageSource)).equals(imageBytes)).toBe(true);
      await page.getByRole('link', { name: '工作盘', exact: true }).click();
      auto = page.getByRole('region', { name: '自动收纳', exact: true });
      await expect(auto.getByRole('checkbox', { name: '自动根据内容命名', exact: true })).toHaveCount(0);
      await auto.getByRole('button', { name: '查看全部 2 条记录', exact: true }).click();
      await expect(auto).toContainText(textRelative); await expect(auto).toContainText(imageRelative);
      await expect.poll(async () => (await state(page)).receipts.map(receipt => receipt.sourceName).sort()).toEqual([textRelative, imageRelative].sort());
      await expect(auto).toContainText(`${imageTitle}.png`);
      const sent = await captured(instance);
      expect(sent.inputs).toHaveLength(2); expect(sent.tools).toEqual([0, 0]); expect(sent.denied).toEqual([]);
      const evidence = sent.inputs.map(value => JSON.parse(value) as { text: string; labels?: unknown[]; sampled: boolean });
      expect(evidence.some(value => value.text === text)).toBe(true);
      const imageEvidence = evidence.find(value => value.text.includes('Audience research'));
      expect(imageEvidence?.labels).toBeInstanceOf(Array);
      for (const value of evidence) expect(Object.keys(value).sort()).toEqual(value.labels ? ['labels', 'sampled', 'text'] : ['sampled', 'text']);
      for (const forbidden of ['001.txt', 'random.png', textRelative, imageRelative, '1029', '微信图片', data.downloads, 'base64', imageBytes.toString('base64').slice(0, 80)]) expect(sent.payloads.join('\n')).not.toContain(forbidden);

      await auto.getByRole('button', { name: `修改 ${textTitle}.txt 的名称`, exact: true }).click();
      await auto.getByRole('textbox', { name: '新的文件名称', exact: true }).fill(renamedTitle);
      await auto.getByRole('button', { name: '保存名称', exact: true }).click();
      const renamed = await received(page, `${renamedTitle}.txt`);
      expect(renamed.path).toBe(`${article.date}/文档/${renamedTitle}.txt`);
      await expect(readFile(join(data.workdisk, article.path))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readFile(join(data.workdisk, renamed.path))).equals(articleBytes)).toBe(true);
      expect((await readFile(textSource)).equals(articleBytes)).toBe(true);
      await expect(auto).toContainText(`${renamedTitle}.txt`);
      await expect.poll(() => names(page)).toEqual([`${renamedTitle}.txt`, `${imageTitle}.png`].sort());

      await auto.getByRole('button', { name: '暂停自动收纳', exact: true }).click();
      await expect(auto.getByRole('button', { name: '继续自动收纳', exact: true })).toBeVisible();
      await expect.poll(async () => (await state(page)).enabled).toBe(false);
      const pausedBytes = Buffer.from('暂停期间新下载的访谈记录，应在继续后以原名收纳。');
      // Retain a top-level new file alongside the recursive collection cases.
      await writeFile(join(data.downloads, '003.txt'), pausedBytes);
      await page.waitForTimeout(quietWindow);
      expect(await names(page)).toEqual([`${renamedTitle}.txt`, `${imageTitle}.png`].sort());
      expect((await captured(instance)).inputs).toHaveLength(2);
      await auto.getByRole('button', { name: '自动收纳设置', exact: true }).click();
      await auto.getByRole('checkbox', { name: '自动根据内容命名', exact: true }).uncheck();
      await expect.poll(async () => (await state(page)).nameFromContent).toBe(false);
      await auto.getByRole('button', { name: '继续自动收纳', exact: true }).click();
      const resumed = await received(page, '003.txt');
      expect(resumed.path).toMatch(/^\d{4}-\d{2}-\d{2}\/文档\/003\.txt$/u);
      expect((await readFile(join(data.workdisk, resumed.path))).equals(pausedBytes)).toBe(true);
      expect((await readFile(join(data.downloads, '003.txt'))).equals(pausedBytes)).toBe(true);
      expect((await captured(instance)).inputs).toHaveLength(2);
      await expect(auto).toContainText('003.txt');
      await auto.getByRole('button', { name: '自动收纳设置', exact: true }).click();
      await auto.getByRole('button', { name: '收起记录', exact: true }).click();
      await expect(auto.getByRole('checkbox', { name: '自动根据内容命名', exact: true })).toHaveCount(0);
      await expect(auto.getByRole('button', { name: '打开 003.txt', exact: true })).toBeVisible();
      await auto.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: info.outputPath('workdisk-auto-wide.png'), fullPage: true });
      await page.setViewportSize({ width: 720, height: 900 });
      await auto.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await auto.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: info.outputPath('workdisk-auto-narrow.png'), fullPage: true });

      const existingPaths = (await listed(page)).files.map(file => file.path).sort(); expect(existingPaths).toHaveLength(3);
      await instance.close(); instance = undefined;
      const offlineBytes = Buffer.from('应用关闭以后保存的工作资料，下次启动应补收一次。');
      const offlineSource = join(data.downloads, offlineRelative);
      await mkdir(dirname(offlineSource), { recursive: true }); await writeFile(offlineSource, offlineBytes);
      instance = await launch(data, mode); await provider(instance); page = await instance.firstWindow();
      await page.getByRole('link', { name: '工作盘', exact: true }).click();
      await expect.poll(() => state(page)).toMatchObject({ enabled: true, nameFromContent: false, source: { rootPath: data.downloads } });
      const offline = await received(page, '004.txt');
      expect(offline.path).toMatch(/^\d{4}-\d{2}-\d{2}\/文档\/004\.txt$/u);
      expect((await readFile(join(data.workdisk, offline.path))).equals(offlineBytes)).toBe(true);
      expect((await readFile(offlineSource)).equals(offlineBytes)).toBe(true);
      await page.waitForTimeout(quietWindow);
      expect((await listed(page)).files.map(file => file.path).sort()).toEqual([...existingPaths, offline.path].sort());
      await expect.poll(async () => (await state(page)).receipts.filter(receipt => receipt.status === 'saved').length).toBe(4);
      expect((await state(page)).receipts.map(receipt => receipt.sourceName).sort()).toEqual([textRelative, '003.txt', offlineRelative, imageRelative].sort());
      expect((await captured(instance)).inputs).toEqual([]); expect((await captured(instance)).denied).toEqual([]);
      expect((await readFile(textSource)).equals(articleBytes)).toBe(true); expect((await readFile(imageSource)).equals(imageBytes)).toBe(true);
      expect(await readFile(join(data.downloads, 'old.txt'), 'utf8')).toBe('连接接收目录以前的下载，不应进入工作盘。');
      expect(await readFile(join(data.downloads, '1029/old.txt'), 'utf8')).toBe('连接接收目录以前的子目录下载，也不应进入工作盘。');
      expect(await readFile(join(data.vault, '02知识库/哨兵.md'), 'utf8')).toBe(sentinel);
    } finally {
      await instance?.close();
      for (const path of [data.vault, data.userData, data.workdisk, data.downloads]) await rm(path, { recursive: true, force: true });
    }
  });
}
