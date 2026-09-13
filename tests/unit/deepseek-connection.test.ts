import { afterEach, expect, it, vi } from 'vitest';
import { createDeepSeekConnectionVerifier } from '../../src/server/ai/deepseek-connection.js';

const key = 'sk-fixture-only-secret';
const completion = (content = 'OK', finish_reason = 'stop') => Response.json({
  choices: [{ finish_reason, message: { role: 'assistant', content } }]
});
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

it('verifies with only a fixed bounded test message and never returns model content', async () => {
  const fetch = vi.fn(async () => completion(key));
  const verifier = createDeepSeekConnectionVerifier({ fetch });
  await expect(verifier.verify(key, signal())).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledExactlyOnceWith('https://api.deepseek.com/chat/completions', expect.objectContaining({
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
  }));
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'Reply with OK only.' }], thinking: { type: 'disabled' }, stream: false, max_tokens: 16 });
});

it.each([[401, 'AUTHENTICATION_FAILED', '更新密钥'], [402, 'INSUFFICIENT_BALANCE', '余额'],
  [429, 'RATE_LIMITED', '稍后'], [503, 'PROVIDER_UNAVAILABLE', '稍后'], [400, 'INVALID_REQUEST', '更新应用'], [302, 'PROVIDER_UNAVAILABLE', '稍后']])(
  'distinguishes HTTP %s and never leaks the provider error or retries', async (status, code, recovery) => {
    const fetch = vi.fn(async () => new Response(`raw error ${key}`, { status: Number(status) }));
    const error = await createDeepSeekConnectionVerifier({ fetch }).verify(key, signal()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code });
    expect(String(error)).toContain(recovery);
    expect(String(error)).not.toContain(key);
    expect(String(error)).not.toContain('raw error');
    expect(fetch).toHaveBeenCalledTimes(1);
  }
);

it('distinguishes network failure from authentication and does not leak transport diagnostics', async () => {
  const fetch = vi.fn(async () => { throw new Error(key); });
  await expect(createDeepSeekConnectionVerifier({ fetch }).verify(key, signal())).rejects.toMatchObject({
    code: 'NETWORK_ERROR', message: '无法连接 DeepSeek，请检查网络连接或代理设置后重试。'
  });
});

it.each([completion('', 'stop'), completion('OK', 'length'), Response.json({ choices: [] })])('rejects incomplete or malformed success responses', async (response) => {
  await expect(createDeepSeekConnectionVerifier({ fetch: async () => response }).verify(key, signal()))
    .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

it('bounds body bytes even when no Content-Length is advertised', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(10_000)); }, cancel });
  await expect(createDeepSeekConnectionVerifier({ fetch: async () => new Response(stream) }).verify(key, signal()))
    .rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('rejects an advertised oversized response before reading it', async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '16385' } });
  await expect(createDeepSeekConnectionVerifier({ fetch: async () => response }).verify(key, signal()))
    .rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('enforces timeout even when the transport ignores abort', async () => {
  vi.useFakeTimers();
  let transportSignal: AbortSignal | undefined;
  const verifier = createDeepSeekConnectionVerifier({ timeoutMs: 20, fetch: async (_url, init) => {
    transportSignal = init?.signal as AbortSignal; return new Promise<Response>(() => {});
  } });
  const pending = expect(verifier.verify(key, signal())).rejects.toMatchObject({ code: 'TIMEOUT' });
  await vi.advanceTimersByTimeAsync(21); await pending;
  expect(transportSignal?.aborted).toBe(true);
});

it('cancels a pending body and avoids requests for an already cancelled or invalid key', async () => {
  const fetch = vi.fn(async () => completion());
  const verifier = createDeepSeekConnectionVerifier({ fetch });
  const controller = new AbortController(); controller.abort();
  await expect(verifier.verify(key, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(verifier.verify('bad\nkey', signal())).rejects.toMatchObject({ code: 'INVALID_KEY' });
  expect(fetch).not.toHaveBeenCalled();
  const cancel = vi.fn();
  const waiting = createDeepSeekConnectionVerifier({ fetch: async () => new Response(new ReadableStream({ cancel })) });
  const current = new AbortController();
  const pending = expect(waiting.verify(key, current.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  await Promise.resolve(); current.abort(); await pending;
  expect(cancel).toHaveBeenCalledTimes(1);
});
