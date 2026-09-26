import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { creationDetailResponseSchema, creationListResponseSchema, type CreationDetail } from '../../src/shared/api/project-creations.js';

type Mode = 'development' | 'packaged';
type Fixture = { vault: string; userData: string; project: string };
async function makeFixture(): Promise<Fixture> {
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  const project = await mkdtemp(join(temporary, 'xiaozhao-client-project-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { flag: 'wx', mode: 0o600 });
  for (const path of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂', '.claude/skills']) await mkdir(join(vault, path), { recursive: true });
  for (const path of RULE_BUNDLE_SOURCE_PATHS) { await mkdir(join(vault, dirname(path)), { recursive: true }); await writeFile(join(vault, path), '# 隔离测试规则\n'); }
  await writeFile(join(project, '合成资料.md'), '# 合成项目\n仅供回收恢复测试，保持原文。\n');
  return { vault, userData, project };
}
async function launch(mode: Mode, fixture: Fixture) {
  const instance = await electron.launch({
    ...(mode === 'packaged' ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] } : { args: [resolve('dist/electron/main.js')] }),
    env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: fixture.vault, XIAOZHAO_TEST_USER_DATA: fixture.userData, XIAOZHAO_TEST_PROJECT_ROOT: fixture.project }
  });
  await instance.evaluate(() => { globalThis.fetch = async () => { throw new Error('ISOLATED_CREATION_LIFECYCLE_NO_EXTERNAL_NETWORK'); }; });
  const window = await instance.firstWindow();
  await window.route(/\/api\/v1\/assistant\/messages(?:\?.*)?$/u, route => route.abort('blockedbyclient'));
  return { instance, window };
}
async function readDetail(window: Page, path: string) {
  return creationDetailResponseSchema.parse(await window.evaluate(async path => (await fetch(path)).json(), path)).data;
}
async function readList(window: Page, path: string) {
  return creationListResponseSchema.parse(await window.evaluate(async path => (await fetch(path)).json(), path)).data.items;
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: explicit candidate choices, retry deduplication and recycle/restore survive a full restart`, async ({}, info) => {
    test.setTimeout(150_000);
    const fixture = await makeFixture(); const source = await readFile(join(fixture.project, '合成资料.md'));
    let instance: ElectronApplication | undefined;
    let interceptedSuggestions = 0;
    const pageErrors: string[] = [];
    try {
      let launched = await launch(mode, fixture); instance = launched.instance; let window = launched.window;
      window.on('pageerror', error => pageErrors.push(error.message));
      // Fulfil the only AI-shaped request inside Playwright, before it reaches the server/provider.
      await window.route(/\/api\/v1\/projects\/[^/]+\/creation-suggestions$/u, async route => {
        expect(route.request().method()).toBe('POST'); expect(route.request().postDataJSON().task).toBe('topics'); interceptedSuggestions++;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, data: {
          id: randomUUID(), task: 'topics', reply: '先挑选，再保存。', topics: ['保留的角度', '放弃的角度'].map(title => ({ title, audience: '合成受众', angle: '资料中的真实问题', rationale: '合成测试依据' })), sources: [], profileRevision: 0, createdAt: new Date().toISOString()
        } }) });
      });
      await window.getByRole('link', { name: '我的项目', exact: true }).click();
      await window.getByRole('button', { name: '添加项目', exact: true }).click();
      await window.getByRole('textbox', { name: '项目显示名（可选）', exact: true }).fill('隔离生命周期项目');
      await window.getByRole('button', { name: '确认添加项目', exact: true }).click();
      await expect(window).toHaveURL(/\/projects\/[0-9a-f-]+$/u);
      const projectId = new URL(window.url()).pathname.split('/').at(-1)!;
      const base = `/api/v1/projects/${projectId}/creations`;
      await window.getByRole('button', { name: '策划选题', exact: true }).click();
      await window.getByRole('textbox', { name: '选题要求', exact: true }).fill('提出两个合成测试选题');
      await window.getByRole('button', { name: '根据资料策划', exact: true }).click();
      await expect(window.getByRole('checkbox', { name: '保留选题：保留的角度', exact: true })).not.toBeChecked();
      expect(await readList(window, base)).toEqual([]);
      await window.setViewportSize({ width: 1360, height: 1000 });
      await window.screenshot({ path: info.outputPath('topic-candidates-1360.png'), fullPage: true });
      await window.getByRole('checkbox', { name: '保留选题：保留的角度', exact: true }).check();
      // The server commits once, but the response is lost. Retrying must use the same requestId.
      let dropped = false; let committed: CreationDetail | undefined;
      await window.route(`**${base}`, async route => {
        if (route.request().method() !== 'POST' || dropped) { await route.continue(); return; }
        dropped = true;
        expect(route.request().postDataJSON().requestId).toMatch(/^[0-9a-f-]{36}$/u);
        const response = await route.fetch(); expect(response.ok(), await response.text()).toBe(true);
        committed = creationDetailResponseSchema.parse(await response.json()).data;
        await route.abort('failed');
      });
      await window.getByRole('button', { name: '保存所选（1）', exact: true }).click();
      await expect(window.getByRole('alert')).toBeVisible();
      await expect(window.getByRole('button', { name: '保存所选（1）', exact: true })).toBeEnabled();
      expect(await readList(window, base)).toHaveLength(1);
      await window.getByRole('button', { name: '保存所选（1）', exact: true }).click();
      await expect(window.getByRole('button', { name: '打开创作：保留的角度', exact: true })).toBeVisible();
      const saved = await readList(window, base); expect(saved).toHaveLength(1); expect(saved[0]!.id).toBe(committed!.item.id);
      await expect(window.getByRole('checkbox', { name: '保留选题：放弃的角度', exact: true })).toBeVisible();
      await window.getByRole('button', { name: '放弃剩余建议', exact: true }).click();
      await expect(window.getByRole('region', { name: '待选择的选题', exact: true })).toHaveCount(0);
      await window.getByRole('button', { name: '打开创作：保留的角度', exact: true }).click();
      const itemPath = `${base}/${saved[0]!.id}`;
      const body = '这个正文和版本应在回收、重启、恢复之后完整保留。';
      await window.getByRole('textbox', { name: '脚本正文', exact: true }).fill(body);
      await expect.poll(async () => (await readDetail(window, itemPath)).item.body).toBe(body);
      await window.getByRole('button', { name: '保存版本', exact: true }).click();
      await expect.poll(async () => (await readDetail(window, itemPath)).versions.length).toBe(1);
      const before = await readDetail(window, itemPath);
      await window.getByRole('button', { name: '移入回收站', exact: true }).click();
      const dialog = window.getByRole('dialog', { name: '移入项目回收站', exact: true });
      await window.screenshot({ path: info.outputPath('creation-discard-confirm-1360.png'), fullPage: true });
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      expect((await readDetail(window, itemPath)).item.discardedAt).toBeUndefined();
      await window.getByRole('button', { name: '移入回收站', exact: true }).click();
      await dialog.getByRole('button', { name: '确认移入回收站', exact: true }).click();
      await expect.poll(async () => (await readList(window, `${base}/discarded`)).length).toBe(1);
      await window.getByRole('button', { name: '撤销移入', exact: true }).click();
      await expect.poll(async () => (await readList(window, base)).length).toBe(1);
      await window.getByRole('tab', { name: '创作台', exact: true }).click();
      await window.getByRole('button', { name: '移入回收站：保留的角度', exact: true }).click();
      await dialog.getByRole('button', { name: '确认移入回收站', exact: true }).click();
      await expect.poll(async () => (await readList(window, base)).length).toBe(0);
      await instance.close(); instance = undefined;
      launched = await launch(mode, fixture); instance = launched.instance; window = launched.window;
      window.on('pageerror', error => pageErrors.push(error.message));
      // No further AI-shaped request is allowed after restart.
      await window.route(/\/api\/v1\/projects\/[^/]+\/creation-suggestions$/u, route => route.abort('blockedbyclient'));
      await window.getByRole('link', { name: '我的项目', exact: true }).click();
      await window.locator(`a[href="/projects/${projectId}"]`).click();
      await expect(window.getByRole('region', { name: '待选择的选题', exact: true })).toHaveCount(0);
      await window.getByRole('tab', { name: '回收站', exact: true }).click();
      await expect(window.getByRole('button', { name: '恢复创作：保留的角度', exact: true })).toBeVisible();
      await window.setViewportSize({ width: 720, height: 1000 });
      await window.screenshot({ path: info.outputPath('creation-trash-720.png'), fullPage: true });
      await window.getByRole('button', { name: '恢复创作：保留的角度', exact: true }).click();
      await expect.poll(async () => (await readList(window, base)).length).toBe(1);
      await window.getByRole('tab', { name: '创作台', exact: true }).click();
      await window.getByRole('button', { name: '打开创作：保留的角度', exact: true }).click();
      await expect(window.getByRole('textbox', { name: '脚本正文', exact: true })).toHaveValue(body);
      const restored = await readDetail(window, itemPath);
      expect(restored.item.discardedAt).toBeUndefined(); expect(restored.versions).toEqual(before.versions); expect(restored.messages).toEqual(before.messages);
      expect(await readList(window, `${base}/discarded`)).toEqual([]);
      expect(await readFile(join(fixture.project, '合成资料.md'))).toEqual(source);
      expect(await readdir(fixture.project)).toEqual(['合成资料.md']);
      expect(interceptedSuggestions).toBe(1); expect(pageErrors).toEqual([]);
    } finally {
      await instance?.close();
      await rm(fixture.vault, { recursive: true, force: true }); await rm(fixture.userData, { recursive: true, force: true }); await rm(fixture.project, { recursive: true, force: true });
    }
  });
}
