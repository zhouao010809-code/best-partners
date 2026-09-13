# 最佳拍档完整分发体验实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将最佳拍档改造成“下载后拥有完整公开知识库模板，并能安装浏览器收藏插件”的可交付版本。

**Architecture:** 桌面 App 内置版本化 `templates/default-vault`，首次创建时安全复制到用户选定位置；Manifest V3 扩展通过 Electron 提供的 Native Messaging host 将网页资料送入当前大脑的固定收件箱目录。首次启动总览页提供模板状态、插件安装说明和测试连接，AI 外发仍复用现有预览/确认流程。

**Tech Stack:** Electron 44、React 19、TypeScript、Fastify、SQLite、Chrome/Edge Manifest V3、Node Native Messaging protocol、Playwright、Vitest。

---

## Task 1: 建立公开入门大脑模板

**Files:**
- Create: `templates/default-vault/00大脑规则/00_大脑规范.md`
- Create: `templates/default-vault/00大脑规则/01_总路由规则.md`
- Create: `templates/default-vault/00大脑规则/02_图书馆入馆规则.md`
- Create: `templates/default-vault/00大脑规则/03_知识库提炼与入库规则.md`
- Create: `templates/default-vault/00大脑规则/05_链接命名与治理规则.md`
- Create: `templates/default-vault/01图书馆/小兆clipper/.gitkeep`
- Create: `templates/default-vault/01图书馆/来自示例/2026-09/示例资料/示例资料.md`
- Create: `templates/default-vault/02知识库/示例主题/示例知识.md`
- Create: `templates/default-vault/03大讲堂/.gitkeep`
- Create: `templates/default-vault/最佳拍档入门说明.md`
- Create: `templates/default-vault/template-manifest.json`
- Test: `tests/unit/default-vault-template.test.ts`

- [ ] **Step 1: 写模板完整性测试**

```ts
it('公开模板包含四个目录、五份规则、示例资料和清单', async () => {
  const entries = await listTemplateFiles();
  expect(entries).toEqual(expect.arrayContaining([
    '00大脑规则/00_大脑规范.md', '00大脑规则/01_总路由规则.md',
    '00大脑规则/02_图书馆入馆规则.md', '00大脑规则/03_知识库提炼与入库规则.md',
    '00大脑规则/05_链接命名与治理规则.md', '01图书馆/小兆clipper/.gitkeep',
    '01图书馆/来自示例/2026-09/示例资料/示例资料.md',
    '02知识库/示例主题/示例知识.md', '03大讲堂/.gitkeep',
    '最佳拍档入门说明.md', 'template-manifest.json'
  ]));
  expect(await readTemplate('最佳拍档入门说明.md')).toContain('示例');
  expect(await readTemplate('00大脑规则/03_知识库提炼与入库规则.md')).toContain('确认入库');
});
```

- [ ] **Step 2: 运行测试确认模板尚不存在时失败**

Run: `npx vitest run --config vitest.config.ts tests/unit/default-vault-template.test.ts`

Expected: FAIL，原因是模板目录及读取辅助函数不存在。

- [ ] **Step 3: 写入无个人信息的模板文件**

规则文件用普通语言说明“原文保留、预览后归档、确认后发送、候选不等于知识、确认后入库、来源可回看”；示例资料只使用虚构标题和正文。`template-manifest.json` 使用固定版本 `1.0.0`、公开内容列表和 SHA-256 指纹，不写入本机绝对路径。

- [ ] **Step 4: 运行测试确认模板通过**

Run: `npx vitest run --config vitest.config.ts tests/unit/default-vault-template.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add templates/default-vault tests/unit/default-vault-template.test.ts
git commit -m "feat: add public starter brain template"
```

## Task 2: 用模板安全创建首次大脑

**Files:**
- Modify: `src/electron/settings-store.ts:56-103`
- Create: `src/electron/vault-template.ts`
- Test: `tests/unit/settings-store.test.ts`
- Test: `tests/electron/first-run-distribution.test.ts`

- [ ] **Step 1: 为复制器写失败测试**

覆盖三个行为：空父目录能创建完整模板；同名 `我的大脑` 不覆盖；复制过程中任一文件失败时临时目录被清理、父目录没有半套文件。

- [ ] **Step 2: 运行定向测试确认失败**

Run: `npx vitest run --config vitest.config.ts tests/unit/settings-store.test.ts`

Expected: 新复制器断言失败，现有实现仍生成占位规则。

- [ ] **Step 3: 实现 `copyDefaultVaultTemplate`**

函数签名：

```ts
export async function copyDefaultVaultTemplate(input: {
  parentRoot: string;
  userDataDir: string;
  templateRoot: string;
  validate: (root: string) => Promise<DesktopSettings>;
}): Promise<DesktopSettings>
```

实现要求：校验父目录为真实目录；在同一父目录创建随机临时目录；逐文件复制并校验清单；将临时目录原子改名为“我的大脑”；调用现有 `validateDesktopVault`；任何异常都删除临时目录，不删除父目录原有内容。

- [ ] **Step 4: 修改 `createInitialVault` 使用复制器**

保留现有对符号链接、同名目录和权限的检查；删除 `STARTER_RULE_TEXT` 写入分支；模板路径在开发模式指向仓库 `templates/default-vault`，打包模式指向 `process.resourcesPath/templates/default-vault`。

- [ ] **Step 5: 运行单元和 Electron 首次启动测试**

Run: `npx vitest run --config vitest.config.ts tests/unit/settings-store.test.ts && npx playwright test --config playwright.electron.config.ts tests/electron/first-run-distribution.test.ts`

Expected: 模板创建、取消、重试、已有大脑保护全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/electron/settings-store.ts src/electron/vault-template.ts tests/unit/settings-store.test.ts tests/electron/first-run-distribution.test.ts
git commit -m "feat: create first brain from public template"
```

## Task 3: 创建 Manifest V3 浏览器收藏扩展

**Files:**
- Create: `browser-extension/manifest.json`
- Create: `browser-extension/src/content-script.js`
- Create: `browser-extension/src/service-worker.js`
- Create: `browser-extension/src/options.html`
- Create: `browser-extension/src/options.js`
- Create: `browser-extension/README.md`
- Create: `browser-extension/keys/README.md`
- Test: `tests/unit/clipper-payload.test.ts`

- [ ] **Step 1: 写资料包 schema 测试**

要求 payload 必须包含 `packetId`、`title`、`url`、`content`、`clippedAt`；标题最长 300 字符、正文最长 10 MiB；拒绝绝对路径、脚本协议和缺少标题的消息。

- [ ] **Step 2: 运行测试确认 schema 尚不存在时失败**

Run: `npx vitest run --config vitest.config.ts tests/unit/clipper-payload.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现最小扩展**

右键菜单和扩展按钮调用 `document.title`、`location.href`、可读正文提取和页面时间候选；service worker 通过 Native Messaging host 发送 payload；发送失败时将标题、链接和正文保留在 `chrome.storage.local`，允许重试；不申请历史记录、cookies 或任意文件权限。

- [ ] **Step 4: 添加安装说明**

明确 Chrome/Edge 的本地安装步骤、扩展权限用途、首次连接测试、卸载方式和“浏览器会要求确认一次”的原因；不声称桌面 App 能静默安装扩展。

- [ ] **Step 5: 运行扩展 schema 测试**

Run: `npx vitest run --config vitest.config.ts tests/unit/clipper-payload.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add browser-extension tests/unit/clipper-payload.test.ts
git commit -m "feat: add best partners browser clipper"
```

## Task 4: 实现 Electron Native Messaging host

**Files:**
- Create: `src/electron/clipper-host.ts`
- Create: `src/electron/clipper-installer.ts`
- Modify: `src/electron/main.ts:1-20, 45-125`
- Create: `src/shared/api/clipper.ts`
- Create: `tests/unit/clipper-host.test.ts`
- Test: `tests/electron/clipper-extension.spec.ts`

- [ ] **Step 1: 写 Native Messaging 协议测试**

测试 4 字节 little-endian 长度前缀、单条 JSON 消息、消息过大、无效令牌、扩展 ID 不在 allowlist、重复 `packetId` 和路径越界。

- [ ] **Step 2: 运行测试确认 host 尚不存在时失败**

Run: `npx vitest run --config vitest.config.ts tests/unit/clipper-host.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现 host 主循环**

`clipper-host.ts` 从 stdin 读取 Native Messaging 帧，解析 schema，读取 App 私有桥接配置，校验扩展 ID 和随机令牌，只允许写入当前大脑的 `01图书馆/小兆clipper/<packetId>/`；以临时文件加 `rename` 方式写入主 Markdown 和元数据，返回 `{ ok, packetId, duplicate }`。

- [ ] **Step 4: 在 `main.ts` 增加 `--clipper-host` 分支**

在正常 `app.whenReady()` 之前识别该参数，设置与桌面 App 相同的 userData 命名空间，运行 host 后退出；普通启动路径保持不变。

- [ ] **Step 5: 实现安装器**

`clipper-installer.ts` 生成用户级 Chrome/Edge Native host manifest，路径指向当前 App 的可执行文件，`allowed_origins` 只包含固定扩展 ID；桥接配置使用 0600 权限；卸载只删除 host manifest 和桥接配置，不删除大脑资料。

- [ ] **Step 6: 运行 host 单元和隔离 Electron/Chrome 流程**

Run: `npx vitest run --config vitest.config.ts tests/unit/clipper-host.test.ts && npx playwright test --config playwright.electron.config.ts tests/electron/clipper-extension.spec.ts`

Expected: 合成网页收藏进入临时大脑收件箱；重试不重复；App 未运行和令牌失效均可恢复。

- [ ] **Step 7: Commit**

```bash
git add src/electron/clipper-host.ts src/electron/clipper-installer.ts src/electron/main.ts src/shared/api/clipper.ts tests/unit/clipper-host.test.ts tests/electron/clipper-extension.spec.ts
git commit -m "feat: bridge browser clipper to local inbox"
```

## Task 5: 加入首次启动安装向导

**Files:**
- Modify: `src/client/pages/DashboardPage.tsx`
- Create: `src/client/components/first-run/DistributionChecklist.tsx`
- Modify: `src/client/api/client.ts`
- Modify: `src/client/pages/intake/IntakeMailbox.tsx`
- Test: `tests/component/distribution-checklist.test.tsx`
- Test: `tests/electron/first-run-distribution.test.ts`

- [ ] **Step 1: 写界面失败测试**

断言新建模板后显示“安装浏览器收藏插件”和“打开安装说明”；点击“测试连接”显示等待、成功或普通语言失败；已连接用户不重复强制展示；文件/粘贴备用入口始终可用。

- [ ] **Step 2: 运行组件测试确认失败**

Run: `npx vitest run --config vitest.client.config.ts tests/component/distribution-checklist.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现 checklist 与安全 IPC/API**

加入 `desktop:open-clipper-install`、`desktop:install-clipper-host`、`desktop:clipper-status` IPC；页面只展示当前状态，不读取或展示令牌；安装失败保留当前路由、模板和输入内容。

- [ ] **Step 4: 更新收件箱来源说明**

在插件未连接、已连接和桥接失败三种状态分别显示下一步；不把插件安装变成 AI Key 或首次启动的强制条件。

- [ ] **Step 5: 运行组件和 Electron 首次流程**

Run: `npx vitest run --config vitest.client.config.ts tests/component/distribution-checklist.test.tsx && npx playwright test --config playwright.electron.config.ts tests/electron/first-run-distribution.test.ts`

Expected: 从创建模板到插件安装向导的状态连续且可重试。

- [ ] **Step 6: Commit**

```bash
git add src/client/pages/DashboardPage.tsx src/client/components/first-run/DistributionChecklist.tsx src/client/api/client.ts src/client/pages/intake/IntakeMailbox.tsx tests/component/distribution-checklist.test.tsx tests/electron/first-run-distribution.test.ts
git commit -m "feat: add first-run distribution checklist"
```

## Task 6: 把模板和扩展纳入桌面包

**Files:**
- Modify: `scripts/package-desktop.ts`
- Modify: `package.json`
- Create: `scripts/package-extension.ts`
- Test: `tests/unit/package-content.test.ts`

- [ ] **Step 1: 写打包内容测试**

断言打包 staging 中有 `templates/default-vault/template-manifest.json`、扩展压缩包、host 入口；不存在 `.local`、真实大脑绝对路径、API Key 或测试 fixture。

- [ ] **Step 2: 实现扩展构建和资源复制**

使用无 bundler 的静态扩展构建：校验 Manifest、复制 `browser-extension/` 到 `dist/extension`，生成 `best-partners-clipper.zip`；`package-desktop.ts` 将模板复制到 `Contents/Resources/templates`，将扩展复制到 `Contents/Resources/clipper-extension`。

- [ ] **Step 3: 运行打包内容测试**

Run: `npx vitest run --config vitest.config.ts tests/unit/package-content.test.ts`

Expected: PASS。

- [ ] **Step 4: 重新打包并检查包内资源**

Run: `npm run package:mac`

Expected: Apple Silicon `.app` 构建成功；`find dist/desktop -path '*最佳拍档.app/Contents/Resources*'` 能看到模板和扩展资源。

- [ ] **Step 5: Commit**

```bash
git add scripts/package-desktop.ts scripts/package-extension.ts package.json tests/unit/package-content.test.ts
git commit -m "build: include starter brain and clipper in desktop package"
```

## Task 7: 更新公开文档和验收记录

**Files:**
- Modify: `README.md`
- Modify: `docs/reviews/2026-09-11-first-run-walkthrough.md`
- Create: `docs/reviews/2026-09-14-distribution-acceptance.md`

- [ ] **Step 1: 更新 README 首次使用**

把流程改成“创建完整大脑 → 安装插件 → 收藏网页 → 收件箱 → 提炼”；说明模板是公开示例，不包含作者个人资料；说明浏览器首次安装需要确认；保留文件/粘贴备用入口。

- [ ] **Step 2: 写隔离验收记录**

记录测试账号、临时父目录、临时 userData、临时 Chrome/Edge profile、模板清单哈希、插件包哈希、收藏到收件箱耗时和失败重试结果；明确未进行真实 DeepSeek 付费调用。

- [ ] **Step 3: 运行最终验证**

Run: `npm run typecheck && npm run test:unit && npm run test:component && npx playwright test --config playwright.electron.config.ts tests/electron/first-run-distribution.test.ts tests/electron/clipper-extension.spec.ts && npm run package:mac`

Expected: 类型检查、单元/组件、隔离首次使用、插件桥接和打包全部通过；仅允许已有 Vite chunk-size 警告。

- [ ] **Step 4: Commit**

```bash
git add README.md docs/reviews/2026-09-11-first-run-walkthrough.md docs/reviews/2026-09-14-distribution-acceptance.md
git commit -m "docs: document complete first-run distribution"
```

## 验收后的发布边界

- 未签名/未公证 DMG 仍只能称为开发者预览；正式发布前需要 Developer ID 签名和 Apple 公证。
- 浏览器扩展在商店上架前使用本地安装包；商店审核不是本计划的自动化验收条件。
- 公开模板必须与用户真实大脑分离；任何真实规则、笔记、密钥、账号和本机路径都不得进入 Git、扩展包或 DMG。
