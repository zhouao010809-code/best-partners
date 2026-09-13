import { expect, test, type Page } from '@playwright/test';

const fixtureOrigin = process.env.INTAKE_TRAY_ORIGIN ?? 'http://127.0.0.1:41793';
const fixtureUrl = (scenario = 'six') => `${fixtureOrigin}/tests/e2e/fixtures/intake-tray.html?scenario=${scenario}`;
const names = {
  complete: '示例-把收藏变成可复用的知识',
  missingDate: '示例-一次产品复盘的完整记录',
  multipleMain: '示例-访谈原稿与整理稿',
  otherComplete: '示例-让选题回到真实问题',
  unsupported: '示例-尚未整理的录音.mp3',
  last: '示例-一份较长路径的学习资料'
};
const viewports = [{ width: 1440, height: 1000 }, { width: 1024, height: 900 }, { width: 390, height: 844 }];

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth })))
    .toEqual({ viewport: page.viewportSize()!.width, document: page.viewportSize()!.width });
  expect(await page.getByRole('main').evaluate(workspace => [...workspace.querySelectorAll<HTMLElement>('button, input, select, textarea, pre, h2, h3, details, section')]
    .filter(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && (box.left < -1 || box.right > window.innerWidth + 1);
    }).map(element => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 60) })))).toEqual([]);
}

async function expectNoArchiveActions(page: Page) {
  expect(await page.evaluate(() => ({ previews: window.__intakeTrayFixture.previewCalls.length,
    commits: window.__intakeTrayFixture.commitTokens.length, resumes: window.__intakeTrayFixture.resumeIds.length,
    unexpected: window.__intakeTrayFixture.unexpectedActions }))).toEqual({ previews: 0, commits: 0, resumes: 0, unexpected: [] });
}

test.beforeEach(async ({ page }) => {
  // The fixture never needs a backend, external resource, AI provider or vault connection.
  await page.route(url => url.pathname.startsWith('/api/') || url.origin !== fixtureOrigin,
    route => route.abort('blockedbyclient'));
});

for (const viewport of viewports) {
  test(`discards without opening and restores a packet at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport); await page.goto(fixtureUrl());
    await page.getByRole('button', { name: '打开收件箱', exact: true }).click();
    const remove = page.getByRole('button', { name: `移入回收站：${names.missingDate}`, exact: true });
    await remove.click();
    const dialog = page.getByRole('dialog', { name: '移入回收站', exact: true });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('region', { name: '归档预览' })).toHaveCount(0);
    await expectNoArchiveActions(page);
    const box = await dialog.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: info.outputPath(`intake-delete-${viewport.width}.png`), fullPage: true });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(remove).toBeFocused();
    expect(await page.evaluate(() => window.__intakeTrayFixture.trashCommits)).toEqual([]);
    await remove.click(); await page.getByRole('button', { name: '确认移入回收站', exact: true }).click();
    await expect(page.getByRole('heading', { name: '已移入回收站', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭回收操作', exact: true }).click();
    await expect(remove).toHaveCount(0);
    await expect(page.getByRole('button', { name: '刷新收件箱', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '回收站', exact: true }).click();
    await expect(page.getByLabel('回收站资料数量')).toHaveText('1');
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`intake-recycle-${viewport.width}.png`), fullPage: true });
    await page.getByRole('button', { name: `恢复到收件箱：${names.missingDate}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: '已恢复到收件箱', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭回收操作', exact: true }).click();
    await expect(page.getByText('回收站为空', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回收件箱', exact: true }).click();
    await expect(page.getByRole('button', { name: /^整理 /u })).toHaveCount(0);
    await page.getByRole('button', { name: '打开收件箱', exact: true }).click();
    await page.getByRole('button', { name: '查看全部 6 份', exact: true }).click();
    await expect(page.getByRole('button', { name: `整理 ${names.missingDate}`, exact: true })).toBeVisible();
    expect(await page.evaluate(() => ({ commits: window.__intakeTrayFixture.trashCommits.length, restores: window.__intakeTrayFixture.trashRestores.length }))).toEqual({ commits: 1, restores: 1 });
    await expectNoArchiveActions(page);
  });

  test(`keeps envelopes and editable archive slip bounded at ${viewport.width}px`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport);
    await page.goto(fixtureUrl());
    await expect(page.getByText('浏览器验证 · 全部为示例资料 · 仅保存在当前页面', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '打开收件箱', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('button', { name: /^整理 /u })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^移入回收站：/u })).toHaveCount(0);
    await expectNoArchiveActions(page);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`intake-mailbox-${viewport.width}-closed.png`), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '打开收件箱', exact: true }).click();
    await expect(page.getByRole('button', { name: /^整理 /u })).toHaveCount(4);
    await expect(page.getByRole('region', { name: '归档预览' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '归档整理单' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '全部', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expectNoArchiveActions(page);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`intake-tray-${viewport.width}-initial.png`), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '合上收件箱', exact: true }).click();
    await expect(page.getByRole('button', { name: /^整理 /u })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '打开收件箱', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '打开收件箱', exact: true }).click();

    await page.getByRole('button', { name: `整理 ${names.complete}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: '整理这份资料', exact: true })).toBeFocused();
    await expect(page.getByLabel('原始标题', { exact: true })).toBeEditable();
    await expect(page.getByLabel('来源平台', { exact: true })).toBeEnabled();
    await expect(page.getByLabel('采集日期', { exact: true })).toBeEditable();
    await expect(page.getByLabel('主 Markdown', { exact: true })).toHaveValue('文章.md');
    await expect(page.getByRole('button', { name: '确认归档', exact: true })).toHaveCount(0);
    await expectNoArchiveActions(page);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`intake-tray-${viewport.width}-review.png`), fullPage: true, animations: 'disabled' });

    const provenance = page.locator('details').filter({ has: page.getByLabel('作者（可留空）', { exact: true }) });
    await expect(provenance).toHaveCount(1);
    await expect(provenance).not.toHaveAttribute('open');
    await provenance.locator('summary').click();
    await expect(page.getByLabel('作者（可留空）', { exact: true })).toHaveAttribute('readonly');
    await expect(page.getByLabel('原始链接（可留空）', { exact: true })).toHaveAttribute('readonly');
    await expect(page.getByLabel('原始链接（可留空）', { exact: true })).toHaveValue('https://example.invalid/articles/knowledge-reuse');
    await expectNoHorizontalOverflow(page);
    await provenance.locator('summary').click();

    const editedTitle = '示例标题已修改：从下一次使用开始整理';
    await page.getByLabel('原始标题', { exact: true }).fill(editedTitle);
    await page.getByRole('button', { name: '合上收件箱', exact: true }).click();
    await expect(page.getByLabel('原始标题', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '打开收件箱', exact: true }).click();
    await expect(page.getByLabel('原始标题', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: `整理 ${names.complete}`, exact: true }).click();
    await expect(page.getByLabel('原始标题', { exact: true })).toHaveValue(editedTitle);
    await page.getByRole('button', { name: '预览归档结果', exact: true }).click();
    await expect(page.getByRole('button', { name: '确认归档', exact: true })).toBeVisible();
    await expect(page.getByLabel('整理后的 Markdown', { exact: true })).toContainText(editedTitle);
    expect(await page.evaluate(() => window.__intakeTrayFixture.previewCalls.at(-1)?.fields.title)).toBe(editedTitle);
    expect(await page.evaluate(() => window.__intakeTrayFixture.commitTokens)).toEqual([]);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`intake-tray-${viewport.width}-preview.png`), fullPage: true, animations: 'disabled' });

    await page.getByLabel('原始标题', { exact: true }).fill(`${editedTitle}（再修订）`);
    await expect(page.getByRole('button', { name: '确认归档', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.__intakeTrayFixture.commitTokens)).toEqual([]);
    await page.getByRole('button', { name: '预览归档结果', exact: true }).click();
    await page.getByRole('button', { name: '确认归档', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '归档完成' })).toBeVisible();
    await expect(page.getByRole('button', { name: `整理 ${names.complete}`, exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => ({ previews: window.__intakeTrayFixture.previewCalls.length,
      commits: window.__intakeTrayFixture.commitTokens.length, resumes: window.__intakeTrayFixture.resumeIds.length,
      unexpected: window.__intakeTrayFixture.unexpectedActions }))).toEqual({ previews: 2, commits: 1, resumes: 0, unexpected: [] });
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });

  test(`filters incomplete metadata and reaches every envelope at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto(fixtureUrl());
    await page.getByRole('button', { name: '打开收件箱', exact: true }).click();
    await expect(page.getByRole('button', { name: /^整理 /u })).toHaveCount(4);
    await page.getByRole('button', { name: '查看全部 6 份', exact: true }).click();
    await expect(page.getByRole('button', { name: /^整理 /u })).toHaveCount(6);
    await expect(page.getByRole('button', { name: `整理 ${names.unsupported}`, exact: true })).toBeDisabled();
    await page.getByRole('button', { name: `整理 ${names.last}`, exact: true }).click();
    await expect(page.getByLabel('原始标题', { exact: true })).toHaveValue('一份较长路径的学习资料：为持续积累建立可以重新找到证据的入口');
    await page.getByRole('button', { name: '关闭归档预览', exact: true }).click();

    await page.getByRole('button', { name: '信息不完整', exact: true }).click();
    await expect(page.getByRole('button', { name: '信息不完整', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '全部', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: `整理 ${names.complete}`, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `整理 ${names.otherComplete}`, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `整理 ${names.last}`, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `整理 ${names.missingDate}`, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `整理 ${names.multipleMain}`, exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`intake-tray-${viewport.width}-filtered.png`), fullPage: true, animations: 'disabled' });

    await page.getByRole('button', { name: `整理 ${names.missingDate}`, exact: true }).click();
    await expect(page.getByLabel('采集日期', { exact: true })).toHaveValue('');
    await page.getByLabel('采集日期', { exact: true }).fill('2026-09-07');
    await expect(page.getByLabel('采集日期', { exact: true })).toHaveValue('2026-09-07');
    await page.getByRole('button', { name: `整理 ${names.multipleMain}`, exact: true }).click();
    await expect(page.getByLabel('主 Markdown', { exact: true })).toHaveValue('');
    await page.getByLabel('主 Markdown', { exact: true }).selectOption('整理稿.md');
    await expect(page.getByLabel('主 Markdown', { exact: true })).toHaveValue('整理稿.md');
    await expectNoArchiveActions(page);
    await expectNoHorizontalOverflow(page);
  });

  test(`renders an honest empty tray at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto(fixtureUrl('empty'));
    await expect(page.getByRole('button', { name: '打开收件箱', exact: true })).toContainText('0 份待整理');
    await page.getByRole('button', { name: '打开收件箱', exact: true }).click();
    await expect(page.getByRole('heading', { name: '收件箱是空的', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^整理 /u })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '确认归档', exact: true })).toHaveCount(0);
    await expectNoArchiveActions(page);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`intake-tray-${viewport.width}-empty.png`), fullPage: true, animations: 'disabled' });
  });

  test(`keeps unfinished recovery visible and explicit at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto(fixtureUrl('recovery'));
    const resume = page.getByRole('button', { name: '继续核验归档', exact: true });
    await expect(resume).toBeVisible();
    await expect(page.getByText('01图书馆/来自个人/示例-待恢复资料', { exact: true })).toBeVisible();
    await expectNoArchiveActions(page);
    await page.getByRole('button', { name: '打开收件箱', exact: true }).click();
    await page.getByRole('button', { name: `整理 ${names.complete}`, exact: true }).click();
    await expect(page.getByRole('button', { name: '预览归档结果', exact: true })).toBeDisabled();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`intake-tray-${viewport.width}-recovery.png`), fullPage: true, animations: 'disabled' });
    await resume.click();
    await expect(page.getByRole('status').filter({ hasText: '归档完成' })).toBeVisible();
    await expect(resume).toHaveCount(0);
    expect(await page.evaluate(() => window.__intakeTrayFixture.resumeIds)).toEqual(['b3d97342-7ba7-45a4-9b31-3dc30ea4a186']);
    expect(await page.evaluate(() => window.__intakeTrayFixture.commitTokens)).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });
}

test('opens and closes a selected envelope with the keyboard and restores focus', async ({ page }) => {
  await page.setViewportSize(viewports[0]!);
  await page.goto(fixtureUrl());
  const mailbox = page.getByRole('button', { name: '打开收件箱', exact: true });
  await mailbox.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: '合上收件箱', exact: true })).toBeVisible();
  const card = page.getByRole('button', { name: `整理 ${names.complete}`, exact: true });
  await expect(card).toBeVisible();
  for (let index = 0; index < 20 && !(await card.evaluate(element => element === document.activeElement)); index += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(card).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '整理这份资料', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('原始标题', { exact: true })).toHaveCount(0);
  await expect(card).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '关闭归档预览', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card).toBeFocused();

  await page.getByRole('button', { name: '查看全部 6 份', exact: true }).click();
  const lastCard = page.getByRole('button', { name: `整理 ${names.last}`, exact: true });
  await lastCard.click();
  await page.getByRole('button', { name: '收起资料', exact: true }).click();
  await expect(page.getByRole('button', { name: /^整理 /u })).toHaveCount(4);
  await expect(lastCard).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('原始标题', { exact: true })).toHaveCount(0);
  await expect(lastCard).toBeFocused();
  await expectNoArchiveActions(page);
});

test('shows the failed first load and recovers through an explicit retry', async ({ page }, info) => {
  await page.setViewportSize(viewports[2]!);
  await page.goto(fixtureUrl('retry'));
  await expect(page.getByRole('alert')).toContainText('示例连接暂时中断');
  await expect(page.getByRole('heading', { name: '收件箱是空的', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^整理 /u })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('intake-tray-390-load-error.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: /重试|刷新收件箱/u }).first().click();
  await expect(page.getByRole('button', { name: /^整理 /u })).toHaveCount(0);
  await page.getByRole('button', { name: '打开收件箱', exact: true }).click();
  await expect(page.getByRole('button', { name: /^整理 /u })).toHaveCount(4);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.__intakeTrayFixture.listCalls)).toBeGreaterThanOrEqual(2);
  await expectNoArchiveActions(page);
  await expectNoHorizontalOverflow(page);
});
