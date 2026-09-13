import { describe, expect, it, vi } from 'vitest';
import { createDeepSeekAssistantAdapter } from '../../src/server/assistant/deepseek-adapter.js';
import type { AssistantEvent, AssistantRunInput } from '../../src/server/assistant/types.js';

const key = 'test-only-assistant-key';
const credentials = { status: () => ({ available: true, configured: true, revision: '1' }), getKey: () => key, setKey: vi.fn(), clear: vi.fn() };
function completion(parts: Array<{ delta: Record<string, unknown>; finish_reason?: string; usage?: Record<string, unknown> }>) {
  const chunks = parts.map(({ delta, finish_reason, usage }) => `data: ${JSON.stringify({ id: 'test', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason: finish_reason ?? null }], ...(usage ? { usage } : {}) })}\n\n`);
  return new Response(chunks.join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
function request(overrides: Partial<AssistantRunInput> = {}): AssistantRunInput & { events: AssistantEvent[] } {
  const events: AssistantEvent[] = [];
  return { model: 'deepseek-v4-pro', system: 'Use only allowed tools.', messages: [{ role: 'user', content: '查找资料' }],
    signal: new AbortController().signal, emit: (event) => events.push(event), tools: [], ...overrides, events };
}

describe('DeepSeek assistant adapter', () => {
  it('offers Pro and max thinking by default while leaving Flash an explicit selection', async () => {
    const info = await createDeepSeekAssistantAdapter({ credentials, fetch: async () => Response.json({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] }) }).describe();
    expect(info).toMatchObject({ status: 'ready', defaultModel: 'deepseek-v4-pro', defaultEffort: 'max' });
    expect(info.models.map((model) => model.id)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash']);
  });

  it('uses the real SDK stream and tool loop with the selected model and retained reasoning', async () => {
    const bodies: Record<string, unknown>[] = [];
    const search = vi.fn(async () => ({ items: [{ title: '短视频开头', path: '02知识库/短视频.md' }] }));
    const fetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? completion([
        { delta: { role: 'assistant', reasoning_content: 'Find relevant evidence.' } },
        { delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'search_knowledge', arguments: '{"query":"短视频"}' } }] } },
        { delta: {}, finish_reason: 'tool_calls' }
      ]) : completion([{ delta: { content: '找到一篇相关知识。' } }, { delta: {}, finish_reason: 'stop' }]);
    }) as typeof globalThis.fetch;
    const input = request({ tools: [{ name: 'search_knowledge', description: 'Find knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, execute: search }] });
    await createDeepSeekAssistantAdapter({ credentials, fetch }).run(input);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ model: 'deepseek-v4-pro', thinking: { type: 'enabled' }, reasoning_effort: 'max', stream: true, max_tokens: 32768 });
    expect(search).toHaveBeenCalledWith({ query: '短视频' });
    expect(JSON.stringify(bodies[1]?.messages)).toContain('Find relevant evidence.');
    expect(input.events.filter((event) => event.type === 'text')).toEqual([{ type: 'text', text: '找到一篇相关知识。' }]);
    expect(input.events.some((event) => event.type === 'activity')).toBe(true);
    expect(input.events.filter((event) => event.type === 'step')).toEqual([
      { type: 'step', id: 'call-1', toolName: 'search_knowledge', label: '查找资料', status: 'running' },
      { type: 'step', id: 'call-1', toolName: 'search_knowledge', label: '查找资料', status: 'completed' }
    ]);
    expect(JSON.stringify(input.events)).not.toContain(key);
    expect(JSON.stringify(input.events)).not.toContain('Find relevant evidence.');
  });

  it('does not downgrade the selected Flash or custom compatible model id', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return completion([{ delta: { content: '完成。' }, finish_reason: 'stop' }]); }) as typeof globalThis.fetch;
    const adapter = createDeepSeekAssistantAdapter({ credentials, fetch });
    await adapter.run(request({ model: 'deepseek-v4-flash', effort: 'high' }));
    await adapter.run(request({ model: 'future-deepseek-pro' }));
    expect(bodies.map((body) => body.model)).toEqual(['deepseek-v4-flash', 'future-deepseek-pro']);
    expect(bodies[0]?.reasoning_effort).toBe('high');
    expect(bodies[1]?.reasoning_effort).toBeUndefined();
    expect(bodies[1]?.thinking).toBeUndefined();
  });

  it('discovers model ids with a 60 second metadata cache without inventing future reasoning capabilities', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v5-pro' }] }));
    const adapter = createDeepSeekAssistantAdapter({ credentials, fetch });
    const [first, concurrent] = await Promise.all([adapter.describe(), adapter.describe()]);
    expect(first.models.find((model) => model.id === 'deepseek-v5-pro')).toEqual({ id: 'deepseek-v5-pro', name: 'deepseek-v5-pro', reasoningEfforts: [] });
    expect(concurrent).toEqual(first);
    await adapter.describe(); expect(fetch).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    try { vi.setSystemTime(Date.now() + 60_001); await adapter.describe(); expect(fetch).toHaveBeenCalledTimes(2); }
    finally { vi.useRealTimers(); }
    expect(fetch.mock.calls[0]).toEqual(['https://api.deepseek.com/models', expect.objectContaining({ method: 'GET', redirect: 'error' })]);
  });

  it.each([401, 402, 403])('marks catalog HTTP %i as unavailable without leaking a provider message', async (status) => {
    const adapter = createDeepSeekAssistantAdapter({ credentials, fetch: async () => Response.json({ error: { message: key } }, { status }) });
    const description = await adapter.describe();
    expect(description.status).toBe('unavailable');
    expect(JSON.stringify(description)).not.toContain(key);
  });

  it('keeps Pro as the default when the current catalog only offers Flash', async () => {
    const adapter = createDeepSeekAssistantAdapter({ credentials, fetch: async () => Response.json({ data: [{ id: 'deepseek-v4-flash' }] }) });
    const description = await adapter.describe();
    expect(description).toMatchObject({ defaultModel: 'deepseek-v4-pro', problem: expect.stringContaining('不会自动切换') });
    expect(description.models.map((model) => model.id)).toEqual(['deepseek-v4-flash']);
  });

  it('reports a catalog outage with fallback entries and invalidates the cache when the key changes', async () => {
    let revision = '1';
    const fetch = vi.fn(async () => { throw new Error(key); });
    const adapter = createDeepSeekAssistantAdapter({ credentials: { ...credentials, status: () => ({ available: true, configured: true, revision }) }, fetch });
    expect(await adapter.describe()).toMatchObject({ status: 'ready', problem: expect.stringContaining('暂时未能刷新') });
    revision = '2'; await adapter.describe();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([401, 429, 404, 500])('sanitizes HTTP %i errors without retry or model fallback', async (status) => {
    const fetch = vi.fn(async () => Response.json({ error: { message: `secret ${key}`, type: 'error' } }, { status }));
    const input = request();
    const error = await createDeepSeekAssistantAdapter({ credentials, fetch }).run(input).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'ASSISTANT_PROVIDER_FAILED' });
    expect(String(error)).not.toContain(key);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(input.events.filter((event) => event.type === 'text')).toEqual([]);
  });

  it('aborts an outstanding stream and does not execute tools after cancellation', async () => {
    const controller = new AbortController();
    const search = vi.fn();
    const fetch = vi.fn(async (_url, init) => {
      await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      return completion([]);
    }) as typeof globalThis.fetch;
    const done = createDeepSeekAssistantAdapter({ credentials, fetch }).run(request({ signal: controller.signal,
      tools: [{ name: 'search_knowledge', description: 'search', inputSchema: { type: 'object' }, execute: search }] }));
    const rejected = expect(done).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(search).not.toHaveBeenCalled();
  });

  it('requires configured credentials and validates effort before making requests', async () => {
    const fetch = vi.fn();
    const adapter = createDeepSeekAssistantAdapter({ credentials: { ...credentials, status: () => ({ available: true, configured: false, revision: '1' }) }, fetch });
    await expect(adapter.run(request())).rejects.toMatchObject({ code: 'MODEL_KEY_REQUIRED' });
    await expect(adapter.run(request({ effort: 'ultra' }))).rejects.toMatchObject({ code: 'ASSISTANT_EFFORT_INVALID' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports each real SDK model step separately rather than labelling cumulative usage as context occupancy', async () => {
    let calls = 0;
    const fetch = vi.fn(async () => ++calls === 1 ? completion([
      { delta: { tool_calls: [{ index: 0, id: 'usage-call', type: 'function', function: { name: 'search_knowledge', arguments: '{}' } }] } },
      { delta: {}, finish_reason: 'tool_calls', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 40, completion_tokens_details: { reasoning_tokens: 5 } } }
    ]) : completion([{ delta: { content: '完成。' }, finish_reason: 'stop', usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 } }]));
    const input = request({ tools: [{ name: 'search_knowledge', description: 'Synthetic tool', inputSchema: { type: 'object' }, execute: async () => ({ text: 'synthetic tool result' }) }] });
    await createDeepSeekAssistantAdapter({ credentials, fetch }).run(input);
    expect(input.events.filter(event => event.type === 'usage').map(event => event.usage)).toMatchObject([
      { step: 1, status: 'reported', inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40, reasoningTokens: 5 },
      { step: 2, status: 'reported', inputTokens: 150, outputTokens: 30, totalTokens: 180 }
    ]);
    expect(input.events.filter(event => event.type === 'context-estimate')).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, { prompt_tokens: 100 }])('preserves unknown token fields when the provider reports %j', async usage => {
    const input = request();
    await createDeepSeekAssistantAdapter({ credentials, fetch: async () => completion([{ delta: { content: '完成。' }, finish_reason: 'stop', ...(usage ? { usage } : {}) }]) }).run(input);
    const event = input.events.find(event => event.type === 'usage');
    expect(event).toMatchObject({ usage: { status: usage ? 'partial' : 'unavailable' } });
    expect(event && event.type === 'usage' ? event.usage.outputTokens : 0).toBeUndefined();
    expect(event && event.type === 'usage' ? event.usage.totalTokens : 0).toBeUndefined();
  });

  it('checks tool output and reserved generation space before starting the next model request', async () => {
    const input = request({ capacity: { contextWindowTokens: 4000, sourceUrl: 'https://example.com/synthetic', verifiedAt: '2026-09-10' }, outputReserveTokens: 100,
      tools: [{ name: 'search_knowledge', description: 'Synthetic tool', inputSchema: { type: 'object' }, execute: async () => ({ text: 'x'.repeat(5000) }) }] });
    const fetch = vi.fn(async () => completion([{ delta: { tool_calls: [{ index: 0, id: 'budget-call', type: 'function', function: { name: 'search_knowledge', arguments: '{}' } }] }, finish_reason: 'tool_calls' }]));
    await expect(createDeepSeekAssistantAdapter({ credentials, fetch }).run(input)).rejects.toMatchObject({ code: 'ASSISTANT_CONTEXT_LIMIT' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(input.events.filter(event => event.type === 'context-estimate').at(-1)).toMatchObject({ estimate: { status: 'over-budget' } });
  });
});
