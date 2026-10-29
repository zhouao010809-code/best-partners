import { describe, expect, it, vi } from 'vitest';
import { createDeepSeekAssistantAdapter } from '../../src/server/assistant/deepseek-adapter.js';
import { createWorkdiskContentNamer } from '../../src/server/workdisk/content-namer.js';

const credentials = { status: () => ({ available: true, configured: true, revision: 'synthetic-naming-test' }), getKey: () => 'synthetic-key-never-sent', setKey: vi.fn(), clear: vi.fn() };
const article = '短视频选题需要围绕受众的问题，结合具体案例说明解决办法，并记录观众咨询来判断内容是否有效。';
const privateDiagnostic = 'synthetic-private-reasoning-must-not-be-returned';
function completion(delta: Record<string, string>, reason: 'stop' | 'length') {
  return new Response(`data: ${JSON.stringify({ id: 'test', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ id: 'test', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`,
  { headers: { 'content-type': 'text/event-stream' } });
}

describe('content naming through the real DeepSeek SDK transport', () => {
  it.each(['txt', 'png'])('reserves its 512 tokens for a %s title instead of reasoning, with no tools or source filename', async extension => {
    const requests: Record<string, unknown>[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'deepseek-v4-pro' }] });
      const body = JSON.parse(String(init?.body)); requests.push(body);
      // Reproduce the previous contract: thinking consumed the whole small output budget.
      return body.thinking?.type === 'disabled'
        ? completion({ content: '{"title":"短视频选题与咨询效果评估"}' }, 'stop')
        : completion({ reasoning_content: privateDiagnostic }, 'length');
    };
    const namer = createWorkdiskContentNamer({ adapter: createDeepSeekAssistantAdapter({ credentials, fetch }),
      imageEvidenceReader: async () => ({ status: 'ready', text: article, labels: [], sampled: false }) });
    const result = await namer({ name: `/synthetic-private-path/93615270.${extension}`, bytes: Buffer.from(extension === 'txt' ? article : 'synthetic image bytes never sent') });
    expect(result.title).toBe('短视频选题与咨询效果评估');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 512, model: 'deepseek-v4-pro' });
    expect(requests[0]!.reasoning_effort).toBeUndefined(); expect(requests[0]!.tools ?? []).toEqual([]);
    expect(JSON.stringify(requests)).not.toMatch(/93615270|synthetic-private-path|image bytes never sent/u);
    expect(JSON.stringify(result)).not.toContain(privateDiagnostic); expect(JSON.stringify(result)).not.toContain(article);
  });
  it('reports provider truncation even when the partial response looks like a valid title', async () => {
    const adapter = createDeepSeekAssistantAdapter({ credentials, fetch: async (url) => String(url).endsWith('/models')
      ? Response.json({ data: [{ id: 'deepseek-v4-pro' }] })
      : completion({ content: '{"title":"不应采用的截断结果"}' }, 'length') });
    const result = await createWorkdiskContentNamer({ adapter })({ name: '123.txt', bytes: Buffer.from(article) });
    expect(result.title).toBeUndefined(); expect(result.reason).toMatch(/长度上限/u); expect(result.reason).toContain('保留原名');
  });
  it('keeps transport failures distinct from truncation without including the provider response', async () => {
    const adapter = createDeepSeekAssistantAdapter({ credentials, fetch: async (url) => String(url).endsWith('/models')
      ? Response.json({ data: [{ id: 'deepseek-v4-pro' }] })
      : Response.json({ error: { message: privateDiagnostic } }, { status: 503 }) });
    const result = await createWorkdiskContentNamer({ adapter })({ name: '123.txt', bytes: Buffer.from(article) });
    expect(result.title).toBeUndefined(); expect(result.reason).toContain('响应未完成'); expect(result.reason).not.toContain(privateDiagnostic);
  });
});
