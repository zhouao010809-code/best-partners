// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { requestApi } from '../../src/client/api/client.js';

const responseSchema = z.object({
  data: z.object({ name: z.string() }).strict(),
  version: z.literal(1)
}).strict();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('API client boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('validates successful responses and always sends same-origin credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: { name: '我的大脑' },
      version: 1
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await requestApi({
      path: '/api/v1/health',
      schema: responseSchema,
      init: { credentials: 'omit' }
    });

    expect(result).toEqual({
      ok: true,
      value: { data: { name: '我的大脑' }, version: 1 }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/health',
      expect.objectContaining({ credentials: 'same-origin' })
    );
  });

  it('maps a network failure to disconnected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const result = await requestApi({ path: '/api/v1/health', schema: responseSchema });

    expect(result).toMatchObject({ ok: false, state: { status: 'disconnected' } });
  });

  it('maps malformed JSON and schema drift to validation-error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{broken', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ data: { name: 42 }, version: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const malformed = await requestApi({ path: '/api/v1/health', schema: responseSchema });
    const drifted = await requestApi({ path: '/api/v1/health', schema: responseSchema });

    expect(malformed).toMatchObject({ ok: false, state: { status: 'validation-error' } });
    expect(drifted).toMatchObject({ ok: false, state: { status: 'validation-error' } });
  });

  it.each([
    ['VERSION_CONFLICT', 'conflict'],
    ['IDEMPOTENCY_CONFLICT', 'conflict'],
    ['INDEX_BUSY', 'busy'],
    ['UNKNOWN_CONFLICT', 'operation-error']
  ] as const)('maps stable error code %s to %s even on HTTP 409', async (code, status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code,
        message: '请求未完成',
        operationId: 'op-code-1'
      }
    }, 409)));
    const result = await requestApi({ path: '/api/v1/index-jobs/rebuild', schema: responseSchema });

    expect(result).toEqual({
      ok: false,
      state: { status, message: '请求未完成' },
      operationId: 'op-code-1'
    });
  });

  it('maps recovery mode and remaining API failures without exposing payload details', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: 'RECOVERY_REQUIRED',
          message: '需要恢复本地数据库',
          operationId: 'op-recovery-1'
        }
      }, 503))
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: 'REQUEST_REJECTED',
          message: '请求未完成',
          operationId: 'op-failed-1'
        }
      }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const recovery = await requestApi({ path: '/api/v1/health', schema: responseSchema });
    const failure = await requestApi({ path: '/api/v1/materials', schema: responseSchema });

    expect(recovery).toMatchObject({
      ok: false,
      state: { status: 'recovery-required' },
      operationId: 'op-recovery-1'
    });
    expect(failure).toMatchObject({
      ok: false,
      state: { status: 'operation-error' },
      operationId: 'op-failed-1'
    });
  });

  it('never logs request bodies or sensitive headers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: 'REQUEST_REJECTED',
        message: '请求未完成',
        operationId: 'op-private-1'
      }
    }, 400)));
    await requestApi({
      path: '/api/v1/index-jobs/rebuild',
      schema: responseSchema,
      init: {
        method: 'POST',
        headers: {
          authorization: 'Bearer must-not-log',
          'x-csrf-token': 'must-not-log'
        },
        body: JSON.stringify({ secret: 'must-not-log' })
      }
    });

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
