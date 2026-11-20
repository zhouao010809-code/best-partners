import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CURRENT_VAULT_LAYOUT } from '../../src/shared/domain/vault-layout.js';
import { projectScanPreviewSchema } from '../../src/shared/api/projects.js';
import { fixturePost, resizeBulk } from './bulk-lifecycle-helpers.js';

const first = '云岫茶作';
const second = '林间纸品';
const category = '原叶茶';
const positioning = '为工作间隙设计的小份原叶茶';
const reason = '每份独立包装，在办公室也能方便冲泡。';
const fact = '每包茶叶独立分装';
const source = '包装规格表 · 第一版';
const claim = '工作间隙，也能喝上一杯原叶茶。';

async function seedProject(window: Page, projectRoot: string, name: string) {
  const rootPath = join(projectRoot, name);
  await mkdir(rootPath);
  await writeFile(join(rootPath, '资料.md'), '# 隔离测试资料\n');
  const scan = await fixturePost(window, '/api/v1/projects/scan', { rootPath }) as { data: unknown };
  const { scanId, sourceSha256 } = projectScanPreviewSchema.parse(scan.data);
  await fixturePost(window, '/api/v1/projects', { scanId, sourceSha256, displayName: name });
}

async function openRegister(window: Page) {
  await window.getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '我的项目', exact: true }).click();
  const table = window.getByRole('table', { name: '项目品牌总表' });
  await expect(table.getByRole('columnheader')).toHaveText(['项目名', '品类', '品牌定位', '购买理由']);
  return table;
}

test('packaged current vault keeps brand tables project-specific across restart and at narrow widths', async ({}, info) => {
  const temporary = await realpath(tmpdir());
  const vault = await mkdtemp(join(temporary, 'xiaozhao-vault-'));
  const userData = await mkdtemp(join(temporary, 'xiaozhao-user-data-'));
  const projects = await mkdtemp(join(temporary, 'xiaozhao-client-project-'));
  const launch = () => electron.launch({
    executablePath: resolve('dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app/Contents/MacOS/最佳拍档'),
    args: [], env: { ...process.env, NODE_ENV: 'test', XIAOZHAO_TEST_VAULT_ROOT: vault, XIAOZHAO_TEST_USER_DATA: userData }
  });
  let app: ElectronApplication | undefined;
  try {
    for (const folder of ['01图书馆/00信息入口', '02日记本', '03知识库', '04大讲堂']) {
      await mkdir(join(vault, folder), { recursive: true });
    }
    for (const path of CURRENT_VAULT_LAYOUT.rulePaths) {
      await mkdir(dirname(join(vault, path)), { recursive: true });
      await writeFile(join(vault, path), '# 隔离规则\n');
    }
    await writeFile(join(vault, '.xiaozhao-read-test-vault.json'), '{"purpose":"read-test"}\n', { mode: 0o600 });
    app = await launch();
    let window = await app.firstWindow();
    await expect(window.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await seedProject(window, projects, first);
    await seedProject(window, projects, second);

    let table = await openRegister(window);
    await table.getByRole('link', { name: first + '的品牌定位', exact: true }).click();
    await expect(window).toHaveURL(/\/projects\/[0-9a-f-]+\/brand$/u);
    await window.getByRole('button', { name: '编辑品牌资料', exact: true }).click();
    for (const [label, value] of [['品类', category], ['品牌定位', positioning], ['购买理由', reason]]) {
      await window.getByRole('textbox', { name: label, exact: true }).fill(value);
    }
    await window.getByRole('button', { name: '添加证据', exact: true }).click();
    await window.getByRole('textbox', { name: '依据 1', exact: true }).fill(fact);
    await window.getByRole('textbox', { name: '出处 1', exact: true }).fill(source);
    await window.getByRole('link', { name: '核心宣传主张', exact: true }).click();
    await expect(window).toHaveURL(/\?view=claims$/u);
    await window.getByRole('button', { name: '添加主张', exact: true }).click();
    await window.getByRole('textbox', { name: '主张内容 1', exact: true }).fill(claim);
    await window.getByRole('button', { name: '保存', exact: true }).click();
    await expect(window.getByRole('button', { name: '编辑品牌资料', exact: true })).toBeEnabled();
    await expect(window.getByRole('table', { name: '核心宣传主张' })).toContainText(claim);

    await app.close();
    app = await launch();
    window = await app.firstWindow();
    table = await openRegister(window);
    const firstRow = table.getByRole('row').filter({ has: window.getByRole('link', { name: first, exact: true }) });
    for (const value of [category, positioning, reason]) await expect(firstRow).toContainText(value);
    const secondRow = table.getByRole('row').filter({ has: window.getByRole('link', { name: second, exact: true }) });
    await expect(secondRow).toBeVisible();
    await expect(secondRow).not.toContainText(category);

    for (const width of [1360, 720]) {
      await resizeBulk(app, window, width);
      await window.screenshot({ path: info.outputPath('brand-register-' + width + '.png') });
    }
    await firstRow.getByRole('link', { name: first + '的品牌定位', exact: true }).click();
    const evidence = window.getByRole('table', { name: '证据链', exact: true });
    await expect(evidence).toContainText(fact);
    await expect(evidence).toContainText(source);
    for (const width of [720, 1360]) {
      await resizeBulk(app, window, width);
      await window.screenshot({ path: info.outputPath('brand-evidence-' + width + '.png') });
    }
    await window.getByRole('link', { name: '核心宣传主张', exact: true }).click();
    await expect(window.getByRole('table', { name: '核心宣传主张' })).toContainText(claim);
    await window.screenshot({ path: info.outputPath('brand-claims-1360.png') });

    table = await openRegister(window);
    await table.getByRole('link', { name: second + '的品牌定位', exact: true }).click();
    await expect(window.getByRole('table', { name: '项目概览' })).toContainText(second);
    await expect(window.getByRole('table', { name: '项目概览' })).not.toContainText(positioning);
    await expect(window.getByRole('table', { name: '证据链' })).not.toContainText(fact);
    await window.getByRole('link', { name: '核心宣传主张', exact: true }).click();
    await expect(window.getByRole('table', { name: '核心宣传主张' })).not.toContainText(claim);
  } finally {
    try { await app?.close(); }
    finally {
      for (const path of [vault, userData, projects]) await rm(path, { recursive: true, force: true });
    }
  }
});
