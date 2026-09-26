# 应用内补丁更新 Implementation Plan

> **For agentic workers:** 使用当前任务内的独立分工完成 UI、发布工具与主进程，主 Agent 集成并验收。用户已确认实施，不再重复询问执行方式。

**Goal:** 让已安装应用能够检查、下载补丁并进入可用的安装流程。

**Architecture:** 主进程持有更新状态与可信 Release。未签名包下载校验 DMG 后交给系统打开；具备签名及 feed 的包由原生 autoUpdater 安装。设置页通过最小 IPC 订阅状态，不持有磁盘路径。

**Tech Stack:** Electron 44、TypeScript、React、Node fetch/crypto、Vitest、Playwright。

---

## 1. 状态与下载

- [ ] 在 `tests/unit/electron-update-download.test.ts` 写失败测试：有效流下载后文件等于输入；错误 SHA-256、大小、外域重定向、取消必须拒绝并删除本次临时目录。
- [ ] 运行 `npx vitest run tests/unit/electron-update-download.test.ts`，确认模块不存在导致失败。
- [ ] 新建 `src/electron/update-download.ts`，流式写入独占临时目录，计算 SHA-256，验证大小；只返回主进程内路径。
- [ ] 扩展 `src/shared/desktop/update.ts` 和 `update-check.ts`：从 API 的 digest/size 提取 download 元数据；仅同一 Release 的官方 ZIP + RELEASES.json 才给出 automaticUpdateUrl。
- [ ] 在 `update-controller.ts` 管理 idle/downloading/ready/installing/error 状态，下载与安装都去重，异常映射为可重试反馈。

## 2. 设置入口

- [ ] 提取 `src/client/components/AppUpdates.tsx`，替换 SettingsPage 原更新区域，保留工作树现有设置页改动。
- [ ] 先写组件测试：手动下载进度、取消、重试、打开安装器；自动模式重启；旧 bridge 兜底；订阅事件优先于迟到快照。
- [ ] 新增 `getUpdateState/downloadUpdate/cancelUpdate/installUpdate/onUpdateState` bridge；主进程统一验证 sender，渲染器不能传 URL/path 给新方法。
- [ ] 运行 `npx vitest run --config vitest.client.config.ts tests/component/settings-updates.test.tsx tests/component/app-updates.test.tsx`。

## 3. 发布与安装

- [ ] 新增 `scripts/package-update.ts` 与单元测试：核对版本，预览模式生成 DMG + SHA256SUMS；正式模式要求签名、公证，再生成 ZIP + RELEASES.json。
- [ ] `package.json` 增加 `package:update:preview` 与 `package:update` 命令，补丁版本递增为 0.1.1。
- [ ] 正常退出收到 will-quit 后关闭服务，再执行原生安装；取消窗口关闭时撤销安装意图。
- [ ] 发布说明说明未签名预览安装边界，禁止声称已验证真实自动安装。

## 4. 验证与交付

- [ ] 运行类型检查、架构检查、相关单元和组件测试。
- [ ] 从 Git HEAD 加本次 diff 创建干净构建快照，避免混入用户的未提交更改。
- [ ] 构建并运行隔离 Electron 更新及首次使用测试，核对下载文件、草稿和资料哨兵。
- [ ] 生成 DMG，检查包版本与校验文件；只提交本次改动，推送 GitHub 并发布对应补丁包。
- [ ] 报告已验证结果与真实签名安装未验证的边界，清理无用临时文件。
