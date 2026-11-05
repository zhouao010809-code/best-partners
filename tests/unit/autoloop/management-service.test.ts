import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fileStore from '../../../src/server/autoloop/file-store.js';
import { createAutoloopManagementService } from '../../../src/server/autoloop/management-service.js';
const homes: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const document = { sources: { local: { name: '本地' } }, agents: { codex: { name: 'Codex', use: 'codex', worker: 'mac' } }, rules: [{ name: '日报', when: { cron: '0 9 * * *' }, to: 'codex', cwd: '/tmp', prompt: '写日报' }] };
const hubState = { now: '2026-11-05T00:00:00Z', timezone: 'Asia/Shanghai', totals: {}, spending: {}, cards: [], recentCards: [], agents: [], channels: [], sources: [], lines: [{ name: '日报', agent: 'codex', source: 'schedule' }], elsewhere: [], runs: [], nextBefore: null, unrouted: [] };
async function setup(validateRules = vi.fn(async () => {})) {
  const home = await mkdtemp(join(tmpdir(), 'autoloop-manage-')); homes.push(home);
  await writeFile(join(home, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:3350', owner: 'owner-secret', source: { name: 'local', key: 'source-secret' }, worker: { name: 'mac', key: 'worker-secret' } }));
  await writeFile(join(home, 'rules.json'), JSON.stringify(document));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(hubState))));
  return { home, validateRules, service: createAutoloopManagementService({ home, validateRules, loadTimeoutMs: 1, pollMs: 1 }) };
}
it('rejects native-invalid rules before persistence, preserving both active and paused documents', async () => {
  const validateRules = vi.fn(async () => { throw new Error('不是有效的 cron'); });
  const { home, service } = await setup(validateRules); const configuration = await service.configuration();
  const original = await readFile(join(home, 'rules.json'), 'utf8');
  await expect(service.save({ revision: configuration.revision, disabledRules: [], document: { ...document, rules: [{ ...document.rules[0]!, when: { cron: 'invalid' } }] } })).rejects.toThrow('cron');
  expect(await readFile(join(home, 'rules.json'), 'utf8')).toBe(original);
  await expect(readFile(join(home, 'bestpartner-disabled-rules.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('persists paused rules and detects concurrent configuration edits', async () => {
  const { service, home } = await setup(); const configuration = await service.configuration();
  await service.save({ revision: configuration.revision, document: { ...document, rules: [] }, disabledRules: document.rules });
  const saved = await service.configuration(); expect(saved.disabledRules).toEqual(document.rules); expect(saved.document.rules).toEqual([]);
  expect(JSON.parse(await readFile(join(home, 'rules.json'), 'utf8')).rules).toEqual([]);
  await expect(service.save({ revision: configuration.revision, document, disabledRules: [] })).rejects.toMatchObject({ statusCode: 409 });
});
it('redacts credentials and bearer URLs from global state while preserving pagination', async () => {
  const { service } = await setup();
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...hubState, runs: [{ id: 1, rule: '日报', token: 'unknown-run-secret', link: 'http://localhost/card/owner-secret', session: 'session-secret', summary: 'Bearer owner-secret source-secret', usage: { cost: 0.1, tokens: 120 } }], nextBefore: 22 })));
  vi.stubGlobal('fetch', fetcher); const state = await service.state(40); const output = JSON.stringify(state);
  expect(output).not.toContain('secret'); expect(state.runs[0]?.usage).toEqual({ cost: 0.1, tokens: 120 }); expect(state.nextBefore).toBe(22); expect(fetcher.mock.calls[0]?.[0]).toContain('?before=40');
});
it('only returns run-scoped trace text, never rules snapshots, session tokens or unrelated runs', async () => {
  const { service } = await setup(); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
    { seq: 1, at: '2026-11-05', type: 'rules', changes: [{ table: 'config', key: 'rules', row: { value: { owner: 'owner-secret' } } }] },
    { seq: 2, at: '2026-11-05', type: 'finish', changes: [{ table: 'runs', key: '8', row: { id: 8, state: 'done', summary: '完成', token: 'secret-run' } }, { table: 'runs', key: '9', row: { id: 9, summary: '别人的内容' } }] }
  ]))));
  expect(await service.trace(8)).toEqual({ runId: 8, timeline: [{ seq: 2, at: '2026-11-05', type: 'finish', text: '运行 done：完成' }] });
});
it('stores command argv only as configuration and delegates validation without executing them', async () => {
  const { service, home } = await setup(); const configuration = await service.configuration();
  const changed = { ...document, agents: { ...document.agents, script: { name: '脚本', use: 'command', worker: 'mac', command: ['sh', '-c', 'touch /tmp/no'] } } };
  await service.save({ revision: configuration.revision, document: changed, disabledRules: [] });
  expect(JSON.parse(await readFile(join(home, 'rules.json'), 'utf8'))).toEqual(changed);
});
it('uses local source identity and rejects disabled-rule manual triggers', async () => {
  const { service } = await setup(); const fetcher = vi.fn(async () => new Response(JSON.stringify({ event: 3, duplicate: false, routed: ['日报'] }))); vi.stubGlobal('fetch', fetcher);
  await service.event({ id: 'unique', type: 'manual.test' });
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: 'Bearer source-secret' }, body: JSON.stringify({ id: 'unique', type: 'manual.test' }) });
  await expect(service.trigger('不存在', 'stable')).rejects.toMatchObject({ statusCode: 404 });
});
it('has no live home by default under test', async () => {
  const service = createAutoloopManagementService(); await expect(service.configuration()).rejects.toMatchObject({ statusCode: 503 });
});

it('keeps the old rules and paused file when atomic persistence fails', async () => {
  const { home, service } = await setup(); const current = await service.configuration(); const old = await readFile(join(home, 'rules.json'), 'utf8');
  const originalWrite = fileStore.atomicJson;
  vi.spyOn(fileStore, 'atomicJson').mockImplementation(async (file, value) => { if (file.endsWith('/rules.json')) throw new Error('disk full'); return originalWrite(file, value); });
  await expect(service.save({ revision: current.revision, document: { ...document, rules: [] }, disabledRules: document.rules })).rejects.toThrow('disk full');
  expect(await readFile(join(home, 'rules.json'), 'utf8')).toBe(old);
  await expect(readFile(join(home, 'bestpartner-disabled-rules.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('waits for a distinct loaded companion after an execution configuration edit before emitting', async () => {
  const { service, home } = await setup(); let firstCompanion: Record<string, any> | undefined;
  let emissions = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, request?: RequestInit) => {
    if (request?.method === 'POST') { emissions++; return new Response(JSON.stringify({ event: 7, duplicate: false, routed: ['日报'] })); }
    const current = JSON.parse(await readFile(join(home, 'rules.json'), 'utf8'));
    const lines = current.rules.map((rule: any) => ({ name: rule.name, agent: rule.to, source: rule.when.source ?? 'schedule', types: rule.when.types ?? [] }));
    firstCompanion = lines.find((rule: any) => rule.name.startsWith('bestpartner-manual-'));
    return new Response(JSON.stringify({ ...hubState, lines }));
  }));
  await service.trigger('日报', 'first'); expect(emissions).toBe(1); const stale = firstCompanion!;
  const current = await service.configuration();
  await service.save({ revision: current.revision, document: { ...current.document, rules: [{ ...current.document.rules[0]!, prompt: 'new execution' }] }, disabledRules: [] });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, request?: RequestInit) => {
    if (request?.method === 'POST') emissions++;
    return new Response(JSON.stringify({ ...hubState, lines: [hubState.lines[0], stale] }));
  }));
  await expect(service.trigger('日报', 'second')).rejects.toMatchObject({ statusCode: 503 });
  expect(emissions).toBe(1);
  const saved = JSON.parse(await readFile(join(home, 'rules.json'), 'utf8'));
  expect(saved.rules.find((rule: any) => rule.name.startsWith('bestpartner-manual-')).name).not.toBe(stale.name);
});

it('prepares all recipe files without overwriting local edits, then returns real execution paths', async () => {
  const { home } = await setup(); const source = join(home, 'app', 'examples', 'recipes', 'morning-brief'); await mkdir(source, { recursive: true });
  await writeFile(join(source, 'README.md'), 'Prepare sources'); await writeFile(join(source, 'SKILL.md'), '# Brief'); await writeFile(join(source, 'collect.ts'), 'local helper');
  await writeFile(join(source, 'rules.json'), JSON.stringify({ ...document, channels: { desktop: { name: 'Example', answerers: ['PLACEHOLDER'] } }, rules: [{ ...document.rules[0], skill: 'morning-brief' }] }));
  await writeFile(join(home, 'rules.json'), JSON.stringify({ ...document, channels: { desktop: { name: 'My desktop' } } }));
  const service = createAutoloopManagementService({ home }); const prepared = await service.prepareTemplate('morning-brief'); const incoming = prepared.rules as typeof document & { channels: Record<string, unknown> };
  const folder = join(home, 'work', 'bestpartner-recipes', 'morning-brief');
  expect(incoming.rules[0]?.cwd).toBe(folder); expect((incoming.rules[0] as any).skill).toBe(join(folder, 'SKILL.md')); expect(incoming.agents.codex.worker).toBe('mac'); expect(incoming.channels).toEqual({}); expect(incoming.sources).toEqual({});
  await writeFile(join(folder, 'collect.ts'), 'user edit'); await service.prepareTemplate('morning-brief'); expect(await readFile(join(folder, 'collect.ts'), 'utf8')).toBe('user edit');
  expect(JSON.parse(await readFile(join(home, 'rules.json'), 'utf8')).rules).toEqual(document.rules);
  await expect(service.prepareTemplate('../escape')).rejects.toMatchObject({ statusCode: 404 });
});

it('prepares the GitHub polling dependency and keeps conflicting existing agents intact', async () => {
  const { home } = await setup(); const app = join(home, 'app'); const source = join(app, 'examples', 'recipes', 'github-issues');
  await mkdir(source, { recursive: true }); await writeFile(join(source, 'README.md'), 'test'); await writeFile(join(app, 'examples', 'watch-github-issues.sh'), '#!/bin/sh\nexit 0\n');
  const watcher = { name: 'Poll', use: 'command', worker: 'sample', command: ['{cwd}/examples/watch-github-issues.sh', 'owner/repo'] };
  await writeFile(join(source, 'rules.json'), JSON.stringify({ ...document, agents: { codex: watcher }, rules: [{ ...document.rules[0], to: 'codex' }] }));
  const service = createAutoloopManagementService({ home }); const draft = (await service.prepareTemplate('github-issues')).rules as typeof document;
  const id = draft.rules[0]!.to; expect(id).not.toBe('codex');
  const command = (draft.agents as any)[id].command; expect(command.slice(0, 2)).toEqual(['/bin/sh', '{cwd}/watch-github-issues.sh']);
  expect(await readFile(join(draft.rules[0]!.cwd, 'watch-github-issues.sh'), 'utf8')).toContain('exit 0');
  expect((await service.configuration()).document.agents.codex?.use).toBe('codex');
});
it('uses an existing editable operations script even if a previous version prepared it without execute permissions', async () => {
  const { home } = await setup(); const app = join(home, 'app'); const source = join(app, 'examples', 'recipes', 'ops-alerts');
  await mkdir(source, { recursive: true }); await writeFile(join(source, 'README.md'), 'test'); await writeFile(join(source, 'restart.sh'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(source, 'rules.json'), JSON.stringify({ ...document, agents: { restart: { name: 'Ops', use: 'command', worker: 'sample', command: ['{cwd}/restart.sh'] } }, rules: [{ ...document.rules[0], to: 'restart' }] }));
  const folder = join(home, 'work', 'bestpartner-recipes', 'ops-alerts'); await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'restart.sh'), '#!/bin/sh\necho my local edit\n', { mode: 0o600 });
  const service = createAutoloopManagementService({ home }); const draft = (await service.prepareTemplate('ops-alerts')).rules as typeof document;
  expect((draft.agents as any).restart.command).toEqual(['/bin/sh', '{cwd}/restart.sh']);
  expect(await readFile(join(folder, 'restart.sh'), 'utf8')).toContain('my local edit');
});
