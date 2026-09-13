# Luminous Overview Deck Implementation Plan

**Goal:** 实现用户确认的无右栏草图，并增加克制的银白光泽；保持原侧向角度。

**Architecture:** Dashboard 移除最近知识展示，但继续读取知识统计。MaterialDeck 增加局部 showcase 外观：原侧向几何约 1.25 倍尺寸、固定标题栏和光泽样式；原 default 与 desk 外观不受影响。沿用原筛选、选中、键盘、长按和提炼入口。

**Tech Stack:** React、TypeScript、CSS 3D transforms、Vitest、Playwright Chrome。

## 执行清单（当前会话内执行，不提交其他未完成工作）

- [x] 在 `tests/component/material-deck/MaterialDeck.test.tsx` 先验证 showcase 标题栏跟随 hover/focus，选择优先，删除当前资料后不残留旧标题。
- [x] 在 `src/client/components/material-deck/materialDeckLayout.ts` 增加 showcase：使用默认 -48° Y/-2° Z 角度；宽高乘 1.25，详情宽度限制在当前视口，长队列位置保持有限。
- [x] 在 `MaterialDeck.tsx` 用 `activeKey ?? liftedKey ?? effectiveFocusedKey` 读取标题栏资料，仅 showcase 展示；空列表不显示旧资料。
- [x] 在 `DashboardPage.tsx` 使用 showcase，删除最近知识 section 和仅用于它的排序函数；保留知识统计与所有过滤函数。
- [x] 在 `dashboard-desk.css` 使用单列主区、稳定高度标题栏、深烟灰玻璃、静态微亮银边、hover 更亮边光与单次反光扫过；减少动态效果偏好下禁用动效。
- [x] 更新 `tests/e2e/overview-desk.spec.ts`：无最近知识栏，标题栏跟随、角度保持、空态和 25 张键盘可达；侧栏知识库入口不变。
- [x] 运行相关组件与布局测试、scoped Chrome、`npm run build`，检查真实尺寸截图。
- [x] 仅替换打包 App 的 client，验证 server/electron/native 哈希不变；真实资料只读核验，清理临时备份并交付截图。

## 验证结果

### 后续：比例、光影与技术文字精修（2026-09-08）

按用户确认的三点调整：showcase 根据空/少量/完整密度分别使用 250/420/480px 展示高度；弱化外框为透明，添加极淡桌面反光；保持侧向角度和原操作。仅总览移除双层英文标题与 READ ONLY 标识，正常状态显示“资料已就绪”，索引原文保留在 title，异常呈现不变。其他页面模式标识保留。

验证：140 项组件、13 项 Chrome 和 build 通过；真实 App 2 张牌的展示高度 420px，181 篇知识，390px 无页面溢出，打开/Escape 正常，无 pageerror、无非 GET API 请求。仅更新 client，哈希 `90113b47180626529233e545c05d9af26f8520b505e401a3aee2f2b0ec330e34`，server/electron/native 不变。真实截图 `.local/overview-desk-evidence/real-overview-polished.png`、`real-overview-polished-mobile.png`。

### 后续：总览统计减负（2026-09-08）

用户确认撤掉四格统计。待提炼数量只保留在牌堆标题旁；知识总量改为小字“已积累 N 篇知识”，可进入知识库；不把可升级数量当成待办。保留原数据一致性检查和侧向发光牌堆。

验证：页面组件 57 项、Chrome 13 项、完整 build 通过。真实 App 显示 2 份待提炼、181 篇知识，无四格统计；390px 无页面横向溢出，知识入口可导航，无 pageerror 或非 GET API 请求。仅部署 client，校验 `53040c834b3a247cfffdd9bbcf889911f82b931db6eca03e229d9df652c4caa8`，后端/electron/native 哈希保持不变。截图 `.local/overview-desk-evidence/real-overview-quiet.png` 和 `real-overview-quiet-mobile.png`。

### 初版光泽验证

- 组件 88 项、布局 31 项通过；Chrome 原 12 项及新增光泽/标题栏/减少动效 1 项通过。
- `npm run build` 通过（保留既有大 chunk 提示）。
- 真实 App：2 份待提炼、无最近知识区；桌面 hover/展开/Escape 和 390px 阅读核验，无 pageerror、无非 GET API 请求。
- client 校验：`a0960925c90e8c991bb3dd4e87c2a6d59f2f20133177da08f3ae2274846fea15`；server/electron/native 与更新前一致。
- 真实截图：`.local/overview-desk-evidence/real-overview-luminous.png`、`real-overview-luminous-open.png`、`real-overview-luminous-mobile.png`。
