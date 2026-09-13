# 文件入口、存储与 PDF 就绪审计 · 2026-09-10

## 结论

现有系统已经具备可靠的 **Markdown 资料包归档 → 提炼候选 → 确认入库 → 回收/恢复** 基础。用户要的“直接给问问一个 PDF，再说归档或提炼”尚未实现；缺的是文件接收、附件身份与持久化、本地解析，以及问问到归档服务的工作流连接。只增加一个上传按钮，或把 PDF 作为 Markdown 的附件搬入图书馆，不能完成这个需求。

本轮对存储链路未确认新增高置信 P1/P2。既有同路径删除历史修复仍在；本轮完整 integration 日志包含相关正式回归。这里的结论限于下述代码检查与隔离测试，不把缺失的新能力伪装成当前实现的数据丢失缺陷，也不重复报告已修复问题。

推荐先实现 **MD/TXT + 文本 PDF + 明确标记的本地 OCR**，保留上传原件并生成独立的解析文本。用户只提问时不归档；明确说“归档这份”时走归档工作流；说“提炼”时先保证资料已归档，再生成待审候选。正式知识入库继续使用现有版本检查与入库计划。

## 审查范围与验证

- 工作区：`PROJECT_ROOT`，包括进入本轮前的 dirty/untracked 实现。
- 检查：intake service/plan/archive/snapshot、ingestion service/coordinator/review-store、两套 trash service/native port、文件网关与只读 helper、SQLite kernel、start-server、Electron main/preload/navigation，以及问问输入 schema/工具边界。
- 没有改业务代码、访问或写入真实资料、调用真实模型、启动 Electron 或浏览器、重建/清理 dist，也没有 Git 提交。外部依赖说明仅查询公开官方文档。

| 本轮证据 | 结果 | 边界 |
|---|---:|---|
| 主审全量 unit | 778/778 | 复用并读取 `/tmp/brain-readiness-unit.log`，没有重复执行 |
| 主审全量 integration | 478/478 | 复用并读取 `/tmp/brain-readiness-integration.log` |
| native-read helper contract | 11/11 | 临时夹具编译 helper；检查路径/身份、并发读取与原始字节 |
| intake-service、intake-archive、intake-crash、personal-trash-flow | 51/51 | 临时 Vault、真实原生归档模块、SQLite/HTTP、崩溃恢复；使用既有 dist 原生模块 |
| 本轮新增 PDF 能力探针 | 通过 | 599 字节自生成合法文本 PDF；主文档/附件哈希、重复提交、重开端口、请求 schema |

原生归档源码修改时间为 2026-09-07，所用个人原生模块构建时间为 2026-09-10；本轮未重新跑所有 native writer 合同或 Electron 退出合同。不能将前轮这些合同的通过数记作本轮重新验证。

复现脚本：[files-probe.mts](PROJECT_ROOT/.local/files-readiness-audit-2026-09-10/files-probe.mts)。运行：

```sh
node --import tsx .local/files-readiness-audit-2026-09-10/files-probe.mts
npx vitest run --config vitest.native.config.ts tests/native/native-read-helper.contract.test.ts
npx vitest run --config vitest.archive.config.ts tests/archive/intake-service.test.ts tests/archive/intake-archive.test.ts tests/archive/intake-crash.test.ts tests/archive/personal-trash-flow.test.ts
```

脚本使用现有受保护的测试夹具，在 finally 关闭原生端口并清理临时 Vault/恢复目录。可复用脚本及三份日志保留在 `.local/files-readiness-audit-2026-09-10/`，没有保留测试 PDF 或临时资料库。

## 现有入口的真实能力

| 输入/操作 | 当前行为 | 依据 |
|---|---|---|
| 在问问粘贴文字 | 支持，单条最多 16,000 字符；会话请求没有附件字段 | [assistant.ts:22](PROJECT_ROOT/src/shared/api/assistant.ts:22) |
| 向问问选文件、拖入 PDF/图片/DOCX | 不支持；没有上传路由/附件表/解析器；严格 schema 拒绝额外 `attachments` 字段 | 同上；[assistant routes:9](PROJECT_ROOT/src/server/api/routes/assistant.ts:9)；`package.json` 无 PDF/OCR 依赖 |
| Electron 选择本地文件 | 当前唯一选择对话框用于选择整个 Vault 目录，没有“上传附件”的 IPC | [main.ts:64](PROJECT_ROOT/src/electron/main.ts:64)，[preload.ts:4](PROJECT_ROOT/src/electron/preload.ts:4) |
| clipper 顶层目录包，内有主 `.md` | 支持推断资料字段、预览、确认归档；主文档与包名规范化，原件留恢复记录 | [intake-service.ts:62](PROJECT_ROOT/src/server/services/intake-service.ts:62) |
| clipper 顶层单个 `.md` / `.txt` / `.pdf` | 显示“这是单个文件，当前需按资料包归档”，不移动 | 同上第 65 行；PDF 探针实证 |
| 仅有 PDF 的目录包 | 显示“没有找到主 Markdown”，不解析、不归档 | 同上第 68–69 行；PDF 探针实证 |
| 主 Markdown + PDF/图片/任意普通二进制附件 | 可以一起移动并保留附件字节；PDF 内文不进入主 Markdown，也不会自动被提炼 | [archive-snapshot.ts:51](PROJECT_ROOT/src/server/archive/archive-snapshot.ts:51)，PDF 探针实证 |
| 在 Vault 放入合规的已归档 Markdown | 扫描后可检索、提炼；没有“从桌面导入”的用户入口；PDF 不入索引 | [SearchIndexer.ts:192](PROJECT_ROOT/src/server/index/SearchIndexer.ts:192)（只收 `.md`） |
| 问问要求“提炼当前资料” | 支持准备完整 Markdown 证据并提交待审候选；不正式入库 | [brain-tools.ts:139](PROJECT_ROOT/src/server/assistant/brain-tools.ts:139) |
| 问问要求“归档这个文件”“将候选正式入库” | 无对应工具；现有工具只有检索、读文档、准备提炼、提交候选 | [brain-tools.ts:96](PROJECT_ROOT/src/server/assistant/brain-tools.ts:96) |
| 正式知识入库 | 候选审阅页支持新增/合并/仅引用；预览后确认，支持未完成批次恢复 | [ingestion-service.ts:138](PROJECT_ROOT/src/server/ingestion/ingestion-service.ts:138) |
| 回收未归档资料包 | 整个包和附件一起回收、恢复；部分彻底删除需重新预览剩余内容 | [intake-trash-service.ts:352](PROJECT_ROOT/src/server/trash/intake-trash-service.ts:352) |
| 回收已归档资料/知识 | 只处理选中的 Markdown，附件与父目录仍留原处；不能把它当作“删除整个 PDF 资料包” | [trash-native.ts:3](PROJECT_ROOT/src/server/trash/trash-native.ts:3) |

PDF 探针输出要点：`markdownPlusPdf=archived`、`pdfTextEnteredMarkdown=false`、`originalMarkdownBytesPreserved=true`；重复提交与重启后 resume 返回同一操作，没有新增 journal。附件 SHA-256 为 `b8d8fd799f12a7b9fcaa4714df6be44c9900d339e31971dabeee92bb6e2b74b1`。

## 可直接复用的存储能力与恢复语义

### 归档

`intake.preview → planIntakeMain → captureArchiveTree → prepareIntakeArchive → executeIntakeArchive` 已经负责字段、命名、整包快照、旧主文档保留、主文件交换与目录移动。确认前重新检查完整包、规则与目标冲突；同 token 复用 operationId，重启后通过 operationId 继续。参见 [intake-service.ts:88](PROJECT_ROOT/src/server/services/intake-service.ts:88)、[intake-archive.ts:150](PROJECT_ROOT/src/server/archive/intake-archive.ts:150)、[intake-archive.ts:213](PROJECT_ROOT/src/server/archive/intake-archive.ts:213)。

限制必须在上传前后分层展示：单文件 10 MiB、包总量 16 MiB、最多 10,000 项、深度 64；journal 上限 32 MiB。归档预览截取最多 30,000 字符用于展示，但实际写入按完整字节验证。这些限制不能因新增上传入口而绕过。新增普通本地资料可使用已存在的平台“个人/其他”，不必增加来源枚举或改真实 Vault 规则。

原始正文保留；已识别的插件 metadata 会规范化，原 Markdown 整体仍留 stage。对 PDF 必须采用更清楚的双层契约：**PDF 原件字节完全保留；解析 Markdown 是带版本的派生文本，不宣称排版或文字序列与 PDF 二进制等价。**

### 提炼与入库

提炼入口目前要求：已归档、`未提炼`、索引与原文哈希一致、完整 Markdown ≤100,000 字节；超过就拒绝，不截断。普通提炼重复 start token 不重复请求；异常重启将 generating 标记 failed，不自动重新付费请求。参见 [extraction-service.ts:67](PROJECT_ROOT/src/server/services/extraction-service.ts:67)、[extraction-service.ts:134](PROJECT_ROOT/src/server/services/extraction-service.ts:134)、[extraction-service.ts:256](PROJECT_ROOT/src/server/services/extraction-service.ts:256)。

正式入库先持久化确认批次和候选绑定，再按顺序执行知识文件和原资料回链。每份文件保留 before/after、原生独占创建或交换、逐步验证；这是可恢复批次，不是跨多文件原子事务。完整回执后重试只重建索引，不重写文件。启动恢复只推进已确认批次，外部改动转为 `needs-review`。参见 [ingestion-service.ts:235](PROJECT_ROOT/src/server/ingestion/ingestion-service.ts:235)、[ingestion-coordinator.ts:102](PROJECT_ROOT/src/server/ingestion/ingestion-coordinator.ts:102)、[start-server.ts:199](PROJECT_ROOT/src/server/start-server.ts:199)。

删除后的同路径新资料聚合已应用删除 cutoff，历史仍按 ID 可读：[review-store.ts:45](PROJECT_ROOT/src/server/ingestion/review-store.ts:45)。新附件层应使用稳定 documentId/attachmentId，避免再把“同名文件”当成同一文档身份。

### 回收、重启和桌面边界

已归档 Markdown 回收采用持久意图与 SQLite；启动只校验，不自动移动或删除。收件箱包回收采用独立目录与不可变意图；已使用的永久删除 token 只查询结果，不能继续删除剩余树。两者恢复均拒绝覆盖同名新文件。归档与收件箱回收共享应用互斥门；未完成入库会阻止关联资料回收。参见 [trash-service.ts:71](PROJECT_ROOT/src/server/trash/trash-service.ts:71)、[trash-service.ts:296](PROJECT_ROOT/src/server/trash/trash-service.ts:296)、[intake-trash-service.ts:488](PROJECT_ROOT/src/server/trash/intake-trash-service.ts:488)。

原生路径依靠目录描述符、root/dev/inode、同盘限制、无符号链接、独占锁与 rename 前后验证；没有开放任意写文件 IPC。Electron 窗口保持 sandbox/contextIsolation，主 IPC 验证当前主窗口和同源 mainFrame。退出实现为 `idle/closing/ready`，待窗口准许退出后才关闭服务。参见 [sandbox-archive.c:776](PROJECT_ROOT/native/macos/sandbox-archive.c:776)、[sandbox-archive.c:1136](PROJECT_ROOT/native/macos/sandbox-archive.c:1136)、[main.ts:21](PROJECT_ROOT/src/electron/main.ts:21)、[main.ts:142](PROJECT_ROOT/src/electron/main.ts:142)。这不等于允许未来上传接口让客户端传任意绝对路径。

一个现存的明确恢复边界：归档 stage 已落盘但 intent 缺失/损坏时会保留文件并暂停后续归档，不能仅靠 App 的 resume 自动修复。当前代码和测试有意采用此行为，不能删除 stage 来“解除阻塞”。附件工作流应展示可定位的恢复项与原因，避免只显示收件箱整体不可用。参见 [intake-archive.ts:107](PROJECT_ROOT/src/server/archive/intake-archive.ts:107)。

## 附件 → 问问 → 归档 → 提炼：最小闭环

以下是设计建议，尚未实现。

```text
选文件 / 拖入
  → 受控接收 + 原件哈希 + attachmentId
  → 本地解析作业（页号、文本、解析器版本、OCR 标记）
  → 问问附件卡：已解析 / 需密码 / 需 OCR / 部分失败 / 超限
  ├─ 只提问：按 attachmentId 读取派生文本，不写入图书馆
  └─ 明确归档意图：构造资料包 → 现有归档计划/执行 → materialPath 回执
       └─ 明确提炼意图：等待索引同版本 → prepare_extraction / submit_candidates
            → 待审候选 → 现有正式入库计划 → knowledgePaths 回执
```

1. **受控接收。** 增加 `AttachmentStore` 和新的文件接收路由，前端发送 bytes/File，或由受限 Electron picker 交付一次性文件句柄；服务端不接受“任意绝对路径”来读用户磁盘。原件复制到当前 Vault 对应的 appData 管理目录，保留原桌面文件。接收记录至少包含 attachmentId、originalFilename、mime/实际格式、bytes、sha256、createdAt、解析状态。未完成上传只清理已确认属于本作业的 `.part`，不删源文件。
2. **本地解析。** 使用独立 helper/worker，输出按页的不可变派生文本和转换版本；PDF 解析失败仍可保留原件供归档。先支持 UTF-8 TXT/MD 和文本 PDF；扫描页进入 OCR 分支，不生成伪空正文。解析状态持久化，重启可继续本地作业；不因此恢复或重发模型请求。
3. **问问附件身份。** 会话请求新增 `attachmentIds`，消息持久记录这些 ID 与所用解析版本；正文不塞进 16,000 字符用户输入框。新增只读 `read_attachment`，沿用 evidence 引用预算，引用应含 attachmentId、页号、textRevision、原件 sha。重开聊天可读同一个附件，不能依赖内存 File/临时 blob URL。
4. **桥接现有归档。** 第一版可由受控 staging publisher 将 `原文.md + 附件/原始文件.pdf + 解析信息.json` 完整发布为现有 `小兆clipper/<generated-id>` 包，再由 IntakeService 归档；这是内部兼容桥，用户无须使用 clipper。publisher 需要新的受限能力：唯一服务生成名称、完整包 ready 后原子发布、确认同盘、不得复用任意路径写接口。不要只在 renderer 用 fetch 写进现有目录。
5. **持久工作流回执。** `AttachmentWorkflow` 记录 attachmentId、intentId、action、archiveOperationId、materialPath、runId/batchId、阶段与错误。归档引擎产生 operationId 后、执行文件变化前，须让工作流能可靠找回该 ID；响应丢失不能换 token 再建新包。重复命令通过同一 clientRequestId/intentId 查询旧结果。识别已有相同原件 sha 时先给出已有资料链接，不按同名猜测是否重复。
6. **自然语言命令的边界。** 用户明确“归档这份”且只有一个附件、字段完整时，服务应完成准备与执行并返回落点，不迫使用户跳到另一个页面重复发同一命令；服务端将实际用户消息/附件/动作绑定为一次意图。缺标题、多个附件不明、重名冲突时在聊天内展示待补字段/计划。模型工具自行提出“归档”不是授权。只说“看看这份”不可归档；说“提炼”可串联归档和生成候选；“提炼”仍不意味着覆盖正式知识。
7. **正式入库与回收。** 复用已有候选、版本、quote 校验、入库 diff 和恢复，不开一个绕过验证的“AI 直接写 Markdown”捷径。第一版归档 PDF 的删除文案必须说明是回收资料笔记还是整个包；若承诺原件也进回收站，则需要新增已归档包的身份/成员清单和恢复事务，不能直接复用单 Markdown trash。未归档聊天附件移除与已归档原件生命周期分开，已有引用不得被临时清理误删。

需要扩展的模块边界：`shared/api/attachments`、`server/attachments/{store,parser,workflow}`、附件 API、桌面受限接收能力、问问附件卡/工具/消息 schema、DB 附件和工作流表、打包 parser/helper。现有 IntakeService/IngestionService 继续作为正式落盘执行者；不需要先建立向量数据库或上传到云端文件库。

## PDF 解析方案与真实边界

当前依赖没有 PDF/OCR 解析器。公开官方文档已核对：DeepSeek Files API 当前接受 JPEG/PNG/GIF/WebP，并配合其视觉实验模型；不能把 PDF 原件直接交给该接口当作已支持的文本输入。此结论与现有项目没有图片消息适配的事实分开，详见 [DeepSeek Files API](https://api-docs.deepseek.com/guides/files_api/)。

| 文件类型 | 推荐第一版行为 | 需要补齐 |
|---|---|---|
| UTF-8 `.txt/.md` | 本地读取、保留原件；生成合规资料包装时分离原件与管理 YAML | 受控接收与包装；无额外模型调用 |
| 文本 PDF | 本地逐页抽取文本，保留页号；展示解析覆盖范围，再供问问使用 | `pdfjs-dist` 独立 worker/helper，或 macOS PDFKit helper |
| 纯扫描 PDF / 图片 | 逐页渲染后做本地 OCR；未开启/失败时显示“没有可用文字”，仍能仅归档原件 | macOS Vision `VNRecognizeTextRequest` + PDF 页渲染；需要语言/页级质量状态 |
| 混合 PDF | 每页检测文本层，只有缺少有效文字的页进入 OCR；记录每页来源，避免重复两份文字 | 页级 manifest、重复内容处理、部分失败提示 |
| 有密码 / 损坏 PDF | 明确显示需密码/解析失败；不能把失败当成功空文本 | 密码只用于本次本地解锁，错误可重试；解析作业取消与资源限制 |
| 超过当前入库链路的长 PDF | 可保真归档；提炼前说明完整派生文本超过 100,000 字节；支持选择明确页段，后续再做分段聚合 | 不能静默截断后称“全文提炼”；须新增 excerpt identity/页段与原件关系 |
| 复杂多栏、表格、数学公式、手写 | 保留页图与原件，抽取文字标明局限；不要宣称保留原版阅读顺序或公式准确性 | 逐页人工核对/后续结构化解析能力 |

依赖取舍：

- **最小跨平台文本解析：`pdfjs-dist`。** 官方 `PDFPageProxy.getTextContent()` 返回页文本内容，可提供页号与布局信息；其 API 文档明确说明空白会标准化，不能把提取文字宣称为字节保真。现有 Electron/Vite 需要显式打包 worker 与资源，服务端解析放独立进程，不能在原生归档同步调用中跑长时间解析。参见 [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html)。
- **与当前 macOS 专用 App 一致的另一实现：系统 PDFKit + Vision helper。** PDFKit 提供文档/页文本，Vision `VNRecognizeTextRequest` 对页图做 OCR；这是系统框架，不是 npm 上同名的 PDF 生成库。可以不引入 Python/常驻服务，但需新增编译/打包、协议、取消、逐页测试，并核验目标 macOS 的实际语言支持。参见 [Apple PDFDocument.string](https://developer.apple.com/documentation/pdfkit/pdfdocument/string?language=objc)、[Apple Recognizing Text in Images](https://developer.apple.com/documentation/vision/recognizing-text-in-images)。

本轮没有安装或运行上述新解析器，因此没有声称中文多栏、OCR 准确率、扫描长文速度已通过验收。文本层存在也不代表正文完整；页眉/水印可能是唯一文本，需结合页级有效文本量和预览判定。

建议验收第一批使用自制/公开可分发夹具：中文文本 PDF、纯扫描、中英混合、部分扫描、有密码、损坏、同名不同内容、同内容重复上传、解析中取消/重启、归档响应丢失、源文件在选择后变化、超过 10 MiB 原件/16 MiB 包/100,000 字节派生文本。各用例必须同时断言原件 hash、状态与回执，不能只断言上传按钮出现。

## 建议交付顺序

1. 文件接收与本地附件会话：上传后能读，重启后能继续，明确告知未归档。
2. 聊天内“归档这份”：可见目标和完成回执，重复命令不重复落盘，已有归档可直接打开。
3. “提炼这份”：必要时串联归档、索引和候选生成；把候选审阅入口带回当前对话。
4. 本地 OCR、页段提炼与完整的已归档附件回收语义；在这些上线前明确显示对应能力状态。

前两步不依赖模型质量；第三步复用现有候选与入库验证。这样每一步都有可独立验收的产物，并且不会把文件已经存好、AI 已读完和知识已入库混成同一个“完成”。
