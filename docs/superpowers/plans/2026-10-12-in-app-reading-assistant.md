# App 内选段学习助手 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** 将既有选段问问升级成可恢复、只读、可保存理解的学习流程。

**Architecture:** 沿用阅读器、问问、模型适配器及 SQLite。新增结构化选段快照和固定用途的学习会话；学习笔记为独立、按大脑隔离的本机数据，用户编辑后保存。实施时由不同工作者负责互不重叠的文件，主 Agent 整合面板与端到端验证。

**Tech Stack:** Electron、React、TypeScript、Fastify、Zod、SQLite、Vitest、Playwright。

设计：[已批准的设计](../specs/2026-10-12-in-app-reading-assistant-design.md)。用户在当前会话明确批准实施，无需再次确认执行方式。

## 共享接口

```ts
// src/shared/api/learning.ts
type LearningSelection = { path: string; title: string; revision: string; text: string };
// 附加于 intent、draft、send、conversation、message，兼容旧记录
type LearningFields = { purpose?: 'learning'; selection?: LearningSelection };
```

`selection.text` 限制为 1–6000 Unicode 码点，版本为 SHA-256；路径限已有图书馆/知识 Markdown。服务端保存会话用途和来源，跟进请求不能移除约束；新的资料进入新会话。用户选文快照与工具读取证据分开保存。

## Task 1：学习协议与服务端读取边界

Files: `src/shared/api/learning.ts`、`assistant.ts`、`assistant-drafts.ts`；`src/server/assistant/service.ts`、`tool-factory.ts`、`brain-tools.ts`、`src/server/app.ts`；`tests/integration/assistant-learning.test.ts`。

- [x] 写失败用例：旧协议兼容；合法快照可持久化；超限/错误路径拒绝；学习会话不能混入普通会话、切换资料或扩大范围；原文变化前置拒绝且模型调用为零。
- [x] 运行 `npx vitest run --config vitest.integration.config.ts tests/integration/assistant-learning.test.ts` 并核对预期失败。
- [x] 增加共享字段；服务端继承会话约束，验证真实来源版本，组装仅当前资料只读工具；禁止 Skill、附件和项目写工具，读取时再次核验版本。
- [x] 学习系统上下文包含选文，区分模型补充与原文证据；工具失败不得伪称读过全文。回执与消息保存用途、快照。
- [x] 运行新增用例和现有 assistant service、draft、project、skill 集成测试，核对通过。

## Task 2：学习笔记持久化与小型 UI

Files: `src/shared/api/learning-notes.ts`、`src/server/learning/notes-service.ts`、`src/server/db/migrations/025_learning_notes.sql`、`src/server/db/migrate.ts`、`src/server/api/routes/learning-notes.ts`、`src/server/api/register-routes.ts`、`src/client/api/client.ts`、`src/client/components/learning/LearningNotes.tsx`、相应 CSS 和独立单元/集成/组件测试。

- [x] 写失败用例：用户正文保存、版本冲突不覆盖、响应丢失重试幂等、按大脑隔离、关闭数据库重开仍可找回、来源回收时快照保留。
- [x] 新增独立表与服务，作用域来自服务端大脑身份；创建/编辑通过稳定 UUID 和 expectedRevision，禁止替换来源身份；笔记保留会话/消息引用但不级联删除。
- [x] 增加只获取当前资料/指定会话笔记的 GET 与 PUT 接口，经既有 CSRF 和响应 schema；不暴露模型调用或原文写入。
- [x] 提供可编辑标题/正文组件：预填当前回答、失败保留输入、成功回执、冲突反馈；列表挂在阅读资料下，支持重新编辑；本机数据库备份边界明确。
- [x] 运行笔记服务/API/组件测试，核对无原始资料写入。

## Task 3：阅读器结构化选段

Files: `src/client/app/AppShell.tsx`、`src/client/components/assistant/assistantIntent.ts`、`src/client/components/learning/ReadingSelection.tsx`、`src/client/pages/LibraryPage.tsx`、`src/client/components/KnowledgeDetail.tsx`、`src/client/pages/queue/QueueDetail.tsx`、`tests/component/app-shell.test.tsx` 及选区组件测试。

- [x] 写失败用例：三处正文的路径/标题/版本来自加载结果；候选/元信息/跨区域不归为原文；刷新中不能取快照；6001 码点提示超限，6000 保留完整。
- [x] 从 AppShell 提取选段采集到阅读区组件；使用已加载文档元数据，点击只发 intent、不触发模型请求，正文切换时清除暂存选区。
- [x] 保留现有选段按钮交互，新增可读错误提示；接入笔记列表，不引入新导航。
- [x] 运行阅读器/选区组件回归。

## Task 4：问问面板与学习笔记整合

Files: `src/client/components/assistant/AssistantPanel.tsx`、`useAssistantDrafts.ts`、`AssistantMessageView.tsx`；独立 `LearningSelectionCard.tsx` 与 CSS；`tests/component/assistant-learning.test.tsx`。

- [x] 写失败用例：新学习会话隔离旧历史；同资料追问/换选段仍保留会话；换资料新建；草稿排队和历史恢复不丢选文；学习发送不匹配 Skill。
- [x] 草稿序列化、恢复和指纹包含 purpose/selection；引用卡独立于可编辑问题，显示当前资料可读取范围。
- [x] 学习会话隐藏不适用的范围/附件/Skill 控件；提供明确另开普通问问入口。读源出错保留问题和引用。
- [x] 回答支持“说简单点”“举个例子”和自由追问，显示历史引用快照，并挂载保存理解组件及该会话的笔记列表。
- [x] 新增测试及既有问问组件测试通过；检查窄面板文字换行与按钮可用。

## Task 5：整合验证与交付

- [x] 独立审查先核对规格，再核对代码风险；修复实际发现的问题，补针对性回归。
- [x] 执行 `npm run verify:fast`：架构/类型/单元通过，3 条旧迁移名单断言失败后更新并复验集成全量 771/771；后续 MCP 两套补跑通过。组件全量 860/860。没有将首次失败报告为命令整体通过。
- [x] 新增隔离 Electron 流程：合成资料划选→发送至替身模型→追问→编辑保存→重启找回；断言原文/正式知识哨兵字节不变及无跨会话污染。
- [x] 用 Playwright 生成桌面和窄窗口截图并检查；真实大脑、用户密钥和真实付费模型不参与自动化测试。
- [x] 更新 README/reference 的已实现范围与验收文档，标记真实模型理解效果仍需试用，不把测试通过写成用户认可。
- [x] 更新本计划的完成项与设计状态，仅提交本次文件；不纳入原有 `.superpowers/` 与 `2026-10-01-followup-code-review.md`。

## 收口记录

- 独立规格/代码审查提出的实际问题已修复：保存后刷新笔记列表；学习回答仅两种快捷追问；移除引用清除旧失败重试；保存理解的运行内草稿与 UUID 在关闭面板后恢复，追问不卸载已有回答编辑区。
- 新增组件/集成用例均先观察相应缺失行为再实现；引用移除后的旧重试和笔记卸载恢复另补针对性回归。
- 完整证据、桌面构建与未验证项见[验收记录](../../reviews/2026-10-12-reading-assistant.md)。
