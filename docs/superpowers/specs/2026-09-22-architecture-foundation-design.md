# 架构基线与工程基建设计

日期：2026-09-22

## 背景

项目已经包含个人桌面运行时、公司运行时、Fastify API、Electron 主进程、React 控制台、MCP、原生归档模块和多套回归测试。功能边界基本形成，但入口和依赖关系正在变复杂：`src/server/app.ts` 同时负责 HTTP 安全、会话、路由注册和运行模式分流；`src/server/start-server.ts` 同时负责资源创建、恢复、索引、模型、归档、附件与关闭；共享契约反向依赖 Electron；工程验证依赖人工记忆，默认测试和 `verify` 没有覆盖所有运行面。

本阶段的目标是建立一条能约束后续开发的架构基线，不改变资料格式、用户数据、API 业务语义或界面流程。

## 目标与验收标准

1. 依赖方向稳定：`shared` 只依赖第三方纯数据库，不依赖 `client`、`server`、`electron`；`client` 只通过 `shared` 契约和客户端端口访问运行时；`electron` 只通过启动端口和桌面桥接装配服务，不把服务实现反向带入共享类型。
2. 运行时装配可读：个人和公司模式使用显式的 composition/capability 对象；`app.ts` 只负责 HTTP 层，资源生命周期由统一的 runtime disposer 管理。
3. 能力缺失可预测：组合根集中列出可选服务；缺失时继续使用各域已有的公共错误码和健康快照，保持客户端合同兼容。
4. 质量门禁可复现：增加架构边界检查、MCP 类型检查、完整验证入口和 CI；默认命令名称不会把“仅单元测试”误导成全量测试。
5. 供应链风险可见：从官方发布源升级受影响依赖，锁定完整性哈希并执行审计；导入器保留输入上限、解析失败记录和兼容性回归。

## 非目标

- 不在本阶段重写个人/公司领域服务，不移动 SQLite 表，不修改 Markdown/YAML 目录与状态枚举。
- 不新增远程基础设施、账号系统、遥测服务或公网部署方案。
- 不把 Electron 主进程改成浏览器可访问的通用 Node 容器。
- 不替换导入业务合同；依赖升级须覆盖 XLS/XLSX、中文字段和日期兼容性。

## 方案比较

### 方案 A：边界优先（采用）

先修正共享契约的反向依赖，建立 `RuntimeCapabilities` 和 `RuntimeDisposer`，再增加架构检查与验证门禁。保持现有服务实现，逐步把组合逻辑移入 composition 模块。优点是变更面小、每一步可独立回归；缺点是第一阶段仍会保留部分旧服务接口，需要后续逐域迁移。

### 方案 B：一次性领域重构

按个人、公司、助手、项目、归档重排整个服务目录和数据库访问边界。长期结构更整齐，但会同时触及全部路由、测试和启动流程，难以区分行为回归与结构回归，不适合作为当前首轮基建。

### 方案 C：只补 CI 和发布脚本

只增加工作流、测试聚合和打包检查，不动运行时依赖。上线门禁会更好，但共享→Electron 反向依赖和组合根复杂度会继续扩大，后续改造成本更高。

## 目标架构

```text
src/shared       纯合同、领域值对象、错误码、桌面桥接类型
      ↑
src/client       React 页面、API client、桌面 API 调用
src/electron     窗口、IPC、文件选择、启动/停止编排
src/server       HTTP 适配器、应用服务、仓储/文件/模型适配器
scripts          构建与验证入口（只能依赖 src 的公开端口）
```

运行时由两个显式阶段组成：

1. `createRuntimeComposition(config)` 创建数据库、索引、个人/公司服务、模型适配器和能力清单，并返回 `RuntimeCapabilities` 与可逆 `dispose`。
2. `createHttpApplication(composition)` 读取能力清单，注册安全钩子和路由；路由只依赖 capability interface，不接触数据库、文件端口或 Electron。

`start-server.ts` 保留网络监听和启动顺序，但不再直接持有所有具体资源；资源关闭按注册顺序的逆序执行，错误聚合后仍保证剩余资源释放。Electron 只消费 `StartedServer`、桌面桥接接口和少量跨运行时类型。

当前组合边界已先落地为兼容适配层：`runtime/personal-composition.ts` 负责个人跨域协调，`runtime/index-composition.ts` 和 `runtime/archive-composition.ts` 分别负责索引、归档与回收服务，`start-server.ts` 只负责校验、HTTP、静态资源和监听，`buildServer` 在入口处将能力映射到旧的 `BuildServerOptions`。旧调用方无需迁移，后续可以按域删除具体 options，而不需要一次性重写 HTTP 路由。

### 能力模型

能力不是布尔开关，而是带公共行为的可选端口：

```ts
export interface RuntimeCapabilities {
  readonly health: HealthService;
  readonly read?: ReadCapabilities;
  readonly personal?: PersonalCapabilities;
  readonly company?: CompanyCapabilities;
  readonly assistant?: AssistantCapabilities;
}

export interface RuntimeDisposer {
  dispose(): Promise<void>;
}
```

当前路由通过兼容适配器接收能力，保留已有各域错误（如 `SKILL_CATALOG_UNAVAILABLE`）。健康接口继续区分“恢复模式”“未配置”和“能力未启用”，不以 500 代替可解释状态。统一 requireCapability 或重命名公共错误属于后续合同迁移，不是当前已实现功能。

### 共享契约迁移

更新检查的 `UpdateCheckResult` 移到 `src/shared/desktop/update.ts`。Electron 的 `update-check.ts` 只保留校验和实现，客户端设置页与桌面桥接只从 shared 引用类型。后续共享目录新增规则：共享文件中禁止出现指向 `electron`、`server` 或 `client` 的相对导入。

### HTTP 与路由装配

保留现有 Fastify 路由文件和 URL。`api/register-routes.ts` 集中注册现有路由，保留个人/公司条件；`app.ts` 负责 HTTP 安全、会话和 HTTP 层服务生命周期。注册表仍接收兼容 options，避免一次性改变路由构造与错误合同。

## 工程基建

### 验证命令

- `npm run check:architecture`：扫描受保护目录的相对导入边，发现共享反向依赖、client 直接依赖 server/electron、server 依赖 client 时失败。
- `npm run typecheck`：增加 `tsconfig.mcp.json`，覆盖个人 MCP 和公司 MCP。
- `npm test`：现在明确指向 `test:unit`；`test:all` 聚合 unit、integration、component、archive、native、MCP、company-MCP 和 security。需要真实 Obsidian、凭证和外部状态的合同探针单独使用 `npm run test:contract:all`，避免缺少外部环境时产生误导性的绿灯。
- `npm run verify`：完整本地门禁的兼容别名，等价于 `verify:full`；日常快速检查使用 `verify:fast`。
- `npm run verify:full`：在完整本地环境中执行 architecture、typecheck、`test:all` 和 desktop runtime build。
- `npm run verify:release`：在 `verify:full` 之后追加 E2E fixture、当前源码的 macOS 打包、Electron 开发/打包验收及 company MCP/operations 构建（server 已由 full 构建）；原生和浏览器不可用时明确失败，不降级成绿灯。真实 Obsidian 合同仍由 `test:contract:all` 单独执行。

### CI

GitHub Actions 现在分为 `verify-fast` 和 `verify-full` 两个 job：都安装 Node 22.12+ 并执行 `npm ci`，快速 job 在 Ubuntu 运行快速门禁和生产构建，完整 job 在 macOS arm64 运行 `verify:full`，匹配原生模块的编译要求（[GitHub runner 说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)）。CI 不执行真实大脑、真实 DeepSeek、真实账号授权或外部写入；真实 Obsidian 合同仍需在具备外部环境的机器上显式运行。

### 客户端包体

生产路由通过独立的 route page loader 生成按页 chunk，测试配置使用 eager loader 保持现有组件测试的同步装配。`npm run build` 会执行 `check:client-bundle`，当前入口预算为 900 KiB；超过预算时构建失败，避免页面和图标依赖重新全部回流到首包。

### 依赖风险

SheetJS 使用官方 CDN 的 `0.20.3`，package-lock 固定 tarball 完整性，`npm audit --omit=dev` 无已知生产漏洞。导入器在 Worker 中解析 Excel，保留 20 MiB、20 工作表、100,000 行、1,000,000 单元格上限及 15 秒超时；V8 heap 上限不等同进程内存沙箱。合成 XLS/XLSX、中文、1900/1904 日历和范围限制已纳入回归，真实平台导出样本仍是外部验收项。开发期 `esbuild` 临时固定到 `0.28.2`；上游 tsup 支持修复版本后可移除 override。

## 错误与关闭策略

- 公共错误继续由 `PublicApiError` 统一映射，内部异常只返回稳定的 operation id。
- 能力未启用、恢复中、冲突和输入错误使用不同错误码，客户端不根据 HTTP 文本猜测状态。
- `RuntimeDisposer` 保证关闭幂等；每个资源注册一次，逆序释放；首次关闭错误不会阻止后续资源清理。
- 启动失败先关闭已创建资源，再把原始错误抛给启动入口；不能留下运行锁、SQLite 连接或定时器。

## 测试策略

1. 单元测试覆盖共享类型迁移、架构边界扫描、能力缺失错误和 disposer 的逆序/幂等/异常继续清理。
2. 集成测试用最小个人和公司 composition 启动 Fastify，验证路由隔离、bootstrap、health 和能力缺失响应。
3. 现有领域测试保持原样运行；新增验证只检查装配和边界，不重复测试已有业务实现。
4. Release 门禁继续使用临时 vault、临时 userData 和合成模型响应；禁止读写真实用户资料。

## 分阶段交付

### Phase 1：契约与门禁

迁移 `UpdateCheckResult`，加入架构扫描、MCP 类型检查、验证聚合命令和 CI。此阶段不改变服务启动行为。

### Phase 2：运行时组合

引入 `RuntimeCapabilities`、`RuntimeDisposer` 和个人 composition；公司启动沿用既有 company-runtime 并接入统一 disposer，保持 `buildServer` 兼容适配层；补充装配与启动失败测试。

### Phase 3：路由能力注册

抽出集中路由注册入口，保留模式条件与可选服务行为；保持 HTTP URL 和响应合同不变。

### Phase 4：按域迁移

在后续独立设计中逐个迁移 assistant、projects、ingestion/archive、trash 和 metrics；每个域完成后删除旧适配层，不进行跨域大爆炸重构。

## 风险与回滚

- 契约迁移风险：只移动类型并保留运行时实现，先跑 typecheck、component 和 Electron update tests。
- 组合根风险：先以适配器包裹现有 `start-server.ts`，新旧入口可并行比较，出现回归时可回退到旧组合函数。
- CI 时间风险：把快速门禁和 release 门禁分开，避免开发迭代必须等待 Electron 打包。
- `xlsx` 风险：升级使用官方 tarball 和锁文件；输入限制、超时及错误记录降低解析风险，真实样本兼容性需要另行验收。
