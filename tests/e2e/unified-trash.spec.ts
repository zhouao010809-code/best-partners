import { expect, test } from '@playwright/test';
const origin = process.env.UNIFIED_TRASH_ORIGIN ?? 'http://127.0.0.1:41795';
const fixture = `${origin}/tests/e2e/fixtures/unified-trash.html`;
test.beforeEach(async ({ page }) => {
  await page.route(url => url.pathname.startsWith('/api/') || url.origin !== origin, route => route.abort('blockedbyclient'));
});
test('reveals the circular count only over the bin artwork or keyboard focus', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(fixture);
  const link = page.getByRole('link', { name: '回收站', exact: true });
  const icon = link.locator('.sidebar-trash-icon');
  const badge = link.locator('.sidebar-trash-count');
  await expect(link).toHaveAccessibleDescription('8 份暂存');
  await expect(badge).toBeHidden();
  await page.getByRole('navigation', { name: '主导航' }).hover();
  await expect(badge).toBeHidden();
  await icon.hover();
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('8');
  await icon.evaluate(async element => {
    const animations = element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)));
  });
  const geometry = await badge.boundingBox();
  expect(geometry!.width).toBeCloseTo(geometry!.height, 1);
  const binGeometry = await icon.boundingBox();
  expect(geometry!.y).toBeLessThan(binGeometry!.y);
  await page.screenshot({ path: info.outputPath('recycle-bin-open-lid-full.png'), fullPage: true });
  await page.screenshot({ path: info.outputPath('recycle-bin-hover.png'), clip: {
    x: binGeometry!.x - 16, y: binGeometry!.y - 20, width: binGeometry!.width + 32, height: binGeometry!.height + 36
  } });
  await page.getByRole('heading', { name: '回收站', exact: true }).hover();
  await expect(badge).toBeHidden();
  await page.getByRole('link', { name: '设置', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  await expect(badge).toBeVisible();
  expect(await link.evaluate(element => element.innerText)).not.toContain('回收站');
  const footer = await link.locator('..').boundingBox();
  const linkGeometry = await link.boundingBox();
  expect(footer!.x + footer!.width - linkGeometry!.x - linkGeometry!.width).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => window.__trashFixture.operations)).toEqual([]);
});
test('does not show a numeric badge for empty or unreadable inventory', async ({ page }) => {
  for (const [query, description] of [['empty', '0 份暂存'], ['packetError', '回收站数量暂不可用']]) {
    await page.goto(`${fixture}?${query}`);
    const link = page.getByRole('link', { name: '回收站', exact: true });
    await expect(link).toHaveAccessibleDescription(description!);
    await link.locator('.sidebar-trash-icon').hover();
    await expect(link.locator('.sidebar-trash-count')).toHaveCount(0);
  }
});
for (const width of [1440, 1024, 390]) test(`the four-source work surface remains usable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); await page.goto(fixture);
  await expect(page.getByRole('tab', { name: '全部 8' })).toBeVisible();
  await expect(page.getByRole('link', { name: '回收站', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^恢复：/ })).toHaveCount(0);
  await page.getByRole('button', { name: '选择：用问题组织知识的方法' }).click();
  await expect(page.getByRole('complementary', { name: '所选资料详情' })).toBeInViewport();
  await expect(page.getByRole('button', { name: '恢复：用问题组织知识的方法' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  await page.getByRole('button', { name: '取消选择' }).click();
  await page.getByRole('tab', { name: '知识库 2' }).click();
  await expect(page.getByRole('button', { name: /^选择：/ })).toHaveCount(2);
  expect(await page.evaluate(() => window.__trashFixture.operations)).toEqual([]);
});
test('restores knowledge and confirms full packet deletion, updating both counts', async ({ page }) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: '选择：用问题组织知识的方法' }).click();
  await page.getByRole('button', { name: '恢复：用问题组织知识的方法' }).click();
  await expect(page.getByRole('heading', { name: '已恢复到原路径' })).toBeVisible();
  await page.getByRole('button', { name: '关闭回收操作' }).click();
  await expect(page.getByRole('tab', { name: '知识库 1' })).toBeVisible();
  await page.getByRole('button', { name: '选择：关于创造力的采访剪藏' }).click();
  await page.getByRole('button', { name: '彻底删除：关于创造力的采访剪藏' }).click();
  const dialog = page.getByRole('dialog', { name: '彻底删除收件箱资料包' });
  await expect(dialog.getByText(/整个资料包及其自带附件将被彻底删除/)).toBeVisible();
  await dialog.getByRole('button', { name: '确认彻底删除' }).click();
  await expect(page.getByRole('heading', { name: '已彻底删除' })).toBeVisible();
  await page.getByRole('button', { name: '关闭回收操作' }).click();
  await expect(page.getByRole('tab', { name: '收件箱 1' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '全部 6' })).toBeVisible();
  expect(await page.evaluate(() => window.__trashFixture.operations.map(value => value.split(':').slice(0, 2).join(':')))).toEqual(['document:restore', 'packet:delete']);
});
test('keeps source failures distinct from an empty recycle bin', async ({ page }) => {
  await page.goto(`${fixture}?packetError`);
  await expect(page.getByRole('tab', { name: '收件箱 —' })).toBeVisible();
  await expect(page.getByText(/收件箱：资料包读取中断/)).toBeVisible();
  await expect(page.getByText('回收站为空', { exact: true })).toHaveCount(0);
});
