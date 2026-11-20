import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CURRENT_VAULT_LAYOUT } from '../../src/shared/domain/vault-layout.js';

test('packaged app opens the current vault and reads its knowledge without creating legacy folders', async () => {
  const temp = await realpath(tmpdir());
  const vault = await mkdtemp(join(temp, 'xiaozhao-vault-'));
  const state = await mkdtemp(join(temp, 'xiaozhao-user-data-'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    for (const dir of ['01图书馆/00信息入口', '02日记本', '03知识库/教学', '04大讲堂']) {
      await mkdir(join(vault, dir), { recursive: true });
    }
    for (const path of CURRENT_VAULT_LAYOUT.rulePaths) {
      await mkdir(dirname(join(vault, path)), { recursive: true });
      await writeFile(join(vault, path), '# 隔离测试规则\n');
    }
    const note = '03知识库/教学/如何记录课堂观察.md';
    const body = '复盘时先记录学生的具体动作。';
    const markdown = [
      '---', '类型: 知识笔记', '创建时间: "2026-10-14-21:30"', '更新时间: "2026-10-15-08:00"',
      '关键词: [教学]', '核心内容: 记录具体动作', '关联资料: []', '关联日记: []', '历史记录: []', '---', body
    ].join('\n');
    await writeFile(join(vault, note), markdown);
    await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
    app = await electron.launch({
      executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'),
      args: [], env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vault, XIAOZHAO_TEST_USER_DATA: state }
    });
    const window = await app.firstWindow();
    await window.getByRole('link', { name: '知识库', exact: true }).click();
    await window.getByRole('button', { name: '打开 教学 收藏册' }).click();
    await window.getByRole('button', { name: '展开 如何记录课堂观察 知识纸页' }).click();
    await expect(window.getByLabel('知识正文', { exact: true })).toContainText(body);
    expect(new URL(window.url()).searchParams.get('path')).toBe(note);
    const settings = JSON.parse(await readFile(join(state, 'config/app-config.json'), 'utf8'));
    expect(settings.vaultRoot).toBe(vault);
    expect(await readFile(join(vault, note), 'utf8')).toBe(markdown);
    for (const legacy of ['02知识库', '03大讲堂', '01图书馆/小兆clipper']) {
      await expect(realpath(join(vault, legacy))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    await app?.close();
    await rm(vault, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
