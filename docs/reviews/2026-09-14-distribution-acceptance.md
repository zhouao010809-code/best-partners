# 最佳拍档分发与首次使用验收 · 2026-09-14

> 2026-10-30 晚间故障复查：[移动硬盘重连修复](2026-10-30-workdisk-reconnect.md)记录临时设备编号变化导致自动收纳暂停、稳定卷身份及恢复流程。

> 2026-10-30 故障复查：[下载子文件夹漏接修复](2026-10-30-auto-collection-subfolders.md)记录真实漏接原因、递归接收迁移和命名请求修复；旧版顶层测试不能证明子文件夹可用。

> 2026-10-30 增补：[自动收纳与图片命名验收](2026-10-30-auto-collection.md)记录下载目录后台接收、本机图片识别、副本改名与开发/打包验证；未执行公开发布。

> 2026-10-29 增补：[内容命名验收](2026-10-29-content-naming.md)记录工作盘根据实际正文命名导入副本的开发/打包验证；未执行公开发布。

> 2026-10-29 增补：[工作盘验收](2026-10-29-workdisk.md)记录新版本本地收纳、查找及开发/打包验证；仍为本机开发者预览，未执行公开发布。

> 2026-10-12 增补：[选段学习助手验收](2026-10-12-reading-assistant.md)记录本次开发/打包闭环与首次使用结果；未宣称签名、公证或公开发布完成。
> 当前入口更新（2026-09-25）：完整插件配置已移至「设置 → 浏览器收藏」，收件箱提供直达链接，首页不再常驻配置清单。下文保留 9 月 14 日当时的验收观察。

## 已观察

- 模板复制：隔离临时父目录和 `userData` 下创建完整 starter vault，失败时不留下半成品。
- 首次流程：开发版与打包版、空大脑与有待处理资料共 4/4 通过；入口能到收件箱或模型设置。
- Native Messaging：7 项 host/installer 单测通过；Electron 剪藏测试 2/2 通过，覆盖写入、幂等、令牌拒绝和中间目录符号链接拒绝。
- 首次分发清单组件：1/1 通过；安装失败显示普通语言错误，文件/粘贴备用入口仍可用。
- 打包内容：模板和扩展目录复制逻辑已接入 `package:mac`；扩展 zip 脚本可生成 `dist/best-partners-clipper.zip`。

## 设计推断

- 新用户无需先理解“Native Messaging”或“收件箱”内部实现；首页清单提供安装、测试和备用入口。
- 插件未连接不阻塞文件导入、粘贴和后续提炼主任务。

## 未验证与发布边界

- 未进行真实浏览器商店安装、真实 DeepSeek 付费调用或真实账号授权。
- 正式发布仍需 Developer ID 签名、Apple 公证和 DMG 验证；当前仅适合作为本机开发者预览。
- 原生系统文件夹选择框、真人对术语理解、跨页面未提交字段持久化仍需人工测试。

复现命令：

```bash
npm run typecheck
npx vitest run --config vitest.config.ts tests/unit/clipper-host.test.ts tests/unit/clipper-installer.test.ts tests/unit/package-content.test.ts
npx vitest run --config vitest.client.config.ts tests/component/distribution-checklist.test.tsx
npx playwright test --config playwright.electron.config.ts tests/electron/first-run-distribution.test.ts tests/electron/first-run-walkthrough.test.ts tests/electron/clipper-extension.spec.ts
```
