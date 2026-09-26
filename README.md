# 最佳拍档 · Best Partners

<p align="center">
  <img src="assets/best-partners-icon.png" width="128" alt="最佳拍档图标" />
</p>

<p align="center">
  <strong>把收藏的资料，变成做事时用得上的知识。</strong><br />
  面向 Apple Silicon Mac 的本地知识与项目助手。<br />
  收集网页和文档，用 AI 辅助提炼，保留原文依据，再把积累带回项目中使用。
</p>

<p align="center">
  <a href="#开始使用">开始使用</a> ·
  <a href="#你可以用它做什么">核心能力</a> ·
  <a href="#界面预览">界面预览</a> ·
  <a href="docs/reference.md">使用参考</a> ·
  <a href="docs/development.md">开发文档</a>
</p>

为经常收集网页、阅读文档、撰写内容或推进客户项目的人准备。最佳拍档把资料收集、知识整理和项目问答连在一起，让你在下一次写作、讨论或做方案时，能找到相关知识，也能回到它的原始出处。

原始资料与知识笔记保存在本地文件夹中。你可以先整理和搜索；需要 AI 时，再配置自己的 DeepSeek 密钥并发起请求。当前为开发者预览阶段。

## 你可以用它做什么

| 你想完成的事 | 最佳拍档如何帮助你 |
| --- | --- |
| 收集分散的资料 | 用浏览器剪藏、导入 PDF / Markdown / TXT，或粘贴文本，把资料带进收件箱。 |
| 把读过的内容留下来 | 预览后归档原文与附件，再用 AI 生成可编辑的知识候选；由你决定保留、放弃或稍后处理。 |
| 找回知识的依据 | 搜索知识、查看关联来源，从一条结论回到原始资料。 |
| 围绕自己的资料提问 | 在“问问”里讨论当前资料或大脑中的知识，查看引用和本轮实际阅读范围。 |
| 在项目中创作内容 | 绑定已有项目文件夹，策划短视频选题、编辑脚本，让问问协助修改；保留版本与定稿，确认后导出到项目 `AI工作区`。 |
| 让外部助手查阅知识 | 单独配置只读 MCP，让 Codex 等支持 MCP 的工具搜索、阅读资料和来源证据。 |

“我的项目”直接使用已有文件夹，不搬走原文件。个人 MCP 需要单独配置；它只读文件，本身不调用模型。

## 从资料到知识，再到项目

```mermaid
flowchart LR
  A[网页与文档] --> B[收件箱与原文归档]
  B --> C[AI 生成知识候选]
  C --> D[人工编辑与取舍]
  D --> E[确认入库]
  E --> F[搜索与项目问答]
  F --> G[回看原文依据]
```

AI 提炼得到的是草稿。你可以修改内容、检查来源、选择保留项，再预览并确认写入知识库。普通问答不会自动把回答写成知识。

## 界面预览

材料卡片把待处理资料放在一起，打开后可查看来源和内容。以下为仓库已有的隔离测试界面示例；具体页面以所用版本为准。

<p align="center">
  <img src="assets/screenshots/material-deck-overview.png" alt="以材料卡片浏览待提炼资料" width="800" />
</p>

<details>
<summary>查看材料详情与窄窗口示例</summary>

<p align="center">
  <img src="assets/screenshots/material-deck-selected.png" alt="打开材料卡片查看详情" width="800" />
</p>

<p align="center">
  <img src="assets/screenshots/material-deck-mobile.png" alt="桌面应用在窄窗口中的材料卡片布局，并非手机应用" width="260" />
</p>

截图使用隔离测试资料。

</details>

## 开始使用

### 选择一个版本

- **试用已发布的预览包**：[下载 Apple Silicon 预览版](https://github.com/zhouao010809-code/best-partners/releases/tag/v0.1.3)。该版本发布于 2026-09-26，尚未完成 Developer ID 签名和 Apple 公证，请先阅读 Release 安装说明。
- **运行最新源码**：本页功能说明对应 `main`，已发布的预览包不包含之后的全部改动。体验最新实现可按下方命令运行。

需要 Apple Silicon Mac、Node.js 22.12+ 和 Xcode Command Line Tools。

```sh
git clone https://github.com/zhouao010809-code/best-partners.git
cd best-partners
npm ci
npm run electron
```

### 从第一份资料开始

1. **创建或选择“我的大脑”**：这是保存资料和知识的本地文件夹；新建时会提供初始目录和规则模板。
2. **带进一份资料**：在收件箱导入文件或粘贴文本，核对信息后归档。浏览器剪藏插件可稍后在「设置 → 浏览器收藏」配置，收件箱也提供直达入口。
3. **生成知识草稿**：需要 AI 时，在设置中保存自己的 DeepSeek 密钥；进入提炼队列，预览发送内容并确认提炼。
4. **留下真正有用的内容**：编辑候选、核对来源，预览本批变化后确认入库；随后在知识库搜索，也可在项目问答中检索。

“收件箱”存放待整理资料；“提炼”生成可编辑草稿；“入库”是你确认后保存为知识笔记。

## 文件、AI 与使用边界

- **本地保存**：原文和知识笔记以本地文件保存；索引、对话及草稿保存在本机。桌面版直接读取大脑文件夹，无需启动 Obsidian 或其 Local REST 插件。
- **按需使用 AI**：AI 问答与提炼调用 DeepSeek，相关内容会发送给服务商，并可能产生费用。保存密钥、浏览资料和预览提炼本身不会调用模型。
- **写入由你决定**：归档、知识入库和项目产出保留确认步骤；归档与入库保留原文正文。回收站支持恢复，彻底删除需逐项确认。
- **格式范围明确**：支持 PDF / Markdown / TXT。PDF 读取文字层，暂不支持 OCR、图片问答和 DOCX 解析。

文件大小、发送范围、恢复记录与冲突处理详见 [功能与使用参考](docs/reference.md)。

## 开发与文档

桌面端使用 Electron + React + TypeScript，服务端使用 Fastify，SQLite 保存索引和操作状态。原始资料与附件保存在本地文件夹，知识笔记使用 Markdown。

| 你要了解的内容 | 入口 |
| --- | --- |
| 详细操作、文件限制、个人 MCP 与数据位置 | [功能与使用参考](docs/reference.md) |
| 本地开发、测试与打包 | [开发与验证](docs/development.md) |
| 当前架构与本地收口结果 | [2026-09-25 验收报告](docs/reviews/2026-09-25-architecture-foundation-acceptance.md) |
| 首次使用流程及验证范围 | [首次使用走查](docs/reviews/2026-09-11-first-run-walkthrough.md) |
| 安装包、剪藏插件与分发状态 | [分发验收](docs/reviews/2026-09-14-distribution-acceptance.md) |
| 独立公司工作区的部署与操作 | [公司工作区运行手册](docs/company/company-p0-operations.md) |

公司工作区是独立运行模式，使用单独的数据与账号；个人桌面版无需配置公司模式或提供平台导出报表。

日常改动可运行 `npm run verify:fast`；完整验证和发布流程分别使用 `npm run verify:full` 与 `npm run verify:release`，环境要求与具体覆盖见开发文档。

## 许可

本仓库公开展示源码，采用保留所有权利的授权方式，并非开源许可证。使用、修改和分发条件以 [LICENSE](LICENSE) 为准。
