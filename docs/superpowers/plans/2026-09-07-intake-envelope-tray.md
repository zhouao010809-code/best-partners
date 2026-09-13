# Intake Envelope Tray Implementation Plan

> **For agentic workers:** Use the frontend design workflow for the tightly coupled page/form work; parallel workers own the isolated tray component and browser fixtures. Preserve unrelated dirty worktree changes. No commits requested.

**Goal:** Implement the user's approved black/silver inbox reference as a working envelope tray with a right-hand archive slip and compact archive history.

**Architecture:** Keep the existing intake API, polling, preview invalidation, explicit confirmation, recovery and read-only provenance fields. Extract only the tray presentation into `IntakeTray`; the page owns the selected draft and all server actions. Use local CSS/SVG materials rather than a screenshot background.

**Tech Stack:** React, TypeScript, existing lucide icons, scoped CSS, Vitest and Playwright.

## Approved design and boundaries

- User selected `clipboard-88957095-aca8-4f23-8635-a7d07dd76378.png` on 2026-09-07. This supersedes earlier rejections of the tray concept and subsequent digital-gallery exploration.
- Black brushed-metal tray, uniform envelope cards, silver edges, subtle opening animation; 2-column tray beside archive slip on wide screens, stacked on smaller screens.
- Right slip: title, platform/date, main Markdown, expandable author/link, preview action; visible stages distinguish review, preview and completion. Initial slip is an honest unselected state.
- Show only real title/platform/date/status. No fabricated attachments, summaries, timestamps, versions or selectable destination folders. Destination comes from preview and remains read-only.
- Preserve metadata editing and preview invalidation, 5-second detection, loading/error/unavailable/retry, busy guards, explicit commit, unfinished resume and indexed-false receipt.
- Do not touch backend/archive semantics, the vault contents, extraction or knowledge UI. No actual model calls or real-vault test writes.

## Task 1 — Envelope tray

Files: `src/client/pages/intake/IntakeTray.tsx`, `src/client/styles/intake-tray.css`.

- [x] Implement `IntakeTray({ items, selectedName, busy, onSelect })` from `IntakeList['items']` with no API side effects.
- [x] Derive needs-info from real fields, candidate selection and reported problem; provide `全部` / `待补信息` and first-four / all expansion.
- [x] Keep accessible button name `整理 ${item.name}`, selected/disabled states, readable truncated titles with full title available, and reduced motion.
- [x] Render a distinct empty-filter state versus an empty inbox; no fake envelopes.

## Task 2 — Archive slip and integration

Files: `src/client/pages/IntakePage.tsx`, `src/client/styles/intake.css`; intake-only identity text in `src/client/app/AppShell.tsx`.

- [x] Replace oversized rules card/list with compact receipt status toolbar, tray and persistent right slip.
- [x] Reuse existing `change`, `showPreview`, `archive`, `run` and request-version protection. Only a submit renders a preview; only explicit confirm calls commit.
- [x] Fold optional provenance under native details, retaining read-only existing values and explicit labels. Show preview path and plain Markdown below the form, with keyboard focus on the preview heading.
- [x] Close via button/Escape only when idle and return focus to the originating envelope; preserve pending recovery actions and compact expandable history with real paths, not guessed dates.
- [x] Distinguish refreshed connection status from action errors; failed first load must offer retry and must not look like an empty inbox.

## Task 3 — Verification and handoff

Files: `tests/component/intake-page.test.tsx`, `tests/e2e/fixtures/intake-tray.{html,tsx}`, `tests/e2e/intake-tray.spec.ts`, README intake description.

- [x] Update only necessary accessibility queries for folded fields; retain existing preview/confirm, invalidation, provenance and recovery assertions. Add targeted interaction regression checks where behavior changed; do not test decorative markup.
- [x] Run `npm run test:component -- tests/component/intake-page.test.tsx`, `npm run typecheck`, `npm exec vite build`.
- [x] Browser fixture uses in-memory responses only. Check 1440, 1024, 390 pixels: cards, form, empty/filter states, explicit confirm, keyboard focus and no horizontal overflow. Capture screenshots and inspect visually against approved reference.
- [x] Review production changes for request/order regressions. Update packaged client only after passing checks, restart the exact existing App normally, then read-only verify `/intake` on its current origin.
- [x] Remove disposable runner/config files, retain useful fixture/screenshots. Report actual completion and leave no fake demo data in the real App.

## Verified delivery

- Existing component suite: 21 files / 374 tests passed; after adding two behavioral checks, the final intake-specific suite passed 7 tests.
- Final typecheck and Vite client build passed. Existing bundle-size advisory remains; no new runtime dependency added.
- 14 Chrome browser checks passed at 1440, 1024 and 390 pixels, including pinned-envelope focus restoration, explicit confirmation, filter/expand, errors and recovery. Fixtures perform no external writes.
- Real packaged App restarted normally after confirming 0 active generations and 0 pending archive operations. Client hashes: index-B4mb1wMr.js and index-I36axymH.css. Current verified origin: http://127.0.0.1:54597/intake (port changes on App restart).
- Read-only actual App checks at the same widths: no page errors or horizontal overflow; 0 incoming items, 1 archived operation. No real archive/model/vault writes were used for validation.
- Useful screenshots: .local/intake-tray-results. Temporary Playwright config and client deployment backup removed; fixture Vite stopped. Packaged App remains running.
