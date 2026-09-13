import { expect, test } from '@playwright/test';

// This fixture exercises the production review component with an in-memory API.
// Filesystem and coordinator guarantees are verified by the integration suites.
for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
  test(`reviews and confirms a visible candidate at ${viewport.width}px`, async ({ page }, info) => {
    const pageErrors: string[] = []; page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize(viewport);
    await page.goto(`${process.env.QUEUE_DRAWER_ORIGIN ?? 'http://127.0.0.1:41793'}/tests/e2e/fixtures/candidate-review.html`);
    await expect(page.getByRole('navigation', { name: '候选目录' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '知识标题' })).toHaveCount(0);
    await page.getByRole('button', { name: '编辑候选' }).click();
    const title = page.getByRole('textbox', { name: '知识标题' }); await expect(title).toBeVisible();
    await title.fill('先明确问题，再选择合适工具');
    await expect(page.getByText('已保存到本机草稿')).toBeVisible();
    await expect(title).toHaveValue('先明确问题，再选择合适工具');
    await title.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`candidate-editor-${viewport.width}.png`) });
    await page.getByRole('radio', { name: '选入本批' }).check();
    await page.getByRole('button', { name: '预览本批变化' }).click();
    await expect(page.getByRole('region', { name: '本批入库预览' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /知识入库状态/u })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await page.getByRole('heading', { name: '本批将发生的变化' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`candidate-preview-${viewport.width}.png`) });
    await page.getByRole('button', { name: '确认入库', exact: true }).click();
    await expect(page.getByRole('link', { name: '打开知识：先明确问题，再选择合适工具' })).toBeVisible();
    await expect(title).toHaveCount(0); expect(pageErrors).toEqual([]);
    await page.getByRole('region', { name: '入库结果', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`candidate-complete-${viewport.width}.png`) });
  });
}
