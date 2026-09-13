# Open Archive Interior Implementation Plan

> Execute inline using executing-plans. Existing isolated dirty worktree stays in place; no commit or unrelated cleanup.

**Goal:** Match the approved open-cabinet preview: persistent dark frame, visible open doors, luminous silver file folders resting on continuous shelves.

**Architecture:** Keep ArchiveVault state machine and mount boundary unchanged. Restyle its doors and frame in open state. Restore CollectionFolder layered paper artwork using the existing library-case CSS, without serial numbers. Shelf lips are repeated per grid cell with zero horizontal gap so each row forms a continuous shelf at any responsive column count. Existing data controls and document reader remain intact.

**Tech Stack:** React, TypeScript, CSS 3D, Vitest, Playwright.

- [x] Update approved spec with preview path and supersede closed-box interior only.
- [x] Change CollectionFolder artwork to library-object-space > library-case, containing backplate, tab, three decorative sheets and silver cover. Use the real folder label; retain accessible button name, count and click behavior. No fabricated numbers.
- [x] In archive-vault.css retain the frame when open, expose hinged door backs at about 100 degrees, reserve side clearance, and light the recessed interior. Use four columns desktop, two medium, one narrow. Put continuous silver shelf lips beneath folders; keep filters/search and reader usable.
- [x] Run existing library component tests and npm run build. No new implementation-mirroring tests for reversible visual-only changes.
- [x] Browser read-only acceptance against current app API: closed read gate, open frame/doors visible, folder and original, search/filter, seal/reopen, mobile no horizontal overflow, reduced motion. Inspect desktop/mobile screenshots against approved preview.
- [x] Check app idle, deploy client only, verify server/electron/native hashes unchanged, read-only deployed acceptance. Move task backup to system trash and stop task preview server. Clear vault handoff after completion.

Verification commands: `npx vitest run --config vitest.client.config.ts tests/component/library-page.test.tsx`; `npm run build`. Expected all pass. Browser uses Chrome via Playwright; block all non-GET API traffic during real-vault inspection.

## Verified delivery

- 29 library component tests passed. Typecheck/client/server build passed; existing bundle-size advisory remains.
- Chrome read-only checks passed: gate, categories, original/Escape, source/topic, search/empty state, status filter, seal/focus/reload, reduced motion, widths 1440/1080/760/600/480/390. Fixed 760px door overflow by reserving 36px side clearance.
- Client deployed and rechecked at http://127.0.0.1:58555/library (PID 57420). Client hash: 6bd912bc01d8964321eddf7a782c1a94dc55e99a18f7fc07625eba8cd82c0205. server/electron/native hashes unchanged. No non-GET API requests in acceptance.
- Visual evidence: .local/open-archive-evidence/deployed.png, mobile.png, reader.png. Only archive-vault.css and CollectionFolder.tsx product files changed this iteration. Worktree and unrelated changes preserved.
