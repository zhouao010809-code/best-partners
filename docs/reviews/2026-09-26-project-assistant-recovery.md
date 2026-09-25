# 项目问问连接与发送恢复 · 2026-09-26

## 问题与修复

1. 面板首次读取模型凭据失败后，会保留失败状态；返回应用或修改密钥时不会重新检查。异常时发送按钮禁用，而手动刷新藏在折叠的模型设置里。
   - 异常连接在返回应用、切换项目时重新检查；保存、移除密钥及设置页手动恢复读取后通知已打开的问问刷新。
   - 正常连接不因恢复窗口焦点重新等待模型目录。刷新不发送聊天，不改变已选模型、项目范围或草稿。
   - 输入区旁提供“重新检查连接”和直达模型设置的入口；按钮和 Enter 使用一致的阻断条件，显示具体原因。
2. 发送项目问题前，`ensureFresh` 会重新扫描。此前即使源快照没有变化，扫描仍递增版本，紧接着的版本比较便拒绝当前问题。
   - 源扫描摘要不变时保留版本；摘要变化时递增。索引、可用状态和扫描时间仍正常刷新。
   - 实际文件变化、重新绑定和写入计划确认继续检查版本，不移除旧版本保护。

## 已观察

- 现有桌面实例在重新读取 AI 服务后恢复“已连接”和发送按钮，草稿保留；未重写真实密钥，也未发送用户问题。
- 组件回归覆盖异常连接恢复、配置通知、正常连接焦点恢复、按钮与 Enter、草稿和模型选择。
- 真实项目服务回归覆盖首次及超过检查缓存时间的提问、不变扫描、内容变化、并发扫描、暂时扫描失败恢复和待确认写入计划。
- 隔离 Electron 开发版、打包版均通过：打开面板后保存合成密钥、模拟解密失败、重查恢复、保留密文和草稿、项目模式首次发送并收到固定测试回答。两种模式的首次使用走查也通过；共 6 项。
- 已检查打包版正常及 720 × 800 窗口截图，重查入口与发送按钮均在可视区域。

## 验证与边界

```sh
npm run verify:fast
npx vitest run --config vitest.client.config.ts tests/component/assistant-panel.test.tsx tests/component/assistant-product-readiness.test.tsx tests/component/assistant-skill-recommendation.test.tsx tests/component/deepseek-settings.test.tsx tests/component/read-pages.test.tsx
npm run package:mac
npx playwright test --config playwright.electron.config.ts tests/electron/assistant-connection-recovery.test.ts tests/electron/first-run-walkthrough.test.ts
```

验证构建使用干净提交快照加本次修复，不包含工作树中其他未提交改动。Electron 用独立临时大脑、项目和 userData；模型传输被固定响应替代，不调用真实 DeepSeek，不改写真实资料。

本次确认了失败状态无法自行恢复和项目版本误递增；最初系统密钥读取短暂失败的具体原因未证实，不将其等同于密钥损坏。未验证真实模型的回答质量。
