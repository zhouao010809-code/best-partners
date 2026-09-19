// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserReadConsoleApi,
  type ApiClientResult,
  type ReadConsoleApi
} from '../../src/client/api/client.js';

const SHA = 'a'.repeat(64);
const CSRF = 'c'.repeat(43);

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function success(data: unknown): Response {
  return jsonResponse({ data, version: 1 });
}

function completedJob(id = 'job-1') {
  return {
    id,
    operationId: 'operation-1',
    status: 'completed' as const,
    requestedIndexVersion: 7,
    indexVersion: 8,
    progress: { completed: 3, total: 3 },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:01.000Z'
  };
}

function readyHealth() {
  return {
    status: 'ready' as const,
    vaultSource: {
      status: 'ready' as const,
      adapter: 'filesystem' as const,
      displayName: '我的大脑'
    },
    index: {
      status: 'ready' as const,
      version: 7,
      refreshedAt: '2026-09-01T00:00:00.000Z'
    },
    model: { status: 'configured' as const, providerHost: 'api.example.com', name: 'model-v1' },
    writeGate: { status: 'blocked' as const, missing: ['WRITE_ENABLED'], fingerprintMatches: true },
    schemaIssues: { status: 'available' as const, count: 3 }
  };
}

describe('read console API facade', () => {
  it('reads the local Skill catalog with encoded detail ids and abort support', async () => {
    const skill = { id: SHA, name: '写作/发布', description: '本地方法', revision: 'b'.repeat(64), folderId: null, folderName: null };
    const folders = [{ id: 'd'.repeat(64), name: '内容', skillCount: 1 }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(success({ folders, items: [skill] }))
      .mockResolvedValueOnce(success({ ...skill, markdown: '# 方法', references: ['README.md'] }));
    const api = createBrowserReadConsoleApi(fetchMock);
    const signal = new AbortController().signal;

    expect(api.skills).toBeDefined();
    expect(await api.skills!.list(signal)).toEqual({ ok: true, value: { folders, items: [skill] } });
    expect(await api.skills!.get('skill/with space', signal)).toMatchObject({ ok: true, value: { name: '写作/发布' } });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/skills', expect.objectContaining({ method: 'GET', signal }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/skills/skill%2Fwith%20space', expect.objectContaining({ method: 'GET', signal }));
  });

  it('preserves the Skill catalog unavailable code for the workspace to explain', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      error: { code: 'SKILL_CATALOG_UNAVAILABLE', message: 'Skill catalog is unavailable.', operationId: 'skill-read-1' }
    }, 503));
    const result = await createBrowserReadConsoleApi(fetchMock).skills!.list();
    expect(result).toMatchObject({ ok: false, code: 'SKILL_CATALOG_UNAVAILABLE', state: { status: 'operation-error' } });
  });

  it('requests library directories with bounded declared filters and validates their complete counts', async () => {
    const page = { mode: 'source', path: '来自B站/2026-09', breadcrumbs: [{ path: '', label: '全部资料' }],
      folders: [], items: [], total: 0, directTotal: 0, unclassifiedCount: 0, indexVersion: 7 };
    const fetchMock = vi.fn().mockResolvedValueOnce(success(page)).mockResolvedValueOnce(success({ ...page, total: -1 }));
    const api = createBrowserReadConsoleApi(fetchMock);
    const controller = new AbortController();
    expect(await api.listLibrary({ mode: 'source', path: '来自B站/2026-09', status: '已入库', title: '原文 & 附件', limit: 20,
      ...({ secret: 'never-send' } as object) }, controller.signal)).toEqual({ ok: true, value: page });
    const [path, init] = fetchMock.mock.calls[0]!;
    const url = new URL(path, 'http://127.0.0.1');
    expect(url.pathname).toBe('/api/v1/library');
    expect(Object.fromEntries(url.searchParams)).toEqual({ mode: 'source', path: '来自B站/2026-09', status: '已入库', title: '原文 & 附件', limit: '20' });
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', signal: controller.signal });
    expect(await api.listLibrary({})).toMatchObject({ ok: false, state: { status: 'validation-error' } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('builds fixed GET requests from only the declared material and knowledge filters', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(success({ items: [{
        path: '01原始素材/alpha.md',
        rawSha256: SHA,
        title: 'Alpha',
        sourcePlatform: 'B站',
        processingStatus: '未归档',
        knowledgeStatus: '部分入库',
        collectedAt: '2026-08-31',
        generatedKnowledge: []
      }] }))
      .mockResolvedValueOnce(success({ items: [] }));
    const api = createBrowserReadConsoleApi(fetchMock);

    const materials = await api.listMaterials({
      status: '部分入库',
      sourcePlatform: 'B站 & 小红书',
      collectedFrom: '2026-08-01',
      collectedTo: '2026-08-31',
      title: 'Alpha / Beta',
      cursor: 'cursor.signature',
      limit: 50,
      ...({ secret: 'must-not-leave-the-client' } as object)
    });
    const knowledge = await api.listKnowledge({
      search: '定论 & 边界',
      includeObsolete: true,
      usageStatus: '定论',
      knowledgeType: '方法论',
      topic: '产品/定价',
      limit: 20
    });

    expect(materials).toMatchObject({ ok: true, value: { items: [{ title: 'Alpha' }] } });
    expect(knowledge).toEqual({ ok: true, value: { items: [] } });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/materials?status=%E9%83%A8%E5%88%86%E5%85%A5%E5%BA%93&sourcePlatform=B%E7%AB%99+%26+%E5%B0%8F%E7%BA%A2%E4%B9%A6&collectedFrom=2026-08-01&collectedTo=2026-08-31&title=Alpha+%2F+Beta&cursor=cursor.signature&limit=50',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/knowledge?search=%E5%AE%9A%E8%AE%BA+%26+%E8%BE%B9%E7%95%8C&includeObsolete=true&usageStatus=%E5%AE%9A%E8%AE%BA&knowledgeType=%E6%96%B9%E6%B3%95%E8%AE%BA&topic=%E4%BA%A7%E5%93%81%2F%E5%AE%9A%E4%BB%B7&limit=20',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' })
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('secret');
  });

  it('returns response data instead of envelopes and validates every public response strictly', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(success(readyHealth()))
      .mockResolvedValueOnce(success({ items: [], unexpected: true }));
    const api = createBrowserReadConsoleApi(fetchMock);

    const health = await api.getHealth();
    const driftedOperations = await api.listOperations();

    expect(health).toMatchObject({
      ok: true,
      value: { index: { status: 'ready', version: 7 } }
    });
    expect(health).not.toHaveProperty('value.data');
    expect(health).not.toHaveProperty('value.version');
    expect(driftedOperations).toMatchObject({
      ok: false,
      state: { status: 'validation-error' }
    });
  });

  it.each([
    {
      name: 'health',
      payload: { ...readyHealth(), unexpected: true },
      invoke: (api: ReadConsoleApi) => api.getHealth()
    },
    {
      name: 'materials',
      payload: { items: [], unexpected: true },
      invoke: (api: ReadConsoleApi) => api.listMaterials({})
    },
    {
      name: 'knowledge',
      payload: { items: [], unexpected: true },
      invoke: (api: ReadConsoleApi) => api.listKnowledge({})
    },
    {
      name: 'document issues',
      payload: { items: [], unexpected: true },
      invoke: (api: ReadConsoleApi) => api.listDocumentIssues({})
    },
    {
      name: 'original document',
      payload: { path: '01图书馆/旧文档.md', title: '旧文档', markdown: '# 原文', versionMarker: { rawSha256: SHA }, unexpected: true },
      invoke: (api: ReadConsoleApi) => api.getDocumentDetail('01图书馆/旧文档.md')
    },
    {
      name: 'knowledge detail',
      payload: {
        path: '02知识库/alpha.md',
        title: 'Alpha',
        markdown: '# Alpha',
        internalKnowledgeLinks: [],
        versionMarker: { rawSha256: SHA },
        unexpected: true
      },
      invoke: (api: ReadConsoleApi) => api.getKnowledgeDetail('02知识库/alpha.md')
    },
    {
      name: 'operations',
      payload: { items: [], unexpected: true },
      invoke: (api: ReadConsoleApi) => api.listOperations()
    },
    {
      name: 'open knowledge',
      payload: { opened: true, path: '02知识库/alpha.md', unexpected: true },
      invoke: (api: ReadConsoleApi) => api.openKnowledge('02知识库/alpha.md')
    },
    {
      name: 'index rebuild',
      payload: { ...completedJob(), unexpected: true },
      invoke: (api: ReadConsoleApi) => api.rebuildIndex(7, 'strict-rebuild-1')
    },
    {
      name: 'index job',
      payload: { ...completedJob(), unexpected: true },
      invoke: (api: ReadConsoleApi) => api.getIndexJob('job-1')
    }
  ])('rejects extra fields in the $name public response schema', async ({ payload, invoke }) => {
    const fetchMock = vi.fn((path: RequestInfo | URL) => (
      path === '/api/v1/bootstrap'
        ? Promise.resolve(success({ csrfToken: CSRF, runtimeMode: 'personal' }))
        : Promise.resolve(success(payload))
    ));
    const api = createBrowserReadConsoleApi(fetchMock);

    const result = await invoke(api);

    expect(result).toEqual({
      ok: false,
      state: { status: 'validation-error', message: '响应结构与当前客户端不兼容。' }
    });
  });

  it('validates the lazy bootstrap response strictly before sending a command', async () => {
    const fetchMock = vi.fn().mockResolvedValue(success({ csrfToken: CSRF, runtimeMode: 'personal', unexpected: true }));
    const api = createBrowserReadConsoleApi(fetchMock);

    const result = await api.openKnowledge('02知识库/alpha.md');

    expect(result).toMatchObject({ ok: false, state: { status: 'validation-error' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/bootstrap',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' })
    );
  });

  it.each(['SESSION_REQUIRED', 'CSRF_INVALID'])('refreshes authentication once after a pre-handler %s rejection', async (code) => {
    const freshToken = 'f'.repeat(43);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(success({ csrfToken: CSRF, runtimeMode: 'personal' }))
      .mockResolvedValueOnce(jsonResponse({ error: { code, message: 'Authentication rejected', operationId: 'auth-1' } }, code === 'SESSION_REQUIRED' ? 401 : 403))
      .mockResolvedValueOnce(success({ csrfToken: freshToken, runtimeMode: 'personal' }))
      .mockResolvedValueOnce(success({ opened: true, path: '02知识库/alpha.md' }));
    const api = createBrowserReadConsoleApi(fetchMock);
    expect(await api.openKnowledge('02知识库/alpha.md')).toEqual({ ok: true, value: { opened: true, path: '02知识库/alpha.md' } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3]?.[1]?.headers['x-csrf-token']).toBe(freshToken);
  });

  it('does not replay a mutation after an uncertain failure or loop on an authentication failure', async () => {
    for (const code of ['INTERNAL_ERROR', 'CSRF_INVALID']) {
      const fetchMock = vi.fn((path: RequestInfo | URL) => Promise.resolve(path === '/api/v1/bootstrap'
        ? success({ csrfToken: CSRF, runtimeMode: 'personal' })
        : jsonResponse({ error: { code, message: 'Rejected', operationId: 'failure-1' } }, code === 'CSRF_INVALID' ? 403 : 500)));
      expect((await createBrowserReadConsoleApi(fetchMock).openKnowledge('02知识库/alpha.md')).ok).toBe(false);
      expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/knowledge/open')).toHaveLength(code === 'CSRF_INVALID' ? 2 : 1);
    }
  });

  it('coalesces the first bootstrap across commands and never persists or logs the CSRF token', async () => {
    let releaseBootstrap!: (response: Response) => void;
    const bootstrapResponse = new Promise<Response>((resolve) => {
      releaseBootstrap = resolve;
    });
    const fetchMock = vi.fn((path: RequestInfo | URL) => {
      if (path === '/api/v1/bootstrap') return bootstrapResponse;
      if (path === '/api/v1/knowledge/open') {
        return Promise.resolve(success({ opened: true, path: '02知识库/alpha.md' }));
      }
      return Promise.resolve(success(completedJob()));
    });
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = createBrowserReadConsoleApi(fetchMock);

    const openPromise = api.openKnowledge('02知识库/alpha.md');
    const rebuildPromise = api.rebuildIndex(7, 'focus-cycle-1');
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/bootstrap')).toHaveLength(1);

    releaseBootstrap(success({ csrfToken: CSRF, runtimeMode: 'personal' }));
    await expect(openPromise).resolves.toMatchObject({ ok: true });
    await expect(rebuildPromise).resolves.toMatchObject({ ok: true });

    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/bootstrap')).toHaveLength(1);
    expect(storageWrite).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('uses CSRF for open, adds idempotency only for rebuild, and posts strict JSON bodies', async () => {
    const fetchMock = vi.fn((path: RequestInfo | URL) => {
      if (path === '/api/v1/bootstrap') return Promise.resolve(success({ csrfToken: CSRF, runtimeMode: 'personal' }));
      if (path === '/api/v1/knowledge/open') {
        return Promise.resolve(success({ opened: true, path: '02知识库/alpha.md' }));
      }
      return Promise.resolve(success(completedJob()));
    });
    const api = createBrowserReadConsoleApi(fetchMock);

    await api.openKnowledge('02知识库/alpha.md');
    await api.rebuildIndex(7, 'focus-cycle-7');

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/knowledge/open', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': CSRF
      },
      body: JSON.stringify({ path: '02知识库/alpha.md' })
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/v1/index-jobs/rebuild', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': CSRF,
        'idempotency-key': 'focus-cycle-7'
      },
      body: JSON.stringify({ indexVersion: 7 })
    });
  });

  it('marks AbortError as cancelled instead of disconnected', async () => {
    const abortError = new DOMException('request was aborted', 'AbortError');
    const api = createBrowserReadConsoleApi(vi.fn().mockRejectedValue(abortError));

    const controller = new AbortController();
    const result: ApiClientResult<unknown> = await api.getHealth(controller.signal);

    expect(result).toEqual({ ok: false, cancelled: true });
    expect(result).not.toHaveProperty('state.status', 'disconnected');
  });

  it('also marks an abort while reading the response body as cancelled', async () => {
    const response = new Response('{}');
    vi.spyOn(response, 'json').mockRejectedValue(new DOMException('body aborted', 'AbortError'));
    const api = createBrowserReadConsoleApi(vi.fn().mockResolvedValue(response));

    const result = await api.getHealth();

    expect(result).toEqual({ ok: false, cancelled: true });
  });

  it.each([
    ['health', '/api/v1/health', (api: ReadConsoleApi, signal: AbortSignal) => api.getHealth(signal)],
    ['document issues', '/api/v1/documents/issues', (api: ReadConsoleApi, signal: AbortSignal) => api.listDocumentIssues({}, signal)],
    ['original document', '/api/v1/documents/file?path=alpha.md', (api: ReadConsoleApi, signal: AbortSignal) => api.getDocumentDetail('alpha.md', signal)],
    ['materials', '/api/v1/materials', (api: ReadConsoleApi, signal: AbortSignal) => api.listMaterials({}, signal)],
    ['knowledge', '/api/v1/knowledge', (api: ReadConsoleApi, signal: AbortSignal) => api.listKnowledge({}, signal)],
    ['knowledge detail', '/api/v1/knowledge/file?path=alpha.md', (api: ReadConsoleApi, signal: AbortSignal) => (
      api.getKnowledgeDetail('alpha.md', signal)
    )],
    ['operations', '/api/v1/operations', (api: ReadConsoleApi, signal: AbortSignal) => api.listOperations(signal)],
    ['index job', '/api/v1/index-jobs/job-1', (api: ReadConsoleApi, signal: AbortSignal) => (
      api.getIndexJob('job-1', signal)
    )]
  ] as const)('forwards a real AbortSignal to the fixed %s GET', async (_name, path, invoke) => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted === true) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    ));
    const api = createBrowserReadConsoleApi(fetchMock);
    const controller = new AbortController();

    const request = invoke(api, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(path, {
      method: 'GET',
      credentials: 'same-origin',
      signal: controller.signal
    });

    controller.abort();

    await expect(request).resolves.toEqual({ ok: false, cancelled: true });
  });

  it('maps a non-abort network failure to disconnected', async () => {
    const api = createBrowserReadConsoleApi(
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    );

    const result = await api.getHealth();

    expect(result).toMatchObject({ ok: false, state: { status: 'disconnected' } });
  });

  it('maps malformed JSON to validation-error', async () => {
    const api = createBrowserReadConsoleApi(
      vi.fn().mockResolvedValue(new Response('{broken', { status: 200 }))
    );

    const result = await api.getHealth();

    expect(result).toMatchObject({ ok: false, state: { status: 'validation-error' } });
  });

  it.each([
    ['READ_API_UNAVAILABLE', 'recovery-required'],
    ['VALIDATION_ERROR', 'validation-error'],
    ['VERSION_CONFLICT', 'conflict'],
    ['IDEMPOTENCY_CONFLICT', 'conflict'],
    ['INDEX_BUSY', 'busy'],
    ['UNKNOWN_CONFLICT', 'operation-error']
  ] as const)('maps stable error code %s to %s without logging private details', async (code, status) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = createBrowserReadConsoleApi(vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code,
        message: 'request failed without private details',
        operationId: 'operation-safe-1'
      }
    }, 409)));

    const result = await api.getIndexJob('job-1');

    expect(result).toEqual({
      ok: false,
      state: { status, message: 'request failed without private details' },
      operationId: 'operation-safe-1'
    });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
