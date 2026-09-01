# Unrefined-Only Dashboard Material Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard MaterialDeck show only materials whose knowledge status is `未提炼`, while preserving partial-ingestion metrics and queue behavior.

**Architecture:** Keep the material API response and dashboard snapshot unchanged so metrics retain both pending and partially ingested records. Apply the business rule only in `DashboardPage`'s `deckCards` adapter; keep `MaterialDeck` generic and leave the queue untouched.

**Tech Stack:** React 19, TypeScript, Testing Library, Vitest, Playwright

---

## File map

- Modify `src/client/pages/DashboardPage.tsx`: narrow the dashboard deck adapter to `未提炼` records and emit only the `start` action.
- Modify `tests/component/read-pages.test.tsx`: prove the deck excludes `部分入库` while the partial metric remains correct.
- Modify `tests/e2e/read-only-console.spec.ts`: align production browser expectations with two pending cards and retain the existing queue coverage for partial records.

### Task 1: Enforce the unrefined-only dashboard deck contract

**Files:**
- Modify: `tests/component/read-pages.test.tsx:214-253`
- Modify: `tests/e2e/read-only-console.spec.ts:109-159`
- Modify: `src/client/pages/DashboardPage.tsx:134-144`

- [ ] **Step 1: Add the failing component regression assertions**

In `publishes dashboard counts only from live read APIs`, keep the existing metric assertions and add:

```tsx
const deck = screen.getByRole('region', { name: '待提炼材料牌堆' });
expect(within(deck).getByRole('button', {
  name: '待提炼，微信，未提炼'
})).toBeVisible();
expect(within(deck).queryByRole('button', {
  name: '部分，网页，部分入库'
})).not.toBeInTheDocument();
```

This uses the existing mixed fixture, so the same test continues to prove `metric-partial` is `1`.

- [ ] **Step 2: Run the component regression and verify RED**

Run:

```bash
./node_modules/.bin/vitest run --config vitest.client.config.ts tests/component/read-pages.test.tsx -t "publishes dashboard counts only from live read APIs"
```

Expected: FAIL because the `部分，网页，部分入库` button is still present in the deck.

- [ ] **Step 3: Tighten the browser-level dashboard expectations before implementation**

In each dashboard viewport case, scope card assertions to the deck and change the expected count from three to two:

```ts
const deck = page.getByRole('region', { name: '待提炼材料牌堆' });
await expect(deck.locator('[data-material-card-trigger]')).toHaveCount(2);
await expect(deck.getByRole('button', { name: /部分入库：证据链/u })).toHaveCount(0);
```

In `opens the dashboard deck by keyboard and restores the exact trigger on Escape`, change:

```ts
await expect(triggers).toHaveCount(2);
```

Do not change `filters the queue to the real partially ingested material`; that test is the regression proof that partial records remain available outside the deck.

- [ ] **Step 4: Run the focused browser tests and verify RED**

Run:

```bash
npm run test:e2e -- --grep "renders real dashboard metrics at 1280|opens the dashboard deck"
```

Expected: FAIL because the production dashboard still renders three card triggers.

- [ ] **Step 5: Implement the minimal dashboard adapter filter**

Replace `deckCards` in `src/client/pages/DashboardPage.tsx` with:

```tsx
function deckCards(materials: readonly MaterialItem[]): readonly MaterialDeckCard[] {
  return materials.flatMap((record): MaterialDeckCard[] => (
    record.knowledgeStatus !== '未提炼' ? [] : [{
      key: record.path,
      path: record.path,
      title: record.title,
      sourcePlatform: record.sourcePlatform,
      ...(record.collectedAt === undefined ? {} : { collectedAt: record.collectedAt }),
      knowledgeStatus: record.knowledgeStatus,
      nextAction: 'start'
    }]
  ));
}
```

Do not change `collectMaterials`, `DashboardMetrics`, MaterialDeck, API queries, or queue filtering.

- [ ] **Step 6: Verify the focused tests are GREEN**

Run:

```bash
./node_modules/.bin/vitest run --config vitest.client.config.ts tests/component/read-pages.test.tsx -t "publishes dashboard counts only from live read APIs"
npm run test:e2e -- --grep "renders real dashboard metrics at 1280|opens the dashboard deck|filters the queue"
```

Expected: all selected tests PASS; dashboard deck count is two, partial card is absent, and queue partial filtering still works.

- [ ] **Step 7: Run complete relevant verification**

Run:

```bash
npm run test:component
npm run test:e2e
npm run typecheck
npm run build
git diff --check
git status --short
```

Expected: 0 test failures, successful typecheck and production build, no whitespace errors, and only the three planned implementation/test files are changed because the confirmed spec and implementation plan were committed before execution.

- [ ] **Step 8: Commit the implementation**

```bash
git add src/client/pages/DashboardPage.tsx tests/component/read-pages.test.tsx tests/e2e/read-only-console.spec.ts
git commit -m "fix: show only unrefined materials in dashboard deck"
```

Expected: the implementation commit contains no backend, queue, MaterialDeck, or formal-vault changes.
