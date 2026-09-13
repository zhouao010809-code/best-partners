import { _electron as electron, expect, test, type ElectronApplication, type Page, type Response } from '@playwright/test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { parseLibraryNote } from '../../src/server/rules/library-schema.js';
import { intakePreviewSchema, intakeOutcomeSchema } from '../../src/shared/api/intake.js';
import { intakeTrashEntrySchema, intakeTrashListSchema, intakeTrashPreviewSchema } from '../../src/shared/api/intake-trash.js';

const packetName = '尚未填写资料信息';
const mainName = '原文.md';
const archiveTitle = '恢复后正常归档';
const archiveFolder = `20260907｜个人｜${archiveTitle}`;
const archiveTarget = `01图书馆/来自个人/2026-09/${archiveFolder}`;
const intakePath = '01图书馆/小兆clipper';
const trashApi = '/api/v1/intake-trash';
const mode = process.env.INTAKE_TRASH_PACKAGED === '1' ? 'packaged' : 'development';

function responseAt(path: string) {
  return (response: Response) => new URL(response.url()).pathname === path;
}
async function dataOf(response: Response) {
  const body: unknown = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return (body as { data: unknown }).data;
}
async function resize(instance: ElectronApplication, page: Page, width: number) {
  await instance.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setMinimumSize(390, 600); window.setSize(size, size === 390 ? 844 : 1000);
  }, width);
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test(`${mode}: intake packet recycle survives restart, restores every byte, and remains archivable after another cycle`, async ({}, info) => {
  test.setTimeout(180_000);
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  const source = join(vault, intakePath, packetName);
  const originalBody = Buffer.from('# 没有填写来源与日期的原文\r\n\r\n完整保留这段原文。\r\n![原附件](附件/嵌套/证据.bin)\r\n', 'utf8');
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), originalBody]);
  const binary = Buffer.from([0, 255, 128, 10, 13, 1, 2, 42]);
  const members = [
    [mainName, original],
    ['附件/嵌套/证据.bin', binary],
    ['附件/空文件.bin', Buffer.alloc(0)]
  ] as const;
  const totalBytes = members.reduce((sum, [, bytes]) => sum + bytes.length, 0);
  const env = { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vault, XIAOZHAO_TEST_USER_DATA: userData };
  let instance: ElectronApplication | undefined;
  const pageErrors: string[] = [];
  const failedRequests: { path: string; status: number }[] = [];
  const mutations: string[] = [];

  async function launch() {
    instance = await electron.launch({
      ...(mode === 'packaged'
        ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] }
        : { args: [resolve('dist/electron/main.js')] }),
      env
    });
    const page = await instance.firstWindow();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && /^\/api\/v1\/intake-trash\/[^/]+\/(commit|restore|retry)$/u.test(path)) mutations.push(path);
    });
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 400 && /^\/api\/v1\/intake(?:-trash)?(?:\/|$)/u.test(path)) failedRequests.push({ path, status: response.status() });
    });
    // This fixture exercises only local filesystem work and cannot call a model.
    await instance.evaluate(() => { globalThis.fetch = async () => { throw new Error('ISOLATED_INTAKE_TRASH_NO_MODEL_NETWORK'); }; });
    await page.getByRole('link', { name: '收件箱', exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新收件箱', exact: true })).toBeEnabled();
    return page;
  }
  async function closeApp() { const current = instance; instance = undefined; await current?.close(); }
  async function verifyOriginal() {
    for (const [relative, bytes] of members) expect(await readFile(join(source, relative)), relative).toEqual(bytes);
    expect((await readdir(source)).sort()).toEqual(['原文.md', '附件']);
    expect((await readdir(join(source, '附件'))).sort()).toEqual(['嵌套', '空文件.bin']);
    expect(await readdir(join(source, '附件/嵌套'))).toEqual(['证据.bin']);
  }
  async function previewMove(page: Page) {
    const response = page.waitForResponse(responseAt(`${trashApi}/preview`));
    await page.getByRole('button', { name: `移入回收站：${packetName}`, exact: true }).click();
    const preview = intakeTrashPreviewSchema.parse(await dataOf(await response));
    expect(preview).toMatchObject({ name: packetName, kind: 'directory', fileCount: members.length, bytes: totalBytes });
    const dialog = page.getByRole('dialog', { name: '移入回收站', exact: true });
    await expect(dialog).toContainText('整个资料包及其自带附件');
    await expect(dialog).toContainText(`${members.length} 个文件`);
    await expect(dialog).toContainText(`${totalBytes.toLocaleString()} 字节`);
    await expect(dialog.getByRole('button', { name: '确认移入回收站', exact: true })).toBeEnabled();
    return { preview, dialog };
  }
  async function commitMove(page: Page) {
    const { preview, dialog } = await previewMove(page);
    const response = page.waitForResponse(responseAt(`${trashApi}/${preview.id}/commit`));
    await dialog.getByRole('button', { name: '确认移入回收站', exact: true }).click();
    const entry = intakeTrashEntrySchema.parse(await dataOf(await response));
    expect(entry).toMatchObject({ id: preview.id, name: packetName, status: 'trashed', fileCount: members.length, bytes: totalBytes });
    await expect(page.getByRole('heading', { name: '已移入回收站', exact: true })).toBeVisible();
    await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mutations.filter((path) => path === `${trashApi}/${entry.id}/commit`)).toHaveLength(1);
    return entry;
  }
  async function openTrash(page: Page) {
    const response = page.waitForResponse(responseAt(trashApi));
    await page.getByRole('button', { name: '回收站', exact: true }).click();
    const list = intakeTrashListSchema.parse(await dataOf(await response));
    await expect(page.getByRole('region', { name: '收件箱回收站', exact: true })).toBeVisible();
    return list;
  }
  async function closeReceipt(page: Page) {
    await page.getByRole('button', { name: '关闭回收操作', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '收件箱回收操作', exact: true })).toHaveCount(0);
  }

  try {
    await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
    for (const directory of ['00大脑规则', '01图书馆/来自个人', '02知识库', '03大讲堂', `${intakePath}/${packetName}/附件/嵌套`]) {
      await mkdir(join(vault, directory), { recursive: true });
    }
    for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vault, path), '# 隔离测试规则\n用户手动确认后，指定收件包及其自带附件可移入回收站并完整恢复。\n');
    for (const [relative, bytes] of members) await writeFile(join(source, relative), bytes);
    const identity = await stat(source, { bigint: true });

    let page = await launch();
    const envelope = page.getByRole('button', { name: `整理 ${packetName}`, exact: true });
    await expect(envelope).toBeVisible();
    await expect(page.getByRole('region', { name: '归档预览', exact: true })).toHaveCount(0);
    await envelope.click();
    await expect(page.getByRole('heading', { name: '整理这份资料', exact: true })).toBeVisible();
    await expect(page.getByLabel('原始标题', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('来源平台', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('采集日期', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '关闭归档预览', exact: true }).click();
    await expect(page.getByRole('region', { name: '归档预览', exact: true })).toHaveCount(0);
    await expect(envelope).toBeFocused();

    const { dialog: cancelDialog } = await previewMove(page);
    expect(mutations).toEqual([]);
    await verifyOriginal();
    for (const width of [1440, 390]) {
      await resize(instance!, page, width);
      const box = await cancelDialog.boundingBox(); expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`intake-trash-preview-${width}.png`) });
    }
    await cancelDialog.getByRole('button', { name: '取消', exact: true }).click();
    await verifyOriginal();
    expect((await stat(source, { bigint: true })).ino).toBe(identity.ino);
    expect(mutations).toEqual([]);
    await resize(instance!, page, 1440);

    const first = await commitMove(page);
    await closeReceipt(page);
    await expect(page.getByText('收件箱是空的', { exact: true })).toBeVisible();
    const firstList = await openTrash(page);
    expect(firstList.items).toHaveLength(1); expect(firstList.items[0]).toMatchObject({ id: first.id, status: 'trashed' });
    await expect(page.getByRole('button', { name: `恢复到收件箱：${packetName}`, exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('intake-trash-before-restart.png'), fullPage: true });
    await closeApp();

    page = await launch();
    await expect(page.getByRole('region', { name: '归档预览', exact: true })).toHaveCount(0);
    await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    const restarted = await openTrash(page);
    expect(restarted.items).toHaveLength(1); expect(restarted.items[0]).toMatchObject({ id: first.id, status: 'trashed' });
    const restoreResponse = page.waitForResponse(responseAt(`${trashApi}/${first.id}/restore`));
    await page.getByRole('button', { name: `恢复到收件箱：${packetName}`, exact: true }).click();
    expect(intakeTrashEntrySchema.parse(await dataOf(await restoreResponse))).toMatchObject({ id: first.id, name: packetName, status: 'restored' });
    await expect(page.getByRole('heading', { name: '已恢复到收件箱', exact: true })).toBeVisible();
    await verifyOriginal();
    const restoredIdentity = await stat(source, { bigint: true });
    expect([restoredIdentity.dev, restoredIdentity.ino]).toEqual([identity.dev, identity.ino]);
    await closeReceipt(page);
    await expect(page.getByText('回收站为空', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回收件箱', exact: true }).click();
    await expect(page.getByRole('button', { name: `整理 ${packetName}`, exact: true })).toBeVisible();

    const second = await commitMove(page);
    expect(second.id).not.toBe(first.id);
    const secondRestore = page.waitForResponse(responseAt(`${trashApi}/${second.id}/restore`));
    await page.getByRole('dialog', { name: '收件箱回收操作', exact: true }).getByRole('button', { name: '恢复到收件箱', exact: true }).click();
    expect(intakeTrashEntrySchema.parse(await dataOf(await secondRestore))).toMatchObject({ id: second.id, status: 'restored' });
    await expect(page.getByRole('heading', { name: '已恢复到收件箱', exact: true })).toBeVisible();
    await verifyOriginal();
    await closeReceipt(page);

    await page.getByRole('button', { name: `整理 ${packetName}`, exact: true }).click();
    await page.getByLabel('原始标题', { exact: true }).fill(archiveTitle);
    await page.getByLabel('来源平台', { exact: true }).selectOption('个人');
    await page.getByLabel('采集日期', { exact: true }).fill('2026-09-07');
    const archivePreviewResponse = page.waitForResponse(responseAt('/api/v1/intake/preview'));
    await page.getByRole('button', { name: '预览归档结果', exact: true }).click();
    const archivePreview = intakePreviewSchema.parse(await dataOf(await archivePreviewResponse));
    expect(archivePreview).toMatchObject({ target: archiveTarget, mainName: `${archiveFolder}.md` });
    await verifyOriginal();
    const archiveResponse = page.waitForResponse(responseAt('/api/v1/intake/commit'));
    await page.getByRole('button', { name: '确认归档', exact: true }).click();
    expect(intakeOutcomeSchema.parse(await dataOf(await archiveResponse))).toMatchObject({ target: archiveTarget, state: 'archived', indexed: true });
    await expect(page.getByRole('status').filter({ hasText: '归档完成，已更新资料列表。知识状态：未提炼。' })).toBeVisible();
    await expect(page.getByText('收件箱是空的', { exact: true })).toBeVisible();
    await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    const archived = await readFile(join(vault, archiveTarget, `${archiveFolder}.md`));
    expect(archived.subarray(0, 3)).toEqual(original.subarray(0, 3));
    expect(archived.subarray(-originalBody.length)).toEqual(originalBody);
    expect(parseLibraryNote(archived).record).toMatchObject({ sourcePlatform: '个人', collectedAt: '2026-09-07', processingStatus: '已归档', knowledgeStatus: '未提炼' });
    for (const [relative, bytes] of members.slice(1)) expect(await readFile(join(vault, archiveTarget, relative))).toEqual(bytes);
    expect(await readdir(join(vault, '02知识库'))).toEqual([]);

    // Completed restore records remain terminal after later archive changes the source path.
    const afterArchive = await openTrash(page);
    expect(afterArchive.items.map((item) => ({ id: item.id, status: item.status })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([first, second].map((item) => ({ id: item.id, status: 'restored' })).sort((a, b) => a.id.localeCompare(b.id)));
    await expect(page.getByText('回收站为空', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^继续核验：/u })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('intake-trash-after-archive.png'), fullPage: true });
    await closeApp();

    page = await launch();
    const finalList = await openTrash(page);
    expect(finalList.items).toHaveLength(2);
    expect(finalList.items.every((item) => item.status === 'restored' && !item.problem)).toBe(true);
    await expect(page.getByText('回收站为空', { exact: true })).toBeVisible();
    expect(mutations).toEqual([
      `${trashApi}/${first.id}/commit`, `${trashApi}/${first.id}/restore`,
      `${trashApi}/${second.id}/commit`, `${trashApi}/${second.id}/restore`
    ]);
    expect(failedRequests).toEqual([]); expect(pageErrors).toEqual([]);
  } finally {
    try { await closeApp(); }
    finally { await Promise.all([rm(vault, { recursive: true, force: true }), rm(userData, { recursive: true, force: true })]); }
  }
});
