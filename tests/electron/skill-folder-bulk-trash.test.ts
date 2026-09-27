import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { skillFolderTrashListResponseSchema } from '../../src/shared/api/skills.js';
import { launchBulk, makeBulkFixture, removeBulkFixture, resizeBulk, treeSnapshot } from './bulk-lifecycle-helpers.js';

const names = ['选题方法', '脚本方法', '保留的方法'];
async function pickTwo(window: Page) {
  for (const name of names.slice(0, 2)) await window.getByRole('checkbox', { name: `选择文件夹：${name}`, exact: true }).check();
  await expect(window.getByRole('checkbox', { name: `选择文件夹：${names[2]}`, exact: true })).not.toBeChecked();
}
async function trashEntries(window: Page) {
  const result = await window.evaluate(async () => {
    const response = await fetch('/api/v1/skills/folder-trash');
    return { status: response.status, body: await response.json() };
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return skillFolderTrashListResponseSchema.parse(result.body).data.items;
}
async function confirmBulk(window: Page) {
  await window.getByRole('button', { name: '批量移到回收站（2）', exact: true }).click();
  await window.getByRole('dialog', { name: '回收选中的 2 个文件夹？', exact: true }).getByRole('button', { name: '确认回收这 2 个文件夹', exact: true }).click();
  await expect(window.getByText('已回收 2 个文件夹。', { exact: true })).toBeVisible();
}

for (const mode of ['development', 'packaged'] as const) {
  test(`${mode}: selected Skill folders support batch cancel, undo, restart and partial restore without byte loss`, async ({}, info) => {
    test.setTimeout(180_000);
    const fixture = await makeBulkFixture(), root = join(fixture.vault, '.claude', 'skills');
    const attempts: string[] = [], errors: string[] = [];
    let instance: ElectronApplication | undefined;
    try {
      for (const [index, name] of names.entries()) {
        const folder = join(root, name);
        await mkdir(join(folder, `skill-${index}`), { recursive: true });
        await writeFile(join(folder, `skill-${index}`, 'SKILL.md'), `\uFEFF---\r\nname: 隔离方法${index}\r\ndescription: 批量回收恢复验收\r\n---\r\n# 原文不可丢失 ${index}\r\n`);
        await writeFile(join(folder, '.hidden'), Buffer.from([0, 255, index, 13, 10]));
        await mkdir(join(folder, '未识别目录', '空文件夹'), { recursive: true });
        await writeFile(join(folder, '未识别目录', '附件.bin'), Buffer.from([255, 128, 1, 2, index]));
      }
      const originals = await Promise.all(names.map(name => treeSnapshot(join(root, name))));
      const originalVault = await treeSnapshot(fixture.vault), originalProject = await treeSnapshot(fixture.project);
      let launched = await launchBulk(mode, fixture, attempts, errors); instance = launched.instance; let window = launched.window;
      await window.getByRole('link', { name: 'Skill 库', exact: true }).click();
      await window.getByRole('button', { name: '全选文件夹', exact: true }).click();
      for (const name of names) await expect(window.getByRole('checkbox', { name: `选择文件夹：${name}`, exact: true })).toBeChecked();
      await window.getByRole('button', { name: '取消全选文件夹', exact: true }).click();
      for (const name of names) await expect(window.getByRole('checkbox', { name: `选择文件夹：${name}`, exact: true })).not.toBeChecked();
      await pickTwo(window);
      await resizeBulk(instance, window, 1360);
      await window.screenshot({ path: info.outputPath('skill-bulk-toolbar-1360.png'), fullPage: true });
      await window.getByRole('button', { name: '批量移到回收站（2）', exact: true }).click();
      const dialog = window.getByRole('dialog', { name: '回收选中的 2 个文件夹？', exact: true });
      await expect(dialog).toContainText(names[0]!); await expect(dialog).toContainText(names[1]!);
      await expect(dialog).not.toContainText(names[2]!);
      await expect(dialog).toContainText('隐藏文件');
      await window.screenshot({ path: info.outputPath('skill-bulk-confirm-1360.png'), fullPage: true });
      await resizeBulk(instance, window, 720);
      await window.screenshot({ path: info.outputPath('skill-bulk-confirm-720.png'), fullPage: true });
      await dialog.getByRole('button', { name: '取消回收', exact: true }).click();
      expect(await treeSnapshot(fixture.vault)).toEqual(originalVault);
      await window.screenshot({ path: info.outputPath('skill-bulk-toolbar-720.png'), fullPage: true });
      await confirmBulk(window);
      let recycled = (await trashEntries(window)).filter(entry => entry.status === 'trashed');
      expect(recycled.map(entry => entry.name).sort()).toEqual(names.slice(0, 2).sort());
      for (const entry of recycled) expect(await treeSnapshot(join(root, '.trash', entry.id, 'folder'))).toEqual(originals[names.indexOf(entry.name)]);
      expect(await treeSnapshot(join(root, names[2]!))).toEqual(originals[2]);
      await window.getByRole('button', { name: '撤销本批回收', exact: true }).click();
      // The list and restore APIs share a lock. Observe the completed UI receipt before verifying persistent state.
      await expect(window.getByText('已恢复 2 个文件夹。', { exact: true })).toBeVisible();
      expect((await trashEntries(window)).filter(entry => entry.status === 'trashed')).toHaveLength(0);
      for (const [index, name] of names.entries()) expect(await treeSnapshot(join(root, name))).toEqual(originals[index]);
      await pickTwo(window); await confirmBulk(window);
      recycled = (await trashEntries(window)).filter(entry => entry.status === 'trashed');
      expect(recycled).toHaveLength(2);
      await instance.close(); instance = undefined;

      launched = await launchBulk(mode, fixture, attempts, errors); instance = launched.instance; window = launched.window;
      await window.getByRole('link', { name: 'Skill 库', exact: true }).click();
      await expect(window.getByRole('checkbox', { name: `选择文件夹：${names[0]}`, exact: true })).toHaveCount(0);
      await expect(window.getByRole('checkbox', { name: `选择文件夹：${names[2]}`, exact: true })).toBeVisible();
      await window.getByRole('button', { name: '文件夹回收站', exact: true }).click();
      await window.getByRole('button', { name: '全选可恢复文件夹', exact: true }).click();
      for (const name of names.slice(0, 2)) await expect(window.getByRole('checkbox', { name: `选择回收文件夹：${name}`, exact: true })).toBeChecked();
      await resizeBulk(instance, window, 720);
      await window.screenshot({ path: info.outputPath('skill-bulk-restore-720.png'), fullPage: true });

      // Create a real target collision after loading the recycle list. One item must restore while the other remains retryable.
      const collisionPath = join(root, names[1]!);
      await mkdir(collisionPath); await writeFile(join(collisionPath, '.new-content'), Buffer.from([44, 33, 0, 255]));
      const collision = await treeSnapshot(collisionPath);
      await window.getByRole('button', { name: '批量恢复（2）', exact: true }).click();
      await expect(window.getByText('已恢复 1 个文件夹，1 个未完成。', { exact: true })).toBeVisible();
      await expect(window.getByRole('button', { name: '刷新回收列表', exact: true })).toBeEnabled();
      expect((await trashEntries(window)).filter(entry => entry.status === 'trashed')).toHaveLength(1);
      await expect(window.getByRole('checkbox', { name: `选择回收文件夹：${names[1]}`, exact: true })).toBeChecked();
      await expect(window.getByRole('button', { name: '批量恢复（1）', exact: true })).toBeEnabled();
      await expect(window.getByRole('alert')).toContainText('同名文件夹');
      expect(await treeSnapshot(join(root, names[0]!))).toEqual(originals[0]);
      expect(await treeSnapshot(collisionPath)).toEqual(collision);
      const pending = recycled.find(entry => entry.name === names[1])!;
      expect(await treeSnapshot(join(root, '.trash', pending.id, 'folder'))).toEqual(originals[1]);
      await window.screenshot({ path: info.outputPath('skill-bulk-partial-conflict-720.png'), fullPage: true });
      const heldCollision = join(fixture.vault, 'held-isolated-collision');
      await rename(collisionPath, heldCollision);
      await window.getByRole('button', { name: '批量恢复（1）', exact: true }).click();
      await expect(window.getByText('已恢复 1 个文件夹。', { exact: true })).toBeVisible();
      await expect(window.getByRole('button', { name: '刷新回收列表', exact: true })).toBeEnabled();
      expect((await trashEntries(window)).filter(entry => entry.status === 'trashed')).toHaveLength(0);
      for (const [index, name] of names.entries()) expect(await treeSnapshot(join(root, name))).toEqual(originals[index]);
      expect(await treeSnapshot(heldCollision)).toEqual(collision);
      expect(await readdir(root)).toEqual(expect.arrayContaining(names));
      expect(await treeSnapshot(fixture.project)).toEqual(originalProject);
      expect(attempts).toEqual([]); expect(errors).toEqual([]);
      await info.attach('preserved-bulk-skill-trees', { body: JSON.stringify({ names, originals }, null, 2), contentType: 'application/json' });
    } finally { await instance?.close(); await removeBulkFixture(fixture); }
  });
}
