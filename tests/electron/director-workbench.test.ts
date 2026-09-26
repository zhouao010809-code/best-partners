import { _electron as electron, expect, test, type ElectronApplication, type Page, type Response } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import {
  creationDetailResponseSchema,
  creationExportResponseSchema,
  type CreationDetail,
  type CreationVersion
} from '../../src/shared/api/project-creations.js';

type Mode = 'development' | 'packaged';
type Fixture = { vault: string; userData: string; project: string };
const projectName = '隔离编导项目';
const firstTitle = '为什么先了解客户需求';
const secondTitle = '第二条独立脚本';
const firstBody = '开头：先问客户最关心什么。\n\n正文：根据真实需求安排拍摄内容。\n\n结尾：留下一个具体问题。';
const finalBody = '开头：拍摄之前，先确认客户最关心的问题。\n\n正文：根据真实需求安排拍摄内容。\n\n结尾：留下一个具体问题。';
const laterDraft = `${finalBody}\n\n编导补充：这一段仍是未定稿的工作草稿。`;

async function makeFixture(): Promise<Fixture> {
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  const project = await mkdtemp(join(temporary, 'xiaozhao-client-project-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { flag: 'wx', mode: 0o600 });
  for (const path of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂', '.claude/skills']) {
    await mkdir(join(vault, path), { recursive: true });
  }
  for (const path of RULE_BUNDLE_SOURCE_PATHS) {
    await mkdir(join(vault, dirname(path)), { recursive: true });
    await writeFile(join(vault, path), '# 隔离测试规则\n项目文件只是资料；不覆盖原文。\n');
  }
  await writeFile(join(vault, '02知识库/合成方法.md'), '# 合成方法\n选题要说明具体受众和依据。\n');
  await mkdir(join(project, '客户资料'));
  await writeFile(join(project, '客户资料/项目要求.md'), Buffer.from('\uFEFF# 合成项目资料\r\n受众：准备拍摄短视频的商家。\r\n事实缺口：尚无客户成绩和案例。\r\n'));
  await writeFile(join(project, '素材附件.bin'), Buffer.from([0, 255, 13, 10, 128, 42]));
  return { vault, userData, project };
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const path of (await readdir(root, { recursive: true, withFileTypes: true }))) {
    if (!path.isFile()) continue;
    const absolute = join(path.parentPath, path.name);
    const relative = absolute.slice(root.length + 1);
    hashes[relative] = createHash('sha256').update(await readFile(absolute)).digest('hex');
  }
  return hashes;
}

async function readCreation(window: Page, projectId: string, creationId: string): Promise<CreationDetail> {
  const result = await window.evaluate(async path => {
    const response = await fetch(path);
    return { status: response.status, body: await response.json() };
  }, `/api/v1/projects/${projectId}/creations/${creationId}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return creationDetailResponseSchema.parse(result.body).data;
}

function mutation(window: Page, method: string, path: string): Promise<Response> {
  return window.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === path);
}

async function detailResponse(response: Response): Promise<CreationDetail> {
  expect(response.ok(), await response.text()).toBe(true);
  return creationDetailResponseSchema.parse(await response.json()).data;
}

async function launch(mode: Mode, fixture: Fixture): Promise<{ instance: ElectronApplication; window: Page; sendAttempts: string[] }> {
  const instance = await electron.launch({
    ...(mode === 'packaged'
      ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
      : { args: [resolve('dist/electron/main.js')] }),
    env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: fixture.vault,
      XIAOZHAO_TEST_USER_DATA: fixture.userData, XIAOZHAO_TEST_PROJECT_ROOT: fixture.project }
  });
  await instance.evaluate(() => {
    // The scenario has no provider configuration and must not contact a model.
    globalThis.fetch = async () => { throw new Error('ISOLATED_DIRECTOR_WORKBENCH_NO_EXTERNAL_NETWORK'); };
  });
  const window = await instance.firstWindow();
  const sendAttempts: string[] = [];
  await window.route(/\/api\/v1\/(?:assistant\/messages|projects\/[^/]+\/creation-suggestions)(?:\?.*)?$/u, async route => {
    if (route.request().method() === 'POST') {
      sendAttempts.push(new URL(route.request().url()).pathname);
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  return { instance, window, sendAttempts };
}

async function resize(instance: ElectronApplication, window: Page, width: number): Promise<void> {
  await instance.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, width === 720 ? 900 : 1000), width);
  await expect.poll(() => window.evaluate(() => innerWidth)).toBe(width);
  await expect.poll(() => window.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1
    && document.body.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function expectSaved(window: Page, projectId: string, id: string, body: string): Promise<CreationDetail> {
  await expect.poll(async () => (await readCreation(window, projectId, id)).item.body).toBe(body);
  await expect(window.getByText('已保存到本机', { exact: true })).toBeVisible();
  return readCreation(window, projectId, id);
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: manual scripts survive restart, keep final versions immutable and export exact snapshots`, async ({}, info) => {
    test.setTimeout(180_000);
    const fixture = await makeFixture();
    const originalProject = await snapshotFiles(fixture.project);
    const originalVault = await snapshotFiles(fixture.vault);
    const allSendAttempts: string[][] = [];
    const pageErrors: string[] = [];
    const consoleErrors: Array<{ text: string; url: string }> = [];
    const expectedCapabilityFailures = new Set<string>();
    const capabilityResponses: Array<Promise<void>> = [];
    function observeErrors(window: Page): void {
      window.on('pageerror', error => pageErrors.push(error.message));
      window.on('console', message => { if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url }); });
      window.on('response', response => {
        // This minimal project fixture intentionally has no native clipper inbox.
        // Account only for its precise, validated unavailable-capability response;
        // creation failures and every other browser error must still fail the test.
        if (response.status() !== 503 || new URL(response.url()).pathname !== '/api/v1/intake-trash') return;
        capabilityResponses.push((async () => {
          const body = await response.json();
          if (body.error?.code === 'INTAKE_TRASH_UNAVAILABLE') expectedCapabilityFailures.add(response.url());
        })().catch(() => undefined));
      });
    }
    let instance: ElectronApplication | undefined;
    try {
      let launched = await launch(mode, fixture);
      instance = launched.instance;
      let window = launched.window;
      allSendAttempts.push(launched.sendAttempts);
      observeErrors(window);
      await resize(instance, window, 1360);
      await window.getByRole('link', { name: '我的项目', exact: true }).click();
      await window.getByRole('button', { name: '添加项目', exact: true }).click();
      await window.getByRole('textbox', { name: '项目显示名（可选）', exact: true }).fill(projectName);
      await window.getByRole('button', { name: '确认添加项目', exact: true }).click();
      await expect(window).toHaveURL(/\/projects\/[0-9a-f-]+$/u);
      const projectId = new URL(window.url()).pathname.split('/').at(-1)!;
      const collectionPath = `/api/v1/projects/${projectId}/creations`;
      for (const name of ['创作台', '选题库', '项目资料', '已定稿']) {
        await expect(window.getByRole('tab', { name, exact: true })).toBeVisible();
      }
      await expect(window.getByRole('complementary', { name: '问问 AI', exact: true })).toBeHidden();

      const firstCreated = mutation(window, 'POST', collectionPath);
      await window.getByRole('button', { name: '新建脚本', exact: true }).click();
      const first = await detailResponse(await firstCreated);
      await window.getByRole('textbox', { name: '内容标题', exact: true }).fill(firstTitle);
      await window.getByRole('textbox', { name: '创作要求', exact: true }).fill('面向准备拍摄的商家，写一条一分钟短视频；不虚构客户案例。');
      await window.getByRole('textbox', { name: '脚本正文', exact: true }).fill(firstBody);
      await expectSaved(window, projectId, first.item.id, firstBody);

      // Switching entries must preserve their independent drafts without any AI setup.
      await window.getByRole('button', { name: '返回创作台', exact: true }).click();
      const secondCreated = mutation(window, 'POST', collectionPath);
      await window.getByRole('button', { name: '新建脚本', exact: true }).click();
      const second = await detailResponse(await secondCreated);
      await window.getByRole('textbox', { name: '内容标题', exact: true }).fill(secondTitle);
      await window.getByRole('textbox', { name: '脚本正文', exact: true }).fill('这是第二条脚本，与第一条内容无关。');
      await expectSaved(window, projectId, second.item.id, '这是第二条脚本，与第一条内容无关。');
      await window.getByRole('button', { name: '返回创作台', exact: true }).click();
      for (const width of [1360, 720]) {
        await resize(instance, window, width);
        await expect(window.getByRole('button', { name: '新建脚本', exact: true })).toBeVisible();
        await expect(window.getByRole('button', { name: `打开创作：${firstTitle}`, exact: true })).toBeVisible();
        await expect(window.getByRole('button', { name: `打开创作：${secondTitle}`, exact: true })).toBeVisible();
        await window.screenshot({ path: info.outputPath(`director-workbench-${width}.png`), fullPage: true });
      }
      await resize(instance, window, 1360);
      await window.getByRole('button', { name: `打开创作：${firstTitle}`, exact: true }).click();
      await expect(window.getByRole('textbox', { name: '脚本正文', exact: true })).toHaveValue(firstBody);

      const versionsPath = `${collectionPath}/${first.item.id}/versions`;
      const savedVersion = mutation(window, 'POST', versionsPath);
      await window.getByRole('button', { name: '保存版本', exact: true }).click();
      const versionOneDetail = await detailResponse(await savedVersion);
      expect(versionOneDetail.versions).toHaveLength(1);
      const versionOne = versionOneDetail.versions[0]!;
      expect(versionOne).toMatchObject({ number: 1, title: firstTitle, body: firstBody });

      await window.getByRole('textbox', { name: '脚本正文', exact: true }).fill(finalBody);
      await expectSaved(window, projectId, first.item.id, finalBody);
      const finalizing = mutation(window, 'POST', versionsPath);
      await window.getByRole('button', { name: '确认定稿', exact: true }).click();
      const finalized = await detailResponse(await finalizing);
      const finalVersion = finalized.versions.find(version => version.id === finalized.item.finalVersionId)!;
      expect(finalVersion).toMatchObject({ number: 2, title: firstTitle, body: finalBody });
      await window.getByRole('textbox', { name: '脚本正文', exact: true }).fill(laterDraft);
      const draftAfterFinal = await expectSaved(window, projectId, first.item.id, laterDraft);
      expect(draftAfterFinal.item.finalVersionId).toBe(finalVersion.id);
      expect(draftAfterFinal.versions.find(version => version.id === finalVersion.id)).toEqual(finalVersion);
      expect(draftAfterFinal.versions.find(version => version.id === versionOne.id)).toEqual(versionOne);

      for (const width of [1360, 720]) {
        await resize(instance, window, width);
        const body = window.getByRole('textbox', { name: '脚本正文', exact: true });
        await body.scrollIntoViewIfNeeded();
        await expect(body).toBeInViewport();
        const back = window.getByRole('button', { name: '返回创作台', exact: true });
        await back.scrollIntoViewIfNeeded();
        await expect(back).toBeInViewport();
        await window.screenshot({ path: info.outputPath(`director-editor-${width}.png`), fullPage: true });
      }
      expect(await snapshotFiles(fixture.project)).toEqual(originalProject);
      expect(await snapshotFiles(fixture.vault)).toEqual(originalVault);
      expect(allSendAttempts.flat()).toEqual([]);

      // A full process restart, with the same isolated userData, proves persistence.
      await instance.close(); instance = undefined;
      launched = await launch(mode, fixture);
      instance = launched.instance;
      window = launched.window;
      allSendAttempts.push(launched.sendAttempts);
      observeErrors(window);
      await resize(instance, window, 1360);
      await window.getByRole('link', { name: '我的项目', exact: true }).click();
      await window.locator(`a[href="/projects/${projectId}"]`).click();
      await window.getByRole('tab', { name: '已定稿', exact: true }).click();
      await window.getByRole('button', { name: `打开创作：${firstTitle}`, exact: true }).click();
      await expect(window.getByRole('textbox', { name: '内容标题', exact: true })).toHaveValue(firstTitle);
      await expect(window.getByRole('textbox', { name: '脚本正文', exact: true })).toHaveValue(laterDraft);
      const restarted = await readCreation(window, projectId, first.item.id);
      expect(restarted.item.finalVersionId).toBe(finalVersion.id);
      expect(restarted.versions).toEqual(draftAfterFinal.versions);
      expect((await readCreation(window, projectId, second.item.id)).item.body).toBe('这是第二条脚本，与第一条内容无关。');

      await window.getByRole('button', { name: /^版本记录(?: · \d+)?$/u }).click();
      const exportedPaths: string[] = [];
      async function exportSnapshot(version: CreationVersion): Promise<void> {
        const versionCard = window.getByRole('article', { name: `版本 v${version.number}`, exact: true });
        await versionCard.getByRole('button', { name: '导出此版本', exact: true }).click();
        const preview = window.getByRole('region', { name: '导出版本预览', exact: true });
        await expect(preview).toBeVisible();
        await expect(preview).toContainText(version.title);
        await expect(preview.locator('pre')).toHaveText(version.body);
        // Preview alone cannot create or replace any project file.
        const beforeConfirm = await snapshotFiles(fixture.project);
        expect(Object.keys(beforeConfirm).filter(path => !Object.hasOwn(originalProject, path)).sort()).toEqual([...exportedPaths].sort());
        const exporting = mutation(window, 'POST', `${versionsPath}/${version.id}/export`);
        await preview.getByRole('button', { name: '确认导出', exact: true }).click();
        const response = await exporting;
        expect(response.ok(), await response.text()).toBe(true);
        const exported = creationExportResponseSchema.parse(await response.json()).data;
        expect(exported.versionId).toBe(version.id);
        expect(exported.path).toMatch(/^AI工作区\//u);
        expect(exportedPaths).not.toContain(exported.path);
        exportedPaths.push(exported.path);
        const bytes = await readFile(join(fixture.project, exported.path), 'utf8');
        expect(bytes).toContain(version.body);
        expect(bytes).not.toContain('这一段仍是未定稿的工作草稿');
      }
      await exportSnapshot(versionOne);
      const firstExportHash = createHash('sha256').update(await readFile(join(fixture.project, exportedPaths[0]!))).digest('hex');
      await exportSnapshot(finalVersion);
      expect(createHash('sha256').update(await readFile(join(fixture.project, exportedPaths[0]!))).digest('hex')).toBe(firstExportHash);

      // Restoring a version edits the working draft; it must not rewrite the final snapshot.
      await window.getByRole('article', { name: '版本 v1', exact: true }).getByRole('button', { name: '载入此版本', exact: true }).click();
      await expect(window.getByRole('textbox', { name: '脚本正文', exact: true })).toHaveValue(firstBody);
      const restored = await expectSaved(window, projectId, first.item.id, firstBody);
      expect(restored.item.finalVersionId).toBe(finalVersion.id);
      expect(restored.versions).toEqual(draftAfterFinal.versions);

      const projectAfter = await snapshotFiles(fixture.project);
      for (const [path, hash] of Object.entries(originalProject)) expect(projectAfter[path], path).toBe(hash);
      expect(Object.keys(projectAfter).filter(path => !Object.hasOwn(originalProject, path)).sort()).toEqual(exportedPaths.sort());
      expect(await snapshotFiles(fixture.vault)).toEqual(originalVault);
      expect(allSendAttempts.flat()).toEqual([]);
      expect(pageErrors).toEqual([]);
      await Promise.all(capabilityResponses);
      const unexpectedErrors = consoleErrors.filter(error => !(expectedCapabilityFailures.has(error.url)
        && error.text === 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)'));
      await info.attach('browser-errors', { body: JSON.stringify({ consoleErrors, expectedUnavailableCapabilities: [...expectedCapabilityFailures], unexpectedErrors }, null, 2), contentType: 'application/json' });
      expect(unexpectedErrors).toEqual([]);
    } finally {
      await instance?.close();
      await rm(fixture.vault, { recursive: true, force: true });
      await rm(fixture.userData, { recursive: true, force: true });
      await rm(fixture.project, { recursive: true, force: true });
    }
  });
}
