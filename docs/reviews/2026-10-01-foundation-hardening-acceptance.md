# 基建稳固验收 · 2026-10-01

状态：公开版验收摘要（真实资料明细保留在本机）；第一、二阶段已实现并验证；第三阶段的发布追溯已交付，实际跨身份应用迁移恢复尚未实现、尚未验证。以下结果来自本轮实际执行，不把合同文档视为恢复实现。

设计：[已确认方案](../superpowers/specs/2026-10-01-foundation-hardening-design.md)；范围与基线：[全量盘点](2026-10-01-infrastructure-audit.md)；执行：[实施计划](../superpowers/plans/2026-10-01-foundation-hardening.md)。

本轮保留模块化单体，修复文件操作和验证入口，新增只读健康检查、个人冷备份、离线检查和构建追溯。真实知识库内只机械修正公众号工具的中文 URL 路径并维护会话交接；未改原始正文、核心目录或 YAML schema，未调用真实模型或外发文章。

## 实现结果

| 范围 | 最终行为与证据 |
| --- | --- |
| 剪藏锁 | 仅取得独占锁并仍持有原 inode 的调用可释放；竞争失败或锁被替换时保留其他锁。隔离红测及回归通过。 |
| 项目输出恢复 | 确认意图与 running 同事务保存；原确认核验已发布内容并补回执，不重写或重复操作。启动只处理已确认 running；根、版本、规则或内容冲突停止。已标记 publication=linked 的目标消失时禁止补写。 |
| 发布后故障 | 目录 sync/I/O 或发布后路径竞争不返回 completed、不索引；保留待核验状态。规则/健康暂不可读暂停；确定身份冲突转 stale。临时文件仅核验后按持有身份清理。 |
| MCP 读取 | 每次扫描/读取复查 section，打开文件描述符后核对身份、有界读取、读后复查 containment。启动后目录替换及解析到读取间竞争均有有效红测；增长超限拒绝且关闭句柄。 |
| 扩展 ZIP | 全新私有 ZIP 校验完整性和成员后发布；源文件删除不遗留旧成员，拒绝不安全来源对象。 |
| 共享门禁 | 本地与 CI 使用相同平台准备，full 按目录发现全部 native/archive；Node 最低版本统一为 22.22.3。月份/退出夹具修正，断言保持。 |
| 健康与治理 | 历史兼容、无类型 Markdown、缺失来源、歧义及非原始资料来源分别报告；不自动写库。SQLite 失败与文件快照失败分层标记。 |
| 个人数据保全 | 完整 vault/userData 与空目录、所有 vault 状态及加密字节进入固定清单；源变化、重叠、篡改、额外成员、SQLite 损坏、祖先替换与清理所有权均有隔离回归。48 项备份集成测试通过。 |
| 构建追溯 | 构建会话防止旧 dist 被录为新 source；打包前验证，ZIP 独立更新，App 嵌入同一清单并验证实际发布资源及包身份。 |
| 健康缓存 | 系统时间回退时不复用负年龄缓存，避免规则状态变化后仍显示旧 readiness；真实服务夹具回归通过。 |

项目和备份仍使用 Node 路径式文件接口。对同用户恶意持续替换目录，不宣称原子的目录身份保护；项目竞争可能留下根外文件，但不会被认领成完成回执或索引。具体恢复状态与清理边界见[运维手册](../operations/personal-backup-and-health.md)。

## 验证结果

环境：macOS arm64，Node 22.22.3，Electron 44.1.0，应用 0.1.8。全部写入、故障和重启测试使用合成临时 vault/userData；不写真实用户状态。

| 最终执行 | 结果 |
| --- | --- |
| Architecture 与 5 套 TypeScript 配置 | 通过 |
| Unit | 106 文件 / 1,297 用例通过 |
| Integration | 63 文件 / 743 用例通过 |
| Component | 66 文件 / 822 用例通过 |
| Security 子集 | 5 文件 / 46 用例通过，已包含在 integration，不重复计数 |
| Native 全目录 | 9 文件 / 149 用例通过 |
| Archive 全目录 | 7 文件 / 69 用例通过 |
| 个人 / 公司 MCP | 各 3 文件，25 / 13 用例通过 |
| `verify:full` 构建 | 客户端、服务端、Electron 与来源清单全部通过；最终源码摘要 9285cf9608322647919d574acc5af140ce684a4d598548838807acc4ca67b2d7 |
| 浏览器 fixture E2E | 6 组 / 60 用例通过 |
| Electron 全目录 | 70 用例通过，覆盖开发版与打包版的首次使用、归档、入库、回收、项目、重启和更新流程 |
| 最终重新打包后的聚焦 Electron | 首次使用、入库与项目工作台 8 用例通过 |
| 个人 / 公司 MCP、公司运维工具构建 | 全部通过 |
| 最终 App 资源及身份核验 | 101 个列出资源通过，与内嵌清单一致 |
| 真库 Doctor | 0 硬错误 / 113 警告，构建来源核验通过 |

完整目录测试共 257 文件、3,118 用例；加上浏览器与 Electron 为 3,248 个用例。安全子集和最终包的 8 个复查用例不重复加入总数。

最后的 Doctor 状态分类变更后重新执行 `verify:full` 与打包。最终运行资源、模板、原生 helper 和扩展源码与通过 70 项 Electron 的版本逐项散列一致；扩展 ZIP 重新生成并独立检查。因此保留全部 70 项证据，并对最终新包另跑上述 8 项。证据见 `runtime-artifact-equivalence-delivery.json`。release 各阶段分步执行通过；没有声称执行过一次完整的 `npm run verify:release`。Linux fast 与真实 Obsidian 插件合同没有在本机验证，不冒称通过。

验证途中发现打包边界 mock 未接新前置、时钟回退导致缓存陈旧，均定位并修复；失败日志保留作历史证据，当前结论使用最终通过日志。

## 当前构建

- Git commit：`3f8354c38e191292c79ec1105f0d3428ac92d26d`，`dirty: true`，本轮未提交 Git。
- 构建来源：`9285cf9608322647919d574acc5af140ce684a4d598548838807acc4ca67b2d7`；构建时间：`2026-09-30T17:56:19.840Z`（UTC）。
- `dist/build-manifest.json`：415 个来源记录、101 个发布资源记录；App 内 `Contents/Resources/build-manifest.json` 完全一致。
- App：`dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app`。
- 清单只覆盖列出资源；依赖与 Electron 框架未做全量散列，图标核验为引用和存在。ABI 使用实际 Electron 流程验证；本轮未做签名、公证或部署。

## 知识库治理与原文保真

真库 lint：315 份笔记，228 严格通过、70 历史兼容、17 无类型警告、0 硬错误。来源链：23 条缺失、1 条歧义、2 条指向知识笔记而非原始资料。合计 113 项警告。

最终 Doctor 前后，四个核心目录共 335 份 Markdown 的路径和 SHA-256 完全一致，见 `doctor-delivery-read-only-proof.json`。这证明本次扫描只读，不代表已修复全部历史元数据。公开分类见[来源链治理方法与汇总](2026-10-01-source-link-governance.md)；真实标题、映射与反链保留于本机 `private-review-docs/`，尚未写回，不补造原文、不自动合并或移动。

## 已交付与未验证的恢复层

- 冷备份及离线检查实现已通过合成完整树验收；源与快照字节保真，SQLite integrity/foreign keys 验证通过。
- 未指定真实备份目标或确认真实 App 停机，本轮没有创建真实个人备份，也没有关闭用户应用。
- `applicationRestore: unverified`、`requiresIdentityRebind: true`。新根改变 dev/ino/cacheKey；归档、入库及两类回收旧日志仍绑定原身份。
- [个人迁移恢复合同](../operations/personal-restore-contract.md)已完成源码复核与验收矩阵；副本导入、身份重绑定、四域历史投影与新确认，以及新根 App 恢复运行未实现、未验证。第三阶段不能标为整体完成。
- 不提供自动覆盖恢复或跨身份旧意图重放；不能以复制成功、SQLite 正常或新空库能打开冒充应用恢复。
- 外置项目原件、浏览器待发送队列、系统 Keychain 不在个人快照覆盖范围；保留引用不等于备份原件。

## 本机证据与交接

证据目录：`.local/infra-audit-2026-10-01/`（Git 忽略；含私人报告原件 `private-review-docs/`）。关键文件：`verify-full-delivery.log`、`e2e-fixtures.log`、`electron.log`、`electron-delivery.log`、`package-mac-delivery.log`、`package-provenance-delivery.json`、`doctor-delivery.json`、`doctor-delivery-read-only-proof.json`、`runtime-artifact-equivalence-delivery.json`。

保留用户已有 `.superpowers/`，删除本轮无用 TypeScript 构建缓存和自建临时夹具；保留当次构建的 App、扩展与必要证据。知识库 `99_当前会话交接.md` 只记录尚未完成的迁移与治理边界，详细已完成记录以本页为准。
