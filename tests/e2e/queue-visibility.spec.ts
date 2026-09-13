import { expect, test } from '@playwright/test';
const fixtureOrigin = process.env.QUEUE_VISIBILITY_ORIGIN ?? 'http://127.0.0.1:41793';

for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
  test(`removes, undoes and re-adds queue sources at ${viewport.width}px`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize(viewport);
    await page.goto(`${fixtureOrigin}/tests/e2e/fixtures/queue-visibility.html`);
    await page.getByRole('button', { name: '展开待提炼抽屉' }).click();
    await page.getByRole('button', { name: '打开 建立自己的阅读与知识系统' }).click();
    await expect(page.getByRole('button', { name: '移出队列' })).toBeVisible();
    await page.getByRole('button', { name: '移出队列' }).click();
    await expect(page.getByRole('button', { name: '重新加入', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '开始提炼' })).toHaveCount(0);
    await expect(page.getByText('已移出队列，原文和全部提炼记录已保留。', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`queue-removed-${viewport.width}.png`), fullPage: true });
    await page.getByRole('button', { name: '撤销移出' }).click();
    await expect(page.getByRole('button', { name: '开始提炼' })).toBeVisible();
    await page.getByRole('button', { name: '移出队列' }).click();
    await page.getByRole('button', { name: '已移出', exact: true }).click();
    await page.getByRole('button', { name: '打开 建立自己的阅读与知识系统' }).click();
    await page.getByRole('button', { name: '重新加入', exact: true }).click();
    await expect(page.getByText('已重新加入队列。', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
  test(`keeps the stop control available before removal at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto(`${fixtureOrigin}/tests/e2e/fixtures/queue-visibility.html?running=1`);
    await page.getByRole('button', { name: '展开提炼中抽屉' }).click();
    await page.getByRole('button', { name: '打开 建立自己的阅读与知识系统' }).click();
    await expect(page.getByRole('button', { name: '移出队列' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '停止本次提炼' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`queue-running-${viewport.width}.png`), fullPage: true });
  });
}
