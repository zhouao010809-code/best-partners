// Prevents losing a persistent task or its question/result across an App restart.
// Every hub request uses a fake local server and temporary configuration.
import { _electron as electron, expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

type Rule = { name: string; cwd: string; to: string; when: { source?: string; types?: string[]; cron?: string } };
type Run = { id: number; rule: string; state: string; summary: string; createdAt: string; finishedAt: string | null };
type Card = { id: number; rule: string; kind: string; state: string; title: string; text: string; options: string[] };

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: automatic task asks, resumes and survives an App restart`, async ({}, info) => {
    test.setTimeout(120_000);
    const temporary = await realpath(tmpdir());
    const vaultRoot = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
    const userDataDir = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
    const hubHome = await mkdtemp(join(temporary, 'xiaozhao-autoloop-'));
    const receivedEvents: unknown[] = [];
    const receivedAnswers: unknown[] = [];
    let runs: Run[] = [];
    let cards: Card[] = [];
    let unavailable = false;
    let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
    const rules = async () => JSON.parse(await readFile(join(hubHome, 'rules.json'), 'utf8')) as { rules: Rule[]; agents: Record<string, unknown> };
    const hub = createServer(async (request, response) => {
      const respond = (data: unknown, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(data));
      };
      try {
        if (unavailable) { respond({ error: 'test hub unavailable' }, 503); return; }
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const expected = url.pathname === '/v1/events' ? 'test-source-key' : 'test-owner-key';
        if (url.pathname !== '/healthz' && request.headers.authorization !== `Bearer ${expected}`) {
          respond({ error: 'unauthorized fixture request' }, 401); return;
        }
        const config = await rules();
        if (url.pathname === '/healthz') { respond({ ok: true }); return; }
        if (url.pathname === '/v1/state') {
          respond({ lines: config.rules.map(rule => ({ id: rule.name, name: rule.name, agent: rule.to, source: rule.when.source ?? 'schedule', types: rule.when.types ?? [] })),
            agents: Object.entries(config.agents).map(([id, agent]) => ({ id, ...(agent as object), online: true })),
            now: new Date().toISOString(), timezone: 'Asia/Shanghai', totals: { doneToday: 1 }, spending: { today: { rounds: 1, tokens: 123, cost: 0, missingCost: 1, missingTokens: 0 } }, sources: [{ id: 'local', name: '本机' }], channels: [], elsewhere: [], unrouted: [], runs, cards: cards.filter(card => card.state === 'open'), recentCards: cards.filter(card => card.state !== 'open'), nextBefore: null });
          return;
        }
        let body = '';
        for await (const chunk of request) body += chunk;
        const input = body ? JSON.parse(body) as Record<string, unknown> : {};
        if (url.pathname === '/v1/events') {
          const rule = config.rules.find(item => item.when.types?.includes(String(input.type)));
          if (!rule) { respond({ event: 1, duplicate: false, routed: [] }); return; }
          receivedEvents.push(input);
          runs = [{ id: 1, rule: rule.name, state: 'claimed', summary: '', createdAt: new Date().toISOString(), finishedAt: null }];
          respond({ event: 1, duplicate: false, routed: [rule.name] }); return;
        }
        if (url.pathname === '/v1/cards/7/answer') {
          receivedAnswers.push(input);
          cards = cards.map(card => ({ ...card, state: 'answered' }));
          const rule = config.rules.find(item => item.name === runs[0]?.rule)!;
          await writeFile(join(rule.cwd, 'result.md'), '# 已完成\n\n你选择了简短版本。<script>window.__injected = true</script>\n');
          runs = [{ id: 2, rule: rule.name, state: 'done', summary: '已按简短版本整理完成。', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }, ...runs];
          respond({ ok: true }); return;
        }
        if (/^\/v1\/runs\/\d+\/why$/u.test(url.pathname)) { respond([{ seq: 10, at: new Date().toISOString(), type: 'result', changes: [{ table: 'runs', row: { id: 2, state: 'done', summary: '追溯测试结果' } }] }]); return; }
        respond({ error: `Unexpected fixture route: ${url.pathname}` }, 404);
      } catch (error) {
        respond({ error: String(error) }, 500);
      }
    });
    try {
      await writeFile(join(vaultRoot, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
      for (const directory of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂']) await mkdir(join(vaultRoot, directory), { recursive: true });
      for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vaultRoot, path), '# Fixture rule\n');
      await new Promise<void>(accept => hub.listen(0, '127.0.0.1', accept));
      const port = (hub.address() as { port: number }).port;
      await writeFile(join(hubHome, 'config.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, owner: 'test-owner-key', source: { name: 'local', key: 'test-source-key' }, worker: { name: 'fixture-worker', key: 'test-worker-key' } }));
      await writeFile(join(hubHome, 'rules.json'), JSON.stringify({ sources: { local: { name: 'local' } }, agents: { codex: { name: 'Codex', worker: 'fixture-worker', use: 'codex' } }, channels: {}, rules: [] }));
      const fixtureApp = join(hubHome, 'app');
      await mkdir(join(fixtureApp, 'protocol'), { recursive: true });
      await writeFile(join(fixtureApp, 'protocol', 'rules.ts'), 'export function parseRules(text) { const doc = JSON.parse(text); if (!doc.rules) throw new Error("缺少规则"); return doc; }');
      await mkdir(join(hubHome, 'runtime', 'node-v24-fixture', 'bin'), { recursive: true });
      await symlink(process.execPath, join(hubHome, 'runtime', 'node-v24-fixture', 'bin', 'node'));
      const templateRoot = join(fixtureApp, 'examples', 'recipes', 'morning-brief');
      await mkdir(templateRoot, { recursive: true });
      await writeFile(join(templateRoot, 'README.md'), '# 晨间简报\n这是隔离的模板说明。');
      await writeFile(join(templateRoot, 'rules.json'), JSON.stringify({ sources: { local: { name: 'local' } }, agents: { codex: { name: 'Codex', worker: 'fixture-worker', use: 'codex' } }, rules: [{ name: '模板草稿', when: { cron: '0 9 * * *' }, to: 'codex', cwd: hubHome, prompt: '生成简报', tell: 'never' }] }));

      // A single card fits above the fold and would hide a detail rendered after the full catalog.
      const recipes = join(fixtureApp, 'examples', 'recipes');
      for (const id of ['github-issues', 'ops-alerts', 'feedback', 'website-watch', 'feishu-brief', 'browser-handoff']) {
        const folder = join(recipes, id);
        await mkdir(folder);
        await writeFile(join(folder, 'README.md'), `# ${id} fixture`);
        await writeFile(join(folder, 'rules.json'), await readFile(join(templateRoot, 'rules.json')));
      }
      const deliverySkill = join(fixtureApp, 'skills', 'agent-autoloop');
      await mkdir(deliverySkill, { recursive: true });
      await writeFile(join(deliverySkill, 'SKILL.md'), '## 交付流水线\nfixture');
      const launch = () => electron.launch({
        ...(mode === 'packaged'
          ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
          : { args: [resolve('dist/electron/main.js')] }),
        env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vaultRoot, XIAOZHAO_TEST_USER_DATA: userDataDir, XIAOZHAO_TEST_AUTOLOOP_HOME: hubHome }
      });
      instance = await launch();
      let window = await instance.firstWindow();
      await window.getByRole('link', { name: '自动任务', exact: true }).click({ timeout: 10_000 });
      await window.getByLabel('任务名称', { exact: true }).fill('问答闭环验证');
      await window.getByLabel('任务要求', { exact: true }).fill('先问我需要简短版还是详细版，收到回答后完成结果。');
      await window.getByLabel('资料范围', { exact: true }).selectOption('vault');
      await window.getByLabel('模型（可选）', { exact: true }).fill('fixture-model');
      await window.getByRole('button', { name: '提交任务', exact: true }).click();
      await expect.poll(() => receivedEvents.length).toBe(1);
      await expect(window.getByText('执行中', { exact: true }).first()).toBeVisible();
      runs[0] = { ...runs[0]!, state: 'done', summary: '等待选择输出长度。', finishedAt: new Date().toISOString() };
      cards = [{ id: 7, rule: runs[0]!.rule, kind: 'ask', state: 'open', title: '需要哪种版本？', text: '选择长度后继续。', options: ['简短版本', '详细版本'] }];
      await expect(window.getByRole('heading', { name: '需要哪种版本？' })).toBeVisible({ timeout: 15_000 });
      await window.screenshot({ path: info.outputPath('autoloop-question.png') });
      await window.getByRole('button', { name: '简短版本', exact: true }).click();
      await expect.poll(() => receivedAnswers.length).toBe(1);
      expect(receivedAnswers[0]).toMatchObject({ choice: 0 });
      await expect(window.getByRole('heading', { name: '任务结果', exact: true })).toBeVisible();
      await expect(window.getByText(/你选择了简短版本。/u)).toBeVisible();
      expect(await window.evaluate(() => '__injected' in window)).toBe(false);
      expect(receivedEvents).toHaveLength(1);
      await window.screenshot({ path: info.outputPath('autoloop-result.png') });
      await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 800));
      await window.getByRole('heading', { name: '任务结果', exact: true }).scrollIntoViewIfNeeded();
      await window.screenshot({ path: info.outputPath('autoloop-compact.png') });
      expect(await window.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await instance.close();
      instance = await launch();
      window = await instance.firstWindow();
      await window.getByRole('link', { name: '自动任务', exact: true }).click({ timeout: 10_000 });
      await expect(window.getByText('问答闭环验证', { exact: true }).first()).toBeVisible();
      await window.getByText('问答闭环验证', { exact: true }).first().click();
      await expect(window.getByText(/你选择了简短版本。/u)).toBeVisible();
      expect(receivedEvents).toHaveLength(1);
      await window.getByRole('tab', { name: '自动规则', exact: true }).click();
      await window.getByRole('button', { name: '新建规则', exact: true }).click();
      await window.getByLabel('规则名称', { exact: true }).fill('每日测试规则');
      await window.getByLabel('工作目录', { exact: true }).fill(hubHome);
      await window.getByLabel('规则任务要求', { exact: true }).fill('只处理隔离测试资料。');
      await window.getByRole('button', { name: '保存规则', exact: true }).click();
      await expect(window.getByRole('button', { name: '暂停 每日测试规则', exact: true })).toBeVisible();
      await window.getByRole('button', { name: '暂停 每日测试规则', exact: true }).click();
      await expect(window.getByRole('button', { name: '启用 每日测试规则', exact: true })).toBeVisible();
      expect((await rules()).rules.some(rule => rule.name === '每日测试规则')).toBe(false);
      await window.getByRole('button', { name: '启用 每日测试规则', exact: true }).click();
      await expect(window.getByRole('button', { name: '暂停 每日测试规则', exact: true })).toBeVisible();
      await window.screenshot({ path: info.outputPath('autoloop-rules.png') });
      await window.getByRole('tab', { name: '运行总览', exact: true }).click();
      await window.getByRole('button', { name: '追溯运行 2', exact: true }).click();
      await expect(window.getByText(/追溯测试结果/u)).toBeVisible();
      await window.screenshot({ path: info.outputPath('autoloop-overview.png') });
      await window.getByRole('tab', { name: '场景模板', exact: true }).click();
      const cardsGrid = window.locator('.autoloop-template-grid');
      await expect(cardsGrid.getByRole('button')).toHaveCount(8);
      const names = await cardsGrid.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')!.slice('查看 '.length)));
      for (const name of names) {
        const openTemplate = window.getByRole('button', { name: `查看 ${name}`, exact: true });
        const clickTarget = names.indexOf(name) % 2 === 0 ? openTemplate.getByText(name, { exact: true }) : openTemplate.getByText(/查看与配置/u);
        await clickTarget.click();
        await expect(window.getByRole('textbox', { name: '模板配置', exact: true })).toBeAttached();
        await expect(window.getByRole('heading', { name, exact: true }).last()).toBeInViewport();
        const back = window.getByRole('button', { name: /返回.*模板|返回.*列表/u });
        await expect(back).toBeInViewport();
        await expect.poll(() => back.evaluate(element => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        })).toBe(true);
        await back.click();
        await expect(openTemplate).toBeInViewport();
      }
      await window.getByRole('button', { name: '查看 晨间简报', exact: true }).click();
      await expect(window.getByRole('textbox', { name: '模板配置', exact: true })).toBeVisible();
      await window.getByRole('button', { name: '准备场景文件', exact: true }).click();
      await expect(window.getByRole('button', { name: '导入为暂停规则', exact: true })).toBeEnabled();
      await window.getByRole('button', { name: '导入为暂停规则', exact: true }).click();
      await expect(window.getByText('模板已导入为暂停规则。到“自动规则”核对后启用。', { exact: true })).toBeVisible();
      await window.getByRole('tab', { name: '自动规则', exact: true }).click();
      await expect(window.getByRole('button', { name: '启用 模板草稿', exact: true })).toBeVisible();
      expect((await rules()).rules.some(rule => rule.name === '模板草稿')).toBe(false);
      await window.getByRole('tab', { name: '连接与执行', exact: true }).click();
      await expect(window.getByRole('heading', { name: '连接与执行', exact: true })).toBeVisible();
      await window.screenshot({ path: info.outputPath('autoloop-connections.png') });
      await window.getByRole('tab', { name: '我的任务', exact: true }).click();
      unavailable = true;
      await window.getByLabel('任务名称', { exact: true }).fill('断线时保留草稿');
      await expect(window.getByLabel('任务名称', { exact: true })).toHaveValue('断线时保留草稿');
      await expect(window.getByText(/暂时无法|无法连接|未连接/u).first()).toBeVisible({ timeout: 15_000 });
      await expect(window.getByLabel('任务名称', { exact: true })).toHaveValue('断线时保留草稿');
    } finally {
      await instance?.close();
      await new Promise<void>(accept => hub.close(() => accept()));
      await Promise.all([vaultRoot, userDataDir, hubHome].map(path => rm(path, { recursive: true, force: true })));
    }
  });
}
