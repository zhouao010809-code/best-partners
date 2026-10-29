import { describe, expect, it, vi } from 'vitest';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';
import { createWorkdiskContentNamer } from '../../src/server/workdisk/content-namer.js';
import { PublicApiError } from '../../src/shared/api/errors.js';
import { createPasswordPdf, createTextPdf } from '../helpers/pdf-fixture.js';

const parserWorkerPath = new URL('../../src/server/attachments/pdf-worker.mjs', import.meta.url);
const article = '短视频获客需要先确定目标受众，围绕用户的实际问题规划选题，再通过案例和明确的咨询入口形成转化。不能只关注播放量，还要记录有效咨询数量。';
function adapter(run: AssistantAdapter['run']): AssistantAdapter {
  return { id: 'deepseek', describe: async () => ({ id: 'deepseek', name: 'Test', status: 'ready', defaultModel: 'test', models: [{ id: 'test', name: 'Test', reasoningEfforts: [] }] }), run };
}
function emitting(output: string) { return adapter(async input => { input.emit({ type: 'text', text: output }); }); }

describe('content-based workdisk naming', () => {
  it('names a gibberish file from actual text, sends neither original name nor filesystem tools', async () => {
    let received: AssistantRunInput | undefined;
    const namer = createWorkdiskContentNamer({ adapter: adapter(async input => {
      received = input; input.emit({ type: 'text', text: '{"title":"短视频获客的选题与转化方法"}' });
    }) });
    const result = await namer({ name: 'a83bc9f7283.txt', bytes: Buffer.from(article) });
    expect(result).toMatchObject({ title: '短视频获客的选题与转化方法', reason: expect.stringContaining('正文') });
    expect(received!.tools).toEqual([]);
    expect(received!.messages[0]!.content).toContain(article);
    expect(JSON.stringify(received!.messages)).not.toContain('a83bc9f7283');
    expect(JSON.stringify(result)).not.toContain(article);
  });
  it('parses actual PDF text before generating a title', async () => {
    let received: AssistantRunInput | undefined;
    const namer = createWorkdiskContentNamer({ parserWorkerPath, adapter: adapter(async input => {
      received = input; input.emit({ type: 'text', text: '{"title":"短视频受众与咨询转化"}' });
    }) });
    const text = 'Video audience research';
    expect(await namer({ name: '093523.pdf', bytes: createTextPdf([text]) })).toMatchObject({ title: '短视频受众与咨询转化' });
    expect(received!.messages[0]!.content).toContain(text);
    expect(received!.messages[0]!.content).not.toContain('%PDF');
  });
  it('keeps scanned, encrypted and broken PDFs with specific explanations and no model request', async () => {
    const run = vi.fn(); const namer = createWorkdiskContentNamer({ parserWorkerPath, adapter: adapter(run) });
    const scanned = await namer({ name: 'scan.pdf', bytes: createTextPdf(['']) });
    const encrypted = await namer({ name: 'locked.pdf', bytes: createPasswordPdf() });
    const broken = await namer({ name: 'broken.pdf', bytes: Buffer.from('not a PDF') });
    expect(scanned.title).toBeUndefined(); expect(scanned.reason).toMatch(/文字层|扫描/u);
    expect(encrypted.title).toBeUndefined(); expect(encrypted.reason).toMatch(/密码|加密/u);
    expect(broken.title).toBeUndefined(); expect(broken.reason).toMatch(/解析|读取/u);
    expect(run).not.toHaveBeenCalled();
  });
  it('does not infer titles from unsupported media, empty, binary or insufficient text', async () => {
    const run = vi.fn(); const namer = createWorkdiskContentNamer({ adapter: adapter(run) });
    for (const [name, bytes] of [ ['招生访谈.mp4', Buffer.from(article)], ['file.docx', Buffer.from(article)], ['0001.txt', Buffer.from('')], ['0002.txt', Buffer.from('只有标题')], ['0003.txt', Buffer.from([0xff, 0xfe, 0, 2])], ['0004.txt', Buffer.from('abc\0'.repeat(50))], ['0005.txt', Buffer.from('a'.repeat(500))] ] as const) {
      const result = await namer({ name, bytes }); expect(result.title).toBeUndefined(); expect(result.reason).toMatch(/不支持读取正文|不是可读取|正文不足/u);
    }
    expect(run).not.toHaveBeenCalled();
  });
  it('keeps original names on missing credentials, invalid JSON, vague output or provider failures', async () => {
    const source = { name: '123.txt', bytes: Buffer.from(article) };
    expect((await createWorkdiskContentNamer()(source)).reason).toMatch(/AI.*连接|配置/u);
    for (const output of ['not JSON', '{"title":"资料"}', '{"title":"文档总结"}', '{"title":"12345678"}', '{"title":"ab9f23de487678ab"}', '{"title":"../../etc/passwd"}', '{"title":"正常主题","directory":"/tmp"}', 'x'.repeat(9000)]) {
      const result = await createWorkdiskContentNamer({ adapter: emitting(output) })(source);
      expect(result.title, output).toBeUndefined(); expect(result.reason).toContain('原名');
    }
    const failed = adapter(async () => { throw new Error('private-key-diagnostics'); });
    const failure = await createWorkdiskContentNamer({ adapter: failed })(source);
    expect(failure.title).toBeUndefined(); expect(failure.reason).not.toContain('private-key');
  });
  it('preserves no model extension or forbidden filename characters and bounds filename bytes', async () => {
    const input = { name: '123.pdf', bytes: createTextPdf(['Useful guidance about meaningful topics and principles.']) };
    const sanitized = await createWorkdiskContentNamer({ parserWorkerPath, adapter: emitting('{"title":"短视频：选题/获客方法.pdf"}') })(input);
    expect(sanitized.title).toBe('短视频-选题-获客方法');
    const long = await createWorkdiskContentNamer({ adapter: emitting(JSON.stringify({ title: '短视频选题与获客方法'.repeat(12) })) })({ name: '123.txt', bytes: Buffer.from(article) });
    expect(Array.from(long.title!).length).toBeLessThanOrEqual(60);
    expect(Buffer.byteLength(long.title!)).toBeLessThanOrEqual(180);
  });
  it('samples head, middle and end of long text and explicitly labels the partial evidence', async () => {
    const text = 'HEAD_MARK\n' + article.repeat(300) + '\nMIDDLE_MARK\n' + article.repeat(300) + '\nTAIL_MARK';
    let received: AssistantRunInput | undefined;
    const namer = createWorkdiskContentNamer({ adapter: adapter(async input => { received = input; input.emit({ type: 'text', text: '{"title":"短视频选题与咨询转化"}' }); }) });
    const result = await namer({ name: 'source.md', bytes: Buffer.from(text) });
    const data = JSON.parse(received!.messages[0]!.content);
    expect(data.text.length).toBeLessThanOrEqual(24000);
    expect(data.text).toContain('HEAD_MARK'); expect(data.text).toContain('MIDDLE_MARK'); expect(data.text).toContain('TAIL_MARK');
    expect(data.sampled).toBe(true); expect(result.reason).toContain('节选');
  });
  it('rejects oversized input without touching the model', async () => {
    const run = vi.fn(); const result = await createWorkdiskContentNamer({ adapter: adapter(run) })({ name: 'large.txt', bytes: Buffer.alloc(20 * 1024 * 1024 + 1) });
    expect(result.title).toBeUndefined(); expect(result.reason).toMatch(/20.*MiB|过大/u); expect(run).not.toHaveBeenCalled();
  });
  it('bounds provider hangs and supports caller cancellation', async () => {
    const run = vi.fn(async () => new Promise<void>(() => {}));
    const source = { name: '123.txt', bytes: Buffer.from(article) };
    const timed = await createWorkdiskContentNamer({ adapter: adapter(run), timeoutMs: 5 })(source);
    expect(timed.title).toBeUndefined(); expect(timed.reason).toContain('原名');
    const controller = new AbortController(); const pending = createWorkdiskContentNamer({ adapter: adapter(run) })(source, controller.signal);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2)); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it.each([
    ['ASSISTANT_OUTPUT_LIMIT', '长度上限'], ['ASSISTANT_TIMEOUT', '超时'],
    ['ASSISTANT_CONTEXT_LIMIT', '处理范围'], ['ASSISTANT_PROVIDER_FAILED', '响应未完成']
  ])('explains %s without exposing provider messages or partial output', async (code, description) => {
    const failed = adapter(async input => {
      input.emit({ type: 'text', text: '{"title":"不能采用的部分结果"}' });
      throw new PublicApiError(code!, 'private-response-and-secret-key');
    });
    const result = await createWorkdiskContentNamer({ adapter: failed })({ name: '123.txt', bytes: Buffer.from(article) });
    expect(result.title).toBeUndefined(); expect(result.reason).toContain(description); expect(result.reason).toContain('保留原名');
    expect(JSON.stringify(result)).not.toMatch(/private-response|secret-key|部分结果/u);
  });
});
