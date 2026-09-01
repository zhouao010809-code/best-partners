import { expect, test, type Page } from '@playwright/test';

const APP_ORIGIN = 'http://127.0.0.1:4317';
const SERVER_SECRET = 'e2e-model-secret-never-expose';

async function openPage(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByLabel('本地连接状态')).toContainText('已连接');
}

async function expectNoRootOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflow: document.body.scrollWidth - document.body.clientWidth
  }))).toEqual({ documentOverflow: 0, bodyOverflow: 0 });
}

test('serves deterministic indexed APIs and completes a real rebuild job', async ({ request }) => {
  const healthResponse = await request.get('/api/v1/health');
  expect(healthResponse.ok()).toBe(true);
  await expect(healthResponse.json()).resolves.toMatchObject({
    data: {
      status: 'ready',
      plugin: {
        status: 'connected',
        pluginId: 'fake-local-rest-api',
        pluginVersion: '5.1.0',
        obsidianVersion: '1.8.10'
      },
      index: { status: 'ready', version: 1, refreshedAt: '2026-09-01T08:00:00.000Z' },
      model: {
        status: 'configured',
        providerHost: 'models.fixture.example',
        name: 'fixture-brain-model'
      },
      writeGate: {
        status: 'blocked',
        missing: ['profile', 'writeEnabled'],
        fingerprintMatches: false
      },
      schemaIssues: { status: 'available', count: 3 }
    },
    version: 1
  });
  expect(await healthResponse.text()).not.toContain(SERVER_SECRET);

  const materialsResponse = await request.get('/api/v1/materials?limit=200');
  expect(materialsResponse.ok()).toBe(true);
  const materials = await materialsResponse.json() as {
    data: { items: Array<{ title: string; knowledgeStatus: string }> };
  };
  expect(materials.data.items).toHaveLength(3);
  expect(materials.data.items.map((item) => item.knowledgeStatus)).toEqual([
    '未提炼', '部分入库', '未提炼'
  ]);
  expect(materials.data.items.map((item) => item.title)).not.toContain('已入库：归档案例');
  const completedMaterialsResponse = await request.get(
    `/api/v1/materials?status=${encodeURIComponent('已入库')}&limit=200`
  );
  expect(completedMaterialsResponse.ok()).toBe(true);
  const completedMaterials = await completedMaterialsResponse.json() as {
    data: { items: Array<{ title: string; knowledgeStatus: string }> };
  };
  expect(completedMaterials.data.items).toEqual([
    expect.objectContaining({ title: '已入库：归档案例', knowledgeStatus: '已入库' })
  ]);

  const knowledgeResponse = await request.get('/api/v1/knowledge?includeObsolete=true&limit=200');
  expect(knowledgeResponse.ok()).toBe(true);
  const knowledge = await knowledgeResponse.json() as {
    data: { items: Array<{ usageStatus: string; createdAt?: string; updatedAt?: string }> };
  };
  expect(knowledge.data.items).toHaveLength(4);
  expect(knowledge.data.items.map((item) => item.usageStatus)).toEqual([
    'AI总结', '定论', '已优化', '过时'
  ]);
  expect(knowledge.data.items.some((item) => (
    item.usageStatus === '定论' && item.createdAt === undefined && item.updatedAt === undefined
  ))).toBe(true);

  const bootstrapResponse = await request.get('/api/v1/bootstrap');
  expect(bootstrapResponse.ok()).toBe(true);
  const bootstrap = await bootstrapResponse.json() as { data: { csrfToken: string } };
  const rebuildResponse = await request.post('/api/v1/index-jobs/rebuild', {
    headers: {
      origin: APP_ORIGIN,
      'x-csrf-token': bootstrap.data.csrfToken,
      'idempotency-key': 'fixture-browser-rebuild-1'
    },
    data: { indexVersion: 1 }
  });
  expect(rebuildResponse.status()).toBe(202);
  const rebuild = await rebuildResponse.json() as { data: { id: string; status: string } };
  let finalJob: { status: string; indexVersion: number; progress: { completed: number; total: number } } | undefined;
  await expect.poll(async () => {
    const response = await request.get(`/api/v1/index-jobs/${rebuild.data.id}`);
    const payload = await response.json() as { data: typeof finalJob };
    finalJob = payload.data;
    return finalJob?.status;
  }).toBe('completed');
  expect(finalJob).toEqual(expect.objectContaining({
    status: 'completed',
    indexVersion: 1,
    progress: { completed: 11, total: 11 }
  }));
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
  { width: 1440, height: 1000 }
] as const) {
  test(`renders real dashboard metrics at ${viewport.width}x${viewport.height} without root overflow`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPage(page, '/');

    await expect(page.getByTestId('metric-pending').locator('strong')).toHaveText('2');
    await expect(page.getByTestId('metric-partial').locator('strong')).toHaveText('1');
    await expect(page.getByTestId('metric-knowledge').locator('strong')).toHaveText('4');
    await expect(page.getByTestId('metric-upgradeable').locator('strong')).toHaveText('2');
    const deck = page.getByRole('region', { name: '待提炼材料牌堆' });
    await expect(deck.locator('[data-material-card-trigger]')).toHaveCount(2);
    await expect(deck.getByRole('button', { name: /部分入库：证据链/u })).toHaveCount(0);

    await expectNoRootOverflow(page);
  });
}

test('keeps every secondary read page within the 390px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const routes = [
    { path: '/queue', readyText: '已加载 3 条' },
    { path: '/knowledge', readyText: '已加载 3 条' },
    { path: '/operations', readyText: '当前尚无提炼/写入工作流操作' },
    { path: '/connections', readyText: '3 个结构问题' }
  ] as const;

  for (const route of routes) {
    await openPage(page, route.path);
    await expect(page.getByText(route.readyText, { exact: true })).toBeVisible();
    await expectNoRootOverflow(page);
  }
});

test('opens the dashboard deck by keyboard and restores the exact trigger on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPage(page, '/');
  const triggers = page.locator('[data-material-card-trigger]');
  await expect(triggers).toHaveCount(2);

  await triggers.first().focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('[data-card-index="1"]')).toHaveAttribute('data-card-mode', 'active');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(triggers.nth(1)).toBeFocused();
});

test('filters the queue to the real partially ingested material', async ({ page }) => {
  await openPage(page, '/queue');
  await expect(page.getByText('已加载 3 条')).toBeVisible();

  await page.getByRole('combobox', { name: '状态', exact: true }).selectOption('部分入库');
  await page.getByRole('button', { name: '应用筛选' }).click();

  await expect(page.getByText('部分入库：证据链', { exact: true })).toBeVisible();
  await expect(page.getByText('01图书馆/YouTube/部分入库-证据链.md')).toBeVisible();
  await expect(page.getByText('已加载 1 条')).toBeVisible();
  await expect(page.getByText('待提炼：深度访谈', { exact: true })).toHaveCount(0);
});

test('searches only the title and YAML recall fields, never the Markdown body', async ({ page }) => {
  await openPage(page, '/knowledge');
  const search = page.getByLabel('标题与 YAML 召回字段');

  await search.fill('星火结论唯一词');
  await page.getByRole('button', { name: '应用筛选' }).click();
  await expect(page.getByRole('button', { name: /AI总结-核心结论/u })).toBeVisible();

  await search.fill('正文幽灵唯一词');
  await page.getByRole('button', { name: '应用筛选' }).click();
  await expect(page.getByRole('button', { name: /AI总结-核心结论/u })).toHaveCount(0);
});

test('loads one live detail, caches its version, and renders malicious Markdown inertly', async ({ page }) => {
  let detailRequests = 0;
  const remoteRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/knowledge/file') detailRequests += 1;
    if (url.hostname === 'remote.invalid') remoteRequests.push(request.url());
  });

  await openPage(page, '/knowledge');
  const trigger = page.getByRole('button', { name: /AI总结-核心结论/u });
  await expect(trigger).toBeVisible();
  expect(detailRequests).toBe(0);

  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'AI总结-核心结论 详情' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('section[aria-labelledby="source-materials-title"]')
    .getByText('01图书馆/B站/待提炼-深度访谈', { exact: true })).toBeVisible();
  await expect(dialog.locator('section[aria-labelledby="internal-links-title"]')
    .getByText('已优化-关联知识', { exact: true })).toBeVisible();
  const openButton = dialog.getByRole('button', { name: '在 Obsidian 中打开' });
  await expect(openButton).toBeVisible();
  expect(detailRequests).toBe(1);

  const markdownBody = dialog.locator('section[aria-label="知识正文"]');
  await expect(markdownBody.getByRole('heading', { name: '核心结论详情' })).toBeVisible();
  await expect(markdownBody).not.toContainText('类型: 知识笔记');
  await expect(markdownBody.locator('script')).toHaveCount(0);
  await expect(markdownBody.locator('iframe')).toHaveCount(0);
  await expect(markdownBody.locator('img')).toHaveCount(0);
  await expect(markdownBody.locator('a[href^="javascript:"]')).toHaveCount(0);
  const executionFlags = await page.evaluate(() => {
    const values = window as unknown as Record<string, unknown>;
    return {
      script: values.__E2E_SCRIPT_RAN__,
      event: values.__E2E_EVENT_RAN__,
      javascript: values.__E2E_JAVASCRIPT_RAN__
    };
  });
  expect(executionFlags).toEqual({ script: undefined, event: undefined, javascript: undefined });
  expect(remoteRequests).toEqual([]);

  await openButton.click();
  await expect(dialog.getByText('已在 Obsidian 中打开')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'AI总结-核心结论 详情' })).toBeVisible();
  await page.waitForTimeout(100);
  expect(detailRequests).toBe(1);
});

test('keeps the deck usable under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPage(page, '/');
  const trigger = page.locator('[data-material-card-trigger]').first();
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();

  const transitionDurations = await page.locator('[data-card-mode="active"]').evaluate((card) => (
    getComputedStyle(card).transitionDuration.split(',').map((value) => value.trim())
  ));
  expect(transitionDurations.every((duration) => duration === '0s' || duration === '0.001s')).toBe(true);
});

test('renders safe connection diagnostics without leaking server secrets', async ({ page }) => {
  const consoleMessages: string[] = [];
  page.on('console', (message) => consoleMessages.push(message.text()));
  await openPage(page, '/connections');

  await expect(page.getByText('models.fixture.example')).toBeVisible();
  await expect(page.getByText('fixture-brain-model')).toBeVisible();
  await expect(page.getByText('3 个结构问题')).toBeVisible();
  await expect(page.getByText('Phase 1 始终只读')).toBeVisible();

  const dom = await page.locator('html').evaluate((element) => element.outerHTML);
  expect(dom).not.toContain(SERVER_SECRET);
  expect(consoleMessages.join('\n')).not.toContain(SERVER_SECRET);
});

test('serves production CSP, applies the nonce deck stylesheet, and blocks an untrusted style', async ({ page }) => {
  const response = await page.goto('/');
  expect(response).not.toBeNull();
  const policy = response?.headers()['content-security-policy'];
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("style-src-elem 'self' 'nonce-");
  expect(policy).toContain("style-src-attr 'none'");
  const headerNonce = /'nonce-([^']+)'/u.exec(policy ?? '')?.[1];
  expect(headerNonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);

  await expect(page.locator('[data-deck-instance]')).toBeVisible();
  const trustedStyle = await page.locator('style[data-material-deck-style]').evaluate((style) => ({
    nonce: (style as HTMLStyleElement).nonce,
    ruleCount: (style as HTMLStyleElement).sheet?.cssRules.length ?? 0
  }));
  const documentNonce = await page.locator('meta[name="csp-nonce"]').getAttribute('content');
  expect(documentNonce).toBe(headerNonce);
  expect(trustedStyle.nonce).toBe(headerNonce);
  expect(trustedStyle.ruleCount).toBeGreaterThan(1);

  const probe = await page.evaluate(async () => {
    document.documentElement.classList.add('e2e-csp-probe');
    let directive: string | undefined;
    document.addEventListener('securitypolicyviolation', (event) => {
      if (event.blockedURI === 'inline') directive = event.effectiveDirective;
    });
    const style = document.createElement('style');
    style.textContent = '.e2e-csp-probe{--e2e-untrusted-style:applied}';
    document.head.append(style);
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    return {
      directive,
      computed: getComputedStyle(document.documentElement)
        .getPropertyValue('--e2e-untrusted-style')
        .trim()
    };
  });
  expect(probe).toEqual({ directive: 'style-src-elem', computed: '' });
});

test('shows the honest empty operation ledger from the live API', async ({ page }) => {
  await openPage(page, '/operations');
  await expect(page.getByText('当前尚无提炼/写入工作流操作')).toBeVisible();
});
