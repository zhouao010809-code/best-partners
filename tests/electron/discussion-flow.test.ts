import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CURRENT_VAULT_LAYOUT } from '../../src/shared/domain/vault-layout.js';
import type { DiscussionAction, DiscussionSession } from '../../src/shared/api/discussion.js';

const sourcePath = '01图书馆/02个人资料/碎片灵感/练习观察.md';
const knowledgeTitle = '先记录学生的具体动作';
const oldChat = '02日记本/2026/2026-10/2026-10-17/聊天记录｜2026-10-17_08：40-09：00.md';
const oldBody = '---\n类型: 聊天记录\n开始时间: 2026-10-17-08:40\n关键词: [课堂里的旧问题]\n关联资料: []\n关联日记: []\n---\n\n## 小兆\n\n我上次想聊的是课后反馈。\n';
const observation = '我想先记录学生的具体动作。';

async function installModel(app: ElectronApplication) {
  await app.evaluate((_electron, { sourcePath, knowledgeTitle, observation }) => {
    globalThis.fetch = async (url, init) => {
      if (String(url) === 'https://api.deepseek.com/models') {
        return Response.json({ data: [{ id: 'deepseek-v4-pro' }] });
      }
      if (String(url) !== 'https://api.deepseek.com/chat/completions') throw new Error('Unexpected network request');
      const request = JSON.parse(String(init?.body));
      const instruction = request.messages.find((m: { role: string }) => m.role === 'system')?.content ?? '';
      let content = '你在教室里观察到了什么？';
      if (instruction.includes('proposals')) {
        content = JSON.stringify({ keywords: ['观察'], proposals: [{ path: sourcePath, status: '部分探讨完成', covered: '观察动作', remaining: '回看记录' }] });
      } else if (instruction.includes('existingPath')) {
        content = JSON.stringify({ knowledge: [{ title: knowledgeTitle, directory: '03知识库/教学', existingPath: null, coreContent: observation, body: observation, keywords: ['观察'], materialPaths: [sourcePath] }] });
      } else if (instruction.includes('topics')) {
        content = JSON.stringify({ body: '# 小兆日记\n\n' + observation, keywords: ['观察'], topics: [{ topic: '记录动作', keywords: ['观察'] }], materialPaths: [sourcePath] });
      }
      const packet = (delta: object, reason: string | null) => 'data: ' + JSON.stringify({
        id: 'fixture', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason: reason }]
      }) + '\n\n';
      return new Response(packet({ role: 'assistant', content }, null) + packet({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
  }, { sourcePath, knowledgeTitle, observation });
}

async function post<T>(window: Page, path: string, body: object): Promise<T> {
  return window.evaluate(async ({ path, body }) => {
    const bootstrap = await (await fetch('/api/v1/bootstrap')).json();
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': bootstrap.data.csrfToken }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(payload.error));
    return payload.data;
  }, { path, body });
}

test('packaged current vault uses actual discussion progress across a restart, then saves one linked diary and knowledge note', async () => {
  const temp = await realpath(tmpdir());
  const vault = await mkdtemp(join(temp, 'xiaozhao-vault-'));
  const profile = await mkdtemp(join(temp, 'xiaozhao-user-data-'));
  const launch = () => electron.launch({
    executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'),
    args: [], env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vault, XIAOZHAO_TEST_USER_DATA: profile }
  });
  let app: ElectronApplication | undefined;
  try {
    for (const name of ['01图书馆/00信息入口', dirname(sourcePath), '02日记本', '03知识库/教学', '04大讲堂']) await mkdir(join(vault, name), { recursive: true });
    for (const name of [...CURRENT_VAULT_LAYOUT.rulePaths, '00大脑规则/Skills/xiaozhao-discussion/SKILL.md', '00大脑规则/文档规范/聊天记录.md', '00大脑规则/文档规范/小兆日记.md']) {
      await mkdir(dirname(join(vault, name)), { recursive: true });
      await writeFile(join(vault, name), '本库按真实交流整理日记。');
    }
    await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
    const source = '---\n类型: 原始资料\n标题: 练习观察\n资料来源: 碎片灵感\n探讨状态: 未探讨\n关联日记: []\n---\n把课堂上的观察记录下来。\n';
    await writeFile(join(vault, sourcePath), source);
    await mkdir(dirname(join(vault, oldChat)), { recursive: true });
    await writeFile(join(vault, oldChat), oldBody);
    app = await launch();
    let window = await app.firstWindow();
    await installModel(app);
    const act = (action: DiscussionAction) => post<DiscussionSession>(window, '/api/v1/discussions/actions', action);
    await expect(window.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '探讨', exact: true })).toBeVisible();
    await expect(window.getByRole('link', { name: '提炼队列', exact: true })).toHaveCount(0);
    const legacy = await window.evaluate(async () => (await fetch('/api/v1/extraction-queue')).status);
    expect(legacy).toBe(404);
    await post(window, '/api/v1/deepseek/key', { apiKey: 'sk-discussion-fixture' });
    await window.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '探讨', exact: true }).click();
    await window.getByRole('checkbox', { name: /练习观察/ }).check();
    await window.getByRole('button', { name: '准备资料' }).click();
    await window.getByRole('button', { name: '开始探讨', exact: true }).click();
    const id = new URL(window.url()).searchParams.get('id')!;
    await window.getByLabel('说说你的想法').fill(observation);
    await window.getByRole('button', { name: '发送', exact: true }).click();
    await expect(window.getByLabel('探讨对话')).toContainText(observation);
    await window.getByRole('button', { name: '暂停探讨' }).click();
    await expect(window.getByRole('combobox', { name: '探讨状态' })).toHaveValue('部分探讨完成');
    expect(await readFile(join(vault, sourcePath), 'utf8')).toBe(source);
    await window.getByRole('button', { name: '确认进度', exact: true }).click();
    await expect.poll(() => readFile(join(vault, sourcePath), 'utf8')).toContain('部分探讨完成');
    await app.close(); app = undefined;
    app = await launch(); window = await app.firstWindow();
    await installModel(app);
    const nav = window.getByRole('navigation', { name: '主导航' });
    await nav.getByRole('link', { name: '探讨', exact: true }).click();
    await window.getByRole('button', { name: /练习观察.*已暂停/ }).click();
    await expect(window.getByLabel('探讨对话')).toContainText(observation);
    await window.getByRole('button', { name: '继续探讨' }).click();
    await window.getByRole('button', { name: '整理小兆日记' }).click();
    await expect(window.getByRole('link', { name: knowledgeTitle })).toBeVisible();
    const saved = await act({ type: 'open', id });
    expect(saved.diaryMarkdown).toContain(observation);
    expect(saved.knowledgePaths).toHaveLength(1);
    expect(await readFile(join(vault, saved.chatPath!), 'utf8')).toContain(observation);
    expect(await readFile(join(vault, saved.diaryPath!), 'utf8')).toContain(knowledgeTitle);
    expect(await readFile(join(vault, saved.knowledgePaths[0]!), 'utf8')).toContain('小兆日记｜');
    expect(await readFile(join(vault, sourcePath), 'utf8')).toContain('部分探讨完成');
    await nav.getByRole('link', { name: '知识库', exact: true }).click();
    await window.getByRole('button', { name: '打开 教学 收藏册' }).click();
    await expect(window.getByText(knowledgeTitle, { exact: true }).first()).toBeVisible();
    await nav.getByRole('link', { name: '探讨', exact: true }).click();
    await window.getByRole('button', { name: /课堂里的旧问题/ }).click();
    const reader = window.getByLabel('历史聊天详情');
    await expect(reader).toContainText('我上次想聊的是课后反馈。');
    await reader.getByRole('button', { name: '接着聊' }).click();
    await expect(window.getByLabel('说说你的想法')).toBeVisible();
    const continuedId = new URL(window.url()).searchParams.get('id');
    expect(continuedId).toBeTruthy();
    expect(continuedId).not.toBe(id);
    expect(await readFile(join(vault, oldChat), 'utf8')).toBe(oldBody);
  } finally {
    await app?.close();
    await rm(vault, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
});
