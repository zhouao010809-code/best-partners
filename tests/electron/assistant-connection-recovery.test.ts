import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

type RecoveryFixtureState = { credentialReadFails: boolean; completionCalls: number };

async function makeFixture() {
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  const project = await mkdtemp(join(temporary, 'xiaozhao-client-project-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
  for (const directory of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂', '.claude/skills']) {
    await mkdir(join(vault, directory), { recursive: true });
  }
  for (const path of RULE_BUNDLE_SOURCE_PATHS) {
    await mkdir(join(vault, dirname(path)), { recursive: true });
    await writeFile(join(vault, path), '# 隔离测试规则\n保留项目原文，不自动写入。\n');
  }
  await writeFile(join(project, 'brief.md'), '# 连接恢复测试项目\n这是合成项目资料。\n');
  return { vault, userData, project };
}

async function installRecoveryFixture(instance: ElectronApplication): Promise<void> {
  await instance.evaluate(({ safeStorage }) => {
    const state = globalThis as unknown as RecoveryFixtureState;
    state.credentialReadFails = false;
    state.completionCalls = 0;
    const decryptString = safeStorage.decryptString.bind(safeStorage);
    safeStorage.decryptString = (encrypted: Buffer) => {
      if (state.credentialReadFails) throw new Error('ISOLATED_TEMPORARY_KEYCHAIN_READ_FAILURE');
      return decryptString(encrypted);
    };
    // Exercise the real local key/settings/provider routes; only the external
    // model transport is replaced. This process never calls a real model.
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.deepseek.com/models') {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] }),
          { headers: { 'content-type': 'application/json' } });
      }
      if (url !== 'https://api.deepseek.com/chat/completions') throw new Error('RECOVERY_TEST_NETWORK_FORBIDDEN');
      state.completionCalls += 1;
      const chunk = { id: 'connection-recovery', created: 1, model: 'deepseek-v4-pro' };
      return new Response(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: '连接已恢复，这是项目模式的测试回答。' }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } })}\n\n` +
        'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }
      );
    };
  });
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: an open project assistant recovers temporary credential failures without losing its draft`, async ({}, info) => {
    test.setTimeout(120_000);
    const fixture = await makeFixture();
    let instance: ElectronApplication | undefined;
    try {
      instance = await electron.launch({
        ...(mode === 'packaged'
          ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
          : { args: [resolve('dist/electron/main.js')] }),
        env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: fixture.vault,
          XIAOZHAO_TEST_USER_DATA: fixture.userData, XIAOZHAO_TEST_PROJECT_ROOT: fixture.project }
      });
      await installRecoveryFixture(instance);
      const window = await instance.firstWindow();
      const sentMessages: unknown[] = [];
      window.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/assistant/messages') {
          sentMessages.push(request.postDataJSON());
        }
      });

      await window.getByRole('link', { name: '设置', exact: true }).click();
      await window.getByRole('button', { name: '打开问问 AI', exact: true }).click();
      const panel = window.getByRole('complementary', { name: '问问 AI' });
      const send = panel.getByRole('button', { name: '发送消息', exact: true });
      await expect(panel.getByText('待连接', { exact: true }).first()).toBeVisible();
      await expect(send).toBeDisabled();

      // Saving while the panel stays open must update its connection status.
      await window.getByLabel('DeepSeek API Key').fill('sk-isolated-connection-recovery');
      await window.getByRole('button', { name: '保存密钥', exact: true }).click();
      await expect(panel.getByText('已连接', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      expect(sentMessages).toEqual([]);
      expect(await instance.evaluate(() => (globalThis as unknown as RecoveryFixtureState).completionCalls)).toBe(0);

      await window.getByRole('link', { name: '我的项目', exact: true }).click();
      await window.getByRole('button', { name: '添加项目', exact: true }).click();
      await window.getByRole('textbox', { name: '项目显示名（可选）' }).fill('连接恢复测试项目');
      await window.getByRole('button', { name: '确认添加项目', exact: true }).click();
      await expect(window).toHaveURL(/\/projects\/[0-9a-f-]+$/u);
      const projectId = new URL(window.url()).pathname.split('/').at(-1)!;
      await expect(panel.getByRole('heading', { name: '项目模式 · 连接恢复测试项目', exact: true })).toBeVisible();
      await expect(panel.getByText('项目语料：已连接', { exact: true })).toBeVisible();

      const input = panel.getByLabel('发送给问问的消息');
      const draft = '请解释这个项目的目标，保留我的草稿。';
      await input.fill(draft);
      await expect(send).toBeEnabled();
      const encryptedBefore = await readFile(join(fixture.userData, 'model-credentials', 'deepseek-key.enc'));
      const projectBefore = await readFile(join(fixture.project, 'brief.md'));

      // A settings update rechecks credentials. Keep the failure active until
      // the failed state is visible so concurrent provider probes cannot heal it.
      await instance.evaluate(() => { (globalThis as unknown as RecoveryFixtureState).credentialReadFails = true; });
      await window.evaluate(() => window.dispatchEvent(new Event('xiaozhao:model-settings-updated')));
      const retry = panel.getByRole('button', { name: '重新检查连接', exact: true });
      await expect(retry).toBeVisible();
      await expect(send).toBeDisabled();
      await expect(input).toHaveValue(draft);
      await expect(panel.getByRole('button', { name: '模型设置', exact: true })).toHaveAttribute('aria-expanded', 'false');
      expect(sentMessages).toEqual([]);
      await expect(retry).toBeInViewport();
      await window.screenshot({ path: info.outputPath('connection-recovery.png') });
      await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 800));
      await expect(retry).toBeInViewport();
      await expect(send).toBeInViewport();
      await window.screenshot({ path: info.outputPath('connection-recovery-compact.png') });
      await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1360, 900));

      await instance.evaluate(() => { (globalThis as unknown as RecoveryFixtureState).credentialReadFails = false; });
      await retry.click();
      await expect(panel.getByText('已连接', { exact: true }).first()).toBeVisible();
      await expect(send).toBeEnabled();
      await expect(input).toHaveValue(draft);
      await expect(retry).toHaveCount(0);
      expect(await readFile(join(fixture.userData, 'model-credentials', 'deepseek-key.enc'))).toEqual(encryptedBefore);
      expect(sentMessages).toEqual([]);
      expect(await instance.evaluate(() => (globalThis as unknown as RecoveryFixtureState).completionCalls)).toBe(0);

      await send.click();
      await expect(panel.getByText('连接已恢复，这是项目模式的测试回答。', { exact: true })).toBeVisible({ timeout: 30_000 });
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({ message: draft, scope: 'project', projectId, projectRevision: expect.any(Number) });
      expect(await instance.evaluate(() => (globalThis as unknown as RecoveryFixtureState).completionCalls)).toBe(1);
      expect(await readFile(join(fixture.project, 'brief.md'))).toEqual(projectBefore);
    } finally {
      await instance?.close();
      await rm(fixture.vault, { recursive: true, force: true });
      await rm(fixture.userData, { recursive: true, force: true });
      await rm(fixture.project, { recursive: true, force: true });
    }
  });
}
