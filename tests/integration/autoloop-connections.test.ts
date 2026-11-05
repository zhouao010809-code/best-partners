import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAutoloopConnectionsService } from '../../src/server/autoloop/connections-service.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'autoloop-connections-')); roots.push(home);
  const config = { url: 'http://127.0.0.1:1', owner: 'private-owner', hub: { listen: '127.0.0.1:1' }, channels: { desktop: { key: 'private-desktop' } } };
  const rules = { sources: { local: { name: '本机' } }, agents: {}, channels: { desktop: { name: '桌面' } }, rules: [] as any[] };
  await writeFile(join(home, 'config.json'), JSON.stringify(config)); await writeFile(join(home, 'rules.json'), JSON.stringify(rules));
  let processes = ''; let rejectCheck = false;
  const run = vi.fn(async (command: string, args: string[], _env: NodeJS.ProcessEnv) => {
    if (args.includes('check') && rejectCheck) throw new Error('private-diagnostic');
    if (args.includes('key')) return { stdout: 'new-private-key\n', stderr: '' };
    if (command === '/bin/ps') return { stdout: processes, stderr: '' };
    if (command === 'lark-cli') return { stdout: JSON.stringify({ identities: { bot: { status: 'ready' }, user: { status: 'needs_refresh' } } }), stderr: '' };
    return { stdout: '', stderr: '' };
  });
  return { home, config, rules, run, service: createAutoloopConnectionsService({ home, nodeExecutable: '/test/node', run }), set processes(value: string) { processes = value; }, set rejectCheck(value: boolean) { rejectCheck = value; } };
}
it('saves both channel registrations, keeps private webhook credentials out of every public result, and marks restart required', async () => {
  const f = await fixture();
  const saved = await f.service.save('slack', { enabled: true, url: 'https://hooks.slack.com/services/private/value', publicUrl: 'https://ignored.example' });
  expect(saved).toEqual({ ok: true, restartRequired: true });
  const config = JSON.parse(await readFile(join(f.home, 'config.json'), 'utf8'));
  expect(config.channels.slack).toEqual({ use: 'webhook', platform: 'slack', url: 'https://hooks.slack.com/services/private/value', key: 'new-private-key' });
  expect(config.channels.desktop.key).toBe('private-desktop');
  expect(JSON.parse(await readFile(join(f.home, 'rules.json'), 'utf8')).channels.slack).toEqual({ name: 'Slack', links: true });
  expect((await stat(join(f.home, 'config.json'))).mode & 0o777).toBe(0o600);
  const output = JSON.stringify([saved, await f.service.list(), await f.service.probe('slack')]);
  expect(output).not.toContain('private-'); expect(output).not.toContain('hooks.slack.com'); expect(output).not.toContain('/services/private/value');
  expect(f.run.mock.calls.some(([, args]) => args.includes('install'))).toBe(false);
});
it('preserves omitted credentials and unrelated secrets, writes the engine secret variable, and refuses to remove a referenced source', async () => {
  const f = await fixture(); await writeFile(join(f.home, 'secrets.env'), 'OTHER_SECRET=keep-original\n');
  await f.service.save('github', { enabled: true, secret: 'github-test-secret' });
  await f.service.save('github', { enabled: true });
  expect(await readFile(join(f.home, 'secrets.env'), 'utf8')).toBe("OTHER_SECRET=keep-original\nAGENT_AUTOLOOP_SECRET_GITHUB='github-test-secret'\n");
  const rules = JSON.parse(await readFile(join(f.home, 'rules.json'), 'utf8')); rules.rules.push({ when: { source: 'github' } }); await writeFile(join(f.home, 'rules.json'), JSON.stringify(rules));
  await expect(f.service.save('github', { enabled: false })).rejects.toMatchObject({ statusCode: 409 });
  expect(JSON.stringify(await f.service.list())).not.toContain('github-test-secret');
});
it('does not alter active files or mint credentials when native validation fails', async () => {
  const f = await fixture(); f.rejectCheck = true;
  const before = await readFile(join(f.home, 'config.json'), 'utf8');
  await expect(f.service.save('feishu', { enabled: true, user: 'ou_person' })).rejects.toMatchObject({ statusCode: 422 });
  expect(await readFile(join(f.home, 'config.json'), 'utf8')).toBe(before);
  expect(f.run.mock.calls.some(([, args]) => args.includes('key'))).toBe(false);
});
it.each(['check', 'key'] as const)('rejects concurrent edits during %s without overwriting any active file', async phase => {
  const f = await fixture();
  await writeFile(join(f.home, 'secrets.env'), 'FIXTURE_ORIGINAL=original\n');
  const concurrent = {
    'config.json': JSON.stringify({ ...f.config, externalSetting: 'preserve-me' }),
    'rules.json': JSON.stringify({ ...f.rules, sources: { ...f.rules.sources, external: { name: '外部新增来源' } } }),
    'secrets.env': 'FIXTURE_ORIGINAL=original\nFIXTURE_CONCURRENT=preserve-me\n'
  };
  f.run.mockImplementation(async (_command, args) => {
    if (args.includes(phase)) {
      await Promise.all(Object.entries(concurrent).map(([file, contents]) => writeFile(join(f.home, file), contents)));
    }
    return { stdout: args.includes('key') ? 'new-fixture-key\n' : '', stderr: '' };
  });
  await expect(f.service.save('slack', { enabled: true, url: 'https://example.com/fixture-hook' })).rejects.toMatchObject({
    code: 'AUTOLOOP_CONNECTION_CONFLICT', statusCode: 409
  });
  for (const [file, contents] of Object.entries(concurrent)) expect(await readFile(join(f.home, file), 'utf8')).toBe(contents);
  await expect(stat(join(f.home, 'bestpartner-connections-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects a concurrent secret-only edit even when parsed rules and config stay unchanged', async () => {
  const f = await fixture();
  const originalConfig = await readFile(join(f.home, 'config.json'), 'utf8');
  const originalRules = await readFile(join(f.home, 'rules.json'), 'utf8');
  const concurrentSecrets = 'FIXTURE_CONCURRENT=preserve-me\n';
  f.run.mockImplementation(async (_command, args) => {
    if (args.includes('check')) await writeFile(join(f.home, 'secrets.env'), concurrentSecrets);
    return { stdout: '', stderr: '' };
  });
  await expect(f.service.save('github', { enabled: true, secret: 'fixture-new-secret' })).rejects.toMatchObject({
    code: 'AUTOLOOP_CONNECTION_CONFLICT', statusCode: 409
  });
  expect(await readFile(join(f.home, 'config.json'), 'utf8')).toBe(originalConfig);
  expect(await readFile(join(f.home, 'rules.json'), 'utf8')).toBe(originalRules);
  expect(await readFile(join(f.home, 'secrets.env'), 'utf8')).toBe(concurrentSecrets);
});
it('rejects a second Feishu listener before service lifecycle commands and never presents CLI login as delivery proof', async () => {
  const f = await fixture(); await f.service.save('feishu', { enabled: true, user: 'ou_person' });
  f.processes = '100 1 /opt/homebrew/bin/lark-cli event consume card.action.trigger --as bot\n';
  const probe = await f.service.probe('feishu');
  expect(probe.ok).toBe(false); expect(probe.checks.find(check => check.name === 'callback')?.ok).toBe(false);
  await expect(f.service.lifecycle('restart')).rejects.toMatchObject({ statusCode: 409 });
  expect(f.run.mock.calls.some(([, args]) => args.includes('service'))).toBe(false);
});
it('rejects secrets in public URLs and preserves existing settings when malformed credentials are supplied', async () => {
  const f = await fixture();
  await expect(f.service.save('hub', { enabled: true, publicUrl: 'https://user:password@example.com' })).rejects.toMatchObject({ statusCode: 422 });
  await expect(f.service.save('slack', { enabled: true, url: 'http://example.com/hook' })).rejects.toMatchObject({ statusCode: 422 });
  expect(f.run).not.toHaveBeenCalled();
});
it('does not report the service stopped when the authenticated hub still responds', async () => {
  const f = await fixture();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ lines: [], runs: [] }), { headers: { 'content-type': 'application/json' } }));
  await expect(f.service.lifecycle('stop')).rejects.toMatchObject({ statusCode: 503 });
});
