# 开发与验证

[返回项目首页](../README.md) · [功能与使用参考](reference.md)

## 环境与启动

需要 macOS arm64、Node.js 22.12+ 和 Xcode Command Line Tools。

```sh
npm ci
npm run electron
```

`electron` 会构建并启动独立桌面运行时；旧 `npm run dev`/`npm start` 仍属于 Local REST 兼容入口，需要其旧配置。

## 验证入口

Node.js 需要 `22.12+`。日常提交前运行：

```sh
npm run verify:fast
```

这会依次检查共享、客户端、服务端、Electron 和 MCP 的层边界与类型，再运行单元、集成和两套 MCP 测试。需要验证浏览器 fixture 时运行：

```sh
npm run test:e2e:fixtures
```

fixture runner 会按配置串行启动各自的 Vite 端口，避免直接运行默认 `test:e2e` 时因为缺少专用 fixture 服务而产生误报。发布前运行 `npm run verify:release`；CI 的快速和完整门禁见 `.github/workflows/ci.yml`。

完整本地门禁运行：

```sh
npm run verify:full
```

它会加入组件、安全、原生、归档、公司 MCP 和桌面运行时构建检查，需要 macOS arm64 与 Xcode 命令行工具。`npm run verify:release` 还会执行 E2E fixture、重新打包当前源码、Electron 开发版/打包版验收，以及公司 MCP/运维工具构建；真实 Obsidian 合同探针需要单独配置外部环境后运行 `npm run test:contract:all`。只读扫描正式大脑的元数据时，使用：

```sh
VAULT_ROOT=/absolute/path/to/vault npm run vault:lint
```

该命令只读取 `01图书馆` 和 `02知识库`，把严格通过、历史兼容和硬错误分开统计，不会改写笔记。存在硬错误时退出码为 `2`。

生产构建会执行客户端入口预算检查。当前首屏入口预算为 900 KiB，个人和公司页面在生产环境按路由懒加载；组件测试通过专用 eager route map 保持同步测试语义。

## 打包与原生模块

```sh
npm run package:mac
npm run test:electron
```

桌面测试会检查开发入口与生成的 `.app`，必须先打包。测试使用独立临时目录；Electron 测试根守卫在初始化缓存前执行。

打包下载不可用时，可将 `XIAOZHAO_ELECTRON_ZIP_DIR` 指向本机已核对的 Electron ZIP 缓存目录；其中必须有同版本、同平台文件 `electron-v44.1.0-darwin-arm64.zip`。此选项只供构建使用，不给运行中的 App 增加写入权限。

`test:sandbox-archive` 单独验证新建临时测试库中的整包移动、私有恢复记录、
进程中断和冲突识别，也在实际 Electron 主进程验证。它不是正式自动归档入口：
不规范 YAML、不建立月份目录、不更新索引、不接收 App 请求，正式写入开关不变。
仅接受带专用标记的私有临时目录，拒绝普通大脑路径；正常打包明确排除该模块与故障测试模块。
归档模块构建按当前 `process.versions.node` 选择头文件，默认缓存为 `~/Library/Caches/node-gyp/<当前版本>/include/node`；缺少有效头文件时，使用项目锁定的 `node-gyp` 下载该版本并校验下载内容，之后再次核对头文件与版本。残缺缓存先在独立临时目录下载，成功后只补齐当前版本，保留其他缓存。可设置绝对路径 `XIAOZHAO_NODE_GYP_CACHE` 使用独立缓存；离线构建可将 `XIAOZHAO_NODE_HEADERS` 指向同版本的 `include/node` 目录，目录无效或版本不符会明确失败，不会自动改用其他缓存。安全边界和后续项见
[隔离归档与恢复](superpowers/plans/2026-09-05-sandbox-archive-recovery.md)。

`test:personal-archive` 验证外置恢复目录、主文件交换、独占改名、月份创建、确认后归档以及实际进程退出后的恢复。正式 App 只打包批准的 `personal-archive.node` 和只读 helper，不打包 sandbox writer 或故障钩子。用户已接受启动时信任安装的个人 App/模块；没有签名、公证和抵御同用户恶意替换 App 代码的保证，也不宣称断电安全或来源文件身份的原子比较交换。详见 [个人收件实施与边界](superpowers/plans/2026-09-05-personal-intake-app.md)。

`tests/electron/intake-flow.test.ts` 使用真实插件字段形状，验证日期自动填入、信息区保留、确认归档、原文与附件保真及故障阻断。兼容修复见 [插件日期与附加信息](superpowers/plans/2026-09-05-clipper-date-compatibility.md)。

`tests/electron/extraction-flow.test.ts` 在开发和打包 App 中使用独立临时大脑、测试密钥及替代的模型传输，验证真实本地接口、加密保存、预览不发送、确认仅发送一次、候选持久化、重启恢复与原文不变；不调用真实 DeepSeek。详见 [个人 DeepSeek 候选阶段](superpowers/plans/2026-09-06-personal-deepseek-candidates.md)。

入库闭环的针对性入口包括 `tests/unit/knowledge-note-format.test.ts`、`tests/integration/personal-ingestion-service.test.ts`、`tests/integration/personal-ingestion-api.test.ts`、`tests/component/candidate-review.test.tsx` 和 `tests/native/personal-ingestion.contract.test.ts`，分别检查来源与保护状态、预览/提交/恢复、接口边界、候选编辑与确认、原生文件操作。`tests/integration/extraction-queue-api.test.ts` 与阅读页组件测试覆盖历史候选汇总、完成过滤和知识/原文直达。

历史验收（2026-09-07）：当时已通过单元 660 项、集成 246 项、组件 277 项、原生契约 35 项与真实 native / SQLite 入库流程 4 项；开发及打包 Electron 10 项、候选 Chrome 宽窄屏 2 项全部通过，覆盖归档到入库、重启恢复、部分处理及知识找回。最后的全局标题文案更新另外通过 AppShell 57 项，并重新构建与打包；真实 App 已打开且只读核验连接、历史与原资料。未自动调用真实 DeepSeek 或试写真实知识。详细证据和交付边界见 [个人知识入库闭环](superpowers/plans/2026-09-07-personal-ingestion-loop.md)，本机截图与日志位于 `.local/electron-evidence/`。

工作台的只读接口为 `/api/v1/extraction-queue`、`/api/v1/extraction-queue/source?materialPath=...` 和 `/api/v1/extraction-history`。状态汇总基于完整提炼及候选审阅记录，不限最近 50 次；已有结果可按待处理/已处理筛选。列表和历史采用带筛选条件及快照校验的游标，变化后提示刷新。列表轮询不会收起已展开页，也不会触发模型调用。设计见 [提炼工作台实施记录](superpowers/plans/2026-09-06-extraction-workspace.md)。

浏览器 fixture 完整回归为 `npm run test:e2e:fixtures`，候选编辑与确认的隔离界面入口为 `tests/e2e/candidate-review.spec.ts`，首次需要 Playwright 浏览器。当前机器的浏览器回归使用已安装的 Chrome 运行，没有修改视觉基线。

资料回收与队列管理的测试入口为 `personal-trash-service` / `personal-trash-api` 集成测试、`material-trash` / `trash-api-client` 组件测试、`tests/native/personal-trash.contract.test.ts`、`tests/archive/personal-trash-flow.test.ts`、`tests/electron/material-management.test.ts` 和 `tests/e2e/queue-visibility.spec.ts`。它们覆盖预览不写入、引用提示、重复确认、重启恢复、同名冲突、文件身份与字节保真、队列可见性持久化及宽窄窗口。实施与交付证据见 [资料回收与队列管理](superpowers/plans/2026-09-07-material-trash-and-queue-removal.md)，本机日志与截图在 `.local/material-management-evidence/`。

单条彻底删除的设计、迁移、原生边界和实际验证记录见 [回收站彻底删除](superpowers/plans/2026-09-07-trash-permanent-delete.md)。新操作只接受回收记录 ID 与预览令牌，不接受任意本地删除路径。

## 当前验收记录

以上带日期的测试数字保留当时的验证范围，不代表当前总量。当前结果及未验证项以 [2026-09-25 架构与基建验收](reviews/2026-09-25-architecture-foundation-acceptance.md) 为准。
