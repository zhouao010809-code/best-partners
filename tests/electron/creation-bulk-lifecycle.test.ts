import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { creationDetailResponseSchema, creationListResponseSchema, type CreationDetail } from '../../src/shared/api/project-creations.js';
import { fixturePost, launchBulk, makeBulkFixture, removeBulkFixture, resizeBulk, treeSnapshot } from './bulk-lifecycle-helpers.js';

const titles = ['批量脚本甲', '批量脚本乙', '保留的独立脚本'];
async function readList(window: Page, path: string) {
  return creationListResponseSchema.parse(await window.evaluate(async path => (await fetch(path)).json(), path)).data.items;
}
async function readDetail(window: Page, path: string) {
  return creationDetailResponseSchema.parse(await window.evaluate(async path => (await fetch(path)).json(), path)).data;
}
async function pickTwo(window: Page) {
  await window.getByRole('checkbox', { name: `选择创作：${titles[0]}`, exact: true }).check();
  await window.getByRole('checkbox', { name: `选择创作：${titles[1]}`, exact: true }).check();
  await expect(window.getByRole('checkbox', { name: `选择创作：${titles[2]}`, exact: true })).not.toBeChecked();
}
async function confirmBulk(window: Page, count = 2) {
  await window.getByRole('button', { name: `批量移入回收站（${count}）`, exact: true }).click();
  await window.getByRole('dialog', { name: '批量移入项目回收站', exact: true }).getByRole('button', { name: `确认移入回收站（${count}）`, exact: true }).click();
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: bulk creations support selection, cancel, whole-batch undo, restart restore and retry only failures`, async ({}, info) => {
    test.setTimeout(180_000);
    const fixture = await makeBulkFixture(), originalProject = await treeSnapshot(fixture.project);
    const attempts: string[] = [], errors: string[] = [];
    let instance: ElectronApplication | undefined;
    try {
      let launched = await launchBulk(mode, fixture, attempts, errors); instance = launched.instance; let window = launched.window;
      await window.getByRole('link', { name: '我的项目', exact: true }).click();
      await window.getByRole('button', { name: '添加项目', exact: true }).click();
      await window.getByRole('textbox', { name: '项目显示名（可选）', exact: true }).fill('隔离批量回收项目');
      await window.getByRole('button', { name: '确认添加项目', exact: true }).click();
      await expect(window).toHaveURL(/\/projects\/[0-9a-f-]+$/u);
      const projectId = new URL(window.url()).pathname.split('/').at(-1)!, base = `/api/v1/projects/${projectId}/creations`;
      const before: CreationDetail[] = [];
      // Only fixture setup uses the actual local API. Every lifecycle mutation below is clicked in the app.
      for (const title of titles) {
        const created = creationDetailResponseSchema.parse(await fixturePost(window, base, { kind: 'script', title, body: `必须完整保留的正文：${title}\r\n第二行。` })).data;
        before.push(creationDetailResponseSchema.parse(await fixturePost(window, `${base}/${created.item.id}/versions`, { expectedRevision: created.item.revision, finalize: false })).data);
      }
      await window.reload();
      await expect(window.getByRole('checkbox', { name: `选择创作：${titles[2]}`, exact: true })).toBeVisible();
      await window.getByRole('button', { name: '全选当前列表', exact: true }).click();
      for (const title of titles) await expect(window.getByRole('checkbox', { name: `选择创作：${title}`, exact: true })).toBeChecked();
      await window.getByRole('button', { name: '取消全选', exact: true }).click();
      for (const title of titles) await expect(window.getByRole('checkbox', { name: `选择创作：${title}`, exact: true })).not.toBeChecked();
      await pickTwo(window);
      await resizeBulk(instance, window, 1360);
      await window.screenshot({ path: info.outputPath('creation-bulk-toolbar-1360.png'), fullPage: true });
      await window.getByRole('button', { name: '批量移入回收站（2）', exact: true }).click();
      const dialog = window.getByRole('dialog', { name: '批量移入项目回收站', exact: true });
      await expect(dialog).toContainText(titles[0]!); await expect(dialog).toContainText(titles[1]!);
      await expect(dialog).not.toContainText(titles[2]!);
      await window.screenshot({ path: info.outputPath('creation-bulk-confirm-1360.png'), fullPage: true });
      await resizeBulk(instance, window, 720);
      await window.screenshot({ path: info.outputPath('creation-bulk-confirm-720.png'), fullPage: true });
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      for (const original of before) expect(await readDetail(window, `${base}/${original.item.id}`)).toEqual(original);
      expect(await readList(window, `${base}/discarded`)).toEqual([]);
      await window.screenshot({ path: info.outputPath('creation-bulk-toolbar-720.png'), fullPage: true });
      await confirmBulk(window);
      await expect.poll(async () => (await readList(window, `${base}/discarded`)).length).toBe(2);
      expect((await readList(window, base)).map(value => value.title)).toEqual([titles[2]]);
      await window.getByRole('button', { name: '撤销本批回收', exact: true }).click();
      await expect.poll(async () => (await readList(window, base)).length).toBe(3);
      expect(await readList(window, `${base}/discarded`)).toEqual([]);
      await pickTwo(window); await confirmBulk(window);
      await expect.poll(async () => (await readList(window, `${base}/discarded`)).length).toBe(2);
      await instance.close(); instance = undefined;

      launched = await launchBulk(mode, fixture, attempts, errors); instance = launched.instance; window = launched.window;
      await window.getByRole('link', { name: '我的项目', exact: true }).click();
      await window.locator(`a[href="/projects/${projectId}"]`).click();
      await window.getByRole('tab', { name: '回收站', exact: true }).click();
      await window.getByRole('button', { name: '全选当前列表', exact: true }).click();
      for (const title of titles.slice(0, 2)) await expect(window.getByRole('checkbox', { name: `选择回收创作：${title}`, exact: true })).toBeChecked();
      await resizeBulk(instance, window, 720);
      await window.screenshot({ path: info.outputPath('creation-bulk-restore-720.png'), fullPage: true });
      await window.getByRole('button', { name: '批量恢复（2）', exact: true }).click();
      await expect.poll(async () => (await readList(window, base)).length).toBe(3);
      expect(await readList(window, `${base}/discarded`)).toEqual([]);
      for (const original of before) {
        const restored = await readDetail(window, `${base}/${original.item.id}`);
        expect(restored.item.body).toBe(original.item.body); expect(restored.versions).toEqual(original.versions); expect(restored.messages).toEqual(original.messages);
      }

      // One actual item is refused once. Successful siblings must remain successful; retry selects only the failed item.
      await window.getByRole('tab', { name: '创作台', exact: true }).click();
      const calls: string[] = []; let refused = false;
      await window.route(`**${base}/*/discard`, async route => {
        calls.push(new URL(route.request().url()).pathname);
        if (!refused && route.request().url().endsWith(`/${before[1]!.item.id}/discard`)) {
          refused = true;
          await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: '隔离测试：该条内容已变化，请核对后重试。', operationId: randomUUID() } }) });
        } else await route.continue();
      });
      await pickTwo(window); await confirmBulk(window);
      await expect(window.getByText('已移入回收站 1 条，1 条未完成。', { exact: true })).toBeVisible();
      await expect(window.getByRole('checkbox', { name: `选择创作：${titles[1]}`, exact: true })).toBeChecked();
      expect((await readList(window, `${base}/discarded`)).map(value => value.title)).toEqual([titles[0]]);
      await confirmBulk(window, 1);
      await expect.poll(async () => (await readList(window, `${base}/discarded`)).length).toBe(2);
      expect(calls.filter(value => value.endsWith(`/${before[0]!.item.id}/discard`))).toHaveLength(1);
      expect(calls.filter(value => value.endsWith(`/${before[1]!.item.id}/discard`))).toHaveLength(2);
      expect((await readList(window, base)).map(value => value.title)).toEqual([titles[2]]);

      await window.getByRole('tab', { name: '回收站', exact: true }).click();
      await window.getByRole('button', { name: '全选当前列表', exact: true }).click();
      await window.getByRole('button', { name: '批量恢复（2）', exact: true }).click();
      await expect.poll(async () => (await readList(window, base)).length).toBe(3);
      await window.getByRole('tab', { name: '创作台', exact: true }).click();
      let responseLost = false;
      await window.route(`**${base}/${before[0]!.item.id}/discard`, async route => {
        const committed = await route.fetch(); expect(committed.status()).toBe(200);
        responseLost = true; await route.abort('failed');
      });
      await pickTwo(window); await confirmBulk(window);
      await expect.poll(async () => (await readList(window, `${base}/discarded`)).length).toBe(2);
      // A successful commit with a lost HTTP response must be reconciled into the undo receipt, not silently stranded.
      await window.getByRole('button', { name: '撤销本批回收', exact: true }).click();
      await expect.poll(async () => (await readList(window, base)).length).toBe(3);
      expect(await readList(window, `${base}/discarded`)).toEqual([]);
      expect(responseLost).toBe(true);
      expect(await treeSnapshot(fixture.project)).toEqual(originalProject);
      expect(attempts).toEqual([]); expect(errors).toEqual([]);
    } finally { await instance?.close(); await removeBulkFixture(fixture); }
  });
}
