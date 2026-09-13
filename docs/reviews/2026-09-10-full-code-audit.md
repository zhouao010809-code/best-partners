# 小兆大脑代码审查 · 2026-09-10（历史基线）

后续修复及最终验证另见 [修复记录](2026-09-10-code-audit-fixes.md)。下文仅保留修复前审查基线，不代表当前公开版本仍然存在所有列出的问题；发布判断以最新走查和测试结果为准。

## 结论

发现 6 个已通过隔离复现确认的功能缺陷，以及 1 个从代码确定的构建环境缺陷。优先修复退出时停止服务的顺序，其次修复草稿隔离、资料生命周期隔离和 AI 异常取消。

本次仅审查并生成报告，未修复或提交生产代码。测试使用临时测试库、内存数据库和模拟模型响应，没有对真实大脑执行归档、入库或删除，也没有调用真实付费模型。

## 范围与方法

- 实际运行项目：`PROJECT_ROOT`。
- 基准提交：`920709934624fb2148190915d2186d47117db043`；审查包含当前工作区修改及未跟踪的新代码，并非只审查该提交的 diff。
- 覆盖客户端页面与 API、提炼/候选/AI 服务、索引与查询、文件归档/入库/回收/恢复、SQLite、原生文件模块、Electron 启停/凭据/IPC、安全策略及构建脚本。
- 四个审查工作流分别追踪存储、AI 后端、前端、运行环境，并对候选问题复核调用链、隔离复现和现有测试。
- 没有对全部打包 Electron UI 流程重新运行端到端测试；本次执行的测试范围见下表。审查结果不构成“其余代码没有 bug”的保证。

## 发现

### 1. [P1] 候选阻止退出时，窗口留下但本地服务已关闭

位置：[main.ts:142](PROJECT_ROOT/src/electron/main.ts:142)，关联 [CandidateReview.tsx:124](PROJECT_ROOT/src/client/pages/queue/CandidateReview.tsx:124)。

触发：编辑候选，在草稿尚未保存或保存失败时使用 Cmd+Q / 应用退出。

`before-quit` 先设置 `quitting=true` 并关闭后端，完成后再次 `app.quit()`。但候选编辑器的 `beforeunload` 会阻止窗口关闭。结果是用户仍留在编辑窗口，而本地接口已停止；再次保存或重试均无法连接，且主进程不恢复后端。未同步编辑只能滞留在这个失去服务的窗口。

实际 Electron 44 的隔离窗口复现：

```json
{"backendClosed":true,"quitting":true,"unloadPrevented":true,"windowAlive":true}
```

修复方向：先完成窗口/草稿是否允许退出的判定，在确定退出后关闭后端；取消退出时应保留服务及正常生命周期状态。Electron 官方明确允许 `beforeunload` 取消退出，参见 [app.quit 文档](https://www.electronjs.org/docs/latest/api/app#appquit)。

### 2. [P2] 同一候选的多个窗口会互相删除未同步草稿

位置：[CandidateReview.tsx:49](PROJECT_ROOT/src/client/pages/queue/CandidateReview.tsx:49)、[CandidateReview.tsx:52](PROJECT_ROOT/src/client/pages/queue/CandidateReview.tsx:52)。

触发：两个浏览器窗口打开同一候选；B 修改后保存失败，临时草稿写入 localStorage；A 随后成功保存自己的版本；B 切走再打开。

草稿 key 只有 run/candidate 身份，多个窗口共用；A 的成功保存执行无条件 `removeItem`，删掉 B 的草稿。B 内存仍显示自己的编辑，页面仍认为可保留临时草稿后离开；重新进入后，B 的未同步内容已经丢失。

隔离组件复现使用真实 CandidateReview/ExtractionWorkbench、共享 localStorage 和模拟 API：B 草稿存在 → A 保存 → 公共 key 消失 → B 重挂载后仅显示 A 的版本。复现断言通过。

修复方向：按编辑会话隔离草稿，并只清除与当前已确认保存的内容/版本相匹配的缓存；不要无条件删除另一窗口的草稿。

### 3. [P2] 彻底删除后重新导入同路径资料，旧候选污染新资料入库状态

位置：[review-store.ts:45](PROJECT_ROOT/src/server/ingestion/review-store.ts:45)，关联 [ingestion-service.ts:178](PROJECT_ROOT/src/server/ingestion/ingestion-service.ts:178)。

触发：资料 A 有提炼历史，随后被彻底删除；用户在同一路径放入新的不同内容并重新提炼、处理候选。

`sourceRuns()` 只按 `material_path` 汇总全部 ready 历史，不应用队列已经使用的删除生命周期分界。入库预览据此计算所有未决候选和是否已有入库结果，把已删除旧资料的候选也算入新资料。

内存 SQLite、FakeVaultGateway 与 Map 文件端口复现了两个分支：

- 旧资料有 pending 候选；新资料唯一候选完成入库后，返回 `newComplete=true`，但 `pendingCount=1`、`sourceStatus=部分入库`。
- 旧资料有 committed 候选；新资料候选全部放弃后，新原文仍被回写 `知识入库状态: 已入库`，但 `生成知识: []`。

修复方向：入库和审阅聚合采用与队列一致的删除分界/资料身份。保留旧历史用于追溯，但不能将它计入新资料的当前状态。

### 4. [P2] AI 回答失败后没有取消底层任务，迟到候选仍会落库

位置：[assistant/service.ts:123](PROJECT_ROOT/src/server/assistant/service.ts:123)，关联 [deepseek-adapter.ts:113](PROJECT_ROOT/src/server/assistant/deepseek-adapter.ts:113)。

触发：AI 回复超过服务层 160,000 字符上限，同时工具链仍有正在重验/提交的候选操作。

服务捕获异常后将会话设为 failed，并从 `running` 删除任务，却没有中止共享 AbortController。SDK 的工具流仍可能继续执行；此时用户看见失败，停止按钮也无法找到已经移除的任务，后续 action 回执又会被 `emit` 的状态判断丢弃。

真实 AssistantService、DeepSeek SDK adapter、BrainTools、ExtractionService 配合模拟 SSE 与内存数据库复现：

- 50 ms：对话 `failed`，提炼记录数 0。
- 450 ms：对话仍 `failed`，`signalAborted=false`，但新增 1 条 ready 提炼记录和 1 个候选，对话 `actions=[]`。

没有真实网络或资料写入；复现证实的是失败后候选仍被保存，而非自动写入正式知识库。

修复方向：所有终止路径都中止模型/工具任务；异步操作在落库前重新检查取消状态，清理运行记录前确认任务已结束。

### 5. [P2] 第二个浏览器工作台使第一个页面的写入请求持续失效

位置：[app.ts:265](PROJECT_ROOT/src/server/app.ts:265)，关联 [client.ts:316](PROJECT_ROOT/src/client/api/client.ts:316)。

触发：同一浏览器、同一工作台服务，A 页面先执行一次操作，B 页面随后首次执行操作，再回 A 保存或重试。

每次 `/bootstrap` 都签发并覆盖共享会话 cookie，而各页面永久缓存自己的 CSRF token。B 的初始化使 A 的 token 与当前 cookie 不匹配；客户端既不清理旧 token，也不重新握手。因此 A 的所有 POST 持续返回 403，普通重试无效。

真实服务和两个真实客户端实例、共享模拟 cookie jar、无副作用假服务复现：A 首次成功、B 首次成功、A 再次请求和重试均为 `CSRF token rejected`，初始化次数一直为 2。

修复方向：bootstrap 复用有效会话，或在明确鉴权失败且请求尚未执行时刷新会话。需要避免自动重放执行结果不确定的写入请求。

### 6. [P2] 操作记录首次加载失败后，连接恢复不会自动重读

位置：[OperationsPage.tsx:44](PROJECT_ROOT/src/client/pages/OperationsPage.tsx:44)，关联 [AppShell.tsx:288](PROJECT_ROOT/src/client/app/AppShell.tsx:288)。

触发：直接进入操作与恢复页，首次请求时本地服务暂时断开，随后健康检查恢复且没有发布新的索引版本。

操作页的数据 effect 只依赖 `dataRevision` 等本页状态，没有订阅健康状态恢复；而 AppShell 首次接到 ready 索引不会递增 `dataRevision`。即使侧栏重新显示已连接，操作页仍保留错误或旧数据，且错误状态会停止本页的运行任务轮询。只有用户手动刷新或发生新的索引版本变化才会重读。

复核原有两个 app-shell 测试时，先在临时副本中更新旧文案断言，测试仍在恢复后的数据断言处失败，确认不只是文案变更。恢复路径与初始构建完成路径均缺少自动重读触发。

修复方向：显式监听首次就绪/连接恢复，并重新读取操作记录；保持对旧请求的取消和结果隔离。

### 7. [P2] 原生模块构建依赖本机某个固定版本的 Node 头文件缓存

位置：[build-sandbox-archive.ts:10](PROJECT_ROOT/scripts/build-sandbox-archive.ts:10)。

代码固定读取 `~/Library/Caches/node-gyp/22.22.3/include/node`，并立刻 `access(node_api.h)`。README 只要求 Node 22.12+、macOS arm64 和 Xcode；`npm ci` 不保证创建这个精确版本的缓存。

因此，新环境或清理缓存后，即使已满足声明的前提，`npm run electron`、`build:desktop-runtime` 和 `package:mac` 仍会在原生构建阶段报 ENOENT。当前机器已有缓存，所以这不是本轮本机执行失败，而是从固定路径和前置检查确定的可复现环境条件。

修复方向：明确获取与构建目标兼容的 Node headers，使用受支持的发现/配置路径；不要依赖开发者机器上偶然存在的版本缓存。

## 验证结果

| 检查 | 结果 |
|---|---:|
| TypeScript 类型检查 | 通过 |
| Vite 生产前端构建（输出到独立临时目录） | 通过 |
| Unit | 762 通过 / 1 失败 |
| Integration | 462 通过 / 1 失败 |
| Component | 464 通过 / 10 失败 |
| Native contracts | 144 通过 |
| Archive / recovery | 69 通过 |
| 已有测试合计 | 1,901 通过 / 12 失败，共 1,913 项 |

另有本报告中的隔离缺陷复现，不计入上表。

审查日志和可再次运行的后端复现脚本已保存在本机 [证据目录](PROJECT_ROOT/.local/code-audit-2026-09-10)。其中 [同路径历史复现](PROJECT_ROOT/.local/code-audit-2026-09-10/storage-history-repro.mts) 在当前缺陷下预期两个断言失败；[AI 迟到候选复现](PROJECT_ROOT/.local/code-audit-2026-09-10/assistant-late-candidates-repro.mts) 断言当前异常确实发生。主审已重新执行这两个脚本并确认结果。脚本的断言方向不同，修复后应相应改为期望正确行为的正式回归测试。

现有失败集中在五个测试文件：

- `material-deck-source-boundary.test.ts`：旧规则禁止出现“归档”，现在空状态文案含此词。
- `database-kernel.test.ts`：仍断言 6 个数据库迁移，现有迁移为 7 个。
- `app-smoke.test.tsx`：仍寻找旧的“当前模式：只读”标识。
- `app-shell.test.tsx`：2 项先因旧文案断言失败；更新临时副本中的文案后仍失败，暴露发现 6 的真实自动恢复问题。
- `material-trash.test.tsx`：7 项测试缺少新版“打开档案柜”的前置操作，在入口定位阶段失败；临时副本补齐开柜步骤后，相关选择范围内 8 项测试通过。

这些失败不能直接计为 12 个产品 bug：其中 10 项属于旧测试约定未同步，另外 2 项揭示同一个操作页恢复缺陷。默认 `npm run verify` 会在单元测试阶段中断，后续验证不会自动执行；相关测试需要更新到真实 UI 和现有数据库结构，不能简单删除断言冒充修复。

## 后续顺序

1. 修复退出生命周期，确保未保存编辑不会把应用带入无服务状态。
2. 修复多窗口草稿隔离和 AI 异常取消，并加入上面的复现用例。
3. 修复新旧资料生命周期混算、多标签会话及操作页自动恢复问题。
4. 修复 headers 获取方式，更新失效测试后重新运行完整验证。

旧的 `npm run dev` 使用 Local REST 适配器，而桌面入口使用 filesystem 适配器，是本次会话之前打开错误队列的原因。当前审查基于已启动的桌面代码，不将该兼容入口本身重复计为新的功能缺陷。
