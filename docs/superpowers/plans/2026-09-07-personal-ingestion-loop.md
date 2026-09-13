# Personal Ingestion Loop Implementation Plan

> **For agentic workers:** Use executing-plans with independent bounded implementation tasks. Steps use checkbox syntax for tracking. Preserve the existing dirty linked worktree; no commits or worktree replacement in this task.

**Goal:** 在打包个人 App 内完成提炼、候选保存编辑、查重、确认入库、来源回链、检索和恢复。

**Architecture:** 保留不可变 extraction result，另存可编辑 review draft；不可变入库预览绑定版本。专用 native writer 与持久 manifest 执行可恢复批次，来源最后回写；成功后索引和 App 联动，不自动模型调用。

**Tech Stack:** TypeScript / React / Fastify / Zod / SQLite / YAML / macOS N-API / Vitest / Playwright Electron。

---

## 共享接口与责任

所有路径相对于活动工作树 `/Users/ao/Desktop/AO/04AI应用/xiaozhao-brain-console/.worktrees/desktop-read`。

- `src/shared/api/knowledge-content.ts`：知识召回字段与可复用表达；编辑草稿可暂空，正式内容必须完整。
- `src/shared/api/ingestion.ts`：Review、CandidateDraft、Match、Preview、Batch 的输入输出契约。
- `src/server/ingestion/note-format.ts`：纯函数生成/合并知识、按字段范围 patch 来源 YAML，保留正文。
- `src/server/ingestion/review-store.ts`：候选版本与显式取舍、批次状态。
- `src/server/ingestion/ingestion-service.ts`：当前来源版本、查重、预览、提交、恢复及索引。
- `src/server/ingestion/ingestion-native.ts` 与 `native/macos/sandbox-archive.c`：复用个人库已持有 root 的限定入库端口，隔离入库 recovery 目录，不修改入馆路径权限。
- `src/client/pages/queue/CandidateReview.tsx`：候选编辑、存草稿、选择目标、预览、确认和恢复。
- 主 Agent 负责共享契约、服务与整合；独立任务负责提炼输出与诊断、native primitive、候选 UI。不得交叉覆盖所有权文件。

## Task 1 — 完整提炼契约与可定位失败

Files: `src/shared/api/extraction.ts`, `src/shared/api/knowledge-content.ts`, `src/server/ai/deepseek-provider.ts`, `src/server/services/extraction-service.ts`; corresponding `tests/unit` and personal extraction integration tests.

- [x] 先测试：旧结果仍可读；新候选含 keywords/scenarios/conclusion/keyPoints/boundary/quotes/summaries；空可选 caution、截断、坏 JSON、越界目录的行为可区分。
- [x] 执行 `npx vitest run tests/unit/extraction-contract.test.ts tests/unit/deepseek-provider.test.ts`，确认新增断言先失败。
- [x] 从共享 schema 生成输出约束；只允许明确的无损可选空值归一化；保留严格限制和零候选。
- [x] 不改变现有模型/密钥与显式发送边界；安全诊断以错误码和白名单字段为准，不保存未过滤响应到日志。
- [x] 上述单测与 personal extraction service/API 回归通过。

内容协议：
```ts
type KnowledgeContent = {
  keywords: string[]; scenarios: string[]; conclusion: string;
  keyPoints: string[]; boundary: string; quotes: string[]; summaries: string[];
};
// Existing candidate fields remain; optional `draft: KnowledgeContent` adds
// a complete writable proposal while historical candidates remain readable.
```

## Task 2 — 受限原生单文件写入与保留版本

Files: `native/macos/sandbox-archive.c`, `src/server/archive/sandbox-native.ts`, `src/server/ingestion/ingestion-native.ts`, `tests/native/personal-ingestion.contract.test.ts`.

- [x] 先写隔离 native 测试，验证已有个人 root 句柄可打开独立 recovery；只允许知识 `.md` 及已归档原资料 `.md`。
- [x] 建立接口：
```ts
interface PersonalIngestionPort {
  rootIdentity: {dev: string; ino: string};
  read(path: string): Buffer | null;
  writeRecovery(name: string, bytes: Buffer): void;
  readRecovery(name: string): Buffer | null;
  listRecovery(): readonly string[];
  apply(path: string, stageName: string, before: Buffer | null, after: Buffer): void;
  close(): void;
}
```
- [x] 专用句柄复用 archive root 锁而不第二次抢同一锁；recovery 目录同卷、私有、独立锁与描述符。
- [x] create 使用排他 rename，update 使用 swap 保留旧版。始终先校验路径链、before/after 字节和 stage，再操作，操作后复核。无源内容原子 CAS 承诺；竞争版本保留，抛 conflict 交给协调器处理。
- [x] 拒绝 symlink、hardlink、非法路径、目录替换、错误 stage、旧内容不符；恢复文件 O_EXCL + fsync，不能覆盖旧日志。
- [x] `npm run build:personal-archive` 与 scoped native tests 通过；回归现有 personal archive contract。

## Task 3 — 候选草稿、查重与确定性预览

Files: shared ingestion contract, `009_personal_ingestion.sql`, `migrate.ts`, new review-store/note-format/ingestion-service; tests `personal-ingestion-service.test.ts` and `knowledge-note-format.test.ts`.

- [x] 先写纯函数测试：新建完整 YAML/body，source 只 patch 两字段且其他字节不变；合并保存出处、保护状态和映射。
- [x] 候选 key 为 run ID + ordinal，版本递增；pending/discarded/committed 分开，选入本批不等于已提交。草稿保存 CAS；已提交不可重写。
- [x] 加 schema migration 保存 review drafts、source heads、immutable previews/batches；操作幂等 key 与候选 batch 绑定持久化。
- [x] 从现存目录构建选择；本地标题/关键词/召回字段检索目标与邻近目录，返回匹配原因和使用状态；支持精确目标读取。
- [x] Preview 读取原资料、当前规则、草稿与目标；不同候选同目标生成一次完整更新；新建撞名、引用缺证、定论改判断、过时合并均明确阻止。
- [x] YAML patch 使用 YAML node range 替换目标值/字段，原始 BOM/newline/正文与非目标项不变；生成后重新解析并确认语义及字节保真。
- [x] 所有计划都是 `{id, runId, draftVersions, sourceBeforeSha, rulesSha, files:[{path,before,after}], decisions}` 不变快照；编辑或外部变化使其失效。
- [x] 单测与服务测试覆盖 legacy drafts、保存/放弃/恢复、同源多轮未决项、空结果及部分入库后的内部 source head。

## Task 4 — 持久批次、来源最后回写与恢复

Files: new `src/server/ingestion/ingestion-coordinator.ts`, service/store, tests `tests/archive/personal-ingestion-flow.test.ts`.

- [x] 先验证无确认不写；确认同一 preview 两次只产生一个 batch；两候选选一条后 source 部分入库，后续选/放弃后已入库。
- [x] 第一次改库前完整写入 manifest、before/after/stages；知识先、source 最后，所有步骤按当前磁盘 before/after/unknown 分类。
- [x] 复读全部输出、schema、双链与原正文之后提交 DB；source head 从已核实本应用回写链推进，不让部分入库误判旧候选失效。
- [x] 启动恢复已确认批次，无确认 preview 不执行。unknown 保留所有版本，在 App 提供查看、按当前内容重新核对或确认恢复操作，不能要求 shell。
- [x] 写完但索引失败单独显示 indexed=false；重复操作只索引刷新，不重写文件。
- [x] 故障注入知识写后、来源写前、DB finalize 前；重启只完成缺失步骤。竞争原地修改保留版本，不误报成功。

## Task 5 — App 审阅与完整 API

Files: `src/server/api/routes/ingestion.ts`, app/start-server; client API; CandidateReview and stylesheet; ExtractionPage; QueuePage/QueueDetail; KnowledgePage/LibraryPage; DashboardPage; component/API tests.

- [x] API 保持现有 bootstrap/CSRF 及 strict input/output 校验。GET review/matches/batches/detail；POST draft/preview/commit/resume/resolve，仅明确动作触发仓库写入。
- [x] UI 第一条可编辑候选、自动保存状态、选入本批、明确放弃、稍后处理、分类和已有目标；不把未勾选解释成放弃。
- [x] 预览本批新建/更新/来源变化，单次明确确认；成功显示笔记链接及剩余数；失败保留编辑，响应丢失通过同一批次找回。
- [x] 补 Knowledge exact path 深链和原资料 App 入口，不通过 Obsidian 外跳才能查阅。
- [x] source-only 最终取舍也必须通过可见确认落状态；零入库全放弃仅 App 完成，不伪造 source 已入库。
- [x] 首页和队列同步真实状态；部分入库不入牌堆，可继续剩余候选；已处理零结果不反复占待处理位置。
- [x] 宽窄屏、loading/error/retry/unsaved/recovery、失效响应与多窗口版本冲突测试通过。

## Task 6 — 打包验收与交付

- [x] 实际 Electron 在隔离 vault 从新原资料→归档→受控模型→两候选→编辑重启→入一条→放弃另一条→搜索知识→回原文跑通。
- [x] 验证候选、来源与知识文件状态及字节；重复确认、模型坏输出、外部改动与恢复均不丢数据。所有真实模型调用仍由用户在 App 确认。
- [x] 运行相关 unit/integration/component/native/archive tests，`npm run build:desktop-runtime`，以及开发+打包 Electron tests。
- [x] 更新 README 已实现范围；重新包装 App、只读检查运行状态后交付。用户真实资料不用于自动写入测试。
- [x] 更新或清空 vault `99_当前会话交接.md`；删除本次不用的临时文件。记录验证证据，不把未通过项写成完成。

## 执行记录

- 起点：已有 linked worktree `desktop-read`；现有 extraction contract/provider 21 个单测通过。计划与设计已确认，直接实施，无新增产品决策待问。

### 2026-09-07 交付验证

- 单元测试 660 项、集成测试 246 项、组件测试 277 项通过；原生入库与归档契约 35 项、真实 native + 磁盘 SQLite 入库流程 4 项通过。类型检查与 `build:desktop-runtime` 通过。
- 完整 Electron 10 项通过，包含开发与打包两种模式的启动、归档、提炼和全链路入库；候选 Chrome 宽窄屏 2 项通过。结果及截图保存在 `.local/electron-evidence/README.md`、`full-electron.log`、`candidate-visual.log`、`results/` 与 `browser/`。
- 全链路实际验证：插件资料及附件归档 → 显式受控提炼 → 编辑候选并重启 → 入库一条、来源部分入库 → 知识详情及返回原文 → 放弃剩余候选、来源已入库 → 队列已处理、牌堆排除 → 知识检索。原正文与附件按字节核验；重复提交同批次不产生重复文件或更新 inode / mtimeNs。
- 验收中修复 BOM + CRLF frontmatter 被当成正文的问题；新组件断言先失败再通过。编辑自动保存后滚动位置未重置。测试中的 CSRF 轮换问题通过复用原有令牌修正测试，没有改动生产认证边界。
- 全套验收后仅将全局标题“本地只读控制台”改为“本地大脑管理”，重新通过 AppShell 57 项测试、构建客户端并打包。无后续业务逻辑变更；最终客户端资源为 `index-B1SK_upN.js`。
- 已打开最终 `.app`，真实大脑及索引均为 ready；只读接口确认个人入库服务已挂载。旧通用 writeGate 仍保持原边界，不代表个人确认入库不可用。真实 App 截图为 `.local/electron-evidence/real-app.png`。
- 真实历史仍仅有原 failed run `6ea1a9e5-f880-4fb3-bc20-ddd612fe08b7`；该来源 SHA-256 仍为 `52a8f38b8661178081c73c510c2da6b1b791e99cf98c4858b9e6063ffc09c0d1`。没有替用户重发模型请求、归档或写入真实知识；旧失败没有可找回的候选结果。下一次真实调用由用户在“提炼队列 → 未完成”重新预览并确认发送。
- 测试进程、临时 vault / userData / Chrome 配置已清理，保留有用日志与截图；实际 App 保持打开。所有已有未提交改动保留，无提交或工作树替换。

### 已实现的恢复边界

确认计划、候选版本和批次持久化；知识先写、来源最后回写，重新读取核验后才完成批次。启动只继续已确认且磁盘版本吻合的缺失步骤；未知外部修改保留版本并要求在 App 重新核对。恢复预览同时绑定祖先保留版本与当前读集，确认前或执行期间变化会失效或进入待核对，不覆盖受保护笔记。索引失败独立重试，不重写知识。测试不构成多文件原子提交、断电安全或真实模型质量保证。
