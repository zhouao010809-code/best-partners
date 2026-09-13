# 抽屉式提炼工作台 Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independent cabinet component; the primary agent integrates and reviews. Preserve this worktree's existing uncommitted changes. Do not commit unrelated work.

**Goal:** 将用户认可的 B 黑银抽屉式工作台接入真实提炼队列，同时控制资料密度、支持宽屏审阅和下一份。

**Architecture:** 保留 extractionQueue、ExtractionWorkbench 和 CandidateReview 的真实接口、发送预览及人工入库确认。QueuePage 负责筛选、分页、URL 和后台刷新；独立 QueueCabinet 负责三层抽屉、首排预览和文件夹外观。审阅宽度切换不卸载编辑器，下一份为显式操作，不自动提交或丢弃草稿。

**Tech Stack:** React 19、TypeScript、Lucide、现有 CSS、Vitest、Playwright；不增加依赖。

---

### 1. 抽屉展示组件

- [x] 新建 `src/client/pages/queue/QueueCabinet.tsx` 和 `src/client/styles/queue-cabinet.css`：pending / generating / ready 三层柜体、斜切银标签、把手开合、统一两行标题。每层默认 3 份，完整展开后使用现有游标分页，不自动读取全部正文。
- [x] `tests/component/queue-cabinet.test.tsx` 先验证第 4 份默认隐藏、查看全部和开合、空/错误/加载状态、选中项；呈现层回调不调用模型接口。

### 2. 真实队列集成

- [x] 修改 `QueuePage.tsx`：使用原有单状态完整页和独立只读首排预览，保留搜索、来源、日期、已移出、失败和已处理入口以及 URL 深链。待确认层只显示仍需取舍的结果；总数无法从旧接口获取时使用明确的已显示数量，不伪造总数。
- [x] 原有轮询和分页保持稳定；从其他抽屉点选使用对应真实资料，旧响应不得覆盖新筛选，某层失败不得伪装为零资料。
- [x] 更新 `tests/component/extraction-workspace.test.tsx` 以覆盖多个只读预览请求，并保留发送/取消/移出/历史、分页和旧响应测试。

### 3. 审阅与视觉

- [x] 在 QueuePage 的同一个详情容器提供“展开阅读 / 收起阅读”“下一份”和关闭按钮。切宽度不改组件 key，保护候选编辑草稿；下一份有草稿时明确提示保留或取消切换。
- [x] 正式 CSS 按 B 黑色柜体、细银边、内凹柜腔和文件夹制作；绿仅用于状态。窄屏保留左导航，点选后进入详情并能回到原抽屉。全局导航和其他页面不重设计。

### 4. 验证与本地交付

- [x] 执行 `npm run typecheck` 和相关 component tests；使用独立 fixture 进行 1440 / 1024 / 390 宽度与核心交互验证，不在真实大脑上发模型请求或测试写入。
- [x] 构建 `dist/client`；确认当前 App 的静态资源目录后仅同步前端构建产物，保留旧哈希资源给仍打开的窗口，不替换数据库、密钥、原文、服务或原生模块。
- [x] 只读打开真实 `/queue` 确认页面和接口；更新 README 及仓库临时交接，清理本次临时测试文件。

## 交付证据 · 2026-09-07

- 实现过程中完整组件集 21 文件 / 373 项通过；增加异步切换边界测试与最后的后台刷新保留后，针对性组件 53 项及三套 TypeScript 检查通过。`npx vite build` 成功；保留原有单包体积提示，不扩大到全站拆包。
- Chrome 独立夹具 10 项通过，覆盖 1440 / 1024 / 390、三层首排/查看全部/把手开合、宽阅读同一编辑框、连续处理不回跳、移出/撤销/重新加入及运行中停止入口。最终视觉检查移除了会遮住取舍选项的浮动批次栏，普通桌面审阅为独立滚动区。
- `tests/e2e/queue-drawer.spec.ts` 和对应 fixture 为永久回归入口。夹具全部数据、保存均在内存，网络守卫拒绝真实 API 与外部请求。截图位于 `.local/queue-drawer-results/`；临时独立测试配置已移除，后续可用项目 Playwright 配置运行指定 spec。
- 实际 App 只更新 `Contents/Resources/app/dist/client`。由于服务启动时缓存首页 HTML，在确认无运行中提炼、归档记录已完成后正常退出并重开，没有强杀进程。
- 当前本机只读验收地址 `http://127.0.0.1:62492/queue`（重启会变）；真实待提炼 2、提炼中 0、待确认 0，原文打开与 980px 宽阅读正常，无横向溢出或页面异常。服务实际返回 `index-D7STf2yJ.js` / `index-C0zeoi7d.css`。没有调用真实 DeepSeek，也未试写原资料或正式知识。
