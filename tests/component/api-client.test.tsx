// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserReadConsoleApi,
  type ApiClientResult
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

describe('read console API facade', () => {
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
      .mockResolvedValueOnce(success({
        status: 'ready',
        plugin: {
          status: 'connected',
          pluginId: 'local-rest-api',
          pluginVersion: '5.1.0',
          obsidianVersion: '1.9.12'
        },
        index: {
          status: 'ready',
          version: 7,
          refreshedAt: '2026-09-01T00:00:00.000Z'
        },
        model: { status: 'configured', providerHost: 'api.example.com', name: 'model-v1' },
        writeGate: { status: 'blocked', missing: ['WRITE_ENABLED'], fingerprintMatches: true },
        schemaIssues: { status: 'available', count: 3 }
      }))
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

    releaseBootstrap(success({ csrfToken: CSRF }));
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
      if (path === '/api/v1/bootstrap') return Promise.resolve(success({ csrfToken: CSRF }));
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
