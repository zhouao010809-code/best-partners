import {expect,test} from '@playwright/test';
test.beforeEach(async({page})=>{await page.route(url=>url.pathname.startsWith('/api/')||url.origin!=='http://127.0.0.1:41804',route=>route.abort());});
for(const width of [1440,1024,390]) test(`record selection and recovery at ${width}px`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width,height:1040});await page.goto('/tests/e2e/fixtures/operations.html');
  const row=page.getByRole('button',{name:/关于知识复用的笔记/});await expect(row).toBeVisible();
  await expect(page.getByRole('heading',{name:'恢复工作单'})).toHaveCount(0);
  await page.screenshot({path:info.outputPath(`ledger-${width}.png`),fullPage:true});
  await row.click();await expect(page.getByRole('heading',{name:'恢复工作单'})).toBeVisible();
  await page.screenshot({path:info.outputPath(`work-slip-${width}.png`),fullPage:true,animations:'disabled'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
  const panel=await page.locator('.operation-work-slip').boundingBox();expect(panel!.x).toBeGreaterThanOrEqual(0);expect(panel!.x+panel!.width).toBeLessThanOrEqual(width);
  await page.getByRole('button',{name:'关闭工作单'}).click();await expect(row).toBeFocused();
  await row.click();await page.getByRole('button',{name:'继续核验归档'}).click();await expect(page.getByText('归档核验完成，检索已更新。')).toBeVisible();await expect(row).toHaveCount(0);
  await page.getByRole('tab',{name:/进行中/}).click();await expect(page.getByRole('heading',{name:'当前没有进行中的操作'})).toBeVisible();
  expect(errors).toEqual([]);
});
test('keyboard and incomplete-state notice',async({page})=>{
  await page.goto('/tests/e2e/fixtures/operations.html?scenario=partial');
  await expect(page.getByText('记录未完整读取')).toBeVisible();
  const tab=page.getByRole('tab',{name:/需要处理/});await tab.focus();await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab',{name:/进行中/})).toBeFocused();
  await expect(page.getByRole('tab',{name:/进行中/})).toHaveAttribute('aria-selected','true');
});
