# 操作记录台 Implementation Plan

> 执行方式：当前会话按 executing-plans 顺序完成；保留现有工作树，不提交混合改动。

**Goal:** 将已确认的深色银色记录台接到真实历史，按需展开恢复工作单。

**Architecture:** 后端只读投影现有数据库及归档收据，按状态过滤后分页，不另建写入系统。前端复用归档 resume 和现存提炼/入库页面，回收动作只跳转统一回收站。

**Tech Stack:** React, TypeScript, Fastify, SQLite, Zod, Vitest, Playwright。

### 1. 真实摘要与契约
- [x] 在 `tests/integration/operation-ledger.test.ts` 写隔离数据库测试：旧失败被后续记录覆盖、超过 50 条历史可翻页、无时间收据、入库仅缺索引、源读取失败。
- [x] 运行 `npx vitest run --config vitest.integration.config.ts tests/integration/operation-ledger.test.ts`，确认缺失功能失败。
- [x] 新增 `src/server/services/operation-ledger.ts`，批量读取轻量字段，归一化并过滤分页；不读取原文或调用 review 的写入副作用。
- [x] 扩展 `src/shared/api/schemas.ts`；更新 operations 路由和 app 注入。给 intake 增加独立完整收据读取，避开前 200 项 UI 限制。
- [x] 重跑上述测试通过。

### 2. 记录台和工作单
- [x] 在 `tests/component/operations-page.test.tsx` 验证默认工作单隐藏、选择/关闭、过滤、继续核验单次提交、失败提示与刷新、回收站唯一跳转入口。
- [x] 扩展 API client 的可选分页查询；重写 `OperationsPage.tsx`，新增 scoped `operations.css`；更新 shell 的过期描述。
- [x] 原记录状态仍为真源，归档完成后刷新并去掉旧待处理项；入库冲突跳转原批次所在提炼页处理。
- [x] 运行组件测试和 `npm run typecheck`。

### 3. 验收与交付
- [x] 运行相关 API、页面回归和构建。
- [x] 浏览器用隔离示例验证桌面/窄屏、选择关闭、键盘和空态；真实服务只执行 GET。
- [x] 备份当前包的 client/server 后替换本次构建，保持 native/electron 不变；重启并只读核验真实记录。
- [x] 更新设计状态和交接，提供实际可用页面，不改用户笔记。
