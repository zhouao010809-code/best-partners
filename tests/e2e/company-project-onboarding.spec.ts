import { expect, test } from '@playwright/test';

const SHA = 'a'.repeat(64);
const session = { data: { user: { id: 'owner', displayName: '老板', role: 'owner' }, csrfToken: 'c'.repeat(43) }, version: 1 };
const proposal = {
  sourceRoot: 'incoming/培训机构', sourceSha256: SHA, suggestedName: '培训机构项目', suggestedClientName: '星河培训', suggestedStatus: 'draft',
  fields: { clientName: { value: '星河培训', confidence: 'inferred', evidencePaths: ['项目说明.md'] }, serviceStart: { confidence: 'unknown', evidencePaths: [] } }, selectedSkillIds: [], entries: [{ relativePath: '项目说明.md', kind: 'file', bytes: 20, sha256: SHA }], issues: []
};
const run = { id: 'run-e2e', projectId: 'project-e2e', sourceSha256: SHA, state: 'proposed', proposal, operationId: 'op-e2e', createdAt: '2026-09-18T08:00:00.000Z', updatedAt: '2026-09-18T08:00:00.000Z' };
const active = { id: 'project-e2e', workspaceId: 'company', name: '培训机构项目', clientName: '星河培训', status: 'active', projectRoot: 'projects/project-e2e', sourceRoot: 'incoming/培训机构', configSha256: SHA, confidence: {}, selectedSkillIds: [], createdAt: '2026-09-18T08:00:00.000Z', updatedAt: '2026-09-18T08:01:00.000Z', dataCoverage: 'not_configured' };

test('company onboarding keeps the source on the Mac mini and confirms an Agent proposal', async ({ page }) => {
  let confirmed = false;
  const personalDataRequests: string[] = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/v1/health' || pathname.startsWith('/api/v1/trash')) personalDataRequests.push(pathname);
  });
  await page.route('**/api/v1/bootstrap', async route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { csrfToken: 'p'.repeat(43), runtimeMode: 'company' }, version: 1 }) }));
  await page.route('**/api/company/v1/auth/session', async route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) }));
  await page.route('**/api/company/v1/projects', async route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { items: confirmed ? [active] : [] }, version: 1 }) }));
  await page.route('**/api/company/v1/projects/scan', async route => {
    const body = route.request().postDataJSON() as { incomingPath?: string };
    expect(body).toEqual({ incomingPath: 'incoming/培训机构' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { reused: false, run, project: { ...active, status: 'draft' }, proposal }, version: 1 }) });
  });
  await page.route('**/api/company/v1/projects/drafts/run-e2e/confirm', async route => {
    confirmed = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { project: active, run: { ...run, state: 'confirmed' }, operationId: 'op-confirm' }, version: 1 }) });
  });

  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '公司主导航' })).toBeVisible();
  expect(personalDataRequests).toEqual([]);
  await expect(page.getByRole('link', { name: '项目数据看板' })).toBeVisible();
  await expect(page.getByRole('link', { name: '项目档案库' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Skill 库' })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开 Agent 连接说明' })).toBeVisible();
  await page.getByRole('button', { name: '打开 Agent 连接说明' }).click();
  await expect(page.getByRole('status', { name: 'Agent 连接说明' })).toContainText('默认只读');
  await expect(page.getByRole('status', { name: 'Agent 连接说明' })).toContainText('网页不内置聊天');
  await page.getByRole('link', { name: '项目档案库' }).click();
  const source = page.getByRole('textbox', { name: 'incoming 文件夹路径' });
  await source.fill('incoming/培训机构');
  await page.getByRole('button', { name: '分析文件夹' }).click();
  await expect(page.getByRole('heading', { name: '导入提案' })).toBeVisible();
  await expect(page.getByText('客户名称')).toBeVisible();
  await page.getByRole('button', { name: /确认并建立项目/u }).click();
  await expect(page.getByRole('heading', { name: '培训机构项目' })).toBeVisible();
  await expect(page.getByText('服务中')).toBeVisible();
});
