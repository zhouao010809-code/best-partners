# 问问受控知识动作确认层：产品设计

日期：2026-09-14。状态：已实现并完成服务层、组件和桌面验收复核。

## 目标

把问问从“能回答和提炼资料”推进到“能在用户确认后完成有限的知识动作”，首个动作是附件归档。普通问答保持只读；任何由问问触发的正式资料或正式知识写入，都必须先显示服务端生成的动作计划，再由用户确认。候选提炼继续使用既有的候选审阅边界。

这不是把问问改成通用终端 Agent，也不开放任意命令、任意路径、浏览器或整个电脑的文件写入。

## 现有基础和约束

- 问答、资料检索、原文引用、附件阅读、候选提炼和审阅回执已经存在。
- 当前附件工具中的 `archive_attachment` 会在模型运行期间调用归档服务；本设计只改变它的确认时机，不新增一套文件写入器。
- 正式文件变化必须继续经过现有 `AttachmentService`、`IntakeService` 和原生归档事务；不能绕过既有恢复、哈希和路径校验。
- 当前对话服务限制范围、来源数量、读取字符数、历史消息和并发任务；新动作计划必须继承这些范围，不扩大模型权限。
- 候选生成不是正式知识写入。候选仍由现有审阅界面确认，聊天回复不得声称已经正式入库。

## 产品范围

### P0 纳入

1. 对明确的附件归档请求生成待确认计划。
2. 在计划卡中显示附件、目标位置、原件保留方式、来源版本和重复提示。
3. 用户确认后调用现有附件归档事务，并返回真实操作回执。
4. 支持取消、过期、文件变化、失败、重启恢复和幂等重复确认。
5. 普通问答、总结和仅解释“归档流程”的问题不得创建计划或写入正式资料；候选提炼仍只进入现有候选审阅状态。

### P0 不纳入

- 任意电脑文件读写、终端命令、脚本、浏览器操作、Git 或远程环境。
- 多 Agent、后台无人值守执行和跨对话排队。
- 模型外发前的完整内容审批；当前沿用已有附件范围和费用披露，单独的发送前预览在后续阶段处理。
- DOCX、图片、扫描 PDF 的 OCR 和新的知识入库策略。
- `draft`、`export` 等后续动作类型的执行器。数据结构可以保留扩展位置，但 P0 API 只接受 `archive`。

## 用户流程

```text
用户选中文件并明确说“归档这个文件”
        ↓
问问读取必要的附件元数据并生成动作计划
        ↓
时间线显示待确认卡，不改变文件
        ↓
用户打开详情并确认
        ↓
服务端重新验证附件、哈希、范围、目标和计划有效期
        ↓
调用现有 AttachmentService.archive
        ↓
更新为已完成回执，提供真实路径和来源入口
```

用户只说“总结一下”“解释怎么归档”或引用资料中的归档建议时，问问只能回答，不创建计划。当前的 `attachmentIntent` 继续作为第一道意图门槛；服务端动作计划再作为第二道权限门槛。

## 架构设计

### 1. 模型和工具边界

将写入型工具标记为两阶段工具。第一阶段只生成计划并保存待确认记录，返回给模型一个 `awaiting_confirmation` 结果；模型必须结束本轮并告知用户需要确认，不能在同一轮再次调用写入工具。第二阶段完全由确认 API 执行，不再次调用模型。

`AssistantTool` 增加一个明确的副作用标记：

```ts
type AssistantToolEffect = 'read' | 'propose-write';
```

读工具保持现有行为。`archive_attachment` 改成 `propose-write`：

- 校验当前消息确实包含明确归档意图。
- 只使用本轮选中的附件 ID。
- 调用归档层的纯预览能力，得到服务端计算的目标和主文档摘要。
- 将附件哈希、解析版本、目标和请求指纹写入动作计划。
- 发出 `action` 事件，让对话保存计划卡。
- 不发布资料包、不移动文件、不改变附件归档状态。

候选提炼仍沿用 `prepare_attachment_extraction` 和现有候选审阅。若未来要把“生成候选”也改成两阶段写入，应另立设计，不在本次扩展隐含实现。

### 2. 动作计划持久化

新增迁移 `016_assistant_action_plans.sql`，建立 `assistant_action_plans` 表：

```sql
CREATE TABLE assistant_action_plans (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id),
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'archive'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'stale')),
  payload TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirm_request_id TEXT UNIQUE,
  confirm_fingerprint TEXT,
  result_action_id TEXT,
  problem TEXT
);
CREATE INDEX assistant_action_plans_conversation_idx
  ON assistant_action_plans(conversation_id, created_at);
```

`payload` 由服务端 schema 校验，至少包含：

```ts
type ArchivePlanPayload = {
  attachmentId: string;
  attachmentName: string;
  attachmentSha256: string;
  archiveFields: Record<string, string>;
  textRevision?: string;
  sourceRange?: { startPage: number; endPage: number; label: string };
  targetPath: string;
  mainName: string;
  mainSha256: string;
  duplicateOf?: string;
};
```

模型不能提交或修改 `targetPath`、哈希、操作编号和任何绝对路径。计划有效期固定为创建后 30 分钟；过期只标记失效，不触碰文件。

应用启动时把 `running` 计划改为 `pending` 或 `failed`：如果归档账本已经有同一操作回执，恢复为 `completed`；如果只有未完成的原生恢复记录，显示“待核验”，交由既有恢复流程处理；不自动执行新的写入。

### 3. 预览和执行分离

现有附件归档层需要拆成两个明确入口：

- `preview(request, signal)`：读取和校验原件、解析文本、计算字段、目标路径和主文档哈希；只能返回预览，不持久化归档计划、不发布文件。
- `archive(request, signal)`：复用相同计算结果，在执行前重新计算并校验哈希，然后沿用现有 staging、原生发布、`IntakeService` 提交和恢复逻辑。

如果预览和确认之间资料变化，`archive` 返回 `ATTACHMENT_ARCHIVE_PLAN_CHANGED`，动作计划变为 `stale`。不能使用旧预览继续写入。

## API 契约

### 共享 schema

在 `src/shared/api/assistant.ts` 增加 `assistantPlanActionSchema`，并把它加入 `assistantActionSchema`：

```ts
const assistantPlanActionSchema = z.object({
  id: z.uuid(),
  type: z.literal('plan'),
  kind: z.literal('archive'),
  label: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'stale']),
  attachmentId: z.uuid(),
  sourceTitle: z.string(),
  sourceSha256: z.string(),
  targetPath: z.string(),
  mainName: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  resultActionId: z.string().optional(),
  problem: z.string().optional()
});
```

计划动作会持久化在 assistant message 的 `actions` 中；完整的不可变 payload 仍以 `assistant_action_plans` 表为准，避免仅相信聊天 JSON。

### 路由

```text
POST /api/v1/assistant/action-plans/:id/confirm
POST /api/v1/assistant/action-plans/:id/cancel
```

请求体均为严格 schema：

```ts
{ clientRequestId: string } // UUID
```

响应返回更新后的 `assistantConversationResponseSchema`，使客户端可以用现有刷新路径重新投影所有动作卡。确认请求同时使用现有 CSRF 校验和 `clientRequestId` 幂等记录。

确认服务必须按以下顺序处理：

1. 读取计划并确认当前大脑、对话和动作类型一致。
2. 确认状态为 `pending`，未过期，且请求编号没有冲突。
3. 重新读取附件并校验原件 SHA-256、解析版本、页码范围和目标冲突。
4. 先在一个短事务中将计划置为 `running`，事务提交后再调用现有归档服务；不把异步文件操作包在 SQLite 事务里。
5. 成功后保存实际 `operationId`、路径、索引状态和结果动作，计划置为 `completed`。
6. 失败时保存可展示的错误和恢复状态；重复确认先查询已有结果，不创建新操作。

取消只允许从 `pending` 转为 `cancelled`，不删除临时附件，不调用归档服务。

错误码至少包括：

- `ASSISTANT_ACTION_NOT_FOUND`：计划不存在或不属于当前大脑。
- `ASSISTANT_ACTION_EXPIRED`：计划已过期。
- `ASSISTANT_ACTION_STALE`：文件或解析结果已变化。
- `ASSISTANT_ACTION_ALREADY_RESOLVED`：计划已经完成、取消或失效。
- `ASSISTANT_ACTION_CONFLICT`：幂等编号对应了不同请求。

## 界面设计

### 待确认卡

在 `AssistantMessageView` 的动作区域显示“准备执行”卡片，内容顺序为：动作标题、文件名、目标位置、原件/知识影响、来源版本、重复提示、操作按钮。

按钮文案：

- `查看计划`
- `确认归档`
- `取消`

“确认归档”先打开确认对话框，确认对话框内只有一个最终确认按钮。确认期间按钮禁用并显示“正在归档…”。

### 状态和可访问性

- 计划卡使用 `aria-label="待确认的归档计划"`，状态变化使用 `role="status"`。
- 对话框打开时焦点进入标题，关闭后回到触发按钮；支持 Escape 取消查看但不会误触发归档。
- 失效状态明确说明“文件已变化，未写入”，提供“重新生成计划”；不显示“已完成”。
- 已完成状态复用现有归档回执卡，避免同一动作出现两种成功展示。
- 对话历史和重启恢复都展示相同的状态，不因重新加载而自动执行。

## 安全和恢复不变量

1. 没有用户明确归档意图，就没有 `archive` 计划。
2. 没有用户确认，就没有正式资料目录变化或正式知识写入。
3. 模型永远不能指定绝对路径、命令、任意附件或确认结果。
4. 预览哈希与执行时哈希必须一致。
5. 原件 SHA-256 和字节内容不被改写。
6. 操作回执丢失时按持久化操作编号恢复，而不是重新发起归档。
7. 计划取消、过期或失效不会删除资料。
8. 既有原生归档恢复记录和写入闸门继续有效；本设计不增加未批准的直接文件写入路径。

## 测试和验收

### 单元测试

- `attachmentIntent` 对总结、教程、转述和否定句均不创建归档计划。
- 归档计划只接受本轮选中的 UUID，并由服务端生成目标和哈希。
- 预览不会改变附件账本或资料目录。
- 哈希变化、过期、重复确认和错误幂等编号分别返回对应错误。
- 取消计划后原件、附件状态和归档目录完全不变。

### 集成测试

- 上传文字 PDF，发送明确归档请求，断言对话得到 `pending` 计划且资料目录没有变化。
- 确认同一计划，断言只产生一个归档操作、原件哈希不变、回执路径真实可读。
- 在确认前修改解析文本或目标冲突，断言计划变为 `stale`，没有覆盖文件。
- 在归档执行后模拟响应丢失，重试同一 `clientRequestId` 返回已有回执。
- 应用重启后恢复 `pending`、`running` 和原生待核验状态，不自动新建操作。
- 现有问答、附件阅读、提炼候选和正式入库审阅回归通过。

### 组件和 Electron 验收

- 待确认卡、确认对话框、取消、失效、失败和已完成状态都有组件覆盖。
- 从独立测试大脑完成“选择 PDF → 明确归档 → 计划 → 确认 → 打开归档资料”完整流程。
- 普通总结流程前后目录快照、附件账本和 SHA-256 均不变。
- 重启应用后可以从对话中继续处理未完成计划。
- TypeScript 类型检查、unit、integration、component、Electron 相关测试和桌面构建全部通过。

## 交付顺序

1. 先新增共享 schema、迁移和只读计划存储测试。
2. 将附件归档预览与执行拆开，先完成失败测试再接入计划创建。
3. 增加确认/取消路由和幂等恢复。
4. 增加动作卡、确认对话框和失效/失败状态。
5. 跑针对性测试，再跑项目现有完整验证命令和独立 Electron 流程。

P0 完成的判断不是“出现了确认按钮”，而是：明确请求先产生计划、未确认绝不写入、确认只执行一次、失败可恢复、来源和原件可核对，同时现有问答和候选审阅行为不回退。
