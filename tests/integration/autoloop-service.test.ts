// Prevent duplicate dispatch, cross-vault disclosure, unsafe output reads, and incomplete task cancellation.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createAutoloopService, type AutoloopOptions } from '../../src/server/autoloop/service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function fixture(extra: Partial<AutoloopOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autoloop-bridge-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'hub'); await mkdir(home);
  let runs: any[] = []; let cards: any[] = []; let pages = false; let emits = 0; let lost = false; let holdLines = false; let lastLines: any[] = [];
  const eventIds = new Set<string>(); const received: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    received.push({ url: req.url, auth: req.headers.authorization, body });
    const rules = JSON.parse(await readFile(join(home, 'rules.json'), 'utf8'));
    res.setHeader('content-type', 'application/json');
    if (req.url!.startsWith('/v1/state')) {
      if (!holdLines) lastLines = rules.rules.map((r: any) => ({ name: r.name, source: r.when.source, types: r.when.types, agent: r.to }));
      res.end(JSON.stringify({ lines: lastLines, cards, runs: pages && !req.url!.includes('before') ? [] : runs, nextBefore: pages && !req.url!.includes('before') ? 100 : null }));
    } else if (req.url === '/v1/events') {
      expect(req.headers.authorization).toBe('Bearer source-secret');
      const rule = rules.rules.find((r: any) => r.when.types.includes(body.type));
      if (!eventIds.has(body.id)) { eventIds.add(body.id); emits++; runs.push({ id: emits, rule: rule.name, state: 'claimed', createdAt: new Date().toISOString(), summary: '' }); }
      if (lost) { lost = false; req.socket.destroy(); return; }
      res.end(JSON.stringify({ event: emits, duplicate: false, routed: [rule.name] }));
    } else {
      const cancel = req.url!.match(/\/v1\/runs\/(\d+)\/cancel/); const resolve = req.url!.match(/\/v1\/cards\/(\d+)\/resolve/);
      if (cancel) { const run = runs.find(run => run.id === Number(cancel[1])); if (!['queued', 'claimed'].includes(run?.state)) { res.statusCode = 400; } else run.state = 'cancelled'; }
      if (resolve) { const card = cards.find(card => card.id === Number(resolve[1])); card.state = 'resolved'; }
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  await writeFile(join(home, 'config.json'), JSON.stringify({ url: `http://127.0.0.1:${(server.address() as any).port}`, owner: 'owner-secret', source: { name: 'local', key: 'source-secret' }, worker: { name: 'test-worker' } }));
  await writeFile(join(home, 'rules.json'), JSON.stringify({ agents: { codex: { name: 'Codex', use: 'codex', worker: 'test-worker', access: 'full' } }, sources: { local: { name: 'Local' } }, channels: {}, rules: [] }));
  const service = createAutoloopService({ home, stateRoot: join(root, 'private'), vaultIdentity: '/fake/vault', loadTimeoutMs: 500, pollMs: 5, ...extra });
  return { root, home, service, received, get runs() { return runs; }, set runs(value) { runs = value; }, set cards(value: any[]) { cards = value; }, set pages(value: boolean) { pages = value; }, set lost(value: boolean) { lost = value; }, set holdLines(value: boolean) { holdLines = value; }, get emits() { return emits; } };
}
const input = () => ({ requestId: randomUUID(), title: '核对', instructions: '只问一个颜色问题，回答后把结果写好。' });
describe('Autoloop private task bridge', () => {
  it('uses trusted workspace and skill identities with per-task execution snapshots and no secrets in choices', async () => {
    const f = await fixture();
    const workspace = join(f.root, 'brain'); await mkdir(workspace);
    const skill = join(workspace, 'SKILL.md'); await writeFile(skill, '# Proof');
    const service = createAutoloopService({ home: f.home, stateRoot: join(f.root, 'private'), vaultIdentity: '/fake/vault',
      getWorkspaces: async () => [{ id: 'vault', name: '我的大脑', kind: 'vault', path: workspace }],
      skills: { list: async () => ({ items: [{ id: 'proof', name: 'Proof', description: 'proof' }] }), resolveSource: async id => { if (id !== 'proof') throw new Error(); return skill; } }
    });
    const choices = await service.choices();
    expect(choices.workspaces.map(w => w.id)).toEqual(['isolated', 'vault']);
    expect(JSON.stringify(choices)).not.toContain(workspace);
    expect(JSON.stringify(choices)).not.toContain('secret');
    const request = { ...input(), workspaceId: 'vault', agentId: 'codex', model: 'chosen-model', skillId: 'proof', notify: true };
    const created = await service.create(request);
    expect(created.task).toMatchObject({ workspaceId: 'vault', agentId: 'codex', model: 'chosen-model', skillId: 'proof', notify: true });
    const rules = JSON.parse(await readFile(join(f.home, 'rules.json'), 'utf8'));
    expect(rules.rules[0].prompt).toContain(workspace); expect(rules.rules[0].prompt).toContain(skill);
    expect(rules.rules[0].prompt).toContain('AGENTS.md'); expect(rules.rules[0].cwd).not.toBe(workspace);
    expect(rules.rules[0].tell).toBe('always'); expect(rules.agents[rules.rules[0].to].model).toBe('chosen-model');
    await expect(service.create({ ...request, model: 'changed-model' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.create({ ...input(), workspaceId: '/etc' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.create({ ...input(), skillId: 'unknown' })).rejects.toMatchObject({ statusCode: 409 });
    await service.create({ ...input(), agentId: 'codex', model: 'another-model' });
    const final = JSON.parse(await readFile(join(f.home, 'rules.json'), 'utf8'));
    expect(final.rules[0].to).not.toBe(final.rules[1].to);
  });
  it('rejects a bound project replaced by a directory link and unavailable command agents', async () => {
    const f = await fixture(); const project = join(f.root, 'project'); const other = join(f.root, 'other');
    await mkdir(other); await symlink(other, project);
    const doc = JSON.parse(await readFile(join(f.home, 'rules.json'), 'utf8'));
    doc.agents.acp = { name: 'ACP', worker: 'test-worker', use: 'acp' };
    doc.agents.command = { name: 'Command', worker: 'test-worker', use: 'command', command: ['/nonexistent-autoloop-agent'] };
    await writeFile(join(f.home, 'rules.json'), JSON.stringify(doc));
    const service = createAutoloopService({ home: f.home, stateRoot: join(f.root, 'private'), vaultIdentity: '/fake/vault', getWorkspaces: async () => [{ id: 'project', name: '项目', kind: 'project', path: project }] });
    expect((await service.choices()).workspaces.find(item => item.id === 'project')?.available).toBe(false);
    expect((await service.choices()).agents.filter(item => ['acp', 'command'].includes(item.id)).every(item => !item.available)).toBe(true);
    await expect(service.create({ ...input(), workspaceId: 'project' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.create({ ...input(), agentId: 'acp' })).rejects.toMatchObject({ statusCode: 409 });
  });
  it('creates trusted rules with fixed workspaces, safe agent and source identity; retries do not duplicate work', async () => {
    const f = await fixture(); const request = input();
    const first = await f.service.create(request); const again = await f.service.create(request);
    expect(first.task.id).toBe(again.task.id); expect(f.emits).toBe(1);
    const rules = JSON.parse(await readFile(join(f.home, 'rules.json'), 'utf8'));
    expect(rules.rules).toHaveLength(1); expect(rules.agents[rules.rules[0].to].access).toBe('edit');
    expect(rules.agents.codex.access).toBe('full'); expect(rules.rules[0].cwd).toContain('/private/');
    expect(rules.rules[0].prompt).toContain(request.instructions);
    expect(JSON.stringify(first)).not.toContain('secret');
    await expect(f.service.create({ ...request, instructions: 'changed' })).rejects.toMatchObject({ statusCode: 409 });
  });
  it('waits for the exact new rule to load before emitting and recovers a timed-out dispatch with the saved identity', async () => {
    const f = await fixture(); const request = input(); f.holdLines = true;
    await expect(f.service.create(request)).rejects.toMatchObject({ code: 'AUTOLOOP_RULE_PENDING', statusCode: 503 });
    expect(f.emits).toBe(0); expect(f.received.filter(entry => entry.url === '/v1/events')).toHaveLength(0);
    const storedRules = JSON.parse(await readFile(join(f.home, 'rules.json'), 'utf8'));
    expect(storedRules.rules).toHaveLength(1);
    const reopened = createAutoloopService({ home: f.home, stateRoot: join(f.root, 'private'), vaultIdentity: '/fake/vault' });
    const saved = (await reopened.list()).tasks;
    expect(saved).toHaveLength(1); expect(saved[0]).toMatchObject({ id: request.requestId, title: request.title, instructions: request.instructions, status: 'dispatching' });
    f.holdLines = false;
    const recovered = await reopened.create(request); await reopened.create(request);
    expect(recovered.task).toMatchObject({ id: request.requestId, createdAt: saved[0]!.createdAt });
    expect(f.emits).toBe(1);
    const sent = f.received.filter(entry => entry.url === '/v1/events');
    expect(sent).toHaveLength(1); expect(sent[0].body.id).toBe(storedRules.rules[0].name);
    expect(JSON.parse(await readFile(join(f.home, 'rules.json'), 'utf8')).rules).toEqual(storedRules.rules);
  });
  it('keeps durable identity after event response loss and resumes through the same event', async () => {
    const f = await fixture(); const request = input(); f.lost = true;
    await expect(f.service.create(request)).rejects.toMatchObject({ statusCode: 503 });
    const recovered = await f.service.create(request); expect(recovered.task.id).toBe(request.requestId); expect(f.emits).toBe(1);
  });
  it('does not label a finished asking round complete and only permits own cards/runs', async () => {
    const f = await fixture(); const { task } = await f.service.create(input());
    const rule = f.runs[0].rule; f.runs = [{ ...f.runs[0], state: 'done', summary: 'Asked' }];
    f.cards = [{ id: 9, rule, kind: 'ask', state: 'open', title: '颜色', text: '', options: ['蓝', '绿'] }, { id: 88, rule: 'unrelated', kind: 'ask', state: 'open', title: 'private', options: [] }];
    expect((await f.service.detail(task.id)).task.status).toBe('waiting');
    await expect(f.service.answer(task.id, { cardId: 88, choice: 0 })).rejects.toMatchObject({ statusCode: 404 });
    await f.service.answer(task.id, { cardId: 9, choice: 1 });
    expect(f.received.at(-1).body).toEqual({ choice: 1 });
    expect(JSON.stringify(await f.service.list())).not.toContain('private');
  });
  it('includes old runs after pagination and reads only bounded non-symlink result files', async () => {
    const f = await fixture(); const { task } = await f.service.create(input()); f.pages = true;
    f.runs = [{ ...f.runs[0], state: 'done', summary: 'done' }];
    const rules = JSON.parse(await readFile(join(f.home, 'rules.json'), 'utf8')); const cwd = rules.rules[0].cwd;
    await writeFile(join(cwd, 'result.md'), '完整成果');
    expect((await f.service.detail(task.id)).result).toBe('完整成果');
    await rm(join(cwd, 'result.md')); await symlink(join(f.home, 'config.json'), join(cwd, 'result.md'));
    expect((await f.service.detail(task.id)).result).not.toContain('owner-secret');
  });
  it('refuses overlapping wildcard rules before emitting and keeps vault identities separate', async () => {
    const f = await fixture(); const rules = JSON.parse(await readFile(join(f.home, 'rules.json'), 'utf8'));
    rules.rules.push({ name: 'catch-all', when: { source: 'local', types: ['*'] }, to: 'codex', cwd: f.root, prompt: 'other' });
    await writeFile(join(f.home, 'rules.json'), JSON.stringify(rules));
    await expect(f.service.create(input())).rejects.toMatchObject({ statusCode: 409 }); expect(f.emits).toBe(0);
    const other = createAutoloopService({ home: f.home, stateRoot: join(f.root, 'private'), vaultIdentity: '/different/vault' });
    expect((await other.list()).tasks).toHaveLength(0);
  });
  it('cancels a waiting task by removing only its rule, resolving its cards and stopping only its active runs', async () => {
    const f = await fixture(); const request = input(); const { task } = await f.service.create(request);
    const rule = f.runs[0].rule;
    f.runs = [{ ...f.runs[0], state: 'done' }, { id: 3, rule, state: 'claimed' }, { id: 8, rule: 'unrelated', state: 'claimed' }];
    f.cards = [{ id: 9, rule, kind: 'ask', state: 'open', title: '等待', options: [] }, { id: 88, rule: 'unrelated', kind: 'ask', state: 'open', title: 'private', options: [] }];
    await f.service.cancel(task.id);
    expect((await f.service.detail(task.id)).task.status).toBe('cancelled');
    expect(f.received.filter(r => /\/(cancel|resolve)$/.test(r.url)).map(r => r.url)).toEqual(['/v1/cards/9/resolve', '/v1/runs/3/cancel']);
    expect(JSON.parse(await readFile(join(f.home, 'rules.json'), 'utf8')).rules).toHaveLength(0);
    await f.service.create(request); expect(f.emits).toBe(1);
  });
  it('does not claim an unknown execution stopped when preventing further task dispatch', async () => {
    const f = await fixture(); const { task } = await f.service.create(input()); f.runs[0].state = 'unknown';
    await f.service.cancel(task.id);
    expect((await f.service.detail(task.id)).task.status).toBe('unknown');
    expect(f.received.some(r => r.url.endsWith('/cancel'))).toBe(false);
  });
  it('keeps an interrupted stop retryable until the loaded rule is gone', async () => {
    const f = await fixture(); const { task } = await f.service.create(input()); f.runs[0].state = 'done'; f.holdLines = true;
    await expect(f.service.cancel(task.id)).rejects.toMatchObject({ statusCode: 503 });
    const reopened = createAutoloopService({ home: f.home, stateRoot: join(f.root, 'private'), vaultIdentity: '/fake/vault' });
    expect((await reopened.detail(task.id)).task.status).toBe('unknown');
    f.holdLines = false; await reopened.cancel(task.id);
    expect((await reopened.detail(task.id)).task.status).toBe('cancelled');
  });
  it('dispatches only to the configured local worker even when another Codex agent comes first', async () => {
    const f = await fixture(); const rules = JSON.parse(await readFile(join(f.home, 'rules.json'), 'utf8'));
    rules.agents = { remote: { name: 'Remote', use: 'codex', worker: 'other-machine', access: 'full' }, ...rules.agents };
    await writeFile(join(f.home, 'rules.json'), JSON.stringify(rules));
    await f.service.create(input()); const saved = JSON.parse(await readFile(join(f.home, 'rules.json'), 'utf8'));
    expect(saved.agents[saved.rules[0].to].worker).toBe('test-worker');
  });
  it('test mode without explicit home remains unavailable and never touches production configuration', async () => {
    const service = createAutoloopService({ stateRoot: '/must-not-be-written', vaultIdentity: '/fake/vault', home: null });
    expect((await service.list()).connection.connected).toBe(false);
    await expect(service.create(input())).rejects.toMatchObject({ statusCode: 503 });
  });
});
