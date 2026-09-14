import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createTextPdf } from '../helpers/pdf-fixture.js';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

type FixtureMode = 'development' | 'packaged';
type ProviderScenario = 'archive' | 'summary';

async function makeFixture() {
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  const pdfPath = join(userData, 'assistant-source.pdf');
  const pdf = createTextPdf(['AI_ARCHIVE_ACCEPTANCE']);
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
  for (const path of ['00大脑规则', '01图书馆/来自个人', '01图书馆/小兆clipper', '02知识库', '03大讲堂']) {
    await mkdir(join(vault, path), { recursive: true });
  }
  for (const path of RULE_BUNDLE_SOURCE_PATHS) {
    await mkdir(join(vault, dirname(path)), { recursive: true });
    await writeFile(join(vault, path), '# 隔离测试规则\n保留原文，确认后才执行知识动作。\n');
  }
  await writeFile(pdfPath, pdf);
  return { vault, userData, pdfPath, pdf };
}

async function launch(mode: FixtureMode, fixture: Awaited<ReturnType<typeof makeFixture>>): Promise<ElectronApplication> {
  const launchOptions = mode === 'packaged'
    ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
    : { args: [resolve('dist/electron/main.js')] };
  return electron.launch({
    ...launchOptions,
    env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: fixture.vault, XIAOZHAO_TEST_USER_DATA: fixture.userData }
  });
}

async function installProviderFixture(instance: ElectronApplication, scenario: ProviderScenario): Promise<void> {
  await instance.evaluate((_electron, selectedScenario) => {
    const state = globalThis as unknown as { completionCalls: number; planSent: boolean };
    const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
    state.completionCalls = 0;
    state.planSent = false;
    const stream = (id: string, finishReason: string, delta: Record<string, unknown>, usage: Record<string, unknown>) => new Response(
      `data: ${JSON.stringify({ id, created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id, created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage })}\n\n` +
      'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }
    );
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://api.deepseek.com/models') {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] }), { headers: { 'content-type': 'application/json' } });
      }
      if (url !== 'https://api.deepseek.com/chat/completions') throw new Error('ASSISTANT_TEST_NETWORK_FORBIDDEN');
      const body = JSON.parse(String(init?.body)) as { messages?: unknown };
      state.completionCalls += 1;
      if (selectedScenario === 'summary') {
        return stream(`summary-${state.completionCalls}`, 'stop', { role: 'assistant', content: '这是普通总结，不创建动作计划。' }, { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 });
      }
      if (!state.planSent) {
        const ids = [...JSON.stringify(body.messages ?? {}).matchAll(new RegExp(uuidPattern, 'giu'))].map(match => match[0]);
        const attachmentId = ids.at(-1);
        if (!attachmentId) throw new Error('ASSISTANT_TEST_ATTACHMENT_ID_MISSING');
        state.planSent = true;
        return stream('archive-plan', 'tool_calls', { role: 'assistant', tool_calls: [{ index: 0, id: 'archive-call-1', type: 'function', function: { name: 'archive_attachment', arguments: JSON.stringify({ id: attachmentId }) } }] }, { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 });
      }
      return stream(`archive-text-${state.completionCalls}`, 'stop', { role: 'assistant', content: '归档计划已生成，请确认；尚未写入资料。' }, { prompt_tokens: 40, completion_tokens: 18, total_tokens: 58 });
    };
  }, scenario);
}

async function configureAndOpenAssistant(window: Page): Promise<any> {
  await window.getByRole('link', { name: '设置', exact: true }).click();
  await window.getByLabel('DeepSeek API Key').fill('sk-isolated-assistant-action-plan');
  await window.getByRole('button', { name: '保存密钥', exact: true }).click();
  await expect(window.getByText('密钥已保存，连接尚未验证。')).toBeVisible();
  await window.getByRole('button', { name: '打开问问 AI', exact: true }).click();
  const panel = window.getByRole('complementary', { name: '问问 AI' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('已连接', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  return panel;
}

async function uploadAndPlan(panel: any, pdfPath: string, message: string) {
  await panel.getByLabel('添加 PDF、MD 或 TXT 文件').setInputFiles(pdfPath);
  await expect(panel.getByText(/可阅读/u)).toBeVisible({ timeout: 30_000 });
  await panel.getByLabel('发送给问问的消息').fill(message);
  await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  const plan = panel.getByRole('article', { name: '待确认的归档计划' });
  await expect(plan).toBeVisible({ timeout: 45_000 });
  return plan;
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    const directory = join(root, relative);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) result[child] = createHash('sha256').update(await readFile(join(root, child))).digest('hex');
    }
  }
  await visit('');
  return result;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: explicit archive creates a plan, confirms once, preserves the original and survives reload`, async () => {
    test.setTimeout(120_000);
    const fixture = await makeFixture();
    let instance: ElectronApplication | undefined;
    try {
      instance = await launch(mode, fixture);
      const window = await instance.firstWindow();
      expect(await window.evaluate(() => location.origin)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      await installProviderFixture(instance, 'archive');
      const panel = await configureAndOpenAssistant(window);
      const beforeSend = await snapshotFiles(fixture.vault);
      const plan = await uploadAndPlan(panel, fixture.pdfPath, '请归档这个文件');
      expect(await snapshotFiles(fixture.vault)).toEqual(beforeSend);
      await expect(plan.getByText('尚未写入资料')).toBeVisible();
      await plan.getByRole('button', { name: '确认归档', exact: true }).click();
      await expect(panel.getByRole('dialog', { name: '确认归档' })).toBeVisible();
      await panel.getByRole('dialog', { name: '确认归档' }).getByRole('button', { name: '最终确认归档', exact: true }).click();
      const receipt = panel.getByRole('region', { name: '文件归档结果' });
      await expect(receipt).toBeVisible({ timeout: 45_000 });
      const sourceLink = receipt.getByRole('link', { name: '查看归档资料', exact: true });
      const href = await sourceLink.getAttribute('href');
      expect(href).toBeTruthy();
      const materialPath = new URL(href!, await window.evaluate(() => location.origin)).searchParams.get('path');
      expect(materialPath).toMatch(/^01图书馆\/来自个人\//u);
      const archived = await readFile(join(fixture.vault, materialPath!));
      const originalPath = join(fixture.vault, dirname(materialPath!), '附件', '原件.pdf');
      expect(sha256(await readFile(originalPath))).toBe(sha256(fixture.pdf));
      expect(archived.toString('utf8')).toContain('AI_ARCHIVE_ACCEPTANCE');
      expect(await stat(originalPath)).toBeTruthy();
      await window.reload();
      await expect(window.getByRole('button', { name: '打开问问 AI', exact: true })).toBeVisible();
      await window.getByRole('button', { name: '打开问问 AI', exact: true }).click();
      const reopened = window.getByRole('complementary', { name: '问问 AI' });
      await expect(reopened.getByRole('region', { name: '文件归档结果' })).toHaveCount(1, { timeout: 30_000 });
    } finally {
      await instance?.close();
      await rm(fixture.vault, { recursive: true, force: true });
      await rm(fixture.userData, { recursive: true, force: true });
    }
  });

  test(`${mode}: ordinary summary does not create a plan or change the vault`, async () => {
    test.setTimeout(90_000);
    const fixture = await makeFixture();
    let instance: ElectronApplication | undefined;
    try {
      instance = await launch(mode, fixture); const window = await instance.firstWindow();
      await installProviderFixture(instance, 'summary');
      const panel = await configureAndOpenAssistant(window);
      const before = await snapshotFiles(fixture.vault);
      await panel.getByLabel('添加 PDF、MD 或 TXT 文件').setInputFiles(fixture.pdfPath);
      await expect(panel.getByText(/可阅读/u)).toBeVisible({ timeout: 30_000 });
      await panel.getByLabel('发送给问问的消息').fill('总结一下');
      await panel.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(panel.getByText('这是普通总结，不创建动作计划。')).toBeVisible({ timeout: 45_000 });
      expect(await panel.getByRole('article', { name: '待确认的归档计划' }).count()).toBe(0);
      expect(await snapshotFiles(fixture.vault)).toEqual(before);
    } finally {
      await instance?.close(); await rm(fixture.vault, { recursive: true, force: true }); await rm(fixture.userData, { recursive: true, force: true });
    }
  });

  test(`${mode}: cancelling a plan leaves the vault unchanged`, async () => {
    test.setTimeout(90_000);
    const fixture = await makeFixture();
    let instance: ElectronApplication | undefined;
    try {
      instance = await launch(mode, fixture); const window = await instance.firstWindow();
      await installProviderFixture(instance, 'archive');
      const panel = await configureAndOpenAssistant(window); const before = await snapshotFiles(fixture.vault);
      const plan = await uploadAndPlan(panel, fixture.pdfPath, '请归档这个文件');
      await plan.getByRole('button', { name: '取消', exact: true }).click();
      await expect(plan.getByText('已取消')).toBeVisible({ timeout: 20_000 });
      expect(await snapshotFiles(fixture.vault)).toEqual(before);
    } finally {
      await instance?.close(); await rm(fixture.vault, { recursive: true, force: true }); await rm(fixture.userData, { recursive: true, force: true });
    }
  });

  test(`${mode}: a target conflict makes the plan stale without creating an archive`, async () => {
    test.setTimeout(90_000);
    const fixture = await makeFixture();
    let instance: ElectronApplication | undefined;
    try {
      instance = await launch(mode, fixture); const window = await instance.firstWindow();
      await installProviderFixture(instance, 'archive');
      const panel = await configureAndOpenAssistant(window); const plan = await uploadAndPlan(panel, fixture.pdfPath, '请归档这个文件');
      const target = await plan.getByLabel('归档目标').locator('code').first().innerText();
      await mkdir(join(fixture.vault, target), { recursive: true });
      await plan.getByRole('button', { name: '确认归档', exact: true }).click();
      await panel.getByRole('dialog', { name: '确认归档' }).getByRole('button', { name: '最终确认归档', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('文件或解析结果已变化', { timeout: 30_000 });
      await window.reload(); await window.getByRole('button', { name: '打开问问 AI', exact: true }).click();
      const reopened = window.getByRole('complementary', { name: '问问 AI' });
      await expect(reopened.getByText('文件已变化，未写入')).toBeVisible({ timeout: 30_000 });
      expect(await readdir(join(fixture.vault, target))).toEqual([]);
    } finally {
      await instance?.close(); await rm(fixture.vault, { recursive: true, force: true }); await rm(fixture.userData, { recursive: true, force: true });
    }
  });
}
