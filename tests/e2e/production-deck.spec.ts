import { expect, test, type Page } from '@playwright/test';

const fixturePath = 'http://127.0.0.1:41793/tests/e2e/fixtures/material-deck.html';
const viewports = [
  { name: '1440x820', width: 1440, height: 820 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '390x844', width: 390, height: 844 }
] as const;

async function openFixture(page: Page): Promise<void> {
  await page.goto(fixturePath);
  await expect(page.locator('[data-deck-instance]')).toBeVisible();
  await expect(page.locator('[data-card-index]')).toHaveCount(9);
}

for (const viewport of viewports) {
  test(`renders the silver card scene at ${viewport.name} without root overflow`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openFixture(page);

    await expect.poll(() => page.evaluate(() => ({
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth - document.body.clientWidth
    }))).toEqual({ documentOverflow: 0, bodyOverflow: 0 });

    const visualContract = await page.locator('[data-deck-instance]').evaluate((root) => {
      const stage = root.querySelector<HTMLElement>('.material-deck__stage')!;
      const viewportElement = root.querySelector<HTMLElement>('.material-deck__viewport')!;
      const card = root.querySelector<HTMLElement>('[data-card-index="0"]')!;
      const cardRules = getComputedStyle(card);
      return {
        stageOverflow: getComputedStyle(stage).overflow,
        viewportOverflowX: getComputedStyle(viewportElement).overflowX,
        cardPosition: cardRules.position,
        cardBackground: cardRules.backgroundImage,
        cardTransform: cardRules.transform
      };
    });
    expect(visualContract.stageOverflow).toBe('hidden');
    expect(visualContract.viewportOverflowX).toBe('auto');
    expect(visualContract.cardPosition).toBe('absolute');
    expect(visualContract.cardBackground).not.toBe('none');
    expect(visualContract.cardTransform).not.toBe('none');

    await expect(page.locator('[data-deck-instance]')).toHaveScreenshot(
      `material-deck-${viewport.name}.png`,
      { animations: 'disabled' }
    );
  });
}

test('opens by keyboard and restores the exact trigger on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openFixture(page);
  const triggers = page.locator('[data-material-card-trigger]');
  await triggers.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('[data-card-index="2"]')).toHaveAttribute('data-card-mode', 'active');
  await expect(page.locator('[data-card-mode="rail"]')).toHaveCount(8);
  await expect(page.locator('[data-deck-instance]')).toHaveScreenshot(
    'material-deck-selected.png',
    { animations: 'disabled' }
  );

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(triggers.nth(2)).toBeFocused();
  await expect(page.locator('[data-card-mode="collapsed"]')).toHaveCount(9);
});

test('keeps mobile titles distinct and scrolls the last card into view by keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture(page);
  const triggers = page.locator('[data-material-card-trigger]');

  await expect.poll(() => page.locator('[data-deck-instance]').evaluate((root) => {
    const rects = Array.from(
      root.querySelectorAll<HTMLElement>('.material-deck-card__trigger strong'),
      (title) => title.getBoundingClientRect()
    );
    const minimumAdjacentGap = Math.min(...rects.slice(0, -1).map(
      (rect, index) => rects[index + 1]!.left - rect.right
    ));
    return {
      nonOverlapping: minimumAdjacentGap >= 0,
      overlapCount: rects.slice(0, -1).filter(
        (rect, index) => rect.right > rects[index + 1]!.left
      ).length,
      readableCount: rects.filter((rect) => rect.width >= 24 && rect.height >= 18).length
    };
  })).toEqual({ nonOverlapping: true, overlapCount: 0, readableCount: 9 });

  await triggers.first().focus();
  for (let index = 1; index < 9; index += 1) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(triggers.last()).toBeFocused();
  await expect.poll(() => page.locator('[data-deck-instance]').evaluate((root) => {
    const viewport = root.querySelector<HTMLElement>('[data-material-deck-viewport]')!;
    const last = root.querySelectorAll<HTMLElement>('[data-material-card-trigger]')[8]!;
    const viewportRect = viewport.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    return {
      scrolled: viewport.scrollLeft > 0,
      visible: lastRect.left >= viewportRect.left && lastRect.right <= viewportRect.right
    };
  })).toEqual({ scrolled: true, visible: true });
});

test('cancels a native 13px pointer drag without swallowing the next click', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openFixture(page);
  const trigger = page.locator('[data-material-card-trigger]').first();
  const bounds = await trigger.boundingBox();
  if (!bounds) throw new Error('MISSING_MATERIAL_CARD_BOUNDS');
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 13, y);
  await page.mouse.up();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('reduced motion reaches the same left detail and ordered right rail immediately', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture(page);
  const trigger = page.locator('[data-material-card-trigger]').nth(4);
  await trigger.focus();
  await page.keyboard.press('Enter');

  const geometry = await page.locator('[data-deck-instance]').evaluate((root) => {
    const active = root.querySelector<HTMLElement>('[data-card-mode="active"]')!;
    const rails = Array.from(root.querySelectorAll<HTMLElement>('[data-card-mode="rail"]'));
    const rootBounds = root.getBoundingClientRect();
    const activeBounds = active.getBoundingClientRect();
    const transitions = getComputedStyle(active).transitionDuration
      .split(',')
      .map((value) => value.trim());
    return {
      activeLeft: activeBounds.left - rootBounds.left,
      activeWidth: activeBounds.width,
      railCount: rails.length,
      railIndexes: rails.map((rail) => Number(rail.dataset.cardIndex)),
      transitions
    };
  });

  expect(geometry.activeLeft).toBeGreaterThanOrEqual(17);
  expect(geometry.activeLeft).toBeLessThanOrEqual(32);
  expect(geometry.activeWidth).toBeGreaterThanOrEqual(279);
  expect(geometry.activeWidth).toBeLessThanOrEqual(421);
  expect(geometry.railCount).toBe(8);
  expect(geometry.railIndexes).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
  expect(geometry.transitions.every((duration) => duration === '0s' || duration === '0.001s')).toBe(true);
});
