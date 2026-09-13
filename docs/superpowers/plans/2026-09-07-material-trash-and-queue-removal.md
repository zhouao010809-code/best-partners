# Material Trash and Queue Removal Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent native / queue / library UI tasks; main owns contracts, trash service and integration. Preserve the existing dirty linked worktree, no commits or worktree replacement. User approved the design and implementation; do not pause for another product approval.

**Goal:** 用户可在个人 App 回收和恢复原始 Markdown、移出和重新加入提炼队列，保留全部知识和提炼历史。

**Architecture:** 独立 SQLite 可见性状态与回收日志；受限 native 单文件排他移动；先预览再确认，重启核验同一操作。原有入库、提炼与新回收共用持久状态阻止重叠操作。

**Tech Stack:** React / TypeScript / Fastify / SQLite / Zod / macOS N-API / Vitest / Electron Playwright。

## 1. 契约、规则与状态

- [x] 将已批准的权限例外写入 vault `SKILL.md`，保留不永久删除、不自动删除、原文保真与不连带删除边界。
- [x] 新测试 `tests/integration/personal-trash-service.test.ts` 先断言迁移存在，再验证服务行为；`npx vitest run --config vitest.integration.config.ts tests/integration/personal-trash-service.test.ts` 观察功能缺失。
- [x] `src/server/db/migrations/010_personal_material_management.sql` 增加 `personal_queue_visibility(material_path PRIMARY KEY, removed_at)` 及 `personal_trash_entries(id,material_path,title,created_at,status,manifest_json,problem,indexed,restored_at)`；在 `migrate.ts` 注册版本 10，更新迁移版本断言。
- [x] 新 `src/shared/api/trash.ts` 定义 `TrashPreview {id,materialPath,title,bytes,referencedKnowledge:[{path,title}],expiresAt}`、`TrashEntry {id,materialPath,title,createdAt,status,indexed,restoredAt?,problem?}`；状态 moving / trashed / restoring / restored / needs-review。GET list/entry，POST preview/commit/restore/retry 均 strict schema，无客户端任意路径写入参数。

## 2. Native 原文回收端口（独立任务）

- [x] 新 `src/server/trash/trash-native.ts`，扩展 `archive/sandbox-native.ts` 和 `native/macos/sandbox-archive.c`：
```ts
interface PersonalTrashPort {
  rootIdentity: ArchiveIdentity;
  stat(path: string): ArchiveStat | null;
  read(path: string): Buffer | null;
  statItem(id: string): ArchiveStat | null;
  readItem(id: string): Buffer | null;
  move(path: string, id: string, expected: ArchiveIdentity): void;
  restore(id: string, path: string, expected: ArchiveIdentity): void;
  writeRecovery(name: string, bytes: Buffer): void;
  readRecovery(name: string): Buffer | null;
  listRecovery(): readonly string[];
  close(): void;
}
```
- [x] `tests/native/personal-trash.contract.test.ts` 先验证缺失方法，再实现共享 root 锁、私有同卷回收目录与锁、UUID.md 槽、UUID.intent.json 不可变日志，前后身份检查、排他 rename 与 fsync。
- [x] 验证移动恢复字节保真、同名碰撞、路径链变更、软硬链接、非法路径、重开及关闭；执行 `npm run build:personal-archive` 和 scoped native contracts。

## 3. 队列移出（独立任务）

- [x] `extraction-queue.ts` 增加可选 `visibility: active|removed`，item 可选 removedAt；POST `/api/v1/extraction-queue/visibility {materialPath,removed}`，返回 source envelope。
- [x] `extraction-queue-service.ts` 持久幂等可见性、全历史汇总、cursor 纳入隐藏与回收状态；任何非 restored 的回收原文均不进入两个队列。
- [x] `extraction-service.ts` preview/start 都阻断移出或回收来源，防旧预览绕过；运行中请求或未完成入库先处理，不自动停止。
- [x] `read-service.ts` 隐藏队列项仅排除待处理牌堆，不排除原始资料；回收项立即排除资料列表。`QueuePage` / `QueueDetail` 加操作与已移出入口，保持历史与候选。
- [x] API/service/component scoped tests：移出与重新加入、草稿和历史不变、重开持久、active 阻断、旧预览失效、牌堆与资料差异。

## 4. 回收服务与 API（主 Agent）

- [x] 新 `src/server/trash/trash-service.ts`：读当前来源和索引引用；preview 不写；commit 绑定 ID、规则、身份、hash 与引用清单，检查活动请求和入库后持久意图并移动；同 ID 返回同记录。
- [x] restore 排他还原原路径；retry 核对两端身份和 hash，只有明确请求才补缺失移动。启动 recover 仅核验已确认记录；不自动改文件。回收与恢复后单独 refreshIndex，失败保留 indexed=false。
- [x] 新 `src/server/api/routes/trash.ts` 挂载 GET `/api/v1/trash`、`/:id`，POST `/preview`、`/commit`、`/:id/restore`、`/:id/retry`。沿用 session/CSRF，严格输出校验。
- [x] `app.ts`、`start-server.ts` 安装和关闭独立端口；`ingestion-service.ts` 防止回收来源进入新的确认批次。注册 intent 与状态后每次写之前复核重叠。
- [x] 服务和 API 测试覆盖预览不写、手动确认才写、重复确认、回收重启、未知竞争保存、恢复碰撞、索引失败重试、规则或来源更新、引用不变、认证边界。

## 5. 原始资料 UI（独立任务）

- [x] `client.ts` 添加可选 trash API 与 queue.setVisibility（兼容旧测试 stub）；新增 `components/MaterialTrash.tsx` 或同职责文件，`LibraryPage` 列表垃圾桶、详情操作和回收站视图。
- [x] 预览显示原路径、仅移动 Markdown/附件保留、引用影响；明确确认后显示可恢复回执。错误保留可重试状态。回收站支持查看记录、恢复、继续核验，恢复碰撞不覆盖。
- [x] `tests/component/material-trash.test.tsx` 与 API client tests 先失败后通过；沿用 lucide、现有样式和左导航，窄屏不溢出。

## 6. 完整验证、打包和交付

- [x] 隔离 Electron 测试从原文列表回收→原文消失/知识不变→重启→回收站恢复；队列移出→已移出→重新加入且历史不变。宽窄窗截图检查。
- [x] 运行相关 unit/integration/component/native 与桌面构建，重新打包再运行开发/打包 Electron 测试；无真实模型请求、真实原文移动。
- [x] README 记录实际功能与恢复数据位置；保存有效测试日志与截图，清理临时测试目录和进程。
- [x] 打开更新 App 只读检查实际大脑连接与历史，更新 `99`，`git diff --check` 后交付；不提交已有混合工作树。

## 验证记录

- 全量单元 660 项、集成 277 项、组件 295 项通过；client/server/electron 类型检查与桌面运行时构建通过。
- 原生回收契约 32 项、原有归档/入库契约 35 项、sandbox 契约 24 项通过。真实 native + 磁盘 SQLite + HTTP 回收/恢复流程 2 项通过，涵盖重启与恢复同名冲突。
- 队列 Chrome 1440/390 宽窄屏 4 项通过，截图在 `.local/material-management-evidence/queue-visual/`。
- 独立审查发现未登记的截断意图会阻断全部回收服务，已补失败用例并修复：保留孤立文件，跳过未知日志，不影响可验证记录。队列持久性、原生回收边界及最终后端复核均无剩余 P1/P2。
- 最后新增 GET/commit 竞态保护：确认尚在等待规则核验、DB 未登记时，同 ID 查询返回 `TRASH_BUSY` 而非 `TRASH_NOT_FOUND`，防止界面误提供取消。对应测试先失败后通过，最终 service/API 24 项及 server 类型检查通过；不把它重复计为一次全量集成运行。
- 原始资料页有手动回收能力时页头使用 `MANUAL CONFIRM`，知识库保持只读。标签更新后 AppShell 57 项与 client 类型检查通过，重建 client/server 并重新打包。最终资源：`index-DnRld5O9.js`、`chunk-5SJRWVTE.js`。
- 首轮 Electron 旧 10 项通过；新增 2 项在首个筛选的测试定位器处失败，尚未执行回收。已将测试定位改为资料筛选表单内的 combobox，未更改生产筛选逻辑。原日志和 trace 保存在 `.local/material-management-evidence/full-electron.log` 与 `first-electron-results/`。
- 最终产物的新增 Electron 2 项通过（开发 4.2 秒、打包 6.4 秒，总计 11.1 秒）。已在真实 Electron 完成取消预览、双击确认、引用提示、回收、重启、恢复、队列撤销和重新加入，并核对原文 inode/字节、知识与附件不变。1440/390 截图无横向溢出；最终日志为 `.local/material-management-evidence/final-management-electron.log`，截图在 `final-management-results/`。隔离测试根和测试进程已清理，保留有效截图与故障复现证据。
- 更新后的真实 App 已打开，连接“我的大脑”、索引 ready，回收 API 可用且为空；未对真实资料执行回收或模型调用。用户的新提炼 `742cef53-60a1-4a30-b118-b16d2a258840` 保持 ready，候选 `:0` 保持 version 6 / discarded，取舍批次 `9702d531-4e8d-432c-be29-79af2363c6d5` 保持 committed / indexed；旧失败记录仍保留。因此不再按旧交接指示用户重试旧失败任务。
- 真实 GPT-6 Astra 原始 Markdown 的 SHA-256 保持 `52a8f38b8661178081c73c510c2da6b1b791e99cf98c4858b9e6063ffc09c0d1`，App 窗口截图 `.local/material-management-evidence/real-app.png`。本机服务端口随启动变化；本次只读核验使用 `127.0.0.1:63753`，不固定或复用旧浏览器端口。
