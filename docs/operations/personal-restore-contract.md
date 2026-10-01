# 个人快照迁移恢复合同

状态：2026-10-01，身份与状态存储边界已按当前源码复核；本文件定义后续实现和验收合同。当前工具只支持冷备份、快照完整性及离线 SQLite 核验，**应用迁移恢复仍为 `applicationRestore: unverified`**。没有自动覆盖真实大脑或真实应用数据的恢复命令。

依据：[基础设施稳固设计](../superpowers/specs/2026-10-01-foundation-hardening-design.md)、[本轮审查](../reviews/2026-10-01-infrastructure-audit.md)。源码观察、拟实现合同与未验证能力分别标记；本文件不把源码推断写成 App 实际恢复成功。

## 已核实的身份与持久数据

### 身份和启动绑定【源码确认】

- `src/server/vault/FileSystemVaultGateway.ts` 对 `[vaultRoot, rootIdentity.dev, rootIdentity.ino]` 的 JSON 字节计算 SHA-256，得到 `cacheKey`。目录复制、目录替换、路径改变或设备改变都可能产生新 key。
- `src/electron/main.ts` 创建 gateway 后通过 `src/electron/vault-cache.ts` 打开 `userData/vaults/<cacheKey>`。仅选择复制的大脑会打开新状态目录；看到正常窗口不能证明旧状态已恢复。
- `userData/config/app-config.json` 保存大脑绝对路径。测试启动的 `XIAOZHAO_TEST_VAULT_ROOT` 会覆盖 saved config 分支，因此验收必须单独核对迁移后的配置，不能依赖测试环境替它改正确。
- 原生 archive/ingestion/trash/intake-trash handle 检查实际 root 和核心目录身份。旧日志中记录的 root、父目录、stage 或文件身份不能由改路径或改 key 自动恢复。
- `native/macos/sandbox-archive.c` 要求 private recoveryRoot 与 vault 在同一设备。跨卷副本能被读取，不等于具备归档或回收能力；本合同不得忽略该限制。

### 持久化对象【源码确认】

下表中的状态目录均相对 `userData/vaults/<cacheKey>`。

| 对象 | 路径或表 | 恢复要求 |
| --- | --- | --- |
| 原始资料、知识、输出、规则、附件、Skill 与其他本地文件 | vault 完整树，采用备份工具的固定依赖排除表 | 保留目录、空目录和原字节；不得为修复元数据而改写原文。 |
| 索引、任务、提炼结果、候选、入库批次、回收状态、项目记录 | `state.sqlite3` 及快照中已有 sidecar | 保留业务表、ID 和引用；索引可在副本重建，但不得以新空 DB 代替历史。 |
| 对话、请求、草稿、归档 action plan | `assistant_conversations`、`assistant_requests`、`assistant_drafts`、`assistant_action_plans` | 原 ID、正文、范围、附件关联和历史回执可查；未完成 action 必须受迁移确认边界约束。 |
| 上传附件、派生文本及归档 ledger | `assistant-attachments-v1/` 中 `.bin`、`.text.json`、`.json` 和 staging | 原件 SHA-256、稳定附件 ID、派生文本、archivePlan 与回执均进入核验；解析失败不得隐去原件。 |
| 归档意图、回执和阶段字节 | `personal-intake-v1/` | 意图和回执记录 root；base 还记录 source/target 父目录与资料包树身份，stage 有独立身份。 |
| 入库意图、回执、阶段文件和保留版本 | `personal-ingestion-v1/` 与 `personal_ingestion_batches`、`personal_candidate_reviews`、`personal_ingestion_source_heads` | 未完成批次不能自动继续；候选与源证据的关联、外部变化和保留版本继续可查。 |
| 原文/知识回收原件与日志 | `personal-trash-v1/<UUID>.md` 及其日志，`personal_trash_entries` | 原日志和 DB manifest 原字节一致；root 与回收原件 inode 改变后必须重新建立经确认的执行证据。 |
| 收件箱回收资料包与日志 | `personal-intake-trash-v1/<UUID>.packet/` 及其日志 | 全树、附件、空目录及删除/恢复方向保留；不得按同名目录猜测身份。 |
| 数据库备份与通用恢复对象 | `backups/`、`recovery/` | 全部保留；已有通用恢复对象仍可阻断写入，不在迁移时自动清空。 |
| App 路径、加密模型密钥、浏览器桥接 | userData 的 `config/`、`model-credentials/`、`clipper-bridge.json` | 更新绑定需有迁移记录；只保留已有加密字节，不解密或打印密钥，不自动安装外部 host。 |
| 项目创作、版本和导出历史 | `personal_projects`、相关创作/版本/导出/操作表 | 数据库历史保留；库外原件与输出不因此被搬动或重新生成。 |

原生回收目录限制已定义的文件名，不能直接向其内部插入任意迁移清单。迁移清单应置于单独、私有的状态目录，由运行时显式读取。

## 当前支持范围【已有实现】

- `personal:backup` 需要显式提供 vault、userData、destination 和 `--cold`。快照是独占新对象，不覆盖以前的快照。
- `personal:restore-check --snapshot ...` 核对快照树、清单、文件大小和 SHA-256；只在自身临时副本中打开 SQLite，核对 `integrity_check` 和 `foreign_key_check`，结束清理临时副本。
- 这两项完整性检查不能证明新根中的 App 可以显示历史、继续操作或恢复回收原件。其输出必须继续保留 `requiresIdentityRebind: true` 与 `applicationRestore: unverified`。
- 未覆盖外置项目原件、浏览器待发送队列和系统 Keychain。加密模型密钥进入快照，不代表跨机器可以解密；失败时保留加密字节，并使用现有“未配置/无法读取”状态。
- 当前没有本合同下的副本导入、身份重绑定或应用恢复验收实现。没有为本文件运行原生恢复或 Electron 迁移实验。

## 离线副本与迁移证据【待实现合同】

### 明确的输入、输出与发布

1. 输入必须是已通过完整性与 SQLite 核验的快照，以及明确指定的全新 vault/userData 目标；目标必须在源快照、原 vault 与原 userData 之外，不互相包含，不使用符号链接。
2. 预览列出实际目标、原身份、新身份计算方式、业务对象数量、未完成意图、外置项目、卷约束及不可恢复项；预览不发布副本、不改快照、不启动 App、不执行旧操作。
3. 只有显式确认后，离线复制并验证新树。采用独占临时目录、持久化和最终发布；失败不发布半成品，不覆盖既有目标，不自动关闭用户 App。
4. 在新 vault 实际目录身份已确定后计算新 key，将原活动状态目录的副本绑定到该 key，保存指向新 vault 的 App 配置。其他 vault 状态也保留并明确标记为未绑定，不按目录最近修改时间挑选。
5. 旧快照与旧日志的原字节保留。副本可生成新索引和迁移状态，但每项主动变更须记录对象、旧/新 hash、原因和父证据；不可用笼统的“复制完成”回执代替。
6. vault 与活动 recovery 的设备约束不满足时，预览必须明确显示写能力不可用；不能以只读启动通过为完整恢复。不得暗自把库或 userData 搬到另一卷。

### 不可变的迁移清单

至少记录：合同版本、snapshot manifest SHA-256、旧 vault 路径/dev/ino/cacheKey、新 vault 路径/dev/ino/cacheKey、新 userData 身份、活动状态目录映射、每个旧日志的相对路径和 SHA-256、每个持久化对象的大小/hash、观察到的新身份、分类结果与未验证项。

身份映射必须由当前真实对象、快照成员和日志证据共同构造。部分交换/移动可能使旧 inode 的内容处于 stage 或目标位置，不能建立“同路径就是同对象”的全局映射，不能搜索替换所有 `dev/ino`。快照 hash 是完整性证据，不是证明用户授权的签名。

## 四域日志与重新确认【待实现合同】

所有领域遵守同一边界：旧 intent/result/方向确认/stage 原字节不改；完成历史与当前执行权限分离。迁移启动和普通 GET 只查阅与分类，不因旧确认而继续在新身份上写入。

| 领域 | 完成历史 | 已确认未完成意图 | 新确认后的证据 |
| --- | --- | --- | --- |
| 归档 | 用旧 intent/receipt 及快照成员核验历史，展示原操作 ID/目标与“来自快照”；不把旧 root receipt 当作新根写授权。 | 根据 source、target、stage 的字节和旧阶段证据分类为待核验；任何缺失或冲突保留全部版本。 | 新预览展示当前文件、字段、去向和变化；新操作记录 predecessor ID/旧日志 hash，绑定当前 root/父目录/资料包树/stage。 |
| 入库 | 保留完成批次、候选 committed 关联与来源回链，不重复产出。 | 暂停运行时自动 recover，保留原计划、保留版本、候选版本和源证据；当前/保留版选择须可审查。 | 复用恢复预览与明确 resolve 语义，创建新 journal ID，记录 predecessor；核对当前规则、候选 stamp、读集、目标与源正文证据。 |
| 原文/知识回收 | restored/deleted 历史可查；trashed 原件必须与快照大小/hash 匹配，并记录当前身份。 | moving/restoring/deleting 状态保留原方向和证据，不能在启动时移动、恢复或删除。 | 新预览绑定当前 root/原件身份和原位置；单独确认恢复或删除。目标存在时禁止覆盖；删除方向不得伪装为可恢复。 |
| 收件箱资料包回收 | 核验 `.packet` 全树，保留资料包和全部附件；历史结果与新根权限分离。 | 全包移动/恢复/部分删除均先展示剩余树及原方向；不能因 hash 相同猜测原阶段已完成。 | 新预览绑定当前完整树、附件、空目录、规则和新确认 token；一次确认的范围不得扩大到包外文件。 |

新日志应采用不可变 predecessor 证据：原操作 ID、原日志 hash、snapshot manifest hash、迁移清单 hash、用户此次确认、当前读集和新身份。新的执行 ID 与旧历史 ID建立显式关联；旧 token 与旧请求重试只能查询旧结果，不能触发新的执行。

附件 ledger/action plan 的旧归档 operationId 必须进入相同边界。完成回执可在原件/目标字节核验后供阅读；未完成 archivePlan、已发布包与 assistant action 不得被清空后“重新归档”而隐藏原进度。新预览必须同时说明原保留版本和当前目标，确认后产生新 lineage。

## 运行时、外置项目与界面边界【待实现合同】

- 在领域服务的启动 recover 和接受 HTTP 请求之前识别迁移上下文。未通过领域核验的旧意图保持可见且暂停；不能将服务初始化失败或能力消失当成成功恢复。
- 提炼/模型请求已中断时可以显示现有“中断”状态，但不能自动恢复外发。对话、草稿、候选与已完成历史必须仍可读，不因为缺模型密钥被隐藏。
- 外置项目保留 ID、原绝对路径、索引历史、创作版本与导出回执，标记 `reconnect-required`。旧 pending/running 写计划和未完成导出暂停，需用户重新选择、扫描、确认；不改旧绝对路径，不自动读取、搬动、导出或写回原项目。
- 浏览器桥接显示重新连接状态；迁移本身不安装系统 Native Messaging host、不发送收藏、不把旧 root 配置继续用于新副本。
- 复查已有首用走查的“返回/取消/失败保留当前任务”和“成功结果可查”要求。新增界面入口时，工程细节放到高级诊断，并重跑隔离 first-run 与已配置用户流程。

## 实现落点【拟实现，尚未交付】

| 文件范围 | 必须承担的职责 |
| --- | --- |
| 新 `scripts/personal-restore-stage.ts`、`src/server/operations/personal-restore.ts` | 只读预览、全新离线副本、完整性核验、身份映射和迁移清单；不提供覆盖模式。 |
| 新 `src/server/runtime/restore-context.ts` 与独立历史投影模块 | 校验清单绑定、区分迁移历史与新操作、提供 predecessor 证据、暂停旧意图。 |
| `src/electron/main.ts`、`src/electron/vault-cache.ts` | 验证新配置与真实新 key，防止启动空状态或回落到旧根。 |
| `runtime/personal-composition.ts`、`runtime/archive-composition.ts` | 在 recover 前建立迁移边界，保持只读和历史入口可用。 |
| `archive/intake-archive.ts`、`ingestion/ingestion-service.ts` | 完成历史投影、部分阶段分类、新确认与新日志链路。 |
| `trash/trash-service.ts`、`trash/intake-trash-service.ts` | 新身份下原件/全树核验、冲突展示、恢复/删除单独确认。 |
| `attachments/archive.ts`、`assistant/action-plan-service.ts` | 保留原 ledger、原进度与对话关联，暂停旧 action，确认后关联新执行。 |
| `projects/project-service.ts`、`projects/project-write-plans.ts`、相关导出服务 | 外置项目重新连接与旧写计划暂停，保留原操作历史。 |
| 数据库迁移/迁移事件表（若实现选择使用） | 记录映射与 lineage；不删除原业务记录，不批量改旧日志内容。 |

不要以修改 native port 返回的 `rootIdentity` 冒充旧身份；实际 native 操作必须继续检查当前目录与文件身份。

## 验收矩阵与完成标准【未验证】

所有自动写入、故障、冲突和重启验证只在独立合成 vault/userData 中运行。Electron 夹具须符合现有 `src/electron/test-roots.ts` 的临时目录、权限与 sentinel 约束。启动前核验已写入的新配置，启动后核验实际活动 key 与 seeded 数据，不能只断言窗口可打开。

| 验收 | 必须观察到的结果 | 当前状态 |
| --- | --- | --- |
| 新路径、新 inode、新 cacheKey | App 打开迁移的非空 DB；与原快照 ID/内容相符，不能生成空状态冒充恢复。 | 未验证 |
| 对话/草稿/提炼/候选 | 原 ID、正文、候选草稿与 committed 来源关联可查，重启后保留；不调用真实模型。 | 未验证 |
| 上传附件与已归档原件 | 原件 bytes/hash、派生文本、稳定 ID与已完成回执可查；不重复归档。 | 未验证 |
| 完成历史与旧日志 | 四域历史可显示，所有旧 journal/stage hashes 在启动、查询及新确认后保持不变。 | 未验证 |
| 已确认未完成意图 | 启动、GET 和普通重试不写 vault、不删除、不外发；旧进度可见，需要新预览确认。 | 未验证 |
| 新预览、取消与过期 | 预览零写入；取消保留全部状态；过期或规则/源/候选变化阻止执行。 | 未验证 |
| 显式重新确认与重试 | 新日志含 predecessor 证据，绑定当前真实身份；同一新确认重复请求/重启不重复产出。 | 未验证 |
| 单篇与整包回收 | 可查原件和附件，恢复到空位置且 bytes 相同；同名冲突不覆盖。部分删除保留剩余树并要求单独确认。 | 未验证 |
| 部分交换/移动和外部变化 | current/preserved 证据均可查；字节或身份不匹配时明确冲突，不能猜测或清理一方。 | 未验证 |
| 外置项目 | 显示重新连接；未访问或写入原项目；创作历史/回执不丢，旧 pending/running 不继续。 | 未验证 |
| 跨卷目标 | 明确说明当前写能力限制；不能以只读启动通过将完整恢复标通过。 | 未验证 |
| 配置、凭证、桥接 | 新配置绑定被独立验证；密钥不解密/输出，未联网；桥接要求重新连接，未安装外部 host。 | 未验证 |
| 首用与已有用户 | `tests/electron/first-run-walkthrough.test.ts` 及隔离已有用户流程无回归。 | 本合同尚未验收 |
| 失败与清理 | 不覆盖目标、不发布半成品；源快照和真实 vault/userData 字节不变；自身临时目录清理。 | 未验证 |

建议新增 `tests/integration/personal-restore-stage.test.ts`、领域迁移 unit/archive 合同及 `tests/electron/personal-restore.test.ts`；先种入非空合成数据与四域中断状态，再复制到新根，运行上述断言。每个失败实验须独立记录实际结果，不把跳过、缺环境或读取成功写成恢复通过。

只有矩阵中数据查阅、四域恢复、新确认幂等、外置边界、配置绑定与重启全部取得实际证据后，才允许将 `applicationRestore` 标为 `passed`。在此之前保持 `unverified`；自动覆盖真实大脑或真实 userData 的工具不在本合同授权范围内。
