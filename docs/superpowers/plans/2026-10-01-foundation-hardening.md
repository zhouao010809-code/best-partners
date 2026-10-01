# 小兆大脑基础设施稳固实施计划

> **For agentic workers:** Use subagent-driven-development for independent tasks; the main agent reviews spec compliance, code quality and integrated verification. Steps use checkbox tracking.

**Goal:** 修复已复现的文件操作缺陷，建立可重复构建、完整门禁、只读健康检查及个人快照/恢复校验。

状态：本实施计划的勾选项已完成并验证，结果见[实施验收](../../reviews/2026-10-01-foundation-hardening-acceptance.md)；文件与数据库离线核验、发布与 Electron 验收已通过。第 5 项交付迁移合同与发布证据，实际跨身份应用恢复不在完成项中，保持 `applicationRestore: unverified`。

**Architecture:** 保留模块化单体、现有文件与状态合同。新的运维工具独立于产品页面，以显式参数操作，并用临时目录证明字节保真和恢复边界。

**Tech Stack:** TypeScript、Node.js 22.22.3、Electron、Fastify、SQLite、Vitest、Playwright、macOS 原生 helper。

实施位置：应用仓库根目录（`desktop-read` 工作树）。不处理用户既有 `.superpowers/`，不修改真实库原文或核心规则，不执行文章外发；GitHub 同步按用户后续授权进行。

## 1. 文件操作与构建修复

- [x] `src/electron/clipper-host.ts`：新增获锁失败保留原锁、正常清理和并发互斥回归；先用 `vitest.config.ts tests/unit/clipper-host.test.ts` 观察失败。释放逻辑必须核对持有句柄和 inode，不能无条件 unlink。
- [x] `scripts/package-extension.ts`：导出可测试的打包函数；用临时 source/dist 两次构建（第二次删除文件），断言 ZIP 成员与当前 source 一致。新 ZIP 在私有临时目录制作、验证后 rename；保持 CLI 入口及原输出路径。
- [x] 创建平台准备/验证 runner，修改 `package.json`、锁文件 engines 与 `.github/workflows/ci.yml`。fast 在 macOS 为 integration 准备 personal archive，full 准备所有 native 并按配置运行全目录，Linux fast 保留平台过滤。release 继续构建当前包后跑 Electron。
- [x] 修正 `tests/integration/attachment-service.test.ts` 的日期夹具；新月份用例断言预览不写。修正 `tests/native/desktop-quit.contract.test.ts` 的 updater 替身，保留取消退出、只关闭一次断言。
- [x] 针对性测试通过后由主 Agent 跑统一门禁，确认不靠已有 dist 的隐藏前置。

## 2. 项目写入中断恢复

- [x] 阅读 `project-write-plans.ts`、输出路径/锁/数据库迁移及已有 project tests。
- [x] 以真实 SQLite/临时项目覆盖 claim 后中断、文件发布后缺 DB 回执、外部目标冲突、项目变化、重复请求；观察现有 running 重试不进入终态的失败。
- [x] 在原确认编号重试路径执行幂等核验：尚未发布且目标不存在才继续已确认写入；已记录 `publication: linked` 的目标消失则停止，禁止重建；相同内容补回执；差异/不安全路径进入终态冲突。保留不覆盖语义与一个 operation receipt。
- [x] 在运行时需要启动核验时，只核验已确认记录，不自动执行 pending；实现资源关闭前等待当前工作。
- [x] 运行 project write-plan 单元/集成测试与类型检查，再由主 Agent 复核原文保真和状态终态。

## 3. 个人备份与离线恢复校验

- [x] 创建 `src/server/operations/personal-backup.ts`、`scripts/personal-backup.ts`、`scripts/personal-restore-check.ts`，测试 `tests/integration/personal-backup.test.ts`。不修改公司运维合同。
- [x] 测试先覆盖完整 vault/userData、SHA-256、空目录、目标重叠、符号链接、源变化、缺失/多余/篡改文件、SQLite 损坏、外部资料范围和不覆盖目的地。
- [x] 使用独占 partial 目录，复制 regular files，拒绝不安全对象，固定排除 node_modules 与已声明运行缓存；前后完整源清单一致才发布。私有目录/文件权限，已有加密密钥只复制字节。
- [x] 记录版本化清单、源 root dev/ino 和 cacheKey；要求显式冷备份确认，不自动关闭用户应用。对可识别运行锁和 SQLite 外部写入给出拒绝结果。
- [x] 离线检查在受控临时目录验证全部树、SQLite integrity/foreign keys 和 vault/state 对应关系；清理自己创建的目录，不改真实源。输出分别标识 snapshot/sqlite/application restore 状态。
- [x] 命令缺参数退出 2，校验失败非 0；输出安全错误码与摘要，无凭证值。package scripts 由构建任务的唯一 owner 或主 Agent 统一接入。

## 4. 健康检查与工具路径

- [x] `mcp-server/vault-reader.ts`：先新增启动后 section 被替换为库外链接的枚举回归，再复查 root containment；保持原 readMarkdown 拒绝库外内容。
- [x] 创建 `scripts/brain-doctor.ts` 及聚焦单元测试：必备目录/规则、运行环境、现有 lint、来源链接唯一/缺失/歧义、测试发现与门禁覆盖、构建/快照状况。不解密，不默认写报告。
- [x] 复用 YAML parser，仅读取来源元数据；Obsidian 链接按全路径/唯一后缀/标题判定，不自动猜歧义。兼容警告保留 warning，硬错误退出 2。
- [x] 机械修复真实 vault `publish.ts` 的路径为 `fileURLToPath(import.meta.url)`；只做中文/空格路径和 TS 语法离线验证。
- [x] 真库执行 doctor 与 lint，并确认字节/文件清单不变（交接文件和本次明确工具修正除外）。

## 5. 迁移恢复与发布证据

- [x] 明确旧身份日志不可直接改写、新 cacheKey 对应旧状态，以及未完成操作如何保留/重新确认的恢复合同。没有证明身份迁移前，applicationRestore 必须明确未验证。
- [x] 构建产物清单记录 Git commit、源码内容摘要、dirty 状态、Node/Electron 与资源 hashes；实际打包后核验 App 内 assets 与当前 dist。
- [x] 使用临时 vault/userData 跑 first-run、项目写入及归档/入库/重启等受影响的 Electron 流程；不调用真实模型、不写真实库。
- [x] 更新 `docs/development.md`、运维手册、验收报告；按证据标注完成与尚未证明的迁移恢复层。清理自己创建的无用临时文件并维护 vault 的 `99_当前会话交接.md`。

## 集成验收顺序

针对性回归 → architecture/typecheck → verify:full → fixture E2E → 当前源码打包 → 隔离 Electron 核心流程 → 公司工具构建 → 真库只读 doctor → 文档/变更复核。

同一共享原生产物的构建与原生测试由主 Agent 串行协调，子任务不同时重新构建它们。独立文件组可以并行编辑；`package.json`/lockfile/CI 仅由构建任务修改，避免共享状态冲突。
