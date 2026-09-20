# 应用更新检查与下载入口设计

**日期：** 2026-09-20  
**状态：** 已获用户确认，待用户审阅 spec  
**范围：** 已安装的 Apple Silicon 桌面 App；第一阶段只检查更新并打开官方下载页

## 目标

在“设置”页增加一个清晰、可控的“检查应用更新”入口。应用从固定的 GitHub Releases 读取新版本信息，向用户展示版本和更新说明；用户明确确认后打开官方 DMG 下载地址。这个阶段不执行 `git pull`，不静默替换正在运行的 App，也不修改“大脑”资料、密钥或本地数据库。

## 当前约束

- 桌面包只面向 Apple Silicon（`darwin/arm64`）。
- 当前打包链使用 `@electron/packager`，还没有 `electron-updater`、`electron-builder` 或更新 feed。
- 当前应用是未完成 Developer ID 签名和公证的开发者预览版。
- GitHub Release 的版本标签采用 `vX.Y.Z` 或 `vX.Y.Z-prerelease`；DMG 资产名必须包含 `arm64` 且以 `.dmg` 结尾。
- App 版本和 Release 标签必须使用同一套 SemVer。现有预览包的版本号与标签不一致，实施时要先把发布版本对齐，否则检查结果可能不准确。

## 用户流程

```text
设置页
  → 点击“检查应用更新”
  → 本地显示“正在检查”
  → 主进程读取固定 GitHub Releases
  → 已是最新 / 发现新版本 / 检查失败
  → 用户点击“打开下载页面”
  → 系统浏览器打开官方 DMG 地址
```

发现新版本时显示：

- 当前版本和新版本；
- 发布时间；
- 更新说明（限制长度，按纯文本展示）；
- 仅 Apple Silicon 的提示；
- “打开下载页面”按钮；
- GitHub Release 页面兜底链接。

没有新版本时显示当前版本和最近检查时间。检查失败时保留“重试”和“打开 GitHub Release 页面”两个动作。

## 架构

### 渲染层

`SettingsPage` 新增“应用更新”区域，维护以下状态：

```text
idle → checking → up-to-date
                 ↘ available → opening
                 ↘ error
```

渲染层只通过 `window.xiaozhaoDesktop.checkForUpdates()` 和 `window.xiaozhaoDesktop.openUpdateDownload(url)` 访问桌面能力，不直接请求 GitHub，也不接受任意 URL。

### Electron 主进程

在 `src/electron/main.ts` 注册两个受 sender 校验保护的 IPC：

- `desktop:check-for-updates`：读取 GitHub Releases、解析并返回受控结果；
- `desktop:open-update-download`：校验 URL 只属于允许的 GitHub Release/资产域名，再调用 `shell.openExternal`。

请求必须设置超时；主进程只访问固定仓库 `zhouao010809-code/best-partners`，不把仓库、路径或任意网络地址交给渲染层决定。

### 独立更新服务

新增一个可单测的纯函数/服务模块，负责：

1. 解析 GitHub Releases 响应；
2. 识别符合约束的 SemVer tag；
3. 选择适用于当前 `darwin/arm64` 的 DMG 资产；
4. 比较当前版本与候选版本；
5. 截断更新说明并移除不可控的 HTML/链接内容；
6. 返回不含本机路径和原始 API 响应的 DTO。

版本筛选规则：

- 忽略 draft 和没有合法 SemVer tag 的 Release；
- 稳定版 App 默认只看稳定版 Release；
- 当前 App 本身是 prerelease 时，可以匹配更高版本的 prerelease；
- 只选择 `arm64` DMG，找不到合适资产时将该 Release 视为不可下载；
- 版本小于或等于当前版本时返回“已是最新”。

### Desktop bridge

扩展 `src/shared/desktop/bridge.ts` 的类型，返回结构只包含：

```ts
type UpdateCheckResult =
  | { status: 'up-to-date'; currentVersion: string; checkedAt: string }
  | { status: 'available'; currentVersion: string; version: string; releaseUrl: string; assetUrl: string; publishedAt?: string; notes: string }
  | { status: 'error'; currentVersion: string; code: string; message: string; releaseUrl: string };
```

`preload.ts` 只暴露上述两个最小方法，不暴露 `ipcRenderer`、文件系统或通用网络能力。

## 安全与数据边界

- 更新检查是只读网络请求，不会把大脑内容、对话、API Key 或本地路径发送给 GitHub。
- 所有外部链接必须是 `https://github.com/zhouao010809-code/best-partners/...` 或其官方 Release 资产地址；其他协议和域名一律拒绝。
- 不下载到应用数据目录，不覆盖 `.app`，不调用 shell 命令，不执行 Release 中的脚本。
- 只有用户点击“打开下载页面”后才打开外部浏览器。
- 更新说明按纯文本展示，避免将 Release HTML 当作可执行内容。
- 网络失败、JSON 结构变化、版本解析失败和缺少 arm64 资产都转成可理解的错误，不显示堆栈或本机路径。

## 版本与发布约定

实施时统一 `package.json`、Electron `app.getVersion()` 和 GitHub tag 的版本格式。例如：

```text
package.json: 0.1.1
GitHub tag:   v0.1.1
```

预览版使用同样的 SemVer prerelease 格式，例如 `0.2.0-beta.1` 与 `v0.2.0-beta.1`。每个可供更新的 Release 必须包含一个可下载的 arm64 DMG，并在 Release 页面保留变更说明。

## 错误处理

| 情况 | 用户看到的结果 | 外部写入 |
| --- | --- | --- |
| 没有更高版本 | 显示“已是最新版本” | 无 |
| GitHub 超时/不可达 | 显示“暂时无法检查”，可重试或打开 Release 页面 | 无 |
| Release 标签非法 | 跳过该 Release，继续找下一个 | 无 |
| 没有 arm64 DMG | 将该 Release 视为不可下载，并显示 Release 页面兜底 | 无 |
| 用户未确认 | 只显示信息，不打开浏览器 | 无 |
| 用户确认下载 | 打开官方 GitHub 地址 | 仅外部浏览器导航 |

## 测试与验收

1. **服务单元测试**：覆盖 SemVer 比较、稳定/prerelease 筛选、arm64 DMG 选择、非法响应、说明截断和 URL 白名单。
2. **Electron IPC 集成测试**：覆盖 sender 校验、超时/失败映射、允许与拒绝的 URL。
3. **设置页组件测试**：覆盖检查按钮、加载态、已是最新、新版本卡片、重试和下载按钮。
4. **Electron 端到端测试**：在隔离环境注入固定 Release 响应，验证开发版和打包版都能展示检查结果；验证点击下载只触发允许的 GitHub 地址，不修改临时大脑文件夹。
5. **现有回归检查**：`npm run typecheck`、相关 Vitest 配置和 Electron 更新场景通过后，才能把功能标为完成。

## 不在本阶段范围

- 直接执行 `git pull`；
- 应用内静默下载或替换 `.app`；
- 自动重启安装；
- `electron-updater`/`electron-builder` 迁移；
- Developer ID 签名、公证和 CI 发布流水线；
- Windows、Intel Mac 或 Universal 包；
- 自动迁移用户资料、数据库或密钥。

## 后续升级路径

完成签名、公证和稳定 Release 流程后，再单独设计第二阶段：生成 ZIP、`latest-mac.yml` 和 blockmap，接入 `electron-updater`，增加下载进度、磁盘空间检查、退出前任务核验、重启安装和失败回滚。第二阶段不复用本阶段的“打开 DMG”状态机，避免把手动下载和自动安装混成一个不可恢复的动作。
