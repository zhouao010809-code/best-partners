# 架构基线与工程基建设计

日期：2026-09-22

## 背景

项目已经包含个人桌面运行时、公司运行时、Fastify API、Electron 主进程、React 控制台、MCP、原生归档模块和多套回归测试。功能边界基本形成，但入口和依赖关系正在变复杂：`src/server/app.ts` 同时负责 HTTP 安全、会话、路由注册和运行模式分流；`src/server/start-server.ts` 同时负责资源创建、恢复、索引、模型、归档、附件与关闭；共享契约反向依赖 Electron；工程验证依赖人工记忆，默认测试和 `verify` 没有覆盖所有运行面。

本阶段的目标是建立一条能约束后续开发的架构基线，不改变资料格式、用户数据、API 业务语义或界面流程。

## 目标与验收标准

1. 依赖方向稳定：`shared` 只依赖第三方纯数据库，不依赖 `client`、`server`、`electron`；`client` 只通过 `shared` 契约和客户端端口访问运行时；`electron` 只通过启动端口和桌面桥接装配服务，不把服务实现反向带入共享类型。
2. 运行时装配可读：个人和公司模式使用显式的 composition/capability 对象；`app.ts` 只负责 HTTP 层，资源生命周期由统一的 runtime disposer 管理。
3. 能力缺失可预测：未启用的可选服务通过统一的 `CAPABILITY_UNAVAILABLE` 公共错误和健康快照暴露，不在每个路由文件中重复定义隐式 `service?` 分支。
4. 质量门禁可复现：增加架构边界检查、MCP 类型检查、完整验证入口和 CI；默认命令名称不会把“仅单元测试”误导成全量测试。
5. 供应链风险可见：`xlsx` 暂无上游修复时，CI 明确记录并限制风险范围；导入器继续使用已存在的输入上限和解析失败记录，不把审计结果伪装成“已修复”。

## 非目标

- 不在本阶段重写个人/公司领域服务，不移动 SQLite 表，不修改 Markdown/YAML 目录与状态枚举。
- 不新增远程基础设施、账号系统、遥测服务或公网部署方案。
- 不把 Electron 主进程改成浏览器可访问的通用 Node 容器。
- 不自动升级或替换 `xlsx`，除非后续单独验证兼容替代方案。

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

路由在能力不存在时调用统一的 `requireCapability()`，抛出 `PublicApiError('CAPABILITY_UNAVAILABLE', ...)`。健康接口继续区分“恢复模式”“未配置”和“能力未启用”，不以 500 代替可解释状态。

### 共享契约迁移

更新检查的 `UpdateCheckResult` 移到 `src/shared/desktop/update.ts`。Electron 的 `update-check.ts` 只保留校验和实现，客户端设置页与桌面桥接只从 shared 引用类型。后续共享目录新增规则：共享文件中禁止出现指向 `electron`、`server` 或 `client` 的相对导入。

### HTTP 与路由装配

保留现有 Fastify 路由文件和 URL。新增按运行模式组织的注册表：个人注册个人能力路由，公司注册公司能力路由，公共 bootstrap/health 单独注册。注册表只接收能力接口，避免 `app.ts` 继续知道每个具体服务的创建方式。

## 工程基建

### 验证命令

- `npm run check:architecture`：扫描受保护目录的相对导入边，发现共享反向依赖、client 直接依赖 server/electron、server 依赖 client 时失败。
- `npm run typecheck`：增加 `tsconfig.mcp.json`，覆盖个人 MCP 和公司 MCP。
- `npm test`：明确改名为 `test:unit` 的别名，新增 `test:all` 聚合 unit、integration、component、archive、native、MCP、company-MCP、security 和 contract。
- `npm run verify`：保留本地可运行的快速门禁，包含 typecheck、architecture、unit、integration、component、build。
- `npm run verify:release`：在完整环境中追加 archive/native/MCP/contract、E2E、Electron、company 构建、桌面包内容检查；原生和浏览器不可用时明确失败，不降级成绿灯。

### CI

新增 GitHub Actions 工作流：安装 Node 22.12+、`npm ci`、架构检查、类型检查、快速测试和生产构建；macOS arm64 job 运行原生合同与 Electron smoke。CI 不执行真实大脑、真实 DeepSeek、真实账号授权或外部写入。

### 依赖风险

保留 `xlsx` 的当前功能，但把 `npm audit --omit=dev --audit-level=high` 作为报告步骤而非盲目 `--audit-level=high` 阻断；另加导入输入大小、工作表/行数、解析超时和失败审计的架构合同，确保高风险解析库不会扩大到任意文件执行或无限资源消耗。替换依赖另开设计，不混入本阶段。

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

引入 `RuntimeCapabilities`、`RuntimeDisposer` 和个人/公司 composition，保持现有 `buildServer` 作为兼容适配层；补充装配集成测试。

### Phase 3：路由能力注册

按个人、公司、公共三组注册表拆分 `app.ts`，移除路由层的隐式可选服务分支；保持 HTTP URL 和响应合同不变。

### Phase 4：按域迁移

在后续独立设计中逐个迁移 assistant、projects、ingestion/archive、trash 和 metrics；每个域完成后删除旧适配层，不进行跨域大爆炸重构。

## 风险与回滚

- 契约迁移风险：只移动类型并保留运行时实现，先跑 typecheck、component 和 Electron update tests。
- 组合根风险：先以适配器包裹现有 `start-server.ts`，新旧入口可并行比较，出现回归时可回退到旧组合函数。
- CI 时间风险：把快速门禁和 release 门禁分开，避免开发迭代必须等待 Electron 打包。
- `xlsx` 风险：不在本阶段替换库；输入约束和审计失败时保留原始文件，不写入错误数据。

