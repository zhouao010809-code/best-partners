# 应用更新检查与下载入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置页增加一个受控的“检查应用更新”入口，从固定的 GitHub Releases 读取 Apple Silicon 新版本信息，并在用户确认后打开官方 DMG 下载地址。

**Architecture:** 将 GitHub Release 解析和 SemVer 筛选放在独立的 Electron 更新服务中；主进程通过 sender 校验保护两个最小 IPC，preload 只暴露检查与打开下载两个方法；SettingsPage 只负责状态展示和用户点击，不直接访问网络。生产环境使用固定 GitHub API 地址，Electron 测试使用仅在 NODE_ENV=test 下启用的本地 feed 覆盖。

**Tech Stack:** Electron 44、TypeScript、React 19、Vitest、Testing Library、Playwright Electron、Node fetch、Zod。

---

## 约束与文件地图

只修改本计划列出的更新功能文件；当前工作树中已有的公司项目改动、未跟踪计划和指标文件不得加入任何本计划提交。

| 文件 | 职责 |
| --- | --- |
| src/electron/update-check.ts | GitHub Releases 请求、响应校验、SemVer 比较、arm64 DMG 选择、更新 DTO |
| src/electron/update-navigation.ts | GitHub Release/资产 URL 白名单校验 |
| src/shared/desktop/bridge.ts | 更新结果和两个桌面桥方法的类型 |
| src/electron/preload.ts | 暴露最小更新桥接方法 |
| src/electron/main.ts | 注册 IPC、注入生产/测试 feed、调用 shell.openExternal |
| src/client/pages/SettingsPage.tsx | 更新检查状态机与设置页 UI |
| src/client/styles/settings.css | 更新区块、版本信息、更新说明和响应式样式 |
| tests/unit/electron-update-check.test.ts | 解析、版本筛选、资产选择和失败映射单测 |
| tests/unit/electron-update-navigation.test.ts | URL 白名单单测 |
| tests/component/settings-updates.test.tsx | 设置页更新状态和按钮行为组件测试 |
| tests/helpers/update-fixture-server.ts | Electron 测试用本地 GitHub feed fixture server |
| tests/electron/update-check.test.ts | 开发版/打包版更新检查端到端测试 |
| tests/electron/desktop-launch.test.ts | 更新桥方法白名单回归断言 |
| tests/e2e/fixtures/settings.tsx | 浏览器视觉 fixture 的桌面桥更新方法 |

版本号不在本计划中擅自改成新发布版本；实现会拒绝非法版本并记录当前 app.getVersion()。下一次可更新 Release 必须让 package.json、app.getVersion() 和 tag 使用同一 SemVer，例如 0.1.1 与 v0.1.1。

### Task 1: Add the update domain service (red-green-refactor)

**Files:**
- Create: src/electron/update-check.ts
- Test: tests/unit/electron-update-check.test.ts

- [ ] **Step 1: Write the failing unit tests**

使用本地 fixture，不访问真实 GitHub。测试数据至少包含 draft 的 v9.0.0、prerelease 的 v0.1.2-beta.1、稳定的 v0.1.1（同时有 x64 和 arm64 DMG）、非法 tag not-a-version。断言以下行为：

~~~ts
it('selects the newest stable arm64 release', async () => {
  const result = await checkForUpdate({ currentVersion: '0.1.0', releases, fetcher: fetchJson(releases) });
  expect(result).toMatchObject({
    status: 'available',
    version: '0.1.1',
    assetUrl: expect.stringContaining('0.1.1-arm64.dmg')
  });
  expect(result.notes).toContain('修复');
  expect(result.notes).not.toContain('<b>');
});

it('skips prerelease for a stable app', async () => {
  const result = await checkForUpdate({ currentVersion: '0.1.1', releases, fetcher: fetchJson(releases) });
  expect(result.status).toBe('up-to-date');
});

it('allows a newer prerelease for a prerelease app', async () => {
  const result = await checkForUpdate({ currentVersion: '0.1.1-beta.1', releases, fetcher: fetchJson(releases) });
  expect(result).toMatchObject({ status: 'available', version: '0.1.2-beta.1' });
});

it('maps unavailable and invalid feeds to safe error DTOs', async () => {
  await expect(checkForUpdate({
    currentVersion: '0.1.0',
    fetcher: async () => new Response('offline', { status: 500 })
  })).resolves.toMatchObject({ status: 'error', code: 'UPDATE_FEED_UNAVAILABLE' });
  await expect(checkForUpdate({
    currentVersion: '0.1.0',
    fetcher: async () => new Response('{')
  })).resolves.toMatchObject({ status: 'error', code: 'UPDATE_FEED_INVALID' });
});
~~~

再覆盖：缺少 arm64 资产、body 超过 4,000 个 Unicode 字符、非字符串 asset URL、超时和非法当前版本。测试必须先因模块/导出不存在而失败。

- [ ] **Step 2: Run the focused test and verify the expected red failure**

~~~bash
npx vitest run --config vitest.config.ts tests/unit/electron-update-check.test.ts
~~~

Expected: import 或导出缺失错误；若出现其他错误，先修正测试本身，不写生产代码。

- [ ] **Step 3: Implement the minimal update service**

在 src/electron/update-check.ts 导出以下契约：

~~~ts
export const RELEASES_URL = 'https://api.github.com/repos/zhouao010809-code/best-partners/releases?per_page=20';
export const RELEASE_PAGE_URL = 'https://github.com/zhouao010809-code/best-partners/releases';

export type UpdateCheckResult =
  | { status: 'up-to-date'; currentVersion: string; checkedAt: string }
  | { status: 'available'; currentVersion: string; version: string; releaseUrl: string; assetUrl: string; publishedAt?: string; notes: string }
  | { status: 'error'; currentVersion: string; code: 'UPDATE_FEED_UNAVAILABLE' | 'UPDATE_FEED_INVALID' | 'UPDATE_VERSION_INVALID'; message: string; releaseUrl: string };

export type UpdateCheckerInput = {
  currentVersion: string;
  releasesUrl?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
};

export async function checkForUpdate(input: UpdateCheckerInput): Promise<UpdateCheckResult>;
~~~

使用 Zod 校验 GitHub Release 数组。实现严格的 v 前缀 SemVer X.Y.Z 与 dot-separated prerelease 解析；比较 major/minor/patch，再按稳定版优先规则比较 prerelease。用 AbortSignal.timeout(8_000)，请求头为 Accept: application/vnd.github+json 和 User-Agent: best-partners-update-check。非 2xx 或 fetch 异常返回 UPDATE_FEED_UNAVAILABLE；JSON/schema 错误返回 UPDATE_FEED_INVALID；当前版本非法返回 UPDATE_VERSION_INVALID。

将 body 转为纯文本：HTML 标签替换为空格，移除 Markdown 链接目标和格式标记，压缩连续空行，最多保留 4,000 个 Unicode 字符。只选择 draft=false、tag 合法、html_url 合法、存在名称匹配 /arm64[^/]*.dmg$/iu 的资产；稳定 App 不匹配 prerelease，prerelease App 可匹配更高 prerelease。返回 DTO，不泄漏原始 API 响应或本机路径。

- [ ] **Step 4: Run the focused tests and refactor only after green**

~~~bash
npx vitest run --config vitest.config.ts tests/unit/electron-update-check.test.ts
~~~

Expected: 所有更新服务测试通过。仅在通过后抽取私有 helper，并再次运行同一命令。

- [ ] **Step 5: Commit the isolated service**

~~~bash
git add src/electron/update-check.ts tests/unit/electron-update-check.test.ts
git diff --cached --check
git commit -m "feat: add GitHub release update checker"
~~~

### Task 2: Add the guarded desktop bridge and URL validation

**Files:**
- Create: src/electron/update-navigation.ts
- Test: tests/unit/electron-update-navigation.test.ts
- Modify: src/shared/desktop/bridge.ts
- Modify: src/electron/preload.ts
- Modify: src/electron/main.ts
- Modify: tests/electron/desktop-launch.test.ts

- [ ] **Step 1: Write the failing URL-validation tests**

接受三个官方地址：GitHub 仓库 releases 首页、同仓库 releases/tag/任意合法 tag、同仓库 releases/download/任意路径的 arm64 DMG。拒绝 http、其他域名、其他仓库、file、javascript 协议、凭据和非 releases 路径；所有拒绝都抛出 UPDATE_URL_INVALID。先运行测试，确认 validator 缺失导致红灯。

- [ ] **Step 2: Run the navigation test and verify red**

~~~bash
npx vitest run --config vitest.config.ts tests/unit/electron-update-navigation.test.ts
~~~

- [ ] **Step 3: Implement the validator and bridge types**

在 src/electron/update-navigation.ts 实现一个 validateUpdateUrl(value: unknown): string。用 new URL 解析；只接受 https、hostname github.com、无 username/password/port，并且 pathname 是固定仓库的 releases、releases/tag/ 或 releases/download/ 路径。非法输入统一抛出 UPDATE_URL_INVALID，返回合法 URL 的 href。

在 XiaozhaoDesktopApi 中增加可选的 checkForUpdates(): Promise<UpdateCheckResult> 与 openUpdateDownload(url: string): Promise<void>；preload.ts 只增加两个 ipcRenderer.invoke 包装：

~~~ts
checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates'),
openUpdateDownload: (url) => ipcRenderer.invoke('desktop:open-update-download', url),
~~~

main.ts 在现有 get-app-version handler 附近注册两个 handler。check handler 先 assertMainSender，再在 NODE_ENV=test 时读取 XIAOZHAO_TEST_UPDATE_FEED_URL，否则始终使用 RELEASES_URL；open handler 先 assertMainSender，再调用 validateUpdateUrl 后交给 shell.openExternal。更新 desktop-launch.test.ts 的 exact bridge key 数组，加入两个方法并保留 renderer 隔离断言。

- [ ] **Step 4: Run unit and Electron type checks**

~~~bash
npx vitest run --config vitest.config.ts tests/unit/electron-update-navigation.test.ts
npx tsc -p tsconfig.electron.json --noEmit
~~~

Expected: 两条命令都以 0 退出。

- [ ] **Step 5: Commit the isolated bridge work**

~~~bash
git add src/electron/update-navigation.ts tests/unit/electron-update-navigation.test.ts src/shared/desktop/bridge.ts src/electron/preload.ts src/electron/main.ts tests/electron/desktop-launch.test.ts
git diff --cached --check
git commit -m "feat: expose guarded desktop update bridge"
~~~

### Task 3: Add the Settings update experience (red-green-refactor)

**Files:**
- Create: tests/component/settings-updates.test.tsx
- Modify: src/client/pages/SettingsPage.tsx
- Modify: src/client/styles/settings.css

- [ ] **Step 1: Write the failing component tests**

沿用 tests/component/settings-location.test.tsx 的 runtime、DeepSeekSettings、DocumentIssuesPanel mock。desktop fixture 包含 getAppVersion、getVaultInfo、checkForUpdates、openUpdateDownload。覆盖 available、up-to-date、bridge 缺失的浏览器提示、检查按钮重复点击只产生一次调用。核心测试：

~~~tsx
it('checks for updates and opens the selected arm64 download', async () => {
  desktop.checkForUpdates.mockResolvedValue({
    status: 'available',
    currentVersion: '0.1.0',
    version: '0.1.1',
    releaseUrl: 'https://github.com/zhouao010809-code/best-partners/releases/tag/v0.1.1',
    assetUrl: 'https://github.com/zhouao010809-code/best-partners/releases/download/v0.1.1/best-partners-0.1.1-arm64.dmg',
    publishedAt: '2026-09-18T00:00:00Z',
    notes: '修复 Skill 库同步问题'
  });
  const user = userEvent.setup();
  open();
  await user.click(await screen.findByRole('button', { name: '检查应用更新' }));
  expect(await screen.findByText('发现新版本 0.1.1')).toBeVisible();
  expect(screen.getByText('修复 Skill 库同步问题')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '打开下载页面' }));
  expect(desktop.openUpdateDownload).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('0.1.1-arm64.dmg'));
});

it('shows an actionable error and retries', async () => {
  desktop.checkForUpdates.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
    status: 'up-to-date', currentVersion: '0.1.0', checkedAt: '2026-09-20T12:00:00Z'
  });
  const user = userEvent.setup();
  open();
  await user.click(await screen.findByRole('button', { name: '检查应用更新' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法检查');
  await user.click(screen.getByRole('button', { name: '重试检查' }));
  expect(await screen.findByText('已是最新版本')).toBeVisible();
});
~~~

先运行并确认找不到“检查应用更新”按钮。

- [ ] **Step 2: Run the component tests and verify red**

~~~bash
npx vitest run --config vitest.client.config.ts tests/component/settings-updates.test.tsx
~~~

- [ ] **Step 3: Implement the Settings state machine**

SettingsPage.tsx 增加 idle/checking/up-to-date/available/error 状态和 updatePending ref；不在 mount 时自动检查。核心行为：

~~~tsx
const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' });
const updatePending = useRef(false);

const checkUpdates = async (): Promise<void> => {
  if (!desktop?.checkForUpdates || updatePending.current) return;
  updatePending.current = true;
  setUpdateState({ status: 'checking' });
  try {
    setUpdateState(await desktop.checkForUpdates());
  } catch {
    setUpdateState({ status: 'error', message: '暂时无法检查更新，请重试或打开 GitHub Release 页面。' });
  } finally {
    updatePending.current = false;
  }
};
~~~

在 DeepSeekSettings 后加入 aria-label=应用更新 的 settings-section。idle 显示 appVersion 和“检查应用更新”；checking 禁用并显示“正在检查…”；available 显示“发现新版本 version”、发布时间、notes 和“打开下载页面”；up-to-date 显示“已是最新版本”；error 显示 role=alert、重试按钮和 GitHub Release 普通链接。点击下载调用 openUpdateDownload(assetUrl)，失败时保留版本卡片并显示错误。bridge 不存在时显示“桌面版可用，浏览器预览不会检查应用更新。”，不渲染可用检查按钮。

notes 使用纯文本和 white-space: pre-wrap，不使用 dangerouslySetInnerHTML；进度/结果使用 role=status，错误使用 role=alert。

- [ ] **Step 4: Add styles and run green tests**

在 settings.css 增加 settings-updates、settings-update__meta、settings-update__notes、settings-update__actions，复用现有 settings-button/settings-feedback 和已有 780px 响应式断点。available 时下载按钮使用现有 primary 样式，其他状态不引入新的颜色系统。

~~~bash
npx vitest run --config vitest.client.config.ts tests/component/settings-updates.test.tsx tests/component/settings-location.test.tsx
~~~

Expected: 新旧 Settings 组件测试全部通过且无 console error；通过后才重构。

- [ ] **Step 5: Commit the Settings UI**

~~~bash
git add src/client/pages/SettingsPage.tsx src/client/styles/settings.css tests/component/settings-updates.test.tsx
git diff --cached --check
git commit -m "feat: add settings app update check"
~~~

### Task 4: Add isolated Electron update-flow coverage

**Files:**
- Create: tests/helpers/update-fixture-server.ts
- Create: tests/electron/update-check.test.ts
- Modify: tests/e2e/fixtures/settings.tsx

- [ ] **Step 1: Create a local feed fixture server**

使用 node:http.createServer 实现 createUpdateFixtureServer(releases)。只响应 127.0.0.1 的 /releases，返回 application/json 和固定 JSON；listen 使用随机端口；返回 { url, close }，测试 finally 必须 close。生产代码不得依赖这个 helper。

- [ ] **Step 2: Write the failing Electron tests**

循环 development 和 packaged，沿用 tests/electron/desktop-launch.test.ts 的临时 vault/user-data 与启动方式。fixture feed 返回 v0.1.1 arm64 release；launch 环境增加 NODE_ENV=test、XIAOZHAO_TEST_VAULT_ROOT、XIAOZHAO_TEST_USER_DATA、XIAOZHAO_TEST_UPDATE_FEED_URL。进入 Settings，点击“检查应用更新”，断言“发现新版本 0.1.1”和更新说明；关闭 App 后校验 sentinel 与代表性 Markdown 字节不变。第二个测试用相同版本断言“已是最新版本”。先运行并确认测试因按钮/feed override 不存在而红灯。

- [ ] **Step 3: Extend the visual Settings fixture**

tests/e2e/fixtures/settings.tsx 增加两个 bridge 方法；scenario=update-available 时返回确定的 available DTO，其他 scenario 返回 up-to-date。fixture 只留在内存，不打开真实外部 URL。

- [ ] **Step 4: Run Electron tests**

~~~bash
npm run build:desktop-runtime
npx playwright test --config playwright.electron.config.ts tests/electron/update-check.test.ts tests/electron/desktop-launch.test.ts
~~~

Expected: development/packaged 的 available 与 up-to-date 场景通过，bridge key 断言通过，既有 desktop launch 覆盖不回归。若 packaged binary 过期，按仓库已有离线 Electron cache 重新执行 npm run package:mac 后再跑。

- [ ] **Step 5: Commit Electron coverage**

~~~bash
git add tests/helpers/update-fixture-server.ts tests/electron/update-check.test.ts tests/e2e/fixtures/settings.tsx
git diff --cached --check
git commit -m "test: verify desktop update check flow"
~~~

### Task 5: Run proportionate verification and keep release documentation accurate

**Files:**
- Modify: README.md only when there is an existing suitable “当前可用范围” row; otherwise leave it untouched.

- [ ] **Step 1: Run focused unit, component, type, and desktop checks**

~~~bash
npx vitest run --config vitest.config.ts tests/unit/electron-update-check.test.ts tests/unit/electron-update-navigation.test.ts
npx vitest run --config vitest.client.config.ts tests/component/settings-updates.test.tsx tests/component/settings-location.test.tsx
npm run typecheck
npm run build:desktop-runtime
~~~

Expected: every command exits 0 with no failed tests or TypeScript errors.

- [ ] **Step 2: Run Electron acceptance**

~~~bash
npx playwright test --config playwright.electron.config.ts tests/electron/update-check.test.ts
~~~

Expected: 4 cases pass（development/packaged × available/up-to-date），临时大脑文件没有变化。

- [ ] **Step 3: Verify release contract and isolate unrelated work**

~~~bash
node -e "const p=require('./package.json'); if(!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(p.version)) process.exit(1); console.log(p.version)"
git diff --check
git status --short
~~~

确认更新功能提交只包含更新文件；不要 stage 或 commit 当前 status 中已有的 company 项目改动。

- [ ] **Step 4: Add documentation only when an existing section can hold it**

若 README 已有合适的发布/更新说明区，补充“设置里的检查按钮会打开官方 GitHub Release DMG，第一阶段不会静默安装”；若没有，保持 README 不变，设计 spec 继续作为本阶段契约。文档改动单独提交。

- [ ] **Step 5: Final verification before reporting completion**

最后一次功能改动后执行：

~~~bash
npm run typecheck
npx vitest run --config vitest.config.ts tests/unit/electron-update-check.test.ts tests/unit/electron-update-navigation.test.ts
npx vitest run --config vitest.client.config.ts tests/component/settings-updates.test.tsx
git diff --check
~~~

报告实际通过数量、当前行为（检查 → 用户确认 → 官方 DMG 页面）和仍存在的发布限制（未签名预览/手动安装）。不得声称已经实现自动安装；它明确不在本阶段范围。
