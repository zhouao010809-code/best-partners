# 工作盘内容命名验收 · 2026-10-29

用户本轮明确：数字或字母文件名无法帮助找回资料，需要读取文章正文、概括核心内容，再给导入工作盘的文件起名。本轮将内容命名接入现有收纳流程。本记录是隔离自动化与代码复核证据，不是用户研究或真实模型质量评估。

## 已观察

- “根据内容命名”位于收文件入口下方，默认开启。导入前明确说明正文会交给设置中已连接的 AI，长文使用节选；关闭开关不为命名发送正文。同一页面会话内保留选择。
- 开发版和打包版均能将数字名 TXT、字母名文字层 PDF 解析为实际正文，接收模型生成的标题并保存为 `日期/文档/标题.原扩展名`。
- 模型请求中只有正文及是否为节选的标记，没有源文件名、目录或可调用的工具；PDF 请求内容为提取的文字，不是 PDF 二进制。
- 收纳结果列出原名、实际保存名和原因。同名另存后的编号与实际文件一致，原文件及导入副本正文逐字节一致，知识目录哨兵未变更。
- 扫描、加密、损坏 PDF、二进制或不足以提炼主题的文本，不会仅凭文件名猜测主题。未连接模型、超时或无效返回值均按原名保存并说明原因。
- 长文取开头、中间、结尾，合计不超过 24,000 字符；回执明确是节选命名。输入文件上限 20 MiB，不适用格式和超限文件直接沿用原名。
- 命名与复制共用打开的源文件；命名前后及复制完成后核验文件身份、大小和修改信息。命名期间原件改写或源路径替换时，不发布名字与内容可能不对应的副本。
- 关闭开关再次收文件，未新增模型请求。重启后工作盘连接与已命名文件仍可找回，并能读取原正文。
- 退出应用会取消当前命名等待；即使提供方不响应取消，也不会继续阻塞退出。剩余已接收文件跳过 AI、按原名完成复制，退出仍等待本地保存结束。
- 720px 窗口下无整页横向溢出，命名说明和连接入口位于自身区域内；原名、新名和失败原因可见。
- 最终打包版已在本机重新打开，工作盘保留原先“黑骏画室working”目录连接，已显示并默认选中“根据内容命名”；未导入或外发用户实际资料。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 架构边界、五个 TypeScript 目标、客户端大小检查 | 通过 |
| 内容命名器与存储集成 | 39 项通过，包含退出取消回归 |
| 桌面控制器 | 14 项通过 |
| 工作盘组件 | 11 项通过 |
| Electron 内容命名，开发版 / 打包版 | 2 项通过 |
| Electron 既有工作盘，开发版 / 打包版 | 2 项通过 |
| Electron 首次使用，空大脑 / 待处理资料及开发 / 打包 | 4 项通过 |

独立复核发现并修复批量命名时退出仍会启动后续 AI 请求的问题。两文件批次关闭回归先失败后通过；独立复核确认取消等待、剩余原名复制和迟到结果不采纳均符合预期。当前源码构建和打包校验通过，sourceSha256 为 `af88f3966d663d44a2c59350bfa703e195adc730331a92a1b83e423fb5ca223b`。

## 当前边界

- 仅对本次导入的副本起名；不批量改名已有工作盘文件，不改变原件名称和正文，不调整原有日期/类型目录逻辑。
- 支持 UTF-8 Markdown、TXT、CSV、JSON、字幕、日志、YAML 与文字层 PDF。Office 文档、图片、音视频、扫描 PDF 暂不做 OCR、转写或内容命名。
- 测试使用真实临时文件、实际 PDF 解析和固定的模型响应，并拦截对外网络；证明正文提取、请求、命名与保存流程有效，没有声称已验证真实 AI 账号的标题质量。
- 文件选择框使用受控测试输入。拖放选项传递有组件与桌面控制器回归，真人从 Finder 拖入的完整手势未在本轮验收。
- 仍为本机开发预览，没有签名、公证或公开发布。

## 界面

![内容命名结果](screenshots/2026-10-29-content-naming-wide.png)

![720px 内容命名结果](screenshots/2026-10-29-content-naming-narrow.png)

## 复现

```sh
npx vitest run --config vitest.integration.config.ts tests/integration/workdisk-content-namer.test.ts tests/integration/workdisk-naming-storage.test.ts tests/integration/workdisk-service.test.ts
npx vitest run tests/unit/workdisk-desktop.test.ts
npx vitest run --config vitest.client.config.ts tests/component/workdisk-page.test.tsx
npm run check:architecture
npm run build:desktop-runtime
npm run package:mac:built
npx playwright test --config playwright.electron.config.ts tests/electron/workdisk-naming.test.ts tests/electron/workdisk.test.ts tests/electron/first-run-walkthrough.test.ts
```

本次调用依据：用户当前“依据正文总结文件名”的明确需求用于命名流程；[大脑命名规范](/Volumes/小兆滴剪辑盘/我的大脑/00大脑规则/05_链接命名与治理规则.md)的可读、简短、表达核心与跨平台字符要求用于标题约束；[首次使用复查规则](2026-09-11-first-run-walkthrough.md)用于外发说明、失败反馈与隔离验证。具体对应见[实施计划](../plans/2026-10-29-content-naming.md)。
