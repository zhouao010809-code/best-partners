import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { parseLibraryNote } from '../../src/server/rules/library-schema.js';

for (const mode of ['development', 'packaged'] as const) {
test(`${mode}: intake detects plugin files, previews and archives only after confirmation`, async ({}, info) => {
  const base = await realpath(tmpdir());
  const vault = await mkdtemp(join(base, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(base, 'xiaozhao-user-data-'));
  let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
    for (const directory of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂', '01图书馆/小兆clipper', '01图书馆/来自X推特']) await mkdir(join(vault, directory));
    for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vault, path), '# Fixture rule\n');
    instance = await electron.launch({
      ...(mode === 'packaged' ? { executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'), args: [] } : { args: [resolve('dist/electron/main.js')] }),
      env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vault, XIAOZHAO_TEST_USER_DATA: userData }
    });
    const window = await instance.firstWindow();
    await window.getByRole('link', { name: '收件箱', exact: true }).click();
    await window.getByRole('button', { name: '打开收件箱' }).click();
    await expect(window.getByText('收件箱是空的', { exact: true })).toBeVisible();
    const source = join(vault, '01图书馆/小兆clipper/插件测试资料');
    await mkdir(join(source, '附件'), { recursive: true });
    const body = '# 插件保存的原文\r\n\r\n![原图](附件/图片.bin)\r\n<script>只显示文本</script>\r\n';
    const original = Buffer.from('\uFEFF---\r\ntitle: 插件测试资料\r\nauthor: "@writer"\r\nsource: https://x.com/example/status/1\r\nclipped: 2026-09-05\r\npublished: "2026-09-04T21:44:40.000Z"\r\ndescription: "插件原始描述"\r\n学习状态: 未学习\r\n---\r\n' + body);
    await writeFile(join(source, '原文.md'), original);
    const attachment = Buffer.from([0, 255, 10, 13, 23]); await writeFile(join(source, '附件/图片.bin'), attachment);
    await window.getByRole('button', { name: '整理 插件测试资料' }).click({ timeout: 15_000 });
    await expect(window.getByLabel('原始标题', { exact: true })).toHaveValue('插件测试资料');
    await expect(window.getByLabel('来源平台', { exact: true })).toHaveValue('X推特');
    await expect(window.getByLabel('采集日期', { exact: true })).toHaveValue('2026-09-05');
    await window.getByRole('button', { name: '预览归档结果', exact: true }).click();
    const preview = window.getByLabel('整理后的 Markdown');
    await expect(preview).toContainText('知识入库状态: 未提炼');
    await expect(preview).toContainText(/采集日期:\s*["']?2026-09-05/u);
    await expect(preview).toContainText('## 原始资料信息');
    const previewInfo = (await preview.innerText()).split('## 原始资料信息')[1]!.split('# 插件保存的原文')[0]!;
    expect(previewInfo).toContain('published:');
    expect(previewInfo).toContain('2026-09-04T21:44:40.000Z');
    expect(previewInfo).toContain('description:');
    expect(previewInfo).toContain('插件原始描述');
    expect(previewInfo).toContain('学习状态:');
    expect(previewInfo).toContain('未学习');
    expect(await preview.locator('script,img').count()).toBe(0);
    expect(await readFile(join(source, '原文.md'))).toEqual(original);
    await window.screenshot({ path: info.outputPath('intake-preview.png'), fullPage: true });
    const committed = window.waitForResponse((response) => response.url().endsWith('/api/v1/intake/commit'));
    await window.getByRole('button', { name: '确认归档', exact: true }).click();
    const response = await committed; const result = await response.json();
    expect(result).toMatchObject({ data: { state: 'archived', indexed: true } });
    await expect(window.getByText(/归档完成，已更新资料列表。知识状态：未提炼。/u)).toBeVisible({ timeout: 20_000 });
    await expect(window.getByText('收件箱是空的', { exact: true })).toBeVisible();
    const folder = '20260905｜X推特｜插件测试资料';
    const target = join(vault, '01图书馆/来自X推特/2026-09', folder);
    const final = await readFile(join(target, `${folder}.md`));
    const parsed = parseLibraryNote(final); expect(parsed.record).toMatchObject({ collectedAt: '2026-09-05', sourcePlatform: 'X推特', knowledgeStatus: '未提炼', processingStatus: '已归档' });
    const bodyBytes = Buffer.from(body);
    expect(final.subarray(0, 3)).toEqual(original.subarray(0, 3));
    expect(final.subarray(-bodyBytes.length)).toEqual(bodyBytes);
    const archivedInfo = Buffer.from(parsed.bodyBytes).subarray(0, -bodyBytes.length).toString('utf8');
    expect(archivedInfo).toContain('## 原始资料信息');
    expect(archivedInfo).toContain('published:');
    expect(archivedInfo).toContain('2026-09-04T21:44:40.000Z');
    expect(archivedInfo).toContain('description:');
    expect(archivedInfo).toContain('插件原始描述');
    expect(archivedInfo).toContain('学习状态:');
    expect(archivedInfo).toContain('未学习');
    expect(await readFile(join(target, '附件/图片.bin'))).toEqual(attachment);
    expect(await readdir(join(vault, '02知识库'))).toEqual([]);
    const knowledgeHealth = await window.evaluate(async () => (await (await fetch('/api/v1/health')).json()).data);
    expect(knowledgeHealth.writeGate.status).toBe('blocked');
    await window.getByRole('link', { name: '档案库', exact: true }).click();
    await window.getByRole('button', { name: '打开档案柜', exact: true }).click();
    await window.getByLabel('入库状态').selectOption('未提炼');
    await window.getByLabel('资料标题', { exact: true }).fill('插件测试资料');
    const listed = await window.evaluate(async () => (await (await fetch('/api/v1/materials?status=' + encodeURIComponent('未提炼'))).json()));
    expect(listed).toMatchObject({ data: { items: [{ title: '插件测试资料', knowledgeStatus: '未提炼' }] } });
    const currentHealth = await window.evaluate(async () => (await (await fetch('/api/v1/health')).json()).data);
    expect(currentHealth.index).toMatchObject({ status: 'ready' });
    await expect(window.getByRole('button', { name: '查看 插件测试资料 原文' }), await window.locator('body').innerText()).toBeVisible({ timeout: 5000 });
    await window.getByRole('button', { name: '查看 插件测试资料 原文' }).click();
    await expect(window.getByLabel('原始文件内容')).toContainText('插件保存的原文');
    // A real database recovery marker must still block new archive authority.
    await mkdir(source);
    await writeFile(join(source, '原文.md'), original);
    const cacheKeys = await readdir(join(userData, 'vaults'));
    expect(cacheKeys).toHaveLength(1);
    await writeFile(join(userData, 'vaults', cacheKeys[0]!, 'recovery', 'fixture-fault'), 'pending database recovery', { mode: 0o600 });
    const blocked = await window.evaluate(async () => {
      const bootstrap = await (await fetch('/api/v1/bootstrap')).json();
      const response = await fetch('/api/v1/intake/preview', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': bootstrap.data.csrfToken },
        body: JSON.stringify({ name: '插件测试资料', mainName: '原文.md', fields: { title: '测试', platform: 'X推特', collectedAt: '2026-09-05' } }) });
      return { status: response.status, body: await response.json() };
    });
    expect(blocked).toMatchObject({ status: 409, body: { error: { message: '系统需要先完成恢复或重新连接，已暂停归档。' } } });
    await instance.close(); instance = undefined;
  } finally {
    await instance?.close();
    await rm(vault, { recursive: true, force: true }); await rm(userData, { recursive: true, force: true });
  }
});
}
