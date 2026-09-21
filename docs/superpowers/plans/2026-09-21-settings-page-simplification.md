# 设置页减法重排 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ] syntax) for tracking.

**Goal:** 将真实设置页重排为首屏可扫读的三张主卡，同时保留文件夹、AI、更新、资料检查和诊断的既有行为契约。

**Architecture:** SettingsPage 继续持有所有现有状态机和桌面桥接调用，只改变 JSX 的信息层级：页面概览、资料问题提醒、三张主卡、紧凑运行摘要、默认收起的详情。DeepSeekSettings 保持业务逻辑不变，仅通过现有设置样式进入主卡网格；AppShell 只更新设置页副标题。CSS 在 settings.css 内完成桌面两列、更新卡跨行和窄屏单列，不引入新的布局依赖或数据接口。

**Tech Stack:** React 18, TypeScript, React Testing Library, Vitest, Playwright, CSS Grid/Flexbox, Electron bridge (window.xiaozhaoDesktop).

---

### Task 1: 建立设置页布局与去重的失败测试

**Files:**
- Create: tests/component/settings-layout.test.tsx

- [ ] **Step 1: 写出三张主卡、资料提醒、版本去重和 disclosure 状态的测试**

创建完整的组件测试文件，使用可变的运行时 mock 和桌面桥接 mock，确保测试不依赖网络或 Electron：

~~~tsx
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsPage } from '../../src/client/pages/SettingsPage.js';

const { runtime } = vi.hoisted(() => ({
  runtime: {
    health: {
      status: 'ready' as const,
      data: {
        status: 'ready' as const,
        vaultSource: { status: 'ready' as const, adapter: 'filesystem' as const, displayName: '我的大脑' },
        index: { status: 'ready' as const, version: 47, refreshedAt: '2026-09-21T00:00:00.000Z' },
        model: { status: 'configured' as const, providerHost: 'api.deepseek.com', name: 'deepseek-v4-flash' },
        writeGate: { status: 'blocked' as const, missing: [], fingerprintMatches: true },
        schemaIssues: { status: 'available' as const, count: 3 }
      }
    },
    api: {},
    refreshHealth: vi.fn()
  }
}));

const desktop = {
  getAppVersion: vi.fn(), getVaultInfo: vi.fn(), openVaultDirectory: vi.fn(), chooseVaultDirectory: vi.fn(),
  checkForUpdates: vi.fn(), openUpdateDownload: vi.fn()
};

vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));
vi.mock('../../src/client/components/DeepSeekSettings.js', () => ({
  DeepSeekSettings: () => <section aria-label="AI 模型"><h2>AI 模型</h2></section>
}));
vi.mock('../../src/client/components/DocumentIssuesPanel.js', () => ({
  DocumentIssuesPanel: () => <div data-testid="document-issues-panel">详情列表</div>
}));

beforeEach(() => {
  Object.defineProperty(window, 'xiaozhaoDesktop', { configurable: true, value: desktop });
  desktop.getAppVersion.mockResolvedValue('0.1.0');
  desktop.getVaultInfo.mockResolvedValue({ displayName: '我的大脑', path: '/Users/example/Documents/我的大脑' });
  desktop.openVaultDirectory.mockResolvedValue(undefined);
  desktop.chooseVaultDirectory.mockResolvedValue({ selected: false, reason: 'unchanged' });
  desktop.checkForUpdates.mockResolvedValue({ status: 'up-to-date', currentVersion: '0.1.0', checkedAt: '2026-09-21T00:00:00.000Z' });
});

afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'xiaozhaoDesktop'); vi.resetAllMocks(); });
function open() { render(<MemoryRouter><SettingsPage /></MemoryRouter>); }

it('puts the three primary cards and one current-version label on the settings surface', async () => {
  open();
  expect(screen.getByRole('heading', { name: '大脑文件夹' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'AI 模型' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '应用更新' })).toBeVisible();
  expect(await screen.findByText('版本 0.1.0')).toBeVisible();
  expect(screen.getAllByText('版本 0.1.0')).toHaveLength(1);
  expect(screen.queryByText('本地桌面应用')).not.toBeInTheDocument();
});

it('shows a compact issue alert and keeps the detailed panel closed until requested', async () => {
  const user = userEvent.setup();
  open();
  expect(screen.getByRole('status', { name: '资料检查提醒' })).toHaveTextContent('3 项资料待确认');
  expect(screen.queryByTestId('document-issues-panel')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '查看待确认资料' }));
  expect(await screen.findByTestId('document-issues-panel')).toBeVisible();
});

it('keeps the runtime summary compact while advanced diagnostics remain collapsible', async () => {
  const user = userEvent.setup();
  open();
  expect(screen.getByTestId('schema-issue-count')).toHaveTextContent('3 个结构问题');
  expect(screen.getByText('索引 v47')).toBeVisible();
  expect(screen.queryByText('本地索引')).not.toBeInTheDocument();
  const diagnostics = screen.getByRole('button', { name: /高级诊断/u });
  expect(diagnostics).toHaveAttribute('aria-expanded', 'false');
  await user.click(diagnostics);
  expect(diagnostics).toHaveAttribute('aria-expanded', 'true');
});
~~~

- [ ] **Step 2: 运行新测试，确认它针对当前旧布局失败**

运行：

~~~bash
npx vitest run --config vitest.client.config.ts tests/component/settings-layout.test.tsx
~~~

预期：测试失败，原因是当前页面没有资料检查提醒、索引 v47 或新的紧凑摘要；不要修改断言来迎合旧 DOM。

- [ ] **Step 3: 提交失败测试作为实现边界**

~~~bash
git add tests/component/settings-layout.test.tsx
git commit -m "test: specify compact settings layout"
~~~

### Task 2: 重排设置页 JSX，保留所有现有交互契约

**Files:**
- Modify: src/client/pages/SettingsPage.tsx:1-365
- Modify: src/client/app/AppShell.tsx:238-250

- [ ] **Step 1: 收敛运行状态辅助函数和设置页概览数据**

在 SettingsPage.tsx 中移除只服务于旧诊断列表的 indexDiagnostic 与 schemaDiagnostic，同时移除不再使用的 Database、Gauge 图标导入；保留 vaultDiagnostic、modelDiagnostic、writeGateDiagnostic，因为高级诊断仍然使用它们。新增以下纯函数，用于摘要而非重复渲染完整诊断：

~~~tsx
function indexSummary(snapshot: HealthSnapshot | undefined): string {
  if (snapshot === undefined) return '索引读取中';
  switch (snapshot.index.status) {
    case 'ready': return '索引 v' + snapshot.index.version;
    case 'stale': return '索引 v' + snapshot.index.version + ' · 待刷新';
    case 'building': return '索引 v' + snapshot.index.version + ' · 构建中';
    case 'failed': return '索引 v' + snapshot.index.version + ' · 失败';
    case 'unavailable': return '索引不可用';
  }
}
~~~

保留 appVersion 的桌面桥接读取；它同时供概览和更新卡使用，不能再在页脚复制一份。

- [ ] **Step 2: 把主 JSX 换成“概览 → 提醒 → 三卡 → 摘要 → disclosure”顺序**

将 return 中的主结构按下面的新增节点和现有区块移动规则重排；交互函数 openVault、chooseVault、checkUpdates、openUpdateLink 不改签名：

~~~text
return (
  <div className="settings-workspace">
    <header className="settings-overview" aria-label="设置概览">
      <div>
        <span className="settings-overview__eyebrow">本地应用设置</span>
        <p>管理大脑位置、AI 连接和应用版本</p>
      </div>
      <div className="settings-overview__meta">
        <span className={'settings-chip settings-chip--' + (healthFailed ? 'amber' : snapshot?.vaultSource.status === 'ready' ? 'green' : 'silver')}>
          <i aria-hidden="true" />{healthFailed ? '连接待确认' : snapshot?.vaultSource.status === 'ready' ? '已连接' : '读取中'}
        </span>
        <span className="settings-overview__version">{appVersion ? '版本 ' + appVersion : '版本读取中'}</span>
      </div>
    </header>

    {issueCount !== undefined && issueCount > 0 && (
      <div className="settings-issues-alert" role="status" aria-label="资料检查提醒">
        <ShieldAlert aria-hidden="true" />
        <span><strong>{issueCount} 项资料待确认</strong><small>部分资料信息缺失或分类不明确，不会被自动修改。</small></span>
        <button type="button" className="settings-text-link" onClick={showIssues}>查看待确认资料<ArrowUpRight aria-hidden="true" /></button>
      </div>
    )}

    <div className="settings-primary-grid">
      <section className="settings-section settings-card settings-vault" aria-labelledby="settings-vault-heading">
        将当前 settings-vault 区块内的标题、路径、Finder、更换按钮、错误反馈和重启提示完整保留在这里。
      </section>
      <DeepSeekSettings />
      <section className="settings-section settings-card settings-updates" aria-labelledby="settings-updates-heading">
        <header className="settings-section__heading"><div><h2 id="settings-updates-heading">应用更新</h2><p>手动检查桌面版是否有新版本</p></div></header>
        <div className="settings-section__body">
          <p className="settings-updates__current">当前版本 {appVersion ?? '读取中'}</p>
          保留 checkUpdates 条件、检查按钮、checking/up-to-date/error 反馈、available 结果、assetUrl 下载按钮、releaseUrl 按钮和 updateDownloadError 警报。
        </div>
      </section>
    </div>

    <aside className="settings-health-summary" aria-label="运行状态摘要">
      <header className="settings-health-summary__heading">
        <h2>运行状态</h2>
        <Link className="settings-text-link" to="/operations">操作与恢复<ArrowUpRight aria-hidden="true" /></Link>
        <button className="settings-icon-button" type="button" aria-label={healthFailed ? '重新连接' : '刷新运行状态'} title={healthFailed ? '重新连接' : '刷新运行状态'} disabled={refreshing || runtime.health.status === 'loading'} onClick={() => void runtime.refreshHealth()}><RefreshCw aria-hidden="true" /></button>
      </header>
      {runtime.health.status === 'failed' && <PageState state={runtime.health.state} />}
      <div className="settings-health-summary__items" role="status">
        <span>{healthFailed ? '本地连接待确认' : '本地连接正常'}</span>
        <span>{indexSummary(snapshot)}</span>
        <span data-testid="schema-issue-count">{issueCount === undefined ? '结构检查待进行' : issueCount + ' 个结构问题'}</span>
      </div>
    </aside>

    <div className="settings-support">
      保留当前“待确认资料”和“高级诊断”两个 disclosure，默认收起且仅在展开时挂载详情。
    </div>
  </div>
);
~~~

实际 JSX 中不得保留旧的 settings-health 两列诊断行、旧页脚版本或重复的 settings-about 版本文本；DocumentIssuesPanel 仍必须位于 issuesOpen && 条件内，hidden、aria-expanded、role=status 和 role=alert 语义保持不变。文件夹和更新区块的现有按钮文案、回调、错误状态及桥接调用逐项保留。

- [ ] **Step 3: 更新设置页副标题并跑组件测试**

在 src/client/app/AppShell.tsx 的 /settings identity 中把描述改为：

~~~tsx
description: '管理大脑位置、AI 连接和应用版本。'
~~~

运行：

~~~bash
npx vitest run --config vitest.client.config.ts tests/component/settings-layout.test.tsx tests/component/settings-location.test.tsx tests/component/settings-updates.test.tsx
~~~

预期：布局测试通过；文件夹、更新和桌面桥接回归测试仍通过。

- [ ] **Step 4: 提交结构改动**

~~~bash
git add src/client/pages/SettingsPage.tsx src/client/app/AppShell.tsx
git commit -m "feat: regroup settings controls"
~~~

### Task 3: 用紧凑卡片网格替换旧的纵向设置样式

**Files:**
- Modify: src/client/styles/settings.css:1-218

- [ ] **Step 1: 替换主布局规则并保留既有控件样式**

把旧的 settings-section 标签/正文两列规则改为以下卡片网格；现有 settings-vault__*、settings-model-*、settings-key-*、settings-updates__* 和 disclosure 细节规则继续保留，只调整它们的外层间距：

~~~css
.settings-workspace { width: 100%; max-width: 980px; margin-inline: auto; color: #ebebef; font-size: 14px; line-height: 1.6; }
.settings-overview { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 20px; }
.settings-overview__eyebrow { color: #d9d9e1; font-size: 15px; font-weight: 550; }
.settings-overview p { margin: 5px 0 0; color: #9999a3; font-size: 13px; }
.settings-overview__meta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; justify-content: flex-end; }
.settings-overview__version { color: #a8a8b3; font-family: var(--font-mono); font-size: 12px; }
.settings-issues-alert { display: flex; align-items: center; gap: 12px; min-width: 0; margin-bottom: 16px; padding: 12px 14px; border: 1px solid #ad8b6435; border-radius: 10px; color: #d8c1a6; background: #ad8b640d; }
.settings-issues-alert > svg { flex: 0 0 17px; width: 17px; height: 17px; }
.settings-issues-alert > span { display: grid; flex: 1; min-width: 0; gap: 2px; }
.settings-issues-alert strong { color: #e2c8a6; font-size: 13px; font-weight: 550; }
.settings-issues-alert small { color: #b9a48d; font-size: 12px; overflow-wrap: anywhere; }
.settings-issues-alert .settings-text-link { flex: 0 0 auto; color: #e1c59d; }
.settings-primary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; min-width: 0; }
.settings-primary-grid > .settings-section { min-width: 0; }
.settings-workspace .settings-card { display: flex; flex-direction: column; gap: 18px; min-width: 0; padding: 20px; border: 1px solid #2b2b32; border-radius: 12px; background: #17171b; box-shadow: 0 10px 28px #00000018; }
.settings-primary-grid > .settings-updates { grid-column: 1 / -1; }
.settings-workspace .settings-card .settings-section__heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; min-width: 0; }
.settings-workspace .settings-card .settings-section__heading p { max-width: 34ch; margin: 5px 0 0; color: #9999a3; font-size: 12px; line-height: 1.6; }
.settings-workspace .settings-card .settings-section__body { min-width: 0; padding: 0; }
.settings-health-summary { display: grid; gap: 12px; margin-top: 18px; padding: 14px 2px 0; border-top: 1px solid var(--settings-line); }
.settings-health-summary__heading { display: flex; align-items: center; gap: 12px; }
.settings-health-summary__heading h2 { margin: 0; color: #bdbdc7; font-size: 13px; font-weight: 500; }
.settings-health-summary__heading .settings-text-link { margin-left: auto; }
.settings-health-summary__items { display: flex; flex-wrap: wrap; gap: 8px 18px; color: #9e9ea8; font-size: 12px; }
.settings-health-summary__items span { min-width: 0; overflow-wrap: anywhere; }
~~~

保留 --focus-ring、按钮 focus-visible 和 reduced-motion 规则；卡片内的路径、密钥和更新说明必须继续使用 min-width: 0 与 overflow-wrap: anywhere，这样长路径和长 Release notes 不会撑破布局。

- [ ] **Step 2: 写出桌面、平板、窄屏的明确断点**

用下面的断点替换旧的 settings-section 媒体覆盖，保证窄屏按“标题 → 状态 → 操作 → 说明”堆叠：

~~~css
@media (max-width: 900px) {
  .app-frame:has(.settings-workspace) .main-content { padding-inline: 28px; }
  .settings-primary-grid { grid-template-columns: minmax(0, 1fr); }
  .settings-primary-grid > .settings-updates { grid-column: auto; }
}
@media (max-width: 600px) {
  .app-frame:has(.settings-workspace) .main-content { padding: 26px 18px 32px; }
  .settings-overview { align-items: flex-start; flex-direction: column; gap: 12px; }
  .settings-overview__meta { justify-content: flex-start; }
  .settings-issues-alert { align-items: flex-start; flex-wrap: wrap; }
  .settings-issues-alert .settings-text-link { margin-left: 29px; }
  .settings-workspace .settings-card { padding: 17px; }
  .settings-workspace .settings-card .settings-section__heading { flex-direction: column; }
  .settings-workspace .settings-card .settings-section__heading > .settings-chip { margin-top: -8px; }
  .settings-health-summary__items { display: grid; grid-template-columns: minmax(0, 1fr); }
  .settings-updates__actions { align-items: stretch; flex-direction: column; }
  .settings-updates__actions .settings-button { width: 100%; }
}
~~~

删除 settings-about 的版本排版规则；如果保留品牌 footer，只保留不含版本号的品牌文字，并在 margin-top 上不再制造一整段空白。

- [ ] **Step 3: 跑组件与类型检查，确认 CSS 重排没有改变行为**

运行：

~~~bash
npx vitest run --config vitest.client.config.ts tests/component/settings-layout.test.tsx tests/component/settings-location.test.tsx tests/component/settings-updates.test.tsx
npm run typecheck
~~~

预期：两个命令都以退出码 0 完成，且没有新增 TypeScript 未使用导入或 JSX 可访问性错误。

- [ ] **Step 4: 提交视觉层级改动**

~~~bash
git add src/client/styles/settings.css
git commit -m "style: simplify settings dashboard"
~~~

### Task 4: 补上真实浏览器和 Electron 的布局回归

**Files:**
- Modify: tests/e2e/read-only-console.spec.ts:270-310
- Modify: tests/electron/desktop-launch.test.ts:70-82

- [ ] **Step 1: 在浏览器回归中验证三卡首屏、提醒入口和窄屏无溢出**

在 tests/e2e/read-only-console.spec.ts 的设置相关测试附近加入：

~~~ts
test('keeps the settings primary cards scannable on desktop and mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPage(page, '/settings');
  for (const name of ['大脑文件夹', 'AI 模型', '应用更新']) {
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('status', { name: '资料检查提醒' })).toContainText('3 项资料待确认');
  await page.getByRole('button', { name: '查看待确认资料', exact: true }).click();
  await expect(page.getByRole('region', { name: '资料检查详情' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoRootOverflow(page);
  const cardBoxes = await page.locator('.settings-primary-grid > .settings-card').evaluateAll((cards) => cards.map((card) => {
    const box = card.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
  }));
  expect(cardBoxes).toHaveLength(3);
  expect(cardBoxes[1]!.top).toBeGreaterThanOrEqual(cardBoxes[0]!.bottom);
  expect(cardBoxes[2]!.top).toBeGreaterThanOrEqual(cardBoxes[1]!.bottom);
});
~~~

若现有 DocumentIssuesPanel 的外层不是 role=region，把断言目标改为其已有可访问标题，而不要让测试依赖内部文件名；三张卡和 overflow 断言必须保留。

- [ ] **Step 2: 更新 Electron 入口断言到紧凑摘要**

在 tests/electron/desktop-launch.test.ts 保留 schema-issue-count 的测试 id，另外断言三个主卡标题和唯一版本标签：

~~~ts
await expect(window.getByRole('heading', { name: '大脑文件夹', exact: true })).toBeVisible();
await expect(window.getByRole('heading', { name: 'AI 模型', exact: true })).toBeVisible();
await expect(window.getByRole('heading', { name: '应用更新', exact: true })).toBeVisible();
await expect(window.locator('.settings-overview__version')).toHaveCount(1);
await expect(window.locator('.settings-overview__version')).toContainText('版本');
~~~

已有资料原文、Finder 和安全隔离断言不删，只改因旧诊断行而产生的定位器。

- [ ] **Step 3: 运行浏览器与 Electron 回归**

运行：

~~~bash
npx playwright test tests/e2e/read-only-console.spec.ts -g "settings primary cards|safe connection diagnostics"
npm run build:desktop-runtime
npx playwright test --config playwright.electron.config.ts tests/electron/desktop-launch.test.ts
~~~

预期：浏览器测试通过且窄屏 documentOverflow/bodyOverflow 均为 0；Electron development 与 packaged 两个 mode 均能打开设置页、查看资料详情并保持桥接白名单不变。

- [ ] **Step 4: 提交回归断言**

~~~bash
git add tests/e2e/read-only-console.spec.ts tests/electron/desktop-launch.test.ts
git commit -m "test: cover settings responsive layout"
~~~

### Task 5: 完成全量验证并记录实现状态

**Files:**
- Modify: docs/superpowers/specs/2026-09-21-settings-page-simplification-design.md:1 only to change 待实现 to 已实现并验证 after all checks pass

- [ ] **Step 1: 运行本轮完整质量门槛**

~~~bash
npm run test:component
npm run typecheck
npm run build:desktop-runtime
~~~

预期：三个命令均退出码 0；如果已有与本轮无关的失败，记录失败测试名称和原始输出，不跳过本轮新增设置测试。

- [ ] **Step 2: 检查变更边界，确保没有碰数据或桥接契约**

~~~bash
git diff --check HEAD~4..HEAD
git status --short
git diff --stat HEAD~4..HEAD
~~~

确认最终变更只涉及 SettingsPage、设置样式、设置页副标题、设置相关测试和本设计状态；版本去重只按用户可见文案验收，不绑定页脚 class；不提交 .superpowers/、公司项目文档或用户大脑内容。

- [ ] **Step 3: 更新设计状态并提交收尾记录**

将设计文档首行改为 状态：已实现并验证。，然后运行：

~~~bash
git add docs/superpowers/specs/2026-09-21-settings-page-simplification-design.md
git commit -m "docs: mark settings simplification verified"
~~~

## Self-review checklist

- 规格覆盖：概览副标题和版本摘要在 Task 2；三张主卡与手动更新在 Task 2；问题提醒、运行摘要和 disclosure 在 Task 2；深色卡片、响应式堆叠和焦点轮廓在 Task 3；组件、浏览器和 Electron 验收在 Tasks 1、4、5。
- 无占位符：每个实现步骤给出了目标文件、具体 class、文本、命令和预期结果；没有依赖未定义的函数或接口。
- 类型一致：摘要函数接收现有 HealthSnapshot | undefined；schema-issue-count、settings-overview__version 和 settings-primary-grid 在 JSX、CSS、测试中名称一致；现有 window.xiaozhaoDesktop 方法签名保持不变。
