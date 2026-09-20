import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

type FixtureMode = 'development' | 'packaged';

const skills = [
  {
    directory: 'article-structure',
    name: '公众号文章结构',
    marker: 'SKILL_METHOD_STRUCTURE_ONLY',
    method: '先确定唯一核心观点，再组织问题、证据和结论。'
  },
  {
    directory: 'article-polish',
    name: '公众号文章润色',
    marker: 'SKILL_METHOD_POLISH_ONLY',
    method: '先保留原意，再压缩重复表达并改善段落衔接。'
  }
] as const;

function skillBytes(skill: typeof skills[number]): Buffer {
  return Buffer.from([
    '---',
    `name: ${skill.name}`,
    'description: 把选题处理成清晰的公众号文章',
    '---',
    '',
    `# ${skill.name}`,
    '',
    skill.marker,
    skill.method,
    ''
  ].join('\n'), 'utf8');
}

async function makeFixture() {
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-skill-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-skill-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
  for (const directory of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂']) {
    await mkdir(join(vault, directory), { recursive: true });
  }
  for (const path of RULE_BUNDLE_SOURCE_PATHS) {
    await mkdir(join(vault, dirname(path)), { recursive: true });
    await writeFile(join(vault, path), '# 隔离测试规则\n只读检索，写入前必须确认。\n');
  }
  const skillsRoot = join(vault, '.claude', 'skills', '内容创作');
  const originals = new Map<string, Buffer>();
  for (const skill of skills) {
    const bytes = skillBytes(skill);
    const path = join(skillsRoot, skill.directory, 'SKILL.md');
    originals.set(skill.name, bytes);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return { vault, userData, skillsRoot, originals };
}

async function launch(mode: FixtureMode, fixture: Awaited<ReturnType<typeof makeFixture>>): Promise<ElectronApplication> {
  const options = mode === 'packaged'
    ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
    : { args: [resolve('dist/electron/main.js')] };
  return electron.launch({
    ...options,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      XIAOZHAO_TEST_VAULT_ROOT: fixture.vault,
      XIAOZHAO_TEST_USER_DATA: fixture.userData
    }
  });
}

async function installProviderFixture(instance: ElectronApplication): Promise<void> {
  await instance.evaluate(() => {
    const state = globalThis as unknown as { completionCalls: number; completionBodies: string[] };
    state.completionCalls = 0;
    state.completionBodies = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://api.deepseek.com/models') {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] }), { headers: { 'content-type': 'application/json' } });
      }
      if (url !== 'https://api.deepseek.com/chat/completions') throw new Error('SKILL_INVOCATION_TEST_NETWORK_FORBIDDEN');
      state.completionCalls += 1;
      state.completionBodies.push(String(init?.body ?? ''));
      const chunk = (delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, unknown>) =>
        `data: ${JSON.stringify({ id: 'skill-answer', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`;
      return new Response(
        chunk({ role: 'assistant', content: '已按确认的本地 Skill 完成文章草稿。' }, null)
        + chunk({}, 'stop', { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 })
        + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      );
    };
  });
}

async function providerState(instance: ElectronApplication): Promise<{ completionCalls: number; completionBodies: string[] }> {
  return instance.evaluate(() => {
    const state = globalThis as unknown as { completionCalls: number; completionBodies: string[] };
    return { completionCalls: state.completionCalls, completionBodies: state.completionBodies };
  });
}

async function configureAndOpenAssistant(window: Page) {
  await window.getByRole('link', { name: '设置', exact: true }).click();
  await window.getByLabel('DeepSeek API Key').fill('sk-isolated-skill-invocation');
  await window.getByRole('button', { name: '保存密钥', exact: true }).click();
  await expect(window.getByText('密钥已保存，连接尚未验证。')).toBeVisible();
  await window.getByRole('button', { name: '打开问问 AI', exact: true }).click();
  const panel = window.getByRole('complementary', { name: '问问 AI' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('已连接', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  return panel;
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: confirms one local Skill before the only model call and never rewrites Skill files`, async () => {
    test.setTimeout(120_000);
    const fixture = await makeFixture();
    let instance: ElectronApplication | undefined;
    try {
      instance = await launch(mode, fixture);
      const window = await instance.firstWindow();
      await installProviderFixture(instance);
      const panel = await configureAndOpenAssistant(window);
      await panel.getByLabel('发送给问问的消息').fill('把这个选题写成公众号文章');
      await panel.getByRole('button', { name: '发送消息', exact: true }).click();

      const recommendation = panel.getByLabel('Skill 推荐');
      await expect(recommendation).toBeVisible({ timeout: 20_000 });
      const selectedName = recommendation.locator('.assistant-skill-card__candidate > strong');
      const initialName = (await selectedName.innerText()).trim();
      expect(skills.map(skill => skill.name)).toContain(initialName);
      expect((await providerState(instance)).completionCalls).toBe(0);

      await recommendation.getByRole('button', { name: '换一个', exact: true }).click();
      await expect(selectedName).not.toHaveText(initialName);
      const confirmedName = (await selectedName.innerText()).trim();
      const confirmedSkill = skills.find(skill => skill.name === confirmedName);
      const skippedSkill = skills.find(skill => skill.name !== confirmedName);
      expect(confirmedSkill).toBeTruthy();
      expect(skippedSkill).toBeTruthy();
      expect((await providerState(instance)).completionCalls).toBe(0);

      await recommendation.getByRole('button', { name: '使用此 Skill', exact: true }).click();
      await expect(panel.getByText('已按确认的本地 Skill 完成文章草稿。', { exact: true })).toBeVisible({ timeout: 45_000 });
      await expect(panel.getByText(new RegExp(`已使用 Skill：${confirmedName}`, 'u'))).toBeVisible();
      const captured = await providerState(instance);
      expect(captured.completionCalls).toBe(1);
      expect(captured.completionBodies).toHaveLength(1);
      expect(captured.completionBodies[0]).toContain('BEGIN USER-CONFIRMED LOCAL SKILL');
      expect(captured.completionBodies[0]).toContain(confirmedSkill!.marker);
      expect(captured.completionBodies[0]).not.toContain(skippedSkill!.marker);

      await instance.close();
      instance = undefined;
      for (const skill of skills) {
        await expect(readFile(join(fixture.skillsRoot, skill.directory, 'SKILL.md'))).resolves.toEqual(fixture.originals.get(skill.name));
      }
    } finally {
      await instance?.close();
      await rm(fixture.vault, { recursive: true, force: true });
      await rm(fixture.userData, { recursive: true, force: true });
    }
  });
}
