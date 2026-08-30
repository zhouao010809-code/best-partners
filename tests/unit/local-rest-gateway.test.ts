import { describe, expect, it } from 'vitest';
import { LocalRest51Gateway, type FetchImplementation } from '../../src/server/vault/LocalRest51Gateway.js';
import { AppError, ErrorCode } from '../../src/shared/api/errors.js';

type PublicCall = Readonly<{
  url: string;
  method: string;
  accept: string | null;
}>;

type ResponseFactory = (call: PublicCall) => Response | Promise<Response>;

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

function declaredLengthResponse(
  contentLength: number,
  bytes: Uint8Array,
  onArrayBuffer: () => void
): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(contentLength) }),
    arrayBuffer: async () => {
      onArrayBuffer();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  } as Response;
}

describe('LocalRest51Gateway', () => {
  it('preserves raw bytes and returns a coherent hash and version without exposing authorization', async () => {
    const note = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
    let documentMapCancelled = false;
    const fakeFetch = createFakeFetch([
      () => rawResponse(note),
      () => new Response(new ReadableStream({
        cancel: () => {
          documentMapCancelled = true;
        }
      }), { headers: { etag: '"version-1"' } }),
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
    expect(result.upstreamVersion).toBe('"version-1"');
    expect(fakeFetch.lastAuthorization()).toBe('[redacted]');
    expect(fakeFetch.calls).toHaveLength(3);
    expect(documentMapCancelled).toBe(true);
  });

  it('encodes each file path segment exactly once and preserves separators', async () => {
    const note = new TextEncoder().encode('note');
    const fakeFetch = createFakeFetch([
      () => rawResponse(note),
      () => new Response('{}', { headers: { etag: '"version-path"' } }),
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
  });

  it('fingerprints the exact plugin identity and Obsidian version from GET /', async () => {
    const fakeFetch = createFakeFetch([
      () => Response.json({
        status: 'OK',
        manifest: {
          id: 'obsidian-local-rest-api',
          version: '5.1.0'
        },
        versions: {
          obsidian: '1.8.10',
          self: '5.1.0'
        }
      })
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

  it('lists an encoded directory with a trailing slash and returns an immutable string list', async () => {
    const fakeFetch = createFakeFetch([
      () => Response.json(['a.md', '子 目录/', '#index.md'])
    ]);
    const gateway = new LocalRest51Gateway(
      'https://127.0.0.1:27124',
      'test-api-key',
      fakeFetch.fetchImplementation
    );

    const result = await gateway.listDirectory('01图书馆/中文 目录/');

    expect(result).toEqual(['a.md', '子 目录/', '#index.md']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(fakeFetch.calls).toEqual([{
      url: 'https://127.0.0.1:27124/vault/01%E5%9B%BE%E4%B9%A6%E9%A6%86/%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95/',
      method: 'GET',
      accept: 'application/json'
    }]);
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
      () => new Response('{}', { headers: { etag: '"version-1"' } }),
      () => rawResponse(bytes('attempt-1-b')),
      () => rawResponse(bytes('attempt-2-a')),
      () => new Response('{}', { headers: { etag: '"version-2"' } }),
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
    expect(fakeFetch.calls).toHaveLength(6);
    expect(fakeFetch.calls.map((call) => call.accept)).toEqual([
      'text/markdown',
      'application/vnd.olrapi.document-map+json',
      'text/markdown',
      'text/markdown',
      'application/vnd.olrapi.document-map+json',
      'text/markdown'
    ]);
  });

  it('returns only second-attempt bytes, hash, and ETag after the first triple changes', async () => {
    const stableNote = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
    const fakeFetch = createFakeFetch([
      () => rawResponse(new Uint8Array([1])),
      () => new Response('{}', { headers: { etag: '"stale-version"' } }),
      () => rawResponse(new Uint8Array([2])),
      () => rawResponse(stableNote),
      () => new Response('{}', { headers: { etag: '"stable-version"' } }),
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
    expect(result.upstreamVersion).toBe('"stable-version"');
    expect(fakeFetch.calls).toHaveLength(6);
  });

  it('rejects a declared raw body over 10 MiB before reading or converting the body', async () => {
    let arrayBufferCalled = false;
    const fakeFetch = createFakeFetch([
      () => declaredLengthResponse(10 * 1024 * 1024 + 1, new Uint8Array([1]), () => {
        arrayBufferCalled = true;
      })
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

    expect(arrayBufferCalled).toBe(false);
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VAULT_RESPONSE_TOO_LARGE');
    expect(fakeFetch.calls).toHaveLength(1);
  });

  it('allows raw bytes at exactly the 10 MiB limit', async () => {
    const maximumBody = new Uint8Array(10 * 1024 * 1024);
    maximumBody[maximumBody.byteLength - 1] = 1;
    const fakeFetch = createFakeFetch([
      () => rawResponse(maximumBody),
      () => new Response('{}', { headers: { etag: '"version-maximum"' } }),
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
    expect(fakeFetch.calls).toHaveLength(3);
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
    expect(fakeFetch.calls).toHaveLength(1);
  });

  it('maps non-2xx responses to a stable redacted AppError with the received operation id', async () => {
    const responseMarker = 'unique-upstream-response-body-marker';
    const secretMarker = 'test-api-key';
    let operationIdFactoryCalled = false;
    const fakeFetch = createFakeFetch([
      () => new Response(`${responseMarker}:${secretMarker}`, {
        status: 503,
        headers: { 'x-operation-id': 'upstream-operation-9' }
      })
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
    expect(String(thrown)).not.toContain(responseMarker);
    expect(String(thrown)).not.toContain(secretMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(responseMarker);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(secretMarker);
    expect(JSON.stringify(fakeFetch.calls)).not.toContain(secretMarker);
    expect(fakeFetch.lastAuthorization()).toBe('[redacted]');
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
