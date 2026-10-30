import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';

function wave() {
  const buffer = Buffer.alloc(44 + 16000); buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(16000, 40); return buffer;
}
async function fixture() {
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  const workdisk = await mkdtemp(join(temporary, 'xiaozhao-workdisk-'));
  const source = await mkdtemp(join(temporary, 'xiaozhao-imports-'));
  await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
  for (const path of ['00大脑规则', '01图书馆/来自个人', '01图书馆/小兆clipper', '02知识库', '03大讲堂', '.claude/skills']) await mkdir(join(vault, path), { recursive: true });
  for (const path of RULE_BUNDLE_SOURCE_PATHS) { await mkdir(join(vault, dirname(path)), { recursive: true }); await writeFile(join(vault, path), '# 隔离测试规则\n保留原文。\n'); }
  await writeFile(join(vault, '02知识库/哨兵.md'), '# 知识库保持独立\n');
  await mkdir(join(workdisk, '2026-09-28/文档'), { recursive: true });
  await writeFile(join(workdisk, '2026-09-28/文档/旧工作记录.txt'), '九月招生开放日发布文案：欢迎家长预约参观。');
  const files = [join(source, '活动现场.png'), join(source, '采访录音.wav'), join(source, '今日发布稿.txt')];
  await writeFile(files[0]!, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64'));
  await writeFile(files[1]!, wave()); await writeFile(files[2]!, '今天拍摄的发布文案。');
  return { vault, userData, workdisk, source, files };
}
async function launch(data: Awaited<ReturnType<typeof fixture>>, mode: 'development' | 'packaged') {
  const target = mode === 'packaged' ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] } : { args: [resolve('dist/electron/main.js')] };
  return electron.launch({ ...target, env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: data.vault, XIAOZHAO_TEST_USER_DATA: data.userData, XIAOZHAO_TEST_WORKDISK_ROOT: data.workdisk, XIAOZHAO_TEST_WORKDISK_IMPORT_JSON: JSON.stringify(data.files) } });
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: a long workdisk preview keeps its close button reachable halfway down and at the bottom`, async ({}, info) => {
    const data = await fixture();
    const filename = '长文预览样本.txt';
    let instance: ElectronApplication | undefined;
    try {
      const lines = Array.from({ length: 180 }, (_, index) => `第 ${index + 1} 段：记录这次访谈的具体经过和原话。`);
      await writeFile(join(data.workdisk, '2026-09-28/文档', filename), lines.join('\n\n'));
      instance = await launch(data, mode);
      const page = await instance.firstWindow();
      await page.getByRole('link', { name: '工作盘', exact: true }).click();
      await page.getByRole('button', { name: '连接本地文件夹', exact: true }).click();
      const open = page.getByRole('button', { name: `预览 ${filename}`, exact: true });
      const dialog = page.getByRole('dialog', { name: filename, exact: true });
      for (const fraction of [0.5, 1]) {
        await open.click();
        await expect(dialog).toContainText('第 180 段');
        const position = await dialog.evaluate((node, fraction) => {
          const scroller = [node, ...node.querySelectorAll<HTMLElement>('*')].find(element =>
            /^(auto|scroll)$/u.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1);
          if (!scroller) throw new Error('Long preview has no scrollable reading area');
          const end = scroller.scrollHeight - scroller.clientHeight;
          scroller.scrollTop = Math.floor(end * fraction);
          return { end, top: scroller.scrollTop, height: scroller.clientHeight };
        }, fraction);
        expect(position.end).toBeGreaterThan(3 * position.height);
        expect(Math.abs(position.top - Math.floor(position.end * fraction))).toBeLessThanOrEqual(1);

        const closeButton = dialog.getByRole('button', { name: '关闭预览', exact: true });
        const target = await closeButton.evaluate(button => {
          const box = button.getBoundingClientRect();
          const bounds = button.closest('dialog')!.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          return { x, y, top: box.top, visibleTop: Math.max(bounds.top, 0),
            fullyInside: box.left >= Math.max(bounds.left, 0) && box.right <= Math.min(bounds.right, innerWidth)
              && box.bottom <= Math.min(bounds.bottom, innerHeight),
            hit: button.contains(document.elementFromPoint(x, y)) };
        });
        expect(target.top, 'Close button scrolled above the visible dialog').toBeGreaterThanOrEqual(target.visibleTop);
        expect(target.fullyInside).toBe(true);
        expect(target.hit, 'A mouse click at the visible button center should reach the button').toBe(true);
        await expect(closeButton).toContainText('关闭');
        if (fraction === 0.5) await page.keyboard.press('Escape');
        else {
          await page.screenshot({ path: info.outputPath('long-preview-close.png') });
          // Locator.click() would scroll an offscreen button back into view.
          await page.mouse.click(target.x, target.y);
        }
        await expect(dialog).toHaveCount(0);
      }
    } finally {
      await instance?.close();
      for (const path of [data.vault, data.userData, data.workdisk, data.source]) await rm(path, { recursive: true, force: true });
    }
  });
  test(`${mode}: workdisk connects, collects, previews, searches and persists without altering knowledge`, async ({}, info) => {
    test.setTimeout(120_000); const data = await fixture(); let instance: ElectronApplication | undefined;
    try {
      instance = await launch(data, mode); let page = await instance.firstWindow();
      await page.getByRole('link', { name: '工作盘', exact: true }).click();
      await page.getByRole('button', { name: '连接本地文件夹', exact: true }).click();
      await expect(page.getByRole('button', { name: '预览 旧工作记录.txt', exact: true })).toBeVisible();
      await page.getByLabel('收纳日期', { exact: true }).fill('2026-10-28');
      await page.getByRole('button', { name: '收文件', exact: true }).click();
      await expect(page.getByText('已收好 3 个文件 · 2026-10-28', { exact: true })).toBeVisible();
      expect(await readFile(join(data.workdisk, '2026-10-28/文档/今日发布稿.txt'), 'utf8')).toBe('今天拍摄的发布文案。');
      await page.getByRole('button', { name: '收文件', exact: true }).click();
      await expect(page.getByRole('button', { name: '预览 今日发布稿 (1).txt', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '写文案', exact: true }).click();
      await page.getByLabel('文案标题', { exact: true }).fill('课堂花絮文案');
      await page.getByLabel('文案正文', { exact: true }).fill('记录今天课堂里孩子们专注画画的瞬间。');
      await page.getByRole('button', { name: '保存到工作盘', exact: true }).click();
      await expect(page.getByRole('button', { name: '预览 课堂花絮文案.md', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '预览 课堂花絮文案.md', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText('记录今天课堂里孩子们专注画画的瞬间。');
      await page.getByRole('button', { name: '关闭预览', exact: true }).click();
      await page.getByRole('button', { name: '预览 采访录音.wav', exact: true }).click();
      await expect.poll(() => page.locator('audio').evaluate(element => (element as HTMLAudioElement).readyState)).toBeGreaterThan(0);
      await page.getByRole('button', { name: '关闭预览', exact: true }).click();
      await page.getByRole('button', { name: '预览 活动现场.png', exact: true }).click();
      await expect.poll(() => page.getByRole('img', { name: '活动现场.png', exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
      await page.getByRole('button', { name: '关闭预览', exact: true }).click();
      await page.getByRole('heading', { name: '把今天的工作，收好。', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath('workdisk-wide.png') });
      await page.setViewportSize({ width: 720, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByRole('heading', { name: '把今天的工作，收好。', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath('workdisk-narrow.png') });
      await page.getByRole('searchbox', { name: '描述要找的文件', exact: true }).fill('2026年9月28号的招生文案');
      await page.getByRole('button', { name: '找文件', exact: true }).click();
      await expect(page.getByRole('button', { name: '预览 旧工作记录.txt', exact: true })).toBeVisible();
      await expect(page.getByText('正文匹配 · 2026-09-28/文档/旧工作记录.txt', { exact: true })).toBeVisible();
      await expect(page.getByText(/AI 尚未连接|当前使用本地/u)).toBeVisible();
      await page.screenshot({ path: info.outputPath('workdisk-search.png') });
      await instance.close(); instance = await launch(data, mode); page = await instance.firstWindow();
      await page.getByRole('link', { name: '工作盘', exact: true }).click();
      await expect(page.getByRole('button', { name: '预览 课堂花絮文案.md', exact: true })).toBeVisible();
      expect(await readFile(join(data.workdisk, '2026-10-28/文档/课堂花絮文案.md'), 'utf8')).toBe('记录今天课堂里孩子们专注画画的瞬间。');
      expect(await readFile(data.files[2]!, 'utf8')).toBe('今天拍摄的发布文案。');
      expect(await readFile(join(data.vault, '02知识库/哨兵.md'), 'utf8')).toBe('# 知识库保持独立\n');
    } finally {
      await instance?.close();
      for (const path of [data.vault, data.userData, data.workdisk, data.source]) await rm(path, { recursive: true, force: true });
    }
  });
}
