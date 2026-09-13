import { expect, test, type Page } from '@playwright/test';

const fixtureOrigin = process.env.QUEUE_DRAWER_ORIGIN ?? 'http://127.0.0.1:41793';
const readyTitle = '整理知识之前，先明确下一次会在什么场景使用';
const nextReadyTitle = '从观察到判断：为内容选题建立可以反复核对的标准';
const viewports = [{ width: 1440, height: 1100 }, { width: 1024, height: 1000 }, { width: 390, height: 844 }];

async function expectNoHorizontalOverflow(page: Page) {
  await page.locator('.queue-workspace').evaluate(async workspace => {
    const motion = workspace.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(motion.map(animation => animation.finished.catch(() => {})));
  });
  expect(await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth })))
    .toEqual({ viewport: page.viewportSize()!.width, document: page.viewportSize()!.width });
  expect(await page.locator('.queue-workspace').evaluate(workspace => [...workspace.querySelectorAll<HTMLElement>('*')].filter(element => {
    if (element.closest('[inert]')) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (box.left < -1 || box.right > window.innerWidth + 1);
  }).map(element => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 60) })))).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.route(url => url.pathname.startsWith('/api/'), route => route.abort('blockedbyclient'));
  await page.route('https://**', route => route.abort('blockedbyclient'));
});

test('returns focus to the handle when the selected folder has been put away', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`${fixtureOrigin}/tests/e2e/fixtures/queue-drawer.html`);
  await page.getByRole('button', { name: '展开待确认抽屉' }).click();
  await page.getByRole('button', { name: `打开 ${readyTitle}` }).press('Enter');
  await expect(page.getByRole('region', { name: '资料工作区' })).toBeVisible();
  await page.getByRole('button', { name: '资料导航' }).click();
  await page.getByRole('button', { name: '收起待确认抽屉' }).click();
  await page.getByRole('button', { name: '关闭资料详情' }).click();
  await expect(page.getByRole('region', { name: '资料工作区' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '展开待确认抽屉' })).toBeFocused();
});

for (const viewport of viewports) {
  test(`bounds all three drawers and keeps controls usable at ${viewport.width}px`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport); await page.goto(`${fixtureOrigin}/tests/e2e/fixtures/queue-drawer.html`);
    const pending = page.getByRole('region', { name: '待提炼', exact: true });
    await expect(page.getByRole('region', { name: '资料工作区' })).toHaveCount(0);
    for (const label of ['待提炼', '提炼中', '待确认']) {
      const drawer = page.getByRole('region', { name: label, exact: true });
      await expect(drawer.getByRole('button', { name: `展开${label}抽屉` })).toHaveAttribute('aria-expanded', 'false');
      await expect(drawer.getByRole('button', { name: /^打开 /u })).toHaveCount(0);
      await expect(drawer.locator('[aria-hidden="true"][inert]')).toHaveCount(1);
    }
    await expect(pending.getByRole('heading')).toHaveText('待提炼 8');
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`queue-drawer-${viewport.width}-initial-closed.png`), fullPage: true, animations: 'disabled' });
    expect(await page.evaluate(() => window.__queueDrawerFixture.bodyReads)).toEqual([]);
    await pending.getByRole('button', { name: '展开待提炼抽屉' }).click();
    await expect(page.getByRole('region', { name: '资料工作区' })).toHaveCount(0);
    await expect(pending.getByRole('button', { name: /^打开 /u })).toHaveCount(3);
    await expect(page.getByRole('button', { name: '展开提炼中抽屉' })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('button', { name: '展开待确认抽屉' })).toHaveAttribute('aria-expanded', 'false');
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`queue-drawer-${viewport.width}-pending-open.png`), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '展开提炼中抽屉' }).click();
    await page.getByRole('button', { name: '展开待确认抽屉' }).click();
    await expect(page.getByRole('region', { name: '提炼中', exact: true }).getByRole('button', { name: /^打开 /u })).toHaveCount(1);
    await expect(page.getByRole('region', { name: '待确认', exact: true }).getByRole('button', { name: /^打开 /u })).toHaveCount(2);
    await expect(pending.getByRole('heading')).toHaveText('待提炼 8');
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`queue-drawer-${viewport.width}-all-open.png`), fullPage: true, animations: 'disabled' });
    expect(await page.evaluate(() => window.__queueDrawerFixture.bodyReads)).toEqual([]);
    await pending.getByRole('button', { name: '查看全部待提炼' }).click();
    await expect(pending.getByRole('button', { name: /^打开 /u })).toHaveCount(8);
    await expectNoHorizontalOverflow(page);
    await pending.getByRole('button', { name: '收起待提炼更多资料' }).click();
    await expect(pending.getByRole('button', { name: /^打开 /u })).toHaveCount(3);
    await pending.getByRole('button', { name: '收起待提炼抽屉' }).click();
    await expect(pending.getByRole('button', { name: /^打开 /u })).toHaveCount(0);
    await expect(pending.getByRole('heading')).toHaveText('待提炼 8');
    await expect(page.getByRole('button', { name: '收起提炼中抽屉' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: '收起待确认抽屉' })).toHaveAttribute('aria-expanded', 'true');
    await pending.getByRole('button', { name: '展开待提炼抽屉' }).click();
    await expect(pending.getByRole('button', { name: /^打开 /u })).toHaveCount(3);
    await page.reload();
    for (const label of ['待提炼', '提炼中', '待确认'])
      await expect(page.getByRole('button', { name: `展开${label}抽屉` })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('button', { name: /^打开 /u })).toHaveCount(0);
    expect(await page.evaluate(() => window.__queueDrawerFixture.unexpectedActions)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`preserves candidate editing when widening and never cycles next at ${viewport.width}px`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport); await page.goto(`${fixtureOrigin}/tests/e2e/fixtures/queue-drawer.html`);
    await page.getByRole('button', { name: '展开待确认抽屉' }).click();
    await page.getByRole('button', { name: `打开 ${readyTitle}` }).click();
    const detail = page.getByRole('region', { name: '资料工作区' });
    await expect(detail.getByRole('button', { name: '资料导航' })).toHaveAttribute('aria-expanded', 'false');
    await expect(detail.getByRole('navigation', { name: '候选目录' })).toBeVisible();
    await expect(detail.getByRole('textbox', { name: '核心正文', exact: true })).toHaveCount(0);
    await expect(detail.getByLabel('当前批次操作')).toBeInViewport();
    await detail.getByRole('button', { name: '编辑候选' }).click();
    const core = detail.getByRole('textbox', { name: '核心正文', exact: true });
    await expect(core).toBeVisible();
    const original = await core.elementHandle();
    if (!original) throw new Error('Candidate textarea was not mounted');
    const wideWidth = (await detail.boundingBox())!.width;
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`queue-drawer-${viewport.width}-review.png`), fullPage: true, animations: 'disabled' });
    const edited = '我保留的修改：先明确下次使用的场景，再决定保留哪些知识。\n\n这段草稿在展开阅读后应继续留在原来的编辑框。';
    await core.fill(edited);
    await detail.getByRole('button', { name: '收起阅读' }).click();
    await expect(core).toHaveValue(edited);
    expect(await core.evaluate((current, previous) => current === previous, original)).toBe(true);
    if (viewport.width > 820) expect((await detail.boundingBox())!.width).toBeLessThan(wideWidth - 150);
    await detail.getByRole('button', { name: '展开阅读' }).click();
    await detail.getByRole('button', { name: '查看依据' }).click();
    await expect(detail.getByRole('region', { name: '原文依据' })).toBeVisible();
    expect(await core.evaluate((current, previous) => current === previous, original)).toBe(true);
    await detail.getByRole('button', { name: '收起依据' }).click();
    await expect(core).toHaveValue(edited);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`queue-drawer-${viewport.width}-expanded.png`), fullPage: true, animations: 'disabled' });
    await expect(core).toHaveValue(edited);
    expect(await core.evaluate((current, previous) => current === previous, original)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__queueDrawerFixture.saves.at(-1)?.draft.coreContent)).toBe(edited);
    await expect(detail.getByText('已保存到本机草稿', { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: '下一份', exact: true }).click();
    await expect(detail.getByRole('heading', { name: nextReadyTitle, exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: '下一份', exact: true })).toBeDisabled();
    await expectNoHorizontalOverflow(page);
    await detail.getByRole('button', { name: '关闭资料详情' }).click();
    await expect(detail).toHaveCount(0);
    await expect(page.getByRole('region', { name: '资料列表' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect(await page.evaluate(() => window.__queueDrawerFixture.unexpectedActions)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`supports keyboard handles and reduced motion without overflow at ${viewport.width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(viewport); await page.goto(`${fixtureOrigin}/tests/e2e/fixtures/queue-drawer.html`);
    const pendingHandle = page.getByRole('button', { name: '展开待提炼抽屉' });
    await pendingHandle.focus(); await expect(pendingHandle).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '展开提炼中抽屉' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '展开待确认抽屉' })).toBeFocused();
    await pendingHandle.focus(); await page.keyboard.press('Enter');
    const pending = page.getByRole('region', { name: '待提炼', exact: true });
    await expect(page.getByRole('button', { name: '收起待提炼抽屉' })).toHaveAttribute('aria-expanded', 'true');
    await expect(pending.getByRole('button', { name: /^打开 /u })).toHaveCount(3);
    await expectNoHorizontalOverflow(page);
    expect(await pending.evaluate(drawer => [drawer, ...drawer.querySelectorAll('*')].every(element => {
      const style = getComputedStyle(element);
      return [style.transitionDuration, style.animationDuration].every(value => value.split(',').every(duration => parseFloat(duration) <= .01));
    }))).toBe(true);
    await page.keyboard.press('Space');
    await expect(pendingHandle).toHaveAttribute('aria-expanded', 'false');
    await expect(pending.getByRole('button', { name: /^打开 /u })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    expect(await page.evaluate(() => window.__queueDrawerFixture.bodyReads)).toEqual([]);
    expect(await page.evaluate(() => window.__queueDrawerFixture.unexpectedActions)).toEqual([]);
  });
}
