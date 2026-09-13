import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeepSeekProvider, DEEPSEEK_HOST, DEEPSEEK_MODEL } from '../../src/server/ai/deepseek-provider.js';

const messages = [{ role: 'system' as const, content: 'Return JSON.' }, { role: 'user' as const, content: '资料正文' }];
const key = 'sk-private-test-key';
function envelope(content: string | null, finishReason = 'stop') {
  return { id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'deepseek-v4-flash',
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
}
function response(content = '{"candidates":[]}') { return Response.json(envelope(content)); }
afterEach(() => { vi.useRealTimers(); });

describe('bounded DeepSeek extraction provider', () => {
  it('sends only the fixed nonthinking JSON completion contract and returns parsed content', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const provider = createDeepSeekProvider({ fetch: async (url, init) => {
      requests.push({ url: String(url), init: init! }); return response();
    } });
    await expect(provider.generate(messages, key, new AbortController().signal)).resolves.toEqual({ candidates: [] });
    expect(DEEPSEEK_HOST).toBe('api.deepseek.com');
    expect(DEEPSEEK_MODEL).toBe('deepseek-v4-pro');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`https://${DEEPSEEK_HOST}/chat/completions`);
    expect(requests[0]!.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Headers(requests[0]!.init.headers).get('authorization')).toBe(`Bearer ${key}`);
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      model: DEEPSEEK_MODEL, messages, stream: false, thinking: { type: 'disabled' },
      response_format: { type: 'json_object' }, max_tokens: 32768
    });
  });

  it.each([['', 'stop', 'INVALID_RESPONSE'], ['not json', 'stop', 'INVALID_JSON'], ['{}', 'length', 'OUTPUT_TRUNCATED'], ['{unfinished', 'length', 'OUTPUT_TRUNCATED'], [null, 'length', 'OUTPUT_TRUNCATED'], ['{}', 'tool_calls', 'INVALID_RESPONSE']])(
    'distinguishes content %j with finish %s as %s without retrying', async (content, finishReason, code) => {
      const fetch = vi.fn(async () => Response.json(envelope(content, finishReason)));
      const provider = createDeepSeekProvider({ fetch });
      await expect(provider.generate(messages, key, new AbortController().signal)).rejects.toMatchObject({ code });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it('distinguishes malformed transport JSON from invalid model JSON and never echoes payloads', async () => {
    const provider = createDeepSeekProvider({ fetch: async () => new Response(`{"raw":"${key}"`) });
    const error = await provider.generate(messages, key, new AbortController().signal).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(String(error)).not.toContain(key);
  });

  it('rejects missing or tool-bearing assistant completions', async () => {
    for (const body of [{}, { choices: [] }, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}', tool_calls: [{ type: 'function' }] } }] }]) {
      const provider = createDeepSeekProvider({ fetch: async () => Response.json(body) });
      await expect(provider.generate(messages, key, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });

  it.each([[401, 'AUTHENTICATION_FAILED'], [403, 'AUTHENTICATION_FAILED'], [402, 'INSUFFICIENT_BALANCE'], [429, 'RATE_LIMITED'], [500, 'PROVIDER_UNAVAILABLE'], [302, 'PROVIDER_UNAVAILABLE']])(
    'maps HTTP %s to a fixed error without reading raw provider errors or retrying', async (status, code) => {
      let calls = 0;
      const provider = createDeepSeekProvider({ fetch: async () => { calls += 1; return new Response(`RAW ${key}`, { status: Number(status) }); } });
      const error = await provider.generate(messages, key, new AbortController().signal).catch((value: unknown) => value);
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain(key);
      expect(String(error)).not.toContain('RAW');
      expect(calls).toBe(1);
    }
  );

  it('replaces network failures with a fixed message', async () => {
    const provider = createDeepSeekProvider({ fetch: async () => { throw new Error(`transport ${key}`); } });
    await expect(provider.generate(messages, key, new AbortController().signal)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: '暂时无法连接 DeepSeek，请稍后重新发起提炼。' });
  });

  it('rejects excessive UTF-8 request bytes before sending', async () => {
    let calls = 0;
    const provider = createDeepSeekProvider({ fetch: async () => { calls += 1; return response(); } });
    await expect(provider.generate([{ role: 'user', content: '中'.repeat(180_000) }], key, new AbortController().signal)).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' });
    expect(calls).toBe(0);
  });

  it('rejects invalid credentials without sending or echoing them', async () => {
    let calls = 0;
    const provider = createDeepSeekProvider({ fetch: async () => { calls += 1; return response(); } });
    for (const invalid of ['', `${key}\nInjected`, 'x'.repeat(513)]) {
      await expect(provider.generate(messages, invalid, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(calls).toBe(0);
  });

  it('stops oversized streamed response bytes even without Content-Length', async () => {
    let cancelled = false;
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { reads += 1; controller.enqueue(new Uint8Array(100_000)); }, cancel() { cancelled = true; } });
    const provider = createDeepSeekProvider({ fetch: async () => new Response(stream) });
    await expect(provider.generate(messages, key, new AbortController().signal)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThanOrEqual(7);
  });

  it('bounds advertised responses before consuming their body', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const provider = createDeepSeekProvider({ fetch: async () => new Response(stream, { headers: { 'Content-Length': '524289' } }) });
    await expect(provider.generate(messages, key, new AbortController().signal)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);
  });

  it('does not issue requests already cancelled by the caller', async () => {
    let calls = 0;
    const provider = createDeepSeekProvider({ fetch: async () => { calls += 1; return response(); } });
    const controller = new AbortController(); controller.abort(new Error(key));
    await expect(provider.generate(messages, key, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED', message: '已取消本次提炼。' });
    expect(calls).toBe(0);
  });

  it('propagates caller cancellation to transport without waiting for a response', async () => {
    let transportSignal: AbortSignal | undefined;
    const provider = createDeepSeekProvider({ fetch: async (_url, init) => {
      transportSignal = init!.signal!; return new Promise<Response>(() => {});
    } });
    const controller = new AbortController();
    const result = provider.generate(messages, key, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(transportSignal!.aborted).toBe(true);
  });

  it('times out at 120 seconds by default and aborts transport', async () => {
    vi.useFakeTimers();
    let transportSignal: AbortSignal | undefined;
    const provider = createDeepSeekProvider({ fetch: async (_url, init) => {
      transportSignal = init!.signal!; return new Promise<Response>(() => {});
    } });
    const result = expect(provider.generate(messages, key, new AbortController().signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(120_000);
    await result;
    expect(transportSignal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies timeout while response bytes stall and cancels the body', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const provider = createDeepSeekProvider({ timeoutMs: 20, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    const result = expect(provider.generate(messages, key, new AbortController().signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20);
    await result;
    expect(cancelled).toBe(true);
  });
});
