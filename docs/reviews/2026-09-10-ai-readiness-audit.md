# 问问 AI 产品就绪审计

日期：2026-09-10。范围：工作区全部当前代码，包括未提交、未跟踪文件。本文是本轮审计及随后获授权修复的记录，不替代此前 UI 评审。父任务正在并行实现附件和前端，本文区分审计起点、已经验证的后端变化、仍需整体验收的接线。

审计只使用代码阅读、合成资料、内存 SQLite、真实锁版本 SDK 的假 SSE。未调用真实模型、未读取用户资料、未向真实 vault 或 userData 写入，也未重启服务或构建覆盖 dist。

## 结论与真实缺陷

本线在审计起点独立复现了三个 P2 缺陷，均已修复并添加正式回归；新增附件的集成复查另有后文记录。没有把缺少产品能力、模型可能回答不好或旧历史文案当作已经复现的模型错误。

| 问题 | 可触发流程与影响 | 当前修复位置及验证 |
| --- | --- | --- |
| P2：失效提炼快照不能在本轮更新，阅读状态缓存串用 | `prepare_extraction` 后原文变化，`submit_candidates` 返回 `PREVIEW_STALE`；模型再次准备仍得到旧 token。原缓存只按路径，改为“已看”也拿到“未看”的旧准备。基线实测 `prepares=1, sameToken=true, returnedReadingState=未看`。导致当前对话无法按新证据完成提炼。 | `src/server/assistant/brain-tools.ts:158` 缓存键含路径、阅读状态、服务器范围；`:186` 在 PREVIEW_STALE 后撤销该路径全部缓存和 token。结果字段校验错误仍允许修正后重交。`tests/unit/assistant-brain-tools.test.ts` 覆盖旧 token 失效、重新准备、状态切换。 |
| P2：零候选的合法结果永久显示待审阅，已看资料的导读不可达 | 返回合法 `candidates: []`。历史卡仍为 `ready/审阅知识候选`，没有任何候选可处理；“已看”页又隐藏 briefing。基线内存 DB 投影实测 `candidateCount=0,status=ready`。 | `src/server/assistant/presentation.ts:39`、`brain-tools.ts:190`、`src/shared/api/assistant.ts` 增加真实终态 `empty`；`src/client/pages/ExtractionPage.tsx:176` 使零候选仍可查看导读。显示“已完成 · 无候选”，不假称入库或放弃。unit、integration、组件先红后绿。 |
| P2：点击停止的即时回包遗漏最后一段文本/用量 | 流事件进入内存，尚未到 120 ms 持久化节流；此时调用 stop。旧实现从 DB 读上一个快照返回，前端收到 stopped 后不再轮询，因此最新文字和 usage 暂时丢失。 | `src/server/assistant/service.ts:200` 在读取停止回包前执行当前任务 `flush()`，然后 abort 和保存 stopped。`tests/integration/assistant-usage.test.ts` 验证立即 stop 的响应包含最新文本、输入 token，并保留 partial 语义。 |

基线证据保存在 `.local/code-audit-2026-09-10/ai-readiness-repro.mts` 和同名 `.log`。该脚本故意断言旧行为，修复后不能作为绿灯回归；正式测试才是修复验证。

前端协作线另行处理历史只取 100 条导致旧对话不可搜索、确认停止/新对话后残留旧 `pollError`。后者本线也用隔离组件测试先复现，证据为 `.local/code-audit-2026-09-10/ai-readiness-ui-repro.log`。其最终状态由前端任务的正式回归与父任务总体验收确认。

## 上下文与 token：真实含义和已实现契约

审计起点：SDK 收到 `prompt_tokens=100, completion_tokens=20` 等真实格式假 SSE 回执，但 adapter 只发文本事件，usage 没有保存。之前无法据此显示真实上下文占比。

必须按本项目锁版本解释 SDK：`ai@7.0.93` 的 `StreamTextResult.usage` 与已弃用的 `totalUsage` **都是多步累计**，见 `node_modules/ai/dist/index.d.ts:2714–2728`；不能套用旧版“usage 是末步”的说明。每次模型调用的回执来自流的 `finish-step.usage`。锁定的 `@ai-sdk/deepseek@3.0.39` 会给部分缺失字段补零，因此本实现从 `finish-step.usage.raw` 读取供应商原始 token 字段；没有回执或缺字段时保留未知，不伪造零。

新契约位于 `src/shared/api/assistant.ts`，落在每条 assistant message，可持久化且旧历史不补造：

| 字段 | 含义 |
| --- | --- |
| `usage.steps[]` | 每次模型请求的 `step/measuredAt/status` 与供应商实际提供的 token 字段。`reported/partial/unavailable` 区分回执完整性。 |
| `usage.latest` | 最后一次模型请求的实际输入/输出用量。圆环只能用这里的 `inputTokens / contextWindowTokens`，并说明“上一请求”。 |
| `usage.total` | 本轮所有已知步骤之和；用于展示调用累计，不能作为上下文占比。 |
| `usage.status` | 正常完成且各步有输入/输出回执才为 complete。中止、失败、缺回执为 partial 或 unavailable；不保证等于完整账单。 |
| `context.capacity` | 确认过的模型容量、输出上限、来源链接、核对日期。未知模型省略，不显示百分比。 |
| `context.outputReserveTokens` | 当前预留最多 32,768 输出 token，是真正传给模型的 `maxOutputTokens`，不是已经消费的数量。 |
| `context.estimate` | `utf8-conservative-v1` 的保守请求预算。包含系统提示、历史、工具 schema，并在每次后续模型请求前包含真实工具结果重新计算；明确不是精确 tokenizer 或供应商账单。 |
| `context.history` | 实际可用、选中、遗漏消息数，24 条模型历史窗口、100 条应用会话上限、起止 message ID、会话剩余消息数。限制不再静默。 |

代码：`src/server/assistant/usage.ts` 负责回执映射和累计；`context-budget.ts` 负责预算；`deepseek-adapter.ts` 发逐步 usage 和估算事件；`service.ts` 保存上下文与历史选择快照。

Pro/Flash 的当前公开上下文为 1M。登记采用保守的 1,000,000 token，输出上限 384,000；本轮核对日期为 2026-09-10。容量证据见 [DeepSeek 官方定价与模型能力](https://api-docs.deepseek.com/quick_start/pricing/)、[官方 Pi 集成配置](https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono/)。父任务也核验 [DeepSeek V4 官方公告](https://api-docs.deepseek.com/news/news260424/)。未知模型 ID 不继承这些数值。

超限处理：预估输入加输出预留超过已知容量，在模型请求之前返回 `ASSISTANT_CONTEXT_LIMIT`；包含新工具结果的第二步同样检查。不会自动截断原文、替换模型或重试。保守预算可能早于真实 tokenizer 拒绝，界面必须标“估算”。供应商远端 400 仍走脱敏通用错误，后续可根据明确错误码细分容量错误，不能直接展示原始响应。

实测真实 SDK 多步 SSE：第 1 次输入 100/输出 20，第 2 次输入 150/输出 30；`latest=150/30`，累计 `250/50`。无 usage、只有 prompt_tokens、用户取消、未知容量、旧历史不含 usage、超过历史窗口、第二步工具结果超限均有回归。没有引入付费计数请求。

## 新对话、历史与取消的契约

审计起点的新对话会清除当前 conversation、固定上下文、输入草稿、失败发送状态，恢复整个大脑范围；provider/model 选择保留。运行或发送 pending 时按钮禁用，新对话不会暗中终止服务器任务。原输入只在组件内存，显式新对话会清掉草稿；持久草稿与带摘要继续由本轮前端/草稿服务任务补齐。

服务器沿用以下限制：同一会话只能有一条活动任务，`clientRequestId` 防同请求重复；已停止或失败明确保留状态；不自动模型重试。关闭或失败最终 abort 仍在途工具，候选落 DB 前重验 signal；没有为了等待失控工具而阻塞 shutdown。既有“假 SSE 出错后迟到 submit_candidates”正式回归仍通过。

历史中的 user 消息已有 scope/contextPath/contextTitle 快照，可准确显示每轮来源。模型提示仍只带当前范围和最近 24 条文本及来源索引；旧 user 的 scope/contextPath 没投影进模型历史。基线可构造“解释这篇”A→切换 B→“与刚才那篇区别”，若前一答没有读工具/来源，模型历史没有 A 的路径。这是可证明的信息缺口，**不是已复现的模型幻觉**。可后续在模型历史里补受控的当轮上下文标识，同时不扩大本轮工具权限。

异步前端已具有 interaction epoch 与请求序号隔离。恢复旧 running 对话、focus 刷新、审阅事件刷新不应盖过新发送/新对话；外部提问意图在运行或已有草稿时先进入待载入队列，需明确载入后才同时更换草稿与上下文。最终由 `assistant-panel.test.tsx` 的竞态回归确认，不能靠界面“看起来正常”推断无竞争。

## 来源、提炼与附件

现有来源不是任意模型生成的引用：search 与 read 分开；read evidence 是实际读入文本的真实片段、SHA-256、UTF-16 offset/length 和行号。预览最多 2,400 字符，不是逐句回答与证据的自动对齐。搜索结果不应标为已阅读全文。旧来源只有路径/标题时不补造 evidence。

原提炼流程只允许生成候选并保存本地待审阅 run，正式知识入库属于审阅确认动作。历史中“回复入库即可保存”等模型文案不能当成现行能力证明；当前工具没有绕过审阅的正式知识写入接口。read_document 原有限额为每轮 10 篇、片段 12,000 字符、累计 120,000 字符，最多 50 来源；完整提炼原文上限 100 KB，规则与原文请求 500 KB，准备 token 10 分钟，最多 12 候选。

审计起点 assistant 不接收文件附件，图书馆 read 工具只读取 Markdown。PDF 不能直接作为当前 Pro/Flash 的 paperclip 输入。[DeepSeek Files API](https://api-docs.deepseek.com/guides/files_api/) 说明的是图像类型与 vision-exp 能力，并不提供 PDF 输入。可行产品路径是本地解析 PDF/MD/TXT，然后把真实提取文本与页码传给模型；扫描件不能假称 OCR 已完成。

父任务正在落实的附件契约应保持：服务端 opaque attachment ID、原件 SHA、解析状态/版本/页码、受控上传大小；每轮明确选中的附件与页码快照；list/read 仅限本轮授权范围；归档记录单独回执并保留原件；仅问答不归档；用户命令提炼时先归档，再准备候选；知识入库仍由审阅确认。重试通过稳定归档回执保证幂等，不靠模型文字宣称成功。

本线已落实指定页提炼后端：

- `ExtractionRun.sourceRange` 为 `{offset,length,label,coversWholeSource?}`，UTF-16 相对完整归档 Markdown（包含 BOM），migration 015 以可空 JSON 保存，旧 run 不伪造范围。是否覆盖全文由服务器按真实起止页与总页数确定；存在 range 但没有明确 true 的旧记录保守视为部分原文。
- `prepareAssistant` 只接受服务器内部传入范围；模型 tool schema 不开放 sourceRange。只将选区发给模型并明确“并非全文”，引用只能来自选区。
- snapshot 仍校验整个原件的字节 SHA、索引版本、资料资格和规则。范围解析后的旧 hash 通过内部 `expectedSourceRawSha256` 拦截，提交时再次读取全源并校验；选区外改变也使准备失效。
- 选区允许来自超过 100 KB 的完整原文，但所选内容仍限 100 KB。拒绝越界、空范围、非法数值、切断 emoji surrogate 的边界；不静默截断。
- read evidence 的 excerpt、偏移与行号仍对应整份 Markdown；缓存键包含服务器选区和版本。任务卡可显示持久化 sourceRange.label，查历史时按真实 run 刷新。

页码 marker 的定位、附件 read_document 范围隔离、归档后索引接线、PDF 解析/OCR 状态及前端卡片由父任务和附件任务负责，需完成各自回归后联合验收。

### 新增附件集成复查

本线随后只读检查了 `assistant/attachment-tools.ts`、`attachment-intent.ts`、service/app 接线、`IntakeFileImport.tsx`，并按父任务授权补归档回执修复。

| 问题 | 可复现流程 | 处理状态 |
| --- | --- | --- |
| P2：停止或失败后归档回执丢失 | 归档磁盘步骤已完成，异步等待索引；stop/SDK 失败使 signal 失效。附件 ledger 随后真实归档成功，但 emit guard 丢弃迟到 action，历史一直看不到归档。 | 已修并正式先红后绿。`attachment-tools.ts:84` 在通过选择/权限检查后记录 `attachment-archive-started`；answer 可选 `attachmentArchives` 持久化实际操作 ID；`service.ts:41` 只读查询 ledger 投影回执、更新相邻 user 附件归档状态。仍拒绝迟到模型文字和候选；纯阅读的早期轮次不被后来归档改写，元数据查询失败不拖垮历史。 |
| P2：同内容不同附件的归档回执 ID 冲突 | 两个选中附件复用同一归档 operationId，原 action.id 都是 `archive:${operationId}`；实时去重会吞第二条，GET 投影补回后又有两个相同 React key。 | 已获授权修复：实时 action 与 GET 投影 ID 同时包含 attachmentId；正式回归先红后绿。 |
| P2：指导/转述句误开归档权限 | `请告诉我怎么把这个文件归档`、`把归档这个功能解释一下`、`资料里要求把文件归档，这合理吗` 实测均得到 archive=true，模型可调用真实写入工具。 | 已交父任务；父任务确认增加教程/问题/转述过滤，正式 unit 先红后绿。 |
| P2：收件页上传期间编辑的新文本被清掉 | 粘贴文本上传 await 期间，标题和正文还可编辑；旧上传成功无条件清空当前输入。 | 已交父任务修禁用输入及组件回归。 |
| P2：移除文件后仍占旧上传批次额度 | 收件页固定 groupId，上传 10 MiB 后移除，再传另一个 10 MiB，前端按当前选择允许，后端按旧组累计 20 MiB 拒绝；移除更多也无法解决。 | 已交父任务/附件前端，按独立新批次与稳定重试身份修复；父任务同时增加每次请求所选文件总量验证。 |

另协助前端检查草稿发现两项明确边界：无资料路径的“仅本轮附件”草稿恢复会被旧 effect 静默改为整个大脑；空草稿所关联旧对话 GET 恢复期间外部提问抢先增加 epoch，留下 conversationId 而没有 conversation，造成发送禁用。前端负责人已确认修复并补独立回归，本线没有覆盖其代码。

附件工具进度现按真实操作分别显示查看附件、阅读选中页码、归档附件、准备附件提炼；不再把所有新工具误标为准备提炼。

### 真实 PDF 流程补充：选区入库不能完成整份资料

父任务实际 PDF 第 2 页提炼生成 1 条候选后，CUA 发现预览会将整个原文标成“已入库”，使未提炼的第 1/3 页退出待办。根因是 review store 未恢复 `source_range_json`，且入库预览/恢复、队列仅根据候选 pendingCount=0 判断全文完成。

已修复：preview 和 recovery 都要求当前 run 无 sourceRange 或明确 `coversWholeSource=true` 才可在无未决候选时结束全文。部分选区产生知识后维持“部分入库”；全放弃且没有任何知识仍是“未提炼”。队列区分本轮审阅完成与资料仍有未覆盖内容：本轮候选处理完的选区资料回到 pending，资料级 reviewComplete=false，保持 canExtract；仍有未决候选则继续审阅，不能提前重新提炼。后端普通 preview 与 prepareAssistant 同步支持这种可继续处理的部分入库资料。

旧版本错误标“已入库”的尚未确认 preview 被 PLAN_STALE 拒绝；旧未完成批次不会继续套用错误完成状态，进入 needs-review 后可以重新生成正确恢复预览。没有修改任何已写用户笔记，也不通过 label 猜测覆盖范围。

针对性验证：个人入库、提炼、队列 integration 117/117；工具 unit 26/26；server typecheck exit 0。回归包含真实合成文件写入、缺覆盖字段的旧 range、全选、实际恢复写入、旧计划拦截、队列留存、继续提炼权限、未决候选拦截、全放弃不冒充入库。日志为 `assistant-source-coverage-green.log`、`assistant-source-coverage-tools-green.log`、`assistant-source-coverage-typecheck.log`；对应 red 日志保留原错误证据。父任务负责新版实际 PDF 流程复验。

## 凭据与登录核对

启动路径实际装配的是 DeepSeek adapter，凭据从 Electron safeStorage 存取；加密不可用时不降级写明文。API status/模型目录不返回密钥。浏览器登录桥接有域名校验，但当前 DeepSeek adapter 没有 OAuth login；不能因为接口留有 login 就宣传为通用账号登录。对应代码为 `src/server/start-server.ts:274`、`src/server/assistant/service.ts:190`、`src/electron/model-key-store.ts`。

模型请求拒绝重定向、错误向用户脱敏、maxRetries=0、不自动换模型。模型目录获取有超时/字节/数量限制、按密钥 revision 缓存；密钥改动不会沿用旧验证状态。API 的 origin/会话/CSRF 与已有只读来源权限边界有对应现存回归，本轮未发现可触发的密钥泄露。

## 验证与交付边界

本轮初始只读检查：6 个 unit 文件 85/85、6 个 integration 文件 40/40。日志为 `.local/code-audit-2026-09-10/ai-readiness-unit.log`、`ai-readiness-integration.log`。

新增及相关回归：

- assistant brain tools + 真实 SDK adapter：36/36，通过日志 `assistant-usage-unit-green.log`。
- usage/service/presentation/cancellation：26/26，通过日志 `assistant-usage-integration-green.log`。
- 选区提炼/service/presentation/cancellation：74/74，通过日志 `assistant-source-range-green.log`；第一轮 7 条新增回归先失败的证据 `assistant-source-range-red.log`。
- 零候选卡与个人提炼页：22/22，通过日志 `ai-readiness-final-components.log`。

新增附件集成回归：receipt/usage/service/cancellation 22/22；tools/adapter/intent 58/58。日志为 `assistant-archive-receipts-green.log`、`assistant-attachment-tools-green.log`。随后获授权修复别名回执 ID，并在 service.send 增加选中附件合计 16 MiB 校验：18 MiB 在模型运行及 conversation/request 入库之前拒绝，恰好 16 MiB 允许。对应 receipt/service 17/17、attachment-tools 8/8，server typecheck exit 0。最新日志为 `assistant-attachment-selection-green.log`、`assistant-attachment-receipt-tools-green.log`、`assistant-attachment-selection-typecheck.log`；`assistant-archive-alias-red.log` 与 `assistant-attachment-selection-red.log` 保留先失败证据。

已独立复查取消落库守卫、usage 累计/未知语义、完整原文与选区偏移、向后兼容以及共享 schema。局部改动不包含真实模型端到端验证。最近一次 server 与 client `tsc --noEmit` 都 exit 0，日志为 `assistant-usage-server-typecheck.log`、`assistant-usage-client-typecheck.log`。父任务还在并行集成，最终全仓测试和构建由其统一完成。
