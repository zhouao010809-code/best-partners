# Archive Continuity Implementation Plan

**Goal:** One fixed cabinet across closed/opening/open/closing; controls outside, independently scrolling contents inside.
**Architecture:** ArchiveVault owns stable controls slot and fixed-height body. Context/portal lets existing LibraryMaterials render controls outside without duplicating query state. Mount after opening click, keep contents during closing, unmount when sealed. Make transitioning content inert and hidden from accessibility navigation. Preserve existing URL, backend and material contracts.

- [x] Browser regression first: tests/e2e/archive-motion.spec.ts checks every frame plus delayed long contents at desktop and mobile; confirm current code fails.
- [x] ArchiveVault.tsx: add ArchiveControls portal into stable exterior slot, render stable toolbar and frame, mount contents while transitioning, gate interactions with inert/aria-hidden.
- [x] LibraryPage.tsx: portal breadcrumbs/search/heading/filters into ArchiveControls. Keep data, pagination, selection and provider logic unchanged.
- [x] archive-vault.css: shared dimensions/margins across phases, same frame material, persistent light, scrollable fixed interior, responsive fixed exterior control slot. Only doors rotate. Keep silver folders.
- [x] Existing 29 LibraryPage tests plus motion regression and build; real read-only browser checks controls location, search, folders, reader, closing, six widths and reduced motion.
- [x] Idle-check and client-only deploy; hash-check preserved server/electron/native; deployed motion/read verification, cleanup backup and handoff.

## Delivery evidence

- Red: initial motion regression failed with 192px x-axis jump in isolated fixture before implementation.
- Green: 3 motion browser tests and 29 LibraryPage component tests passed; typecheck and build passed. Existing bundle-size advisory unchanged.
- Real read-only Chrome acceptance: stable geometry throughout opening (including delayed list), controls outside body, reader/Escape/back, search/source, no overflow at 1440/1080/760/600/480/390, reduced-motion seal and focus. Deployed real app check passed without write requests or page errors.
- Deployed http://127.0.0.1:61781/library, PID 33026. Client hash 79dcc7a5832ba56d25a576c1f92b16ccc909e8924389698b9d3dfd527d8b1312. server/electron/native unchanged.
- Screenshots in .local/archive-continuity-evidence. Product changes limited to ArchiveVault.tsx, LibraryPage.tsx and archive-vault.css; original materials and backend unchanged. Worktree preserved.
