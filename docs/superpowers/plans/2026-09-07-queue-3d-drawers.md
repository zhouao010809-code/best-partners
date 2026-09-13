# Queue 3D Drawers Implementation Plan

**Goal:** 按用户明确要求，进入提炼队列时三层抽屉默认收起；点击把手才以黑银 3D 抽拉动作展开，内含可操作文件夹。

**Architecture:** 只改现有 React 柜子组件与 CSS。每层独立本机 open 状态，初始 false，不持久化；使用 CSS perspective、立体底板/内壁/前挡板与位移动画。关闭时内容 aria-hidden + inert，不可键盘或鼠标操作。数据刷新不改变 open，离开后重新进入恢复关闭。保留文件标题、计数、筛选、分页、点击阅读、提炼与删除等现有行为。

**Tech Stack:** Existing React, TypeScript, CSS transforms, Vitest, Playwright Chrome, Electron.

## Confirmed brief and design

用户指定默认闭合与实体抽出视觉，不增加权限锁。沿用黑银磨砂金属与银色拉手，柜体固定、抽屉前移，侧壁/底板形成可见厚度，文件夹随抽屉显露。每层可独立开合，短程平滑减速；减少动态效果时直接切换，不做动画。窄屏减小透视和前移距离，不造成水平溢出。无真实资料写入、无依赖新增、无后端修改。

## Work

- [x] Tests agent: 增加默认关闭、点击打开/关闭、重新进入关闭回归，先观察失败；旧队列测试显式打开需要的抽屉，不削弱旧断言。保留受控 pointerdown/up 稳定性回归。
- [x] Root: `src/client/pages/queue/QueueCabinet.tsx` 将 `useState(true)` 改为 `useState(false)`；分离柜体、抽出托盘、前面板层级；关闭时 `aria-hidden={!open}` 与 `inert={!open}`；沿用 `aria-expanded` 和 `aria-controls`。
- [x] Root: `src/client/styles/queue-cabinet.css` 定义实体柜体、透视底板、侧壁、前面板、银色把手和统一文件夹；保留错误、空态、分页和焦点；用响应式尺度与 reduced-motion 分支保证可用。
- [x] Tests agent: 复用隔离 queue-drawer fixture，核对 1440/1024/390，关闭不可见、手动抽开、正常文件动作、键盘及减少动画；fixture 不调用真实 API。
- [x] Root: 目视关闭/打开/窄屏截图，跑相关组件与类型检查；对本次差异进行只读审查，修正具体问题后构建。
- [x] Root: App 空闲时正常退出，备份并仅替换已验证前端运行产物；重开 App 只读检查真实队列，保留现有回收站/后端/资料。
- [x] Root: 记录验证结果、清理本次临时文件，更新 README 与清空大脑交接。保留既有 dirty worktree，不提交其他工作。

## Verification commands

```sh
npm exec vitest run -- --config vitest.client.config.ts tests/component/queue-cabinet.test.tsx tests/component/extraction-workspace.test.tsx
npm exec playwright test -- --config tests/e2e/queue-drawer.config.ts
npm run build
```

Acceptance is the actual closed/open UI and unchanged document actions, not an image-only prototype. No native rebuild or destructive real-data test is needed for this frontend-only task.

## Delivered and verified — 2026-09-07

- Production scope: `QueueCabinet.tsx` and `queue-cabinet.css` only; README and test expectations updated. Initial closed test observed RED before implementation. Three existing Electron workflow scripts now explicitly open the needed drawer; those scripts received syntax/type review, not a fresh full Electron workflow run.
- Component regression: 24 files / 410 tests passed. An earlier run concurrent with Chrome tests timed out in the unchanged MaterialDeck 100-card keyboard test and affected its following focus tests; standalone MaterialDeck 23/23 and the complete component rerun 410/410 passed without modifying tests or timeout.
- Chrome fixtures: 13/13 at 1440, 1024, 390; initial close, independent handles, remount, pagination, selection, candidate editing, queue remove/undo/re-add, active stop control, keyboard, reduced motion and no horizontal overflow.
- `npm run build` passed client/server/Electron type checks and production compilation. Existing large-chunk advisory remains non-blocking. `git diff --check` and task-file whitespace checks passed.
- Actual App normally quit when no archive/extraction was active. Only packaged `dist/client` replaced; source/packaged client SHA256 matched (`6b29da470ac05ce07d07cbb21c0a43d8d8a8a0646e413829e0d855a797500db4`). Server, Electron and native directory fingerprints remained byte-identical. No native rebuild.
- Reopened App PID 24684, runtime origin `http://127.0.0.1:58457` (ephemeral). Read-only acceptance: 3 closed handles on entry and after returning, 2 actual pending folders open/read correctly, close hides contents, original-read and extraction controls remain available, one sidebar trash entry. No page errors and no non-GET requests during this check. Queue and trash statuses unchanged.
- Actual closed/open screenshots retained in `.local/queue-3d-evidence/real-closed.png` and `.local/queue-3d-evidence/real-open.png`; responsive fixture evidence retained in `test-results/queue-drawer-fixture/`. Removed only this task's superseded screenshots and temporary client backup after acceptance; stopped task Vite server. Existing worktree/data retained; no commit or push.
