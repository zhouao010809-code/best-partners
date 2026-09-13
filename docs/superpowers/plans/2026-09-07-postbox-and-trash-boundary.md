# Postbox and Trash Boundary Implementation Plan

**Goal:** 将收件箱外壳替换为有立杆的经典邮筒，只在统一回收站提供彻底删除；完成后审视大脑总览，保留牌堆逻辑并提出布局建议。

**Architecture:** 沿用现有 React/CSS；邮箱只替换外观，保留初始关闭、打开内部信封、点信封阅读及页内草稿逻辑。回收组件默认没有永久删除能力，由统一 TrashPage 显式启用；遗留删除任务从其他页指向回收站。后端确认与文件存储不变。

**Tech Stack:** React, TypeScript, CSS transforms, Vitest, Playwright Chrome, existing Electron package.

## Accepted scope

用户明确要求直接替换并修正。采用小型弧顶黑银邮筒，带单立杆、侧边投递旗、前开门和投递口；不继续扩大工具箱式外壳。内部信封保持已认可风格。总览仅审视与提出方案，本轮不擅自重做牌堆或数据逻辑。不增加依赖、不写真实资料、不调用模型。

## Tasks

- [x] Root: replace closed markup in `src/client/pages/intake/IntakeMailbox.tsx` and scoped mailbox CSS in `src/client/styles/intake-tray.css`. Preserve props/state/ref/focus/control names, hidden interior, busy guards and existing envelope children. Visual changes use browser acceptance, not tests that repeat decorative class names.
- [x] Trash agent: audit `src/client/components/MaterialTrash.tsx`, `src/client/pages/intake/useIntakeTrash.tsx`, and `TrashPage.tsx`; regression default-off versus trash-enabled deletion, including pending-delete recovery and action guards. Change source-page labels to “移入回收站”; preserve backend previews/confirmation/recovery. Run focused components.
- [x] Root: verify mailbox desktop and narrow screenshots and open/close/draft/delete flows in isolated fixtures; review agent diff and run proportional combined components/build. Keep real vault read-only.
- [x] Root: after idle read checks, quit App normally, copy built client only, verify unchanged packaged server/Electron/native hashes, relaunch and check real closed/open mailbox plus trash-only entry behavior. Do not perform real delete/archive/model calls.
- [x] Overview review agent: inspect existing overview code and screenshot read-only; root validates findings and presents one specific layout recommendation without modifying live overview.
- [x] Root: update README and acceptance evidence, remove task-only temporary artifacts/server, clear vault handoff after completion; preserve dirty changes and do not commit/push.

## Validation

`npm exec vitest run -- --config vitest.client.config.ts tests/component`

`npm exec playwright test -- --config tests/e2e/intake-tray.config.ts`

`npm exec playwright test -- --config tests/e2e/unified-trash.config.ts`

`npm run build`

Coordinate browser/component execution to avoid known load-related test timing. Do not rerun passed suites absent a new change or failure. Keep the actual failed/passed evidence rather than describing retries as first-run success.

## Verified delivery — 2026-09-07

- Root visually checked 1440px and 390px postbox screenshots. The initial SVG inherited the page-wide 17px icon size; a more specific artwork selector fixed it before browser regression and deployment. The final artwork includes the curved roof, front door, post, flag and slot; all existing mailbox state/children remain.
- Intake Chrome fixture: 17/17 passed (23.0s), including 1440/1024/390 widths, unopened envelopes, keyboard focus, field editing, preview/commit confirmation, removal/restoration, errors and archive recovery.
- Unified recycle Chrome fixture: 7/7 passed (9.0s), including four-source tabs, lid/count behavior and explicit packet-deletion confirmation.
- Agent boundary regression: 13 new RED→GREEN cases, covering source-page move result, deny-by-default and route checks, durable pending-delete token, only-trash continuation, revoked callbacks and abandoned preview when leaving the page. Six related component files: 91/91 passed.
- Root complete component run: 416/429 passed; remaining 13 intake-page cases lacked the Router now required by route-scoped controls. Added MemoryRouter at `/intake` to that test harness only; all 13 passed on targeted rerun. No assertions were removed. Build and client/server/Electron typechecks passed; Vite retained its existing >500kB bundle advisory.
- Only the packaged client was replaced after idle checks and a normal quit. Client SHA256 `e6771f40834d148e4dde6bfd4ae4abeca97c3ece081e27b1aed908ab23dae73e`; packaged server/Electron/native hashes unchanged. Temporary prior-client copy removed after verification.
- Current App PID 34150, origin `http://127.0.0.1:56394`. Real read-only Chrome acceptance passed for the postbox, opening/closing the interior, pending queue source action renamed to “移入回收站” with no permanent-delete action, unified trash, and unchanged overview/deck. Zero page errors/non-GET requests; before/after intake/queue/trash state identical.
- Evidence under `.local/postbox-evidence/`: `real-mailbox-closed.png`, `real-mailbox-hover.png`, `real-mailbox-interior.png`, `real-overview-unchanged.png`; overview before screenshots retained locally. No generated/example envelopes were added to the actual vault.

## Overview recommendation — not implemented

Root and independent reviewer inspected the actual overview plus `DashboardPage.tsx`, `materialDeckLayout.ts`, deck CSS and `shell.css`.

1. At 1280px, two cards occupy only about 73–77px visible width each inside a roughly 597×432px stage. Increase front-facing legibility and scale for small decks; keep the existing collection, selection/keyboard/hover and extraction behavior.
2. Compress the 120px four-color metrics block to one restrained silver summary row. Avoid red “可升级” behaving visually like an error; retain the underlying metrics and clear labels.
3. Use one black-silver card surface instead of the outer panel + inner panel + inset line + repeated grid. Put material depth on cards and their contact shadows, not every surrounding box.
4. Turn recent knowledge into a quiet bookmark-like column with readable two-line titles, compact category/date and full paths on demand; retain six links and their destination paths.

Recommended composition: one narrow summary row, dominant card desk to the left, readable recent-knowledge index to the right. No changes to the dashboard were made in this turn. In particular, the unrefined-only deck and completion/partial-ingestion exclusions remain unchanged.
