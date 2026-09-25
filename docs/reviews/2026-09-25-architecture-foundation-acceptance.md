# 架构与基建复核收口 · 2026-09-25

工作树：`xiaozhao-brain-console/.worktrees/desktop-read`。本报告覆盖本轮架构改造、发现的回归及本地验证，不替代真实账号、真实平台文件和正式分发验收。

## 结论

现有模块化单体适合当前产品：Markdown 是内容来源，SQLite 承担索引与操作状态，Electron 提供桌面权限，Fastify 提供统一 API。优先改善组合根、资源生命周期、数据边界和验证入口；当前没有必要引入更多独立服务。

本轮把启动、索引、归档和路由注册拆成明确模块，保留现有领域实现与 HTTP 合同。能力对象先通过兼容层接入，不宣称完成所有领域接口重写。对后续开发而言，最重要的约束是：资源创建后立即登记清理；服务结束且索引停止后，再关原生句柄和数据库；新路由保持公共合同；发布测试必须使用当前源码构建的包。组合层自身按服务、索引、句柄和数据库的顺序清理；完整 HTTP 关闭路径会先通过 `indexJobs.close()` 停止索引，再进入组合层清理，因此组合层单测不代表整机各阶段的完整顺序。

## 已落实的改动

- 运行时：personal/index/archive composition、统一幂等 disposer、能力适配器与集中路由注册；个人/公司启动失败均尝试释放全部资源并保留原始异常。
- 助手：修复启动 API 切换时的草稿/对话恢复竞态；新增确定性回归，覆盖 API 晚到、恢复中替换与恢复后替换。
- 导入：SheetJS 升级到官方 `0.20.3`；Excel 在带超时的 Worker 中解析；保留文件、工作表、行和单元格限制。修正 Excel 日历边界、超长数字 ID 与实际来源行号。
- 前端：生产页面按路由加载，组件测试使用同步路由映射；生产构建检查 900 KiB 入口预算。
- 工程：fast/full/release 门禁区分覆盖面；release 先重新打包再验收；完整 CI 使用 macOS arm64，快速 CI 使用 Ubuntu，增加生产依赖审计；修复旧 Electron fixture 的导航和隔离数据，并让收件/统一回收默认覆盖打包版。
- 大脑：只读 lint 区分严格格式、旧格式兼容和硬错误；未闭合 YAML 不再被降级为普通无元数据文件。已授权修复的 5 条元数据错误不改变资料正文。讲堂脚本的路径不再依赖启动目录。

SheetJS 的官方来源与 npm registry 并不同步，版本 URL 和完整性已写入锁文件。[官方安装说明](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)；CI 原生构建 runner 的平台选择依据 [GitHub runner 说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。`esbuild` 暂时 override 到 `0.28.2`，上游 tsup 支持修复版本后可移除。

Worker 的 V8 heap 上限不限制全部外部 Buffer，也不是 OS 进程沙箱；报告不把依赖审计通过解释为不存在所有安全风险。

## 验证记录

| 检查 | 本轮结果 |
| --- | --- |
| architecture + typecheck | 通过，覆盖 client/server/Electron/两套 MCP。 |
| unit | 93 文件、1,043 项通过。 |
| integration | 56 文件、621 项通过。 |
| component | 51 文件、651 项通过。 |
| security | 5 文件、46 项通过；也是 integration 的子集，不重复计为独立覆盖。 |
| native + archive | 原生读取 11、sandbox native 24、sandbox recovery/Electron 14、personal native 12、personal archive 46 项通过。 |
| MCP | 个人 23、公司 13 项通过。 |
| browser fixture | 60 项最终全部通过；队列组的 Chrome 初始化问题修复后 16/16 通过。 |
| desktop build/package | 当前源码构建与 arm64 打包通过；包内客户端、Electron main/preload、Excel Worker 与当前 dist 逐字节一致，SheetJS 版本为 0.20.3。 |
| company builds | server 已由 full 构建；MCP 和备份/恢复检查工具构建通过。 |
| npm audit | 生产及完整依赖均为 0 已知漏洞。 |
| client budget | 581,605 bytes，约 568 KiB，预算 921,600 bytes（900 KiB）。 |
| Electron | 46 项最终全部通过：初轮 36 项 + 修正的馆藏 2 项 + 收件/统一回收 4 项 + 资料回收/永久删除 4 项；新增两个打包版分支。 |
| vault scripts | generate.js 的 Node 语法检查与 publish_to_wechat.sh 的 Bash 语法检查通过，未执行外部发布。 |

执行说明：`verify:full` 在 release 流程内完整通过。随后 browser queue 组的 3 个 worker 并发启动系统 Chrome，其中一个在 `browser.newContext` 阶段超时；trace 证明当时页面和断言尚未运行。仅将该组设为 `workers: 1`，整组 16 项复跑通过。已通过的 overview 13 和 intake 17 项保留结果，余下 trash 7、motion 3、operations 4 及发布构建按顺序继续执行。这里记录分项最终结果，不把最初退出码为 1 的整条 `verify:release` 写成一次运行通过。

Electron 初轮另有 8 项停在旧导航名、未打开箱体或旧回收页面假设。测试维护统一到当前档案库/回收站交互，补齐隔离收件目录，尊重档案柜记忆的开合状态，并让原文 fixture 的正文带有可区分的身份。原有取消、焦点、BOM/CRLF、附件字节、inode、重启、队列撤销、显式删除确认和不可恢复断言均保留。受影响的 5 个文件最终 10 项通过（含新增的 2 个打包版分支），未以跳过断言或增加重试掩盖失败。产品代码在最终构建后未再修改，无需为测试脚本调整重新打包。

后续隔离环境验收又补齐了 ingestion-flow 的“正式入库完成后再次重启”检查，并与收件回收恢复一同复跑 packaged 子集，2/2 通过（23.2 秒）。新进程中的知识检索、确认批次、来源和附件字节均核验；真实本机文件与模型替身的边界见 [独立测试库验收](2026-09-25-obsidian-isolated-acceptance.md)。

真实大脑只读扫描：315 文件，228 严格通过，87 警告，0 硬错误。警告包括 70 条旧格式兼容记录和 17 条无 frontmatter 的 Markdown；这些可读内容未被批量重写。

## 本地版本收口范围

本轮以本地个人使用版为收口范围，保存架构、数据边界、验证门禁和验收记录的统一检查点，保留 `desktop-read` 分支及工作树供实际使用和后续维护。后续优先修复真实使用中发现的问题。

提交前重新执行 `npm run verify:fast`，退出 0：架构检查、五套 TypeScript 类型检查、1,043 项单元、621 项集成、23 项个人 MCP 与 13 项公司 MCP 全部通过。先前完整构建、组件、浏览器和桌面验收的分项证据继续按上表保留；没有将这次 fast 检查写成重新执行 full/release。

最终独立复核分为运行时生命周期与数据/前端/构建边界两组，基于 `366f353` 检查本轮变更，未发现可证实的 P1/P2 回归。复核发现的组合层与完整 HTTP 关闭顺序差异已在上文明确；不把未证明有业务影响的差异写成已修复缺陷。

公司版三平台导出样本验收属于可选后续工作，不是个人版本地收口的阻塞项。真实模型效果与真人操作反馈在试用阶段核对；Developer ID 签名、公证和 Gatekeeper 安装验收在正式对外分发前完成。旧 REST 通用写入门保持阻断，仅在确实需要开放该入口时继续证明缺失能力。

## 外部验收边界

- Obsidian Local REST 已完成独立测试库的读取、写入、外部变化观测和实际重启探针。读取、条件替换/恢复、COPY 防覆盖创建和重启持久化通过；PUT 防覆盖未通过，条件删除仍未证明，正式 REST 写门禁保持阻断。完整证据见 [独立测试库验收](2026-09-25-obsidian-isolated-acceptance.md)。该接口属于保留的 REST 集成，当前个人桌面版归档、入库和回收使用独立的原生能力。
- 公司版三个平台的真实 CSV/XLS/XLSX 导出文件尚未提供；当前导入验证使用合成样本，该项已留作按需验收。
- 真实 DeepSeek 调用、账号授权、真人对首次使用流程的理解、Developer ID 签名、公证和正式分发沿用原走查中的未验证状态。
- GitHub Actions 配置已更新，本轮只报告本地执行结果，不声称远端 CI 已运行。

细节边界见 [首次使用走查](2026-09-11-first-run-walkthrough.md) 和 [分发验收](2026-09-14-distribution-acceptance.md)。
