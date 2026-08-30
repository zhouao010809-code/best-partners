import { describe, expect, it } from 'vitest';
import { LocalRest51Gateway, type FetchImplementation } from '../../src/server/vault/LocalRest51Gateway.js';
import { AppError, ErrorCode } from '../../src/shared/api/errors.js';

type PublicCall = Readonly<{
  url: string;
  method: string;
  accept: string | null;
}>;

type ResponseFactory = (call: PublicCall) => Response | Promise<Response>;

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const fingerprintPayload = {
  status: 'OK',
  manifest: {
    id: 'obsidian-local-rest-api',
    version: '5.1.0'
  },
  versions: {
    obsidian: '1.8.10',
    self: '5.1.0'
  }
};

function createFakeFetch(responseFactories: ReadonlyArray<ResponseFactory>) {
  const calls: PublicCall[] = [];
  let sawAuthorization = false;

  const fetchImplementation: FetchImplementation = async (input, init) => {
    const request = new Request(input, init);
    if (request.headers.get('authorization') !== 'Bearer test-api-key') {
      throw new Error('missing expected test authorization');
    }
    sawAuthorization = true;

    const call = Object.freeze({
      url: request.url,
      method: request.method,
      accept: request.headers.get('accept')
    });
    calls.push(call);

    const factory = responseFactories[calls.length - 1];
    if (factory === undefined) {
      throw new Error(`unexpected request ${calls.length}`);
    }
    return factory(call);
  };

  return {
    fetchImplementation,
    calls,
    lastAuthorization: () => sawAuthorization ? '[redacted]' : undefined
  };
}

function rawResponse(bytes: Uint8Array): Response {
  return new Response(bytes, {
    headers: { 'content-length': String(bytes.byteLength) }
  });
}

function documentMapPayload(version: string) {
  return {
    blocks: [],
    frontmatterFields: [],
    headings: [],
    version
  };
}

function documentMapBytes(version: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(documentMapPayload(version)));
}

function documentMapResponse(version: string, headers: HeadersInit = {}): Response {
  return new Response(documentMapBytes(version), { headers });
}

function trackedStreamResponse(
  bytes: Uint8Array,
  headers: HeadersInit = {},
  cancelFailureMarker?: string,
  status = 200
) {
  let sent = false;
  let pullCount = 0;
  let cancelCount = 0;
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      pullCount += 1;
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(bytes);
    },
    cancel: () => {
      cancelCount += 1;
      if (cancelFailureMarker !== undefined) {
        throw new Error(cancelFailureMarker);
      }
    }
  }, { highWaterMark: 0 });
  return {
    response: new Response(body, { headers, status }),
    pullCount: () => pullCount,
    cancelCount: () => cancelCount
  };
}

function pendingCancelResponse(
  bytes: Uint8Array,
  headers: HeadersInit = {},
  status = 200
) {
  let sent = false;
  let pullCount = 0;
  let cancelCount = 0;
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      pullCount += 1;
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(bytes);
    },
    cancel: () => {
      cancelCount += 1;
      return new Promise<void>(() => {});
    }
  }, { highWaterMark: 0 });
  return {
    response: new Response(body, { headers, status }),
    pullCount: () => pullCount,
    cancelCount: () => cancelCount
  };
}

type TimedSettlement<T> =
  | { kind: 'fulfilled'; value: T }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'timeout' };

function settleWithin<T>(promise: Promise<T>, timeoutMs = 150): Promise<TimedSettlement<T>> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve({ kind: 'fulfilled', value });
      },
      (error: unknown) => {
        clearTimeout(timeout);
        resolve({ kind: 'rejected', error });
      }
    );
  });
}

function paddedAsciiBody(prefix: string, byteLength: number): Uint8Array {
  const prefixBytes = new TextEncoder().encode(prefix);
  const bytes = new Uint8Array(byteLength);
  bytes.fill(0x20);
  bytes.set(prefixBytes);
  return bytes;
}

function expectGetRequests(calls: ReadonlyArray<PublicCall>, count: number): void {
  expect(calls).toHaveLength(count);
  expect(calls.map((call) => call.method)).toEqual(Array.from({ length: count }, () => 'GET'));
}

describe('LocalRest51Gateway', () => {
  it('preserves raw bytes and returns a coherent hash and version without exposing authorization', async () => {
    const note = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
    const documentMap = trackedStreamResponse(
      documentMapBytes('v2-token'),
      { etag: '"unrelated-etag-value-1234567890"' }
    );
    const fakeFetch = createFakeFetch([
      () => rawResponse(note),
      () => documentMap.response,
      () => rawResponse(note)
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation,
      () => 'operation-1'
    );

    const result = await gateway.readRaw('01图书馆/a.md');

    expect(result.bytes).toEqual(note);
    expect(result.rawSha256).toBe('ea3948106c12d96eaf84d4bb8be214b194c3442acb99a3005251960b0ec2ba63');
    expect(result.upstreamVersion).toBe('v2-token');
    expect(result.upstreamVersion).not.toBe('"unrelated-etag-value-1234567890"');
    expect(fakeFetch.lastAuthorization()).toBe('[redacted]');
    expectGetRequests(fakeFetch.calls, 3);
    expect(documentMap.pullCount()).toBe(2);
    expect(documentMap.cancelCount()).toBe(0);
  });

  it('encodes each file path segment exactly once and preserves separators', async () => {
    const note = new TextEncoder().encode('note');
    const fakeFetch = createFakeFetch([
      () => rawResponse(note),
      () => documentMapResponse('path-v1'),
      () => rawResponse(note)
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    await gateway.readRaw('01图书馆/中文 空格#100%.md');

    const expectedUrl = 'https://127.0.0.1:27124/vault/01%E5%9B%BE%E4%B9%A6%E9%A6%86/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC%23100%25.md';
    expect(fakeFetch.calls.map((call) => call.url)).toEqual([
      expectedUrl,
      expectedUrl,
      expectedUrl
    ]);
    expect(fakeFetch.calls.map((call) => call.accept)).toEqual([
      'text/markdown',
      'application/vnd.olrapi.document-map+json',
      'text/markdown'
    ]);
    expectGetRequests(fakeFetch.calls, 3);
  });

  it.each([
    '',
    '../openapi.yaml',
    './a.md',
    '01图书馆/./a.md',
    '01图书馆/../a.md',
    '/01图书馆/a.md',
    '01图书馆//a.md',
    '01图书馆/a.md/',
    '01图书馆\\a.md',
    '01图书馆/\0a.md',
    '01图书馆/.obsidian/a.md',
    '01图书馆/.hidden.md'
  ])('rejects unsafe vault path %j before dispatch', async (path) => {
    const fakeFetch = createFakeFetch([]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.readRaw(path);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe(ErrorCode.PathNotAllowed);
    expect(fakeFetch.calls).toHaveLength(0);
  });

  it('fingerprints the exact plugin identity and Obsidian version from GET /', async () => {
    const fakeFetch = createFakeFetch([
      () => Response.json(fingerprintPayload)
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    await expect(gateway.fingerprint()).resolves.toEqual({
      pluginId: 'obsidian-local-rest-api',
      pluginVersion: '5.1.0',
      obsidianVersion: '1.8.10'
    });
    expect(fakeFetch.calls).toEqual([{
      url: 'https://127.0.0.1:27124/',
      method: 'GET',
      accept: 'application/json'
    }]);
  });

  it.each([
    ['null payload', () => null],
    ['numeric payload', () => 42],
    ['empty plugin id', (marker: string) => ({
      ...fingerprintPayload,
      manifest: { ...fingerprintPayload.manifest, id: '' },
      diagnostic: marker
    })],
    ['numeric plugin id', (marker: string) => ({
      ...fingerprintPayload,
      manifest: { ...fingerprintPayload.manifest, id: 51 },
      diagnostic: marker
    })],
    ['null plugin version', (marker: string) => ({
      ...fingerprintPayload,
      manifest: { ...fingerprintPayload.manifest, version: null },
      diagnostic: marker
    })],
    ['empty Obsidian version', (marker: string) => ({
      ...fingerprintPayload,
      versions: { ...fingerprintPayload.versions, obsidian: '' },
      diagnostic: marker
    })]
  ])('rejects fingerprint with %s using a body-redacted shape error', async (name, createPayload) => {
    const bodyMarker = `unique-fingerprint-shape-marker:${name}:test-api-key`;
    const fakeFetch = createFakeFetch([
      () => Response.json(createPayload(bodyMarker), {
        headers: { 'x-operation-id': 'fingerprint-shape-7' }
      })
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.fingerprint();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_INVALID_SHAPE');
    expect((thrown as AppError).statusCode).toBe(502);
    expect((thrown as AppError & { operationId?: string }).operationId).toBe('fingerprint-shape-7');
    expect(String(thrown)).not.toContain(bodyMarker);
    expect(String(thrown)).not.toContain('test-api-key');
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(bodyMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain('test-api-key');
    expectGetRequests(fakeFetch.calls, 1);
  });

  it('lists an encoded directory with a trailing slash and returns an immutable string list', async () => {
    const fakeFetch = createFakeFetch([
      () => Response.json({ files: ['a.md', '子目录/'] }),
      () => Response.json({ files: ['a.md', '子目录/'] })
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    const withoutTrailingSlash = await gateway.listDirectory('01图书馆/中文 目录');
    const withTrailingSlash = await gateway.listDirectory('01图书馆/中文 目录/');

    expect(withoutTrailingSlash).toEqual(['a.md', '子目录/']);
    expect(withTrailingSlash).toEqual(['a.md', '子目录/']);
    expect(Object.isFrozen(withoutTrailingSlash)).toBe(true);
    expect(Object.isFrozen(withTrailingSlash)).toBe(true);
    const expectedCall = {
      url: 'https://127.0.0.1:27124/vault/01%E5%9B%BE%E4%B9%A6%E9%A6%86/%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95/',
      method: 'GET',
      accept: 'application/json'
    };
    expect(fakeFetch.calls).toEqual([expectedCall, expectedCall]);
  });

  it.each([
    ['bare array', (marker: string) => ['a.md', marker]],
    ['missing files', (marker: string) => ({ diagnostic: marker })],
    ['non-array files', (marker: string) => ({ files: marker })],
    ['non-string files entry', (marker: string) => ({ files: ['a.md', 42, marker] })]
  ])('rejects directory object with %s using a body-redacted shape error', async (name, createPayload) => {
    const bodyMarker = `unique-list-shape-marker:${name}:test-api-key`;
    const fakeFetch = createFakeFetch([
      () => Response.json(createPayload(bodyMarker), {
        headers: { 'x-operation-id': 'list-shape-3' }
      })
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.listDirectory('01图书馆/子目录');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_INVALID_SHAPE');
    expect((thrown as AppError).statusCode).toBe(502);
    expect((thrown as AppError & { operationId?: string }).operationId).toBe('list-shape-3');
    expect(String(thrown)).not.toContain(bodyMarker);
    expect(String(thrown)).not.toContain('test-api-key');
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(bodyMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain('test-api-key');
    expectGetRequests(fakeFetch.calls, 1);
  });

  it('reads the OpenAPI YAML document from GET /openapi.yaml', async () => {
    const openApi = 'openapi: 3.0.3\ninfo:\n  version: 5.1.0\n';
    const fakeFetch = createFakeFetch([
      () => new Response(openApi)
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    await expect(gateway.readOpenApi()).resolves.toBe(openApi);
    expect(fakeFetch.calls).toEqual([{
      url: 'https://127.0.0.1:27124/openapi.yaml',
      method: 'GET',
      accept: 'application/yaml'
    }]);
  });

  it('retries the complete raw-map-raw triple once and rejects continued mutation', async () => {
    const bytes = (value: string) => new TextEncoder().encode(value);
    const fakeFetch = createFakeFetch([
      () => rawResponse(bytes('attempt-1-a')),
      () => documentMapResponse('version-1'),
      () => rawResponse(bytes('attempt-1-b')),
      () => rawResponse(bytes('attempt-2-a')),
      () => documentMapResponse('version-2'),
      () => rawResponse(bytes('attempt-2-b'))
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.readRaw('01图书馆/changing.md');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe(ErrorCode.VersionConflict);
    expectGetRequests(fakeFetch.calls, 6);
    expect(fakeFetch.calls.map((call) => call.accept)).toEqual([
      'text/markdown',
      'application/vnd.olrapi.document-map+json',
      'text/markdown',
      'text/markdown',
      'application/vnd.olrapi.document-map+json',
      'text/markdown'
    ]);
  });

  it('returns only second-attempt bytes, hash, and document-map version after the first triple changes', async () => {
    const stableNote = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
    const fakeFetch = createFakeFetch([
      () => rawResponse(new Uint8Array([1])),
      () => documentMapResponse('stale-version', { etag: '"unrelated-stale-etag"' }),
      () => rawResponse(new Uint8Array([2])),
      () => rawResponse(stableNote),
      () => documentMapResponse('stable-version', { etag: '"unrelated-stable-etag"' }),
      () => rawResponse(stableNote)
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    const result = await gateway.readRaw('01图书馆/eventually-stable.md');

    expect(result.bytes).toEqual(stableNote);
    expect(result.rawSha256).toBe('ea3948106c12d96eaf84d4bb8be214b194c3442acb99a3005251960b0ec2ba63');
    expect(result.upstreamVersion).toBe('stable-version');
    expectGetRequests(fakeFetch.calls, 6);
  });

  it('rejects and releases a declared raw body over 10 MiB before reading it', async () => {
    const tracked = trackedStreamResponse(
      new Uint8Array([1]),
      { 'content-length': String(MAX_RESPONSE_BYTES + 1) }
    );
    const fakeFetch = createFakeFetch([
      () => tracked.response
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.readRaw('01图书馆/too-large.md');
    } catch (error) {
      thrown = error;
    }

    expect(tracked.pullCount()).toBe(0);
    expect(tracked.cancelCount()).toBe(1);
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_TOO_LARGE');
    expectGetRequests(fakeFetch.calls, 1);
  });

  it('allows raw bytes at exactly the 10 MiB limit', async () => {
    const maximumBody = new Uint8Array(10 * 1024 * 1024);
    maximumBody[maximumBody.byteLength - 1] = 1;
    const fakeFetch = createFakeFetch([
      () => rawResponse(maximumBody),
      () => documentMapResponse('version-maximum'),
      () => rawResponse(maximumBody)
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    const result = await gateway.readRaw('01图书馆/maximum.md');

    expect(result.bytes.byteLength).toBe(10 * 1024 * 1024);
    expect(result.bytes[result.bytes.byteLength - 1]).toBe(1);
    expectGetRequests(fakeFetch.calls, 3);
  });

  it('rejects an actual raw body over 10 MiB when Content-Length is absent', async () => {
    const oversizedBody = new Uint8Array(10 * 1024 * 1024 + 1);
    const fakeFetch = createFakeFetch([
      () => new Response(oversizedBody)
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.readRaw('01图书馆/actual-too-large.md');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_TOO_LARGE');
    expectGetRequests(fakeFetch.calls, 1);
  });

  it.each([
    {
      name: 'fingerprint',
      createResponse: () => trackedStreamResponse(
        new TextEncoder().encode(JSON.stringify(fingerprintPayload)),
        { 'content-length': String(MAX_RESPONSE_BYTES + 1) }
      ),
      invoke: (gateway: LocalRest51Gateway) => gateway.fingerprint()
    },
    {
      name: 'directory listing',
      createResponse: () => trackedStreamResponse(
        new TextEncoder().encode(JSON.stringify({ files: ['a.md'] })),
        { 'content-length': String(MAX_RESPONSE_BYTES + 1) }
      ),
      invoke: (gateway: LocalRest51Gateway) => gateway.listDirectory('01图书馆/子目录')
    },
    {
      name: 'OpenAPI document',
      createResponse: () => trackedStreamResponse(
        new TextEncoder().encode('openapi: 3.0.3\n'),
        { 'content-length': String(MAX_RESPONSE_BYTES + 1) }
      ),
      invoke: (gateway: LocalRest51Gateway) => gateway.readOpenApi()
    }
  ])('rejects a declared oversized $name response before buffering', async ({ createResponse, invoke }) => {
    const tracked = createResponse();
    const fakeFetch = createFakeFetch([() => tracked.response]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await invoke(gateway);
    } catch (error) {
      thrown = error;
    }

    expect(tracked.pullCount()).toBe(0);
    expect(tracked.cancelCount()).toBe(1);
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_TOO_LARGE');
    expectGetRequests(fakeFetch.calls, 1);
  });

  it.each([
    {
      name: 'fingerprint JSON with an underreported length',
      createResponse: () => new Response(
        paddedAsciiBody(JSON.stringify(fingerprintPayload), MAX_RESPONSE_BYTES + 1),
        { headers: { 'content-length': '64' } }
      ),
      invoke: (gateway: LocalRest51Gateway) => gateway.fingerprint()
    },
    {
      name: 'directory JSON without a declared length',
      createResponse: () => new Response(
        paddedAsciiBody(JSON.stringify({ files: ['a.md'] }), MAX_RESPONSE_BYTES + 1)
      ),
      invoke: (gateway: LocalRest51Gateway) => gateway.listDirectory('01图书馆/子目录')
    },
    {
      name: 'OpenAPI text with an underreported length',
      createResponse: () => new Response(
        paddedAsciiBody('openapi: 3.0.3\n', MAX_RESPONSE_BYTES + 1),
        { headers: { 'content-length': '64' } }
      ),
      invoke: (gateway: LocalRest51Gateway) => gateway.readOpenApi()
    }
  ])('rejects an actual oversized $name response after one bounded byte read', async ({ createResponse, invoke }) => {
    const fakeFetch = createFakeFetch([() => createResponse()]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await invoke(gateway);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_TOO_LARGE');
    expectGetRequests(fakeFetch.calls, 1);
  });

  it.each(['not-a-number', '-1', '10, 11'])('falls back to capped streaming for malformed Content-Length %j', async (contentLength) => {
    const tracked = trackedStreamResponse(
      paddedAsciiBody('openapi: 3.0.3\n', MAX_RESPONSE_BYTES + 1),
      { 'content-length': contentLength }
    );
    const fakeFetch = createFakeFetch([() => tracked.response]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.readOpenApi();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_TOO_LARGE');
    expect(tracked.pullCount()).toBe(1);
    expect(tracked.cancelCount()).toBe(1);
    expectGetRequests(fakeFetch.calls, 1);
  });

  it('stops and cancels a chunked response immediately when the 10 MiB cap is crossed', async () => {
    const chunks = [
      new Uint8Array(6 * 1024 * 1024),
      new Uint8Array(4 * 1024 * 1024 + 1),
      new TextEncoder().encode('unique-never-read-chunk-marker')
    ];
    let pullCount = 0;
    let cancelCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        const chunk = chunks[pullCount];
        pullCount += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel: () => {
        cancelCount += 1;
      }
    }, { highWaterMark: 0 });
    const fakeFetch = createFakeFetch([() => new Response(body)]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.readOpenApi();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_TOO_LARGE');
    expect(String(thrown)).not.toContain('unique-never-read-chunk-marker');
    expect(pullCount).toBe(2);
    expect(cancelCount).toBe(1);
    expectGetRequests(fakeFetch.calls, 1);
  });

  it('does not wait for a permanently pending reader cancellation after the stream cap is crossed', async () => {
    const chunks = [
      new Uint8Array(6 * 1024 * 1024),
      new Uint8Array(4 * 1024 * 1024 + 1),
      new TextEncoder().encode('unique-never-read-after-pending-cancel')
    ];
    let pullCount = 0;
    let cancelCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        const chunk = chunks[pullCount];
        pullCount += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel: () => {
        cancelCount += 1;
        return new Promise<void>(() => {});
      }
    }, { highWaterMark: 0 });
    const fakeFetch = createFakeFetch([() => new Response(body)]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    const settlement = await settleWithin(gateway.readOpenApi());

    if (settlement.kind !== 'rejected') {
      expect(settlement.kind).toBe('rejected');
      throw new Error('expected a prompt cap rejection');
    }
    expect(settlement.error).toBeInstanceOf(AppError);
    expect((settlement.error as AppError).code).toBe('VAULT_RESPONSE_TOO_LARGE');
    expect(pullCount).toBe(2);
    expect(cancelCount).toBe(1);
    expectGetRequests(fakeFetch.calls, 1);
  });

  it('maps stream reader failures to a body-redacted safe 502 error without retaining the cause', async () => {
    const failureMarker = 'unique-stream-reader-failure-marker:test-api-key';
    const body = new ReadableStream<Uint8Array>({
      pull: () => {
        throw new Error(failureMarker);
      }
    }, { highWaterMark: 0 });
    const fakeFetch = createFakeFetch([
      () => new Response(body, { headers: { 'x-operation-id': 'stream-read-5' } })
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.readOpenApi();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_READ_FAILED');
    expect((thrown as AppError).statusCode).toBe(502);
    expect((thrown as AppError & { operationId?: string }).operationId).toBe('stream-read-5');
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(thrown)).not.toContain(failureMarker);
    expect((thrown as Error).stack).not.toContain(failureMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(failureMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain('test-api-key');
    expectGetRequests(fakeFetch.calls, 1);
  });

  it('redacts an externally sourced AppError thrown by the response reader', async () => {
    const failureMarker = 'unique-app-error-reader-marker:test-api-key';
    const body = new ReadableStream<Uint8Array>({
      pull: () => {
        throw new AppError('UPSTREAM_STREAM_ERROR', failureMarker, 500);
      }
    }, { highWaterMark: 0 });
    const fakeFetch = createFakeFetch([
      () => new Response(body, { headers: { 'x-operation-id': 'stream-app-error-6' } })
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.readOpenApi();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_READ_FAILED');
    expect((thrown as AppError).statusCode).toBe(502);
    expect((thrown as AppError & { operationId?: string }).operationId).toBe('stream-app-error-6');
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(thrown)).not.toContain(failureMarker);
    expect((thrown as Error).stack).not.toContain(failureMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(failureMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain('test-api-key');
    expectGetRequests(fakeFetch.calls, 1);
  });

  it('accepts OpenAPI text at exactly the 10 MiB bounded-reader limit', async () => {
    const maximumBody = paddedAsciiBody('openapi: 3.0.3\n', MAX_RESPONSE_BYTES);
    const tracked = trackedStreamResponse(
      maximumBody,
      { 'content-length': String(MAX_RESPONSE_BYTES) }
    );
    const fakeFetch = createFakeFetch([
      () => tracked.response
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    const result = await gateway.readOpenApi();

    expect(result).toHaveLength(MAX_RESPONSE_BYTES);
    expect(result.startsWith('openapi: 3.0.3\n')).toBe(true);
    expect(tracked.pullCount()).toBe(2);
    expect(tracked.cancelCount()).toBe(0);
    expectGetRequests(fakeFetch.calls, 1);
  });

  it('rejects an oversized document map by declared length and still releases its body', async () => {
    const note = new TextEncoder().encode('note');
    const documentMap = trackedStreamResponse(
      documentMapBytes('must-not-be-accepted'),
      { 'content-length': String(MAX_RESPONSE_BYTES + 1) }
    );
    const fakeFetch = createFakeFetch([
      () => rawResponse(note),
      () => documentMap.response,
      () => rawResponse(note)
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.readRaw('01图书馆/oversized-map.md');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_TOO_LARGE');
    expect(documentMap.pullCount()).toBe(0);
    expect(documentMap.cancelCount()).toBe(1);
    expectGetRequests(fakeFetch.calls, 2);
  });

  it('fully consumes a valid document map at exactly 10 MiB without cancelling it', async () => {
    const note = new TextEncoder().encode('stable note');
    const documentMap = trackedStreamResponse(
      paddedAsciiBody(JSON.stringify(documentMapPayload('map-at-limit')), MAX_RESPONSE_BYTES),
      {
        'content-length': String(MAX_RESPONSE_BYTES),
        etag: '"unrelated-map-at-limit-etag"'
      }
    );
    const fakeFetch = createFakeFetch([
      () => rawResponse(note),
      () => documentMap.response,
      () => rawResponse(note)
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    const result = await gateway.readRaw('01图书馆/map-at-limit.md');

    expect(result.bytes).toEqual(note);
    expect(result.upstreamVersion).toBe('map-at-limit');
    expect(documentMap.pullCount()).toBe(2);
    expect(documentMap.cancelCount()).toBe(0);
    expectGetRequests(fakeFetch.calls, 3);
  });

  it('stops and cancels an actual oversized document map without requesting raw B', async () => {
    const note = new TextEncoder().encode('stable note');
    const chunks = [
      new Uint8Array(6 * 1024 * 1024),
      new Uint8Array(4 * 1024 * 1024 + 1),
      new TextEncoder().encode('unique-document-map-never-read-marker')
    ];
    let pullCount = 0;
    let cancelCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        const chunk = chunks[pullCount];
        pullCount += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel: () => {
        cancelCount += 1;
      }
    }, { highWaterMark: 0 });
    const fakeFetch = createFakeFetch([
      () => rawResponse(note),
      () => new Response(body),
      () => rawResponse(note)
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.readRaw('01图书馆/actual-oversized-map.md');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_TOO_LARGE');
    expect(String(thrown)).not.toContain('unique-document-map-never-read-marker');
    expect(pullCount).toBe(2);
    expect(cancelCount).toBe(1);
    expectGetRequests(fakeFetch.calls, 2);
  });

  it.each([
    {
      name: 'missing version',
      expectedCode: 'VAULT_RESPONSE_INVALID_SHAPE',
      createBody: (marker: string) => JSON.stringify({
        blocks: [],
        frontmatterFields: [],
        headings: [],
        diagnostic: marker
      })
    },
    {
      name: 'empty version',
      expectedCode: 'VAULT_RESPONSE_INVALID_SHAPE',
      createBody: (marker: string) => JSON.stringify({
        ...documentMapPayload(''),
        diagnostic: marker
      })
    },
    {
      name: 'non-string version',
      expectedCode: 'VAULT_RESPONSE_INVALID_SHAPE',
      createBody: (marker: string) => JSON.stringify({
        ...documentMapPayload('placeholder'),
        version: 51,
        diagnostic: marker
      })
    },
    {
      name: 'invalid JSON',
      expectedCode: 'VAULT_RESPONSE_INVALID_JSON',
      createBody: (marker: string) => `${marker}:not-json:test-api-key`
    }
  ])('rejects a document map with $name using a redacted safe 502 error', async ({ name, expectedCode, createBody }) => {
    const note = new TextEncoder().encode('stable note');
    const bodyMarker = `unique-document-map-${name}-marker:test-api-key`;
    const fakeFetch = createFakeFetch([
      () => rawResponse(note),
      () => new Response(createBody(bodyMarker), {
        headers: { 'x-operation-id': 'document-map-shape-13' }
      }),
      () => rawResponse(note)
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.readRaw('01图书馆/invalid-map.md');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe(expectedCode);
    expect((thrown as AppError).statusCode).toBe(502);
    expect((thrown as AppError & { operationId?: string }).operationId).toBe('document-map-shape-13');
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(thrown)).not.toContain(bodyMarker);
    expect((thrown as Error).stack).not.toContain(bodyMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(bodyMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain('test-api-key');
    expectGetRequests(fakeFetch.calls, 2);
  });

  it('preserves the document-map size error when best-effort body cancellation rejects', async () => {
    const note = new TextEncoder().encode('note');
    let cancellationAttempted = false;
    const fakeFetch = createFakeFetch([
      () => rawResponse(note),
      () => new Response(new ReadableStream({
        cancel: () => {
          cancellationAttempted = true;
          throw new Error('unique-cancel-failed-marker');
        }
      }), {
        headers: {
          'content-length': String(MAX_RESPONSE_BYTES + 1),
          etag: '"must-not-be-accepted"'
        }
      })
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.readRaw('01图书馆/cancel-failure.md');
    } catch (error) {
      thrown = error;
    }

    expect(cancellationAttempted).toBe(true);
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_TOO_LARGE');
    expect(String(thrown)).not.toContain('unique-cancel-failed-marker');
    expectGetRequests(fakeFetch.calls, 2);
  });

  it('redacts invalid JSON bodies and retains only a safe operation id', async () => {
    const bodyMarker = 'unique-invalid-json-body-marker';
    const secretMarker = 'test-api-key';
    const fakeFetch = createFakeFetch([
      () => new Response(`${bodyMarker}:${secretMarker}`, {
        headers: { 'x-operation-id': 'json-operation-8' }
      })
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      secretMarker,
      fakeFetch.fetchImplementation
    );

    let thrown: unknown;
    try {
      await gateway.fingerprint();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_INVALID_JSON');
    expect((thrown as AppError).statusCode).toBe(502);
    expect((thrown as AppError & { operationId?: string }).operationId).toBe('json-operation-8');
    expect(String(thrown)).not.toContain(bodyMarker);
    expect(String(thrown)).not.toContain(secretMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(bodyMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(secretMarker);
    expectGetRequests(fakeFetch.calls, 1);
  });

  it('maps non-2xx responses to a stable redacted AppError with the received operation id', async () => {
    const responseMarker = 'unique-upstream-response-body-marker';
    const secretMarker = 'test-api-key';
    let operationIdFactoryCalled = false;
    const tracked = trackedStreamResponse(
      new TextEncoder().encode(`${responseMarker}:${secretMarker}`),
      { 'x-operation-id': 'upstream-operation-9' },
      'unique-non-2xx-cancel-failed-marker',
      503
    );
    const fakeFetch = createFakeFetch([
      () => tracked.response
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      secretMarker,
      fakeFetch.fetchImplementation,
      () => {
        operationIdFactoryCalled = true;
        return 'generated-operation';
      }
    );

    let thrown: unknown;
    try {
      await gateway.readOpenApi();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_UPSTREAM_ERROR');
    expect((thrown as AppError).statusCode).toBe(503);
    expect((thrown as AppError).message).toBe(
      'Vault request failed (status 503, operationId upstream-operation-9)'
    );
    expect((thrown as AppError & { operationId?: string }).operationId).toBe('upstream-operation-9');
    expect(operationIdFactoryCalled).toBe(false);
    expect(tracked.pullCount()).toBe(0);
    expect(tracked.cancelCount()).toBe(1);
    expect(String(thrown)).not.toContain(responseMarker);
    expect(String(thrown)).not.toContain(secretMarker);
    expect(String(thrown)).not.toContain('unique-non-2xx-cancel-failed-marker');
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(responseMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(secretMarker);
    expect(JSON.stringify(fakeFetch.calls)).not.toContain(secretMarker);
    expect(fakeFetch.lastAuthorization()).toBe('[redacted]');
  });

  it('returns a non-2xx error promptly when response cancellation never settles', async () => {
    const tracked = pendingCancelResponse(
      new TextEncoder().encode('unique-unread-non-2xx-body-marker'),
      { 'x-operation-id': 'pending-non-2xx-10' },
      503
    );
    const fakeFetch = createFakeFetch([() => tracked.response]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    const settlement = await settleWithin(gateway.readOpenApi());

    if (settlement.kind !== 'rejected') {
      expect(settlement.kind).toBe('rejected');
      throw new Error('expected a prompt non-2xx rejection');
    }
    expect(settlement.error).toBeInstanceOf(AppError);
    expect((settlement.error as AppError).code).toBe('VAULT_UPSTREAM_ERROR');
    expect((settlement.error as AppError).statusCode).toBe(503);
    expect(tracked.pullCount()).toBe(0);
    expect(tracked.cancelCount()).toBe(1);
    expectGetRequests(fakeFetch.calls, 1);
  });

  it('returns a declared-size error promptly when response cancellation never settles', async () => {
    const tracked = pendingCancelResponse(
      new Uint8Array([1]),
      { 'content-length': String(MAX_RESPONSE_BYTES + 1) }
    );
    const fakeFetch = createFakeFetch([() => tracked.response]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    const settlement = await settleWithin(gateway.readOpenApi());

    if (settlement.kind !== 'rejected') {
      expect(settlement.kind).toBe('rejected');
      throw new Error('expected a prompt declared-size rejection');
    }
    expect(settlement.error).toBeInstanceOf(AppError);
    expect((settlement.error as AppError).code).toBe('VAULT_RESPONSE_TOO_LARGE');
    expect(tracked.pullCount()).toBe(0);
    expect(tracked.cancelCount()).toBe(1);
    expectGetRequests(fakeFetch.calls, 1);
  });

  it('maps rejected fetch transport failures to a redacted safe 502 error', async () => {
    const failureMarker = 'unique-fetch-rejection-marker:test-api-key';
    let requestCount = 0;
    const fetchImplementation: FetchImplementation = async () => {
      requestCount += 1;
      throw new Error(failureMarker);
    };
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fetchImplementation,
      () => 'transport-operation-11'
    );

    let thrown: unknown;
    try {
      await gateway.readOpenApi();
    } catch (error) {
      thrown = error;
    }

    expect(requestCount).toBe(1);
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_TRANSPORT_ERROR');
    expect((thrown as AppError).statusCode).toBe(502);
    expect((thrown as AppError & { operationId?: string }).operationId).toBe('transport-operation-11');
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(thrown)).not.toContain(failureMarker);
    expect((thrown as Error).stack).not.toContain(failureMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(failureMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain('test-api-key');
  });

  it('maps synchronous fetch transport throws to a redacted safe 502 error', async () => {
    const failureMarker = 'unique-synchronous-fetch-marker:test-api-key';
    let requestCount = 0;
    const fetchImplementation: FetchImplementation = () => {
      requestCount += 1;
      throw new Error(failureMarker);
    };
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fetchImplementation,
      () => 'synchronous-transport-12'
    );

    let thrown: unknown;
    try {
      await gateway.readOpenApi();
    } catch (error) {
      thrown = error;
    }

    expect(requestCount).toBe(1);
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_TRANSPORT_ERROR');
    expect((thrown as AppError).statusCode).toBe(502);
    expect((thrown as AppError & { operationId?: string }).operationId).toBe('synchronous-transport-12');
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(thrown)).not.toContain(failureMarker);
    expect((thrown as Error).stack).not.toContain(failureMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(failureMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain('test-api-key');
  });

  it.each([
    {
      name: 'a malformed base URL',
      baseUrl: 'not a URL unique-malformed-base-marker',
      apiKey: 'test-api-key',
      marker: 'unique-malformed-base-marker'
    },
    {
      name: 'an insecure HTTP base URL',
      baseUrl: 'http://unique-insecure-base-marker.example:27124',
      apiKey: 'test-api-key',
      marker: 'unique-insecure-base-marker'
    },
    {
      name: 'a credential-bearing base URL',
      baseUrl: 'https://unique-credential-marker:secret@127.0.0.1:27124',
      apiKey: 'test-api-key',
      marker: 'unique-credential-marker'
    },
    {
      name: 'control characters in the API key',
      baseUrl: 'https://127.0.0.1:27124',
      apiKey: 'test-api-key\nunique-key-control-marker\0',
      marker: 'unique-key-control-marker'
    },
    {
      name: 'an empty API key',
      baseUrl: 'https://127.0.0.1:27124',
      apiKey: '',
      marker: undefined
    },
    {
      name: 'a whitespace-only API key',
      baseUrl: 'https://127.0.0.1:27124',
      apiKey: '   ',
      marker: undefined
    },
    {
      name: 'a non-ByteString API key',
      baseUrl: 'https://127.0.0.1:27124',
      apiKey: '密钥-unique-unicode-key-marker',
      marker: 'unique-unicode-key-marker'
    }
  ])('rejects $name with a fixed redacted configuration error before fetch', ({ baseUrl, apiKey, marker }) => {
    let requestCount = 0;
    const fetchImplementation: FetchImplementation = async () => {
      requestCount += 1;
      return new Response('must not be requested');
    };

    let thrown: unknown;
    try {
      new LocalRest51Gateway(baseUrl, apiKey, fetchImplementation);
    } catch (error) {
      thrown = error;
    }

    expect(requestCount).toBe(0);
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_GATEWAY_CONFIG_INVALID');
    expect((thrown as AppError).statusCode).toBe(500);
    const operationId = (thrown as AppError & { operationId?: string }).operationId;
    expect(operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    if (marker !== undefined) {
      expect(String(thrown)).not.toContain(marker);
      expect((thrown as Error).stack).not.toContain(marker);
      expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(marker);
    }
    if (apiKey.trim().length > 0) {
      expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(apiKey);
    }
  });

  it('falls back to an internal operation id when the injected factory throws and still releases a non-2xx body', async () => {
    const failureMarker = 'unique-operation-id-factory-marker:test-api-key';
    const tracked = trackedStreamResponse(new Uint8Array([1]), {}, undefined, 500);
    const fakeFetch = createFakeFetch([() => tracked.response]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation,
      () => {
        throw new Error(failureMarker);
      }
    );

    let thrown: unknown;
    try {
      await gateway.readOpenApi();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_UPSTREAM_ERROR');
    expect((thrown as AppError).statusCode).toBe(500);
    const operationId = (thrown as AppError & { operationId?: string }).operationId;
    expect(operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(tracked.pullCount()).toBe(0);
    expect(tracked.cancelCount()).toBe(1);
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(thrown)).not.toContain(failureMarker);
    expect((thrown as Error).stack).not.toContain(failureMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(failureMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain('test-api-key');
    expectGetRequests(fakeFetch.calls, 1);
  });

  it('generates an operation id for a non-2xx response that does not provide one', async () => {
    const fakeFetch = createFakeFetch([
      () => new Response('not public', { status: 404 })
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation,
      () => 'generated-operation-4'
    );

    let thrown: unknown;
    try {
      await gateway.readOpenApi();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).message).toBe(
      'Vault request failed (status 404, operationId generated-operation-4)'
    );
    expect((thrown as AppError & { operationId?: string }).operationId).toBe('generated-operation-4');
  });

  it('replaces an unsafe injected operation id with an internally generated safe id', async () => {
    const unsafeGeneratedId = 'generated-test-api-key with spaces';
    const fakeFetch = createFakeFetch([
      () => new Response('not public', { status: 404 })
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation,
      () => unsafeGeneratedId
    );

    let thrown: unknown;
    try {
      await gateway.readOpenApi();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    const operationId = (thrown as AppError & { operationId?: string }).operationId;
    expect(operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(operationId).not.toBe(unsafeGeneratedId);
    expect(String(thrown)).not.toContain('test-api-key');
    expect(String(thrown)).not.toContain('with spaces');
  });

  it('replaces an unsafe received operation id instead of exposing the API key', async () => {
    const secretMarker = 'test-api-key';
    const fakeFetch = createFakeFetch([
      () => new Response('not public', {
        status: 500,
        headers: { 'x-operation-id': `upstream-${secretMarker}` }
      })
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      secretMarker,
      fakeFetch.fetchImplementation,
      () => 'generated-safe-operation'
    );

    let thrown: unknown;
    try {
      await gateway.readOpenApi();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError & { operationId?: string }).operationId).toBe('generated-safe-operation');
    expect(String(thrown)).not.toContain(secretMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(secretMarker);
  });
});
