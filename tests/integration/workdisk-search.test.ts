import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import type { AssistantAdapter, AssistantRunInput } from '../../src/server/assistant/types.js';
import { createWorkdiskSearchPlanner, localWorkdiskSearchPlan } from '../../src/server/workdisk/search-assistant.js';

const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
const today = '2026-10-29';
function adapter(run: AssistantAdapter['run']): AssistantAdapter {
  return { id: 'deepseek', describe: async () => ({ id: 'deepseek', name: 'Test', status: 'ready', defaultModel: 'test', models: [{ id: 'test', name: 'Test', reasoningEfforts: [] }] }), run };
}
async function headers(app: ReturnType<typeof buildServer>) {
  const response = await app.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:4317' } });
  return { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': response.json().data.csrfToken };
}
describe('local query understanding', () => {
  it('extracts subject, relative date and type without requiring exact filenames', () => {
    expect(localWorkdiskSearchPlan({ query: '帮我找一下上个月28号的招生视频', today })).toEqual({ terms: ['招生'], startDate: '2026-09-28', endDate: '2026-09-28', kind: 'video' });
    expect(localWorkdiskSearchPlan({ query: '上个月二十八号发布文案', today })).toEqual({ terms: [], startDate: '2026-09-28', endDate: '2026-09-28', kind: 'document' });
  });
  it('accepts spoken date particles and whitespace without keeping polite filler as OR keywords', () => {
    for (const query of ['上个月的28号我写的招生文案', '请 找上个月 28 号的招生文案', '上月二十八日的招生文案', '9 月 28 号的招生文案']) {
      expect(localWorkdiskSearchPlan({ query, today })).toEqual({ terms: ['招生'], startDate: '2026-09-28', endDate: '2026-09-28', kind: 'document' });
    }
  });
  it('uses the supplied local date across year, month and leap-day boundaries', () => {
    expect(localWorkdiskSearchPlan({ query: '昨天的图片', today: '2027-01-01' })).toMatchObject({ terms: [], startDate: '2026-12-31', endDate: '2026-12-31', kind: 'image' });
    expect(localWorkdiskSearchPlan({ query: '上个月录音', today: '2024-03-01' })).toMatchObject({ startDate: '2024-02-01', endDate: '2024-02-29', kind: 'audio' });
    expect(localWorkdiskSearchPlan({ query: '2025年12月28日的采访', today })).toMatchObject({ startDate: '2025-12-28', endDate: '2025-12-28', terms: ['采访'] });
  });
  it('does not turn invalid or absent dates into invented filters', () => {
    expect(localWorkdiskSearchPlan({ query: '以前的招生方案', today })).not.toHaveProperty('startDate');
    expect(localWorkdiskSearchPlan({ query: '上个月31号的视频', today })).not.toHaveProperty('startDate');
  });
  it('preserves subject characters and avoids arbitrarily narrowing multiple types', () => {
    expect(localWorkdiskSearchPlan({ query: '关于关键词的文案', today }).terms).toEqual(['关键词']);
    expect(localWorkdiskSearchPlan({ query: '招生视频 图片 录音', today })).not.toHaveProperty('kind');
  });
  it('keeps media topics searchable across file types instead of interpreting part of a topic as a type', () => {
    expect(localWorkdiskSearchPlan({ query: '短视频', today })).toEqual({ terms: ['短视频'] });
    expect(localWorkdiskSearchPlan({ query: '短视频方法的图片', today })).toEqual({ terms: ['短视频方法'], kind: 'image' });
    expect(localWorkdiskSearchPlan({ query: '视频剪辑教程的PDF', today })).toEqual({ terms: ['视频剪辑教程'], kind: 'document' });
    expect(localWorkdiskSearchPlan({ query: '图片压缩方法', today })).toEqual({ terms: ['图片压缩方法'] });
    expect(localWorkdiskSearchPlan({ query: '招生视频和图片', today })).toEqual({ terms: ['招生'] });
  });
});
describe('bounded AI planning', () => {
  it('does not let an AI inferred type hide a topic in images or PDFs, and retains the original topic terms', async () => {
    const planner = createWorkdiskSearchPlanner({ adapter: adapter(async input => input.emit({ type: 'text', text: JSON.stringify({ terms: ['创作方法'], kind: 'video' }) })) });
    expect(await planner({ query: '短视频', today })).toMatchObject({ mode: 'ai', plan: { terms: ['短视频', '创作方法'] } });
    expect((await planner({ query: '短视频', today })).plan).not.toHaveProperty('kind');
    expect((await planner({ query: '短视频方法的图片', today })).plan).toEqual({ terms: ['短视频方法', '创作方法'], kind: 'image' });
    expect((await planner({ query: '招生视频和图片', today })).plan).not.toHaveProperty('kind');
  });
  it('sends only the query and local date, with no filesystem tools or candidate content', async () => {
    let received: AssistantRunInput | undefined;
    const planner = createWorkdiskSearchPlanner({ adapter: adapter(async input => { received = input; input.emit({ type: 'text', text: JSON.stringify({ terms: ['招生', '招新'], startDate: '2026-09-28', endDate: '2026-09-28', kind: 'video' }) }); }) });
    const result = await planner({ query: '上个月28号招生视频', today });
    expect(result.mode).toBe('ai'); expect(result.plan.terms).toEqual(['招生', '招新']);
    expect(received?.tools).toEqual([]);
    expect(JSON.parse(received!.messages[0]!.content)).toEqual({ query: '上个月28号招生视频', today });
    expect(received?.outputReserveTokens).toBeLessThanOrEqual(1024);
  });
  it('falls back honestly when unconfigured, failed, or malformed', async () => {
    expect(await createWorkdiskSearchPlanner()({ query: '今天的文案', today })).toMatchObject({ mode: 'local', plan: { terms: [], kind: 'document', startDate: today, endDate: today } });
    for (const output of ['not json', '{"terms":["招生"],"startDate":"2026-02-30"}', '{"terms":[],"rootPath":"/private"}', 'x'.repeat(9000)]) {
      const result = await createWorkdiskSearchPlanner({ adapter: adapter(async input => input.emit({ type: 'text', text: output })) })({ query: '招生视频', today });
      expect(result).toMatchObject({ mode: 'local', plan: { terms: ['招生'], kind: 'video' } });
      expect(result.message).toBeTruthy();
    }
    const failed = adapter(async () => { throw new Error('secret-provider-diagnostic'); });
    expect(JSON.stringify(await createWorkdiskSearchPlanner({ adapter: failed })({ query: '招生视频', today }))).not.toContain('secret-provider');
  });
  it('stops on caller cancellation and times out even if a provider ignores abort', async () => {
    const run = vi.fn(async () => new Promise<void>(() => {}));
    const controller = new AbortController();
    const pending = createWorkdiskSearchPlanner({ adapter: adapter(run) })({ query: '招生', today }, controller.signal);
    await vi.waitFor(() => expect(run).toHaveBeenCalled()); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect((await createWorkdiskSearchPlanner({ adapter: adapter(run), timeoutMs: 5 })({ query: '招生', today })).mode).toBe('local');
  });
});
describe('workdisk query API', () => {
  it('uses the existing session and CSRF boundary, validates local date, and remains useful without AI', async () => {
    const app = buildServer(); servers.push(app);
    const payload = { query: '上个月28号的招生视频', today };
    const response = await app.inject({ method: 'POST', url: '/api/v1/workdisk/search-plan', payload, headers: await headers(app) });
    expect(response.statusCode).toBe(200); expect(response.json().data).toMatchObject({ mode: 'local', plan: { terms: ['招生'], kind: 'video', startDate: '2026-09-28' } });
    expect((await app.inject({ method: 'POST', url: '/api/v1/workdisk/search-plan', payload, headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/workdisk/search-plan', payload: { ...payload, today: '2026-02-30' }, headers: await headers(app) })).statusCode).toBe(400);
  });
  it('does not register the personal route in company mode', async () => {
    const app = buildServer({ runtimeMode: 'company' }); servers.push(app);
    await app.ready(); expect(app.hasRoute({ method: 'POST', url: '/api/v1/workdisk/search-plan' })).toBe(false);
  });
  it('aborts an active model request when the server closes', async () => {
    let active: AbortSignal | undefined;
    const app = buildServer({ assistantAdapters: [adapter(async input => {
      active = input.signal;
      await new Promise<void>(() => {});
    })] }); servers.push(app);
    const authentication = await headers(app);
    const response = Promise.resolve(app.inject({ method: 'POST', url: '/api/v1/workdisk/search-plan', payload: { query: '招生视频', today }, headers: authentication }));
    await vi.waitFor(() => expect(active).toBeDefined());
    await app.close();
    expect(active!.aborted).toBe(true);
    expect((await response).statusCode).toBe(500);
  });
});
