# Physical Containers Implementation Plan

**Goal:** 实现用户明确指定的实体收纳交互：收件箱先外后内、侧栏图标回收站和悬停计数、内部桶盖、冷黑银真实抽拉柜与按需详情。

**Architecture:** 沿用 React/CSS 与原 API。外壳开关为页面本地状态；关闭的内容不可聚焦。抽屉前板、托盘、文件夹作为立体对象沿深度移动，柜壳保持固定；展开空间独立预留，不再仅靠内部高度揭示。无后端或真实资料写入。

**Tech Stack:** React 19, TypeScript, CSS perspective/transforms, Vitest, Playwright Chrome, existing Electron package.

## Confirmed brief

用户已明确细节并要求“开始整”。沿用黑银实体物件，不加多余确认设计步骤。回收站“最右侧”指左侧导航栏底部区域的右边；只隐藏可见文字，保留无障碍名称。数量仅 hover/focus-visible 时显示红色圆徽章，失败不伪造零。收件箱可合上返回外观，已有整理单操作不得静默丢失。回收站进入内部即可见打开的盖子，不增加第二次进入按钮。队列无选择时单栏，URL明确文档深链仍直接打开，关闭详情沿用草稿保护。

## Parallel ownership and implementation

- [x] Intake agent: `IntakePage.tsx`, new `intake/IntakeMailbox.tsx`, intake CSS and corresponding tests. Initial-closed/open/close regression; preserve archive/trash flow and poll updates. Edited fields remain within the mounted page across envelope/container close and reopen; resuming historic archive does not clear another draft.
- [x] Trash agent: `AppShell.tsx`, `TrashPage.tsx`, shared `RecycleBinArtwork.tsx`, unified-trash CSS and related tests. Icon-only, bottom-right placement, hover badge, matching lid/handle; preserve source counts and restore/delete.
- [x] Root: queue regression for no detail before selection and closing; conditional detail and one-column default. Preserve `closeDetail` draft guard and explicit deep links. Sidebar re-entry retains filters but removes document selection; closing detail focuses the handle when its folder is inside a closed drawer.
- [x] Root: replace warm cabinet palette with neutral silver/graphite, define depth-moving tray/front, fixed pocket, visible rails and perspective folder planes. Match item sizes, keep state/counts visible, independent closed defaults, pagination, error feedback, reduced-motion and responsive controls.
- [x] Root: review scoped diffs; run affected components and isolated browsers at desktop/narrow widths; inspect closed, open, selected, hover screenshots. No screenshot or test manipulates actual documents.
- [x] Root: build and verify only frontend runtime deployment after idle check; preserve packaged server/Electron/native hashes. Reopen App and verify initial states plus read-only interactions.
- [x] Root: update README/evidence, stop temporary fixture server, remove task-only superseded files and the verified frontend deployment backup, clear vault handoff. Keep existing dirty worktree; no commit or push.

## Commands and acceptance

```sh
npm exec vitest run -- --config vitest.client.config.ts tests/component
npm exec playwright test -- --config tests/e2e/queue-drawer.config.ts
npm exec playwright test -- --config tests/e2e/intake-tray.config.ts
npm exec playwright test -- --config tests/e2e/unified-trash.config.ts
npm run build
```

Run component suite separately from Chrome to avoid the known MaterialDeck timeout under load. Intake browser tests use its existing fixture on root-owned Vite; update scoped harness only if required. Acceptance includes no panel before clicking a file, no permanently visible bin count, no obscured file/action controls during or after motion, no horizontal overflow and no actual data changes.

## Verification and delivery — 2026-09-07

- Component suite: 415/416 passed initially. The sole failure was the existing delayed-failure pagination-focus assertion in knowledge, unrelated to modified UI; isolated rerun 1/1 and the complete `read-pages.test.tsx` 57/57 passed without changing production or test code. Error text and focus are separate asynchronous updates; the first full-suite failure is recorded, not claimed as an all-green first run.
- Queue fixture Chrome: 14/14 passed at 1440/1024/390px, including pointer interactions, three drawer states, pagination, candidate edits, return focus, reduced motion and queue removal/re-addition. Fixed real 3D pointer interception by making transparent slide/reveal planes non-hit-testing while preserving actionable children; open reveal avoids Chromium flattening. Capped skewed rails to prevent narrow-screen overflow.
- Intake fixture Chrome: 14/17 initially passed; three delete/restore flows reached the replacement recycle view but the helper still awaited the unmounted intake root. Changed only the helper to measure the main workspace; targeted 3/3 passed at all widths with delete/restore assertions retained. Intake component tests: 30/30 passed.
- Recycle fixture Chrome: 6/7 initially passed; circle test compared floating-point dimensions during animation. Wait for finite animations and use 0.05px tolerance; targeted hover/focus test 1/1 passed without UI changes. Related component tests: 64/64 passed.
- `npm run build` passed client/server/Electron typechecking and builds; Vite emitted its existing >500kB chunk-size advisory. No backend runtime files were deployed.
- App PID 24684 was normally quit after read-only idle checks. Copied only built `dist/client` into the exact packaged App; verified identical client SHA256 `29caaefd6c328b1250d4c18abb7889717ef5718021a5acdc47aeb9c25278c4d4`. Existing packaged server/Electron/native tree hashes were unchanged.
- Relaunched App PID 57670 at `http://127.0.0.1:49187`. Read-only Chrome acceptance passed: mailbox initially closed and returns focus after closing; no reader until a queue folder click; all three drawers close on sidebar re-entry; icon is right-aligned, no zero badge, matching large lid/handle and all four source categories present. No browser errors or non-GET requests. Before/after intake, queue and trash states matched (intake empty, 2 pending, no active extraction/ingestion, recycle items already deleted/restored).
- Final actual-App screenshots: `.local/physical-container-evidence/real-intake-closed.png`, `real-intake-open.png`, `real-queue-closed.png`, `real-queue-open.png`, `real-queue-file.png`, `real-trash-lid.png`. Populated envelopes and positive hover badge are fixture evidence only; no fake records were inserted into the real vault.
