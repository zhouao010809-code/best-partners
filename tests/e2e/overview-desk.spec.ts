import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/overview-desk.js';

const origin = process.env.OVERVIEW_DESK_ORIGIN ?? 'http://127.0.0.1:41798';
const fixture = `${origin}/tests/e2e/fixtures/overview-desk.html`;
const unexpectedRequests = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const requests: string[] = [];
  unexpectedRequests.set(page, requests);
  await page.route(url => url.pathname.startsWith('/api/') || url.origin !== origin, route => {
    requests.push(route.request().url());
    return route.abort('blockedbyclient');
  });
});
test.afterEach(async ({ page }) => {
  expect(unexpectedRequests.get(page), 'The overview fixture must never request a backend or external service').toEqual([]);
  expect(await page.evaluate(() => window.__overviewDeskFixture?.unexpectedActions ?? []), 'Navigation and inspection must not invoke a write or model action').toEqual([]);
});

async function expectMetrics(page: Page, pending: number) {
  await expect(page.getByRole('region', { name: '大脑状态摘要', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('metric-materials')).toHaveText(`${pending} 份`);
  await expect(page.getByTestId('metric-knowledge')).toHaveText('已积累 6 篇知识');
  await expect(page.getByTestId('metric-knowledge')).toHaveAttribute('href', '/knowledge');
  await expect(page.getByTestId('metric-partial')).toHaveCount(0);
  await expect(page.getByTestId('metric-upgradeable')).toHaveCount(0);
}

for (const width of [1440, 1024, 390]) {
  test(`full-width luminous material collection remains usable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(fixture);
    await expectMetrics(page, 2);
    const dashboard = page.locator('.dashboard-reading-desk');
    await expect(dashboard).toBeVisible();
    await expect(page.getByRole('region', { name: '待提炼材料牌堆', exact: true })).toBeVisible();
    const deck = page.getByRole('region', { name: '待提炼材料牌堆', exact: true });
    await expect(deck).toHaveAttribute('data-deck-appearance', 'showcase');
    const cards = page.locator('[data-material-card-trigger]');
    await expect(cards).toHaveCount(2);
    const expected = await page.evaluate(() => window.__overviewDeskFixture.expected);
    for (const title of expected.pendingTitles) await expect(cards.filter({ hasText: title })).toBeVisible();
    for (const title of expected.excludedTitles) await expect(cards.filter({ hasText: title })).toHaveCount(0);
    for (const card of await cards.all()) await expect(card).toHaveAccessibleName(/，未提炼$/u);
    await expect(page.getByRole('list', { name: '最近知识', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '当前资料', exact: true })).toContainText(expected.pendingTitles[0]!);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const bounds = await dashboard.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    await expect(cards.first().locator('strong')).toBeInViewport();
    const collapsed = await cards.first().locator('..').evaluate(element => {
      const style = getComputedStyle(element);
      const matrix = new DOMMatrixReadOnly(style.transform);
      return { width: Number.parseFloat(style.width), is2D: matrix.is2D, depthTilt: Math.abs(matrix.m13) };
    });
    expect(collapsed.width).toBeGreaterThanOrEqual(130);
    expect(collapsed.width, 'Only a 25% enlargement; not the rejected wide cards').toBeLessThanOrEqual(177.5);
    expect(collapsed.is2D, 'Collapsed cards should retain an actual 3D transform').toBe(false);
    expect(collapsed.depthTilt, 'The original collapsed card face should remain visibly side-on').toBeGreaterThan(0.5);
    await page.screenshot({ path: info.outputPath(`overview-desk-${width}.png`), fullPage: true });
    if (width >= 1024) {
      await cards.first().focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      const title = dialog.getByRole('heading');
      await expect(title).toBeFocused();
      await expect.poll(() => page.locator('.material-deck-card.is-selected').evaluate(element => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        return Math.max(Math.abs(matrix.m13), Math.abs(matrix.m23), Math.abs(matrix.m12), Math.abs(matrix.m21));
      }), { message: 'The selected card should finish turning to face the reader' }).toBeLessThan(0.01);
      await expect(title).toBeInViewport();
      const legibility = await title.evaluate(element => ({
        width: element.getBoundingClientRect().width,
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize)
      }));
      expect(legibility.width).toBeGreaterThanOrEqual(160);
      expect(legibility.fontSize).toBeGreaterThanOrEqual(16);
      await page.screenshot({ path: info.outputPath(`overview-desk-${width}-selected.png`), fullPage: true });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(cards.first()).toBeFocused();
    }
  });
}

for (const count of [0, 1, 2, 9, 25]) {
  test(`the ${count}-card collection excludes partial and already-reviewed materials`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${fixture}?count=${count}`);
    await expectMetrics(page, count);
    await expect(page.locator('[data-material-card-trigger]')).toHaveCount(count);
    const diagnostic = await page.evaluate(() => window.__overviewDeskFixture);
    expect(diagnostic.healthReads).toBeGreaterThanOrEqual(3);
    expect(diagnostic.materialQueries).toContainEqual({ limit: 200 });
    expect(diagnostic.knowledgeQueries).toContainEqual({ includeObsolete: true, limit: 200 });
    expect(diagnostic.queueQueries).toContainEqual({ view: 'ready', reviewState: 'complete', limit: 200 });
    for (const view of ['pending', 'generating', 'ready', 'unfinished']) {
      expect(diagnostic.queueQueries).toContainEqual({ view, visibility: 'removed', limit: 200 });
    }
    for (const title of diagnostic.expected.excludedTitles) await expect(page.locator('[data-material-card-trigger]').filter({ hasText: title })).toHaveCount(0);
    if (count === 0) await expect(page.getByText('暂无待提炼材料', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
  });
}

test('keyboard opening and Escape return focus to the selected material', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.goto(fixture);
  const first = page.locator('[data-material-card-trigger]').first();
  await expect(first).toBeVisible();
  await first.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toBeFocused();
  await expect(dialog.getByRole('button', { name: '开始提炼', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute('aria-expanded', 'false');
});

test('the primary action navigates to the existing extraction preparation without a model action', async ({ page }) => {
  await page.goto(fixture);
  const first = page.locator('[data-material-card-trigger]').first();
  await expect(first).toBeVisible();
  await first.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: '开始提炼', exact: true }).click();
  const path = await page.evaluate(() => window.__overviewDeskFixture.expected.pendingPaths[0]!);
  await expect.poll(() => page.evaluate(() => window.__overviewDeskFixture.route)).toBe(`/extractions/new?materialPath=${encodeURIComponent(path)}`);
  await expect(page.getByRole('region', { name: '提炼准备', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '预览发送内容', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__overviewDeskFixture.readCalls)).toEqual(expect.arrayContaining(['deepSeek.get', 'extraction.list']));
});

test('the knowledge library remains accessible from the sidebar', async ({ page }) => {
  await page.goto(fixture);
  const link = page.getByRole('complementary', { name: '最佳拍档侧边栏' }).getByRole('link', { name: '知识库', exact: true });
  await expect(link).toBeVisible();
  const href = '/knowledge';
  await expect(link).toHaveAttribute('href', href);
  await link.click();
  await expect.poll(() => page.evaluate(() => window.__overviewDeskFixture.route)).toBe(href);
  await expect(page.getByRole('heading', { name: '知识库', exact: true })).toBeVisible();
});

test('hover illuminates a side-facing card and updates a stable caption without opening it', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto(`${fixture}?count=9`);
  const cards = page.locator('[data-material-card-trigger]');
  await expect(cards).toHaveCount(9);
  const caption = page.getByRole('region', { name: '当前资料', exact: true });
  const initialBounds = await caption.boundingBox();
  const target = cards.last();
  const initialShadow = await target.locator('..').evaluate(element => getComputedStyle(element).boxShadow);
  await target.hover();
  await expect(target.locator('..')).toHaveAttribute('data-card-lifted', 'true');
  const title = await page.evaluate(() => window.__overviewDeskFixture.expected.pendingTitles.at(-1)!);
  await expect(caption).toContainText(title);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => target.locator('..').evaluate(element => getComputedStyle(element).boxShadow)).not.toBe(initialShadow);
  expect((await caption.boundingBox())!.height).toBe(initialBounds!.height);
  await expect.poll(() => target.locator('..').evaluate(element => Math.abs(new DOMMatrixReadOnly(getComputedStyle(element).transform).m13))).toBeGreaterThan(0.7);
  await page.screenshot({ path: info.outputPath('overview-nine-glow.png'), fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await target.locator('..').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
  await cards.first().focus();
  await page.mouse.move(0, 0);
  await page.keyboard.press('ArrowRight');
  const secondTitle = await page.evaluate(() => window.__overviewDeskFixture.expected.pendingTitles[1]!);
  await expect(caption).toContainText(secondTitle);
});

test('all 25 materials remain reachable by keyboard at a narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto(`${fixture}?count=25`);
  const cards = page.locator('[data-material-card-trigger]');
  await expect(cards).toHaveCount(25);
  await cards.first().focus();
  for (let index = 1; index < 25; index += 1) await page.keyboard.press('ArrowRight');
  await expect(cards.last()).toBeFocused();
  await expect(cards.last()).toBeInViewport();
  await page.keyboard.press('Enter');
  const title = await page.evaluate(() => window.__overviewDeskFixture.expected.pendingTitles.at(-1)!);
  await expect(page.getByRole('dialog', { name: `${title} 详情`, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(cards.last()).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
