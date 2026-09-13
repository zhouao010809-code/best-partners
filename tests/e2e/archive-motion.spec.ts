import { expect, test } from '@playwright/test';

for (const width of [1440, 760, 390]) {
  test(`cabinet stays fixed throughout opening, delayed content and closing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1040 });
    await page.goto('/tests/e2e/fixtures/archive-motion.html');
    const initial = await page.locator('.archive-vault__body').boundingBox();
    const samples = await page.evaluate(async () => {
      const samples: { x: number; y: number; width: number; height: number }[] = [];
      const body = document.querySelector('.archive-vault__body')!;
      const start = performance.now();
      (document.querySelector('.archive-vault__lock') as HTMLButtonElement).click();
      await new Promise<void>(resolve => {
        function frame() {
          const r = body.getBoundingClientRect();
          samples.push({ x: r.x, y: r.y, width: r.width, height: r.height });
          if (performance.now() - start > 1900) resolve(); else requestAnimationFrame(frame);
        }
        frame();
      });
      return samples;
    });
    for (const rect of samples) for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(rect[key] - initial![key]), key).toBeLessThan(1);
    await expect(page.getByText('档案内容 40', { exact: true })).toBeAttached();
    expect(await page.locator('.archive-vault__contents').evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true);
    await page.getByRole('button', { name: '封存并合柜' }).click();
    await expect(page.getByRole('button', { name: '打开档案柜' })).toBeEnabled();
    expect(await page.locator('.archive-vault__body').boundingBox()).toEqual(initial);
  });
}
