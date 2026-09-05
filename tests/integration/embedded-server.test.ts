import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as databaseModule from '../../src/server/db/database.js';
import { startServer, type StartedServer } from '../../src/server/start-server.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; vi.restoreAllMocks(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xiaozhao-embedded-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const vaultRealRoot = join(root, 'fixture-vault');
  const clientRoot = join(root, 'client');
  await mkdir(vaultRealRoot);
  await mkdir(join(clientRoot, 'assets'), { recursive: true });
  await writeFile(join(clientRoot, 'index.html'), '<html><head><meta name="csp-nonce" content="__CSP_NONCE__"></head><body>fixture app</body></html>');
  await writeFile(join(clientRoot, 'assets', 'app.js'), 'console.log("fixture");');
  await writeFile(join(clientRoot, 'assets', 'app.css'), 'body{color:navy}');
  await writeFile(join(root, 'private.txt'), 'private-root-content');
  await symlink(join(root, 'private.txt'), join(clientRoot, 'assets', 'private.txt'));
  const gateway = new FakeVaultGateway({
    '02知识库/测试.md': await readFile(new URL('../fixtures/knowledge-valid.md', import.meta.url))
  });
  return { host: '127.0.0.1' as const, port: 0, appDataDir: join(root, 'data'), vaultRealRoot,
    clientRoot, modelBaseUrl: 'https://models.invalid', gateway, adapter: 'filesystem' as const };
}

async function launch() {
  const config = await fixture();
  const server = await startServer(config);
  cleanup.push(() => server.close());
  return { config, server };
}

function rawRequest(server: StartedServer, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(`${server.origin}${path}`, { headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('embedded runtime with its real allocated listener', () => {
  it('finishes a direct filesystem scan larger than one read budget in one refresh attempt', async () => {
    const config = await fixture();
    const note = await readFile(new URL('../fixtures/knowledge-valid.md', import.meta.url));
    for (let index = 0; index < 125; index += 1) config.gateway.mutateFixture(`02知识库/测试${index}.md`, note);
    const server = await startServer(config);
    cleanup.push(() => server.close());
    expect(await server.requestRefresh()).toMatchObject({ outcome: 'succeeded', refresh: { status: 'ready', total: 126 } });
    const response = await fetch(`${server.origin}/api/v1/knowledge?limit=200`);
    const body = await response.json() as { data: { items: unknown[] } };
    expect(body.data.items).toHaveLength(126);
  });

  it('binds exact dynamic authority and preserves session and CSRF checks', async () => {
    const { server } = await launch();
    expect(server.port).toBeGreaterThan(0);
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
    expect((await fetch(`${server.origin}/api/v1/health`, { headers: { origin: server.origin } })).status).toBe(200);
    expect((await rawRequest(server, '/api/v1/health', { host: 'evil.example' })).status).toBe(421);
    expect((await fetch(`${server.origin}/api/v1/health`, { headers: { origin: 'http://127.0.0.1:5173' } })).status).toBe(403);
    const post = (headers: Record<string, string>) => fetch(`${server.origin}/api/v1/knowledge/open`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ path: '02知识库/测试.md' })
    });
    expect((await post({})).status).toBe(403);
    expect((await fetch(`${server.origin}/api/v1/health`, { method: 'OPTIONS' })).status).toBe(403);
    expect((await post({ origin: server.origin })).status).toBe(401);
    const bootstrap = await fetch(`${server.origin}/api/v1/bootstrap`);
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
    const { data } = await bootstrap.json() as { data: { csrfToken: string } };
    expect((await post({ origin: server.origin, cookie })).status).toBe(403);
    expect((await post({ origin: server.origin, cookie, 'x-csrf-token': data.csrfToken })).status).toBe(200);
  });

  it('serves built assets and nested SPA routes without exposing global files or API fallback', async () => {
    const { server } = await launch();
    for (const path of ['/', '/knowledge/nested', '/settings']) {
      const response = await fetch(`${server.origin}${path}`, { headers: { accept: 'text/html' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(await response.text()).toContain('fixture app');
    }
    const js = await fetch(`${server.origin}/assets/app.js`);
    expect(js.headers.get('content-type')).toMatch(/javascript/u);
    expect(await js.text()).toContain('console.log');
    expect((await fetch(`${server.origin}/assets/app.css`)).headers.get('content-type')).toContain('text/css');
    const head = await fetch(`${server.origin}/knowledge/nested`, { method: 'HEAD', headers: { accept: 'text/html' } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    for (const path of ['/api', '/api/unknown', '/api/v1/absent', '/assets/missing.js', '/assets/private.txt', '/private.txt']) {
      const response = await fetch(`${server.origin}${path}`, { headers: { accept: 'text/html' } });
      expect(response.status, path).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND', operationId: expect.stringMatching(/^[a-z0-9-]+$/u) } });
    }
    expect((await fetch(`${server.origin}/unknown`, { headers: { accept: 'application/json' } })).status).toBe(404);
    expect((await fetch(`${server.origin}/unknown`, { headers: { accept: 'text/html;q=0' } })).status).toBe(404);
  });

  it('refreshes indexed changes and closes the listener and database idempotently', async () => {
    const { config, server } = await launch();
    await server.requestRefresh();
    const health = await (await fetch(`${server.origin}/api/v1/health`)).json() as { data: { index: { version: number } } };
    config.gateway.deleteFixture('02知识库/测试.md');
    await server.requestRefresh();
    const after = await (await fetch(`${server.origin}/api/v1/health`)).json() as { data: { index: { version: number } } };
    expect(after.data.index.version).toBeGreaterThan(health.data.index.version);
    await Promise.all([server.close(), server.close()]);
    await expect(fetch(`${server.origin}/api/v1/health`)).rejects.toThrow();
    const reopened = new Database(join(config.appDataDir, 'state.sqlite3'));
    expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
    reopened.close();
  });

  it('releases database state when loading client assets or binding fails', async () => {
    const config = await fixture();
    const openKernel = vi.spyOn(databaseModule, 'openStateKernel');
    await expect(startServer({ ...config, clientRoot: join(config.clientRoot, 'missing') })).rejects.toThrow();
    const failedAssetsKernel = openKernel.mock.results[0]?.value as databaseModule.StateKernel;
    expect(failedAssetsKernel.mode === 'normal' && failedAssetsKernel.db.open).toBe(false);
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('fixture listen failed');
    await expect(startServer({ ...config, port: address.port })).rejects.toThrow();
    const failedListenKernel = openKernel.mock.results[1]?.value as databaseModule.StateKernel;
    expect(failedListenKernel.mode === 'normal' && failedListenKernel.db.open).toBe(false);
    const retry = await startServer(config);
    cleanup.push(() => retry.close());
    expect((await fetch(`${retry.origin}/api/v1/health`)).status).toBe(200);
  });

  it('rejects foreign binding or state inside a vault before startup', async () => {
    const config = await fixture();
    await expect(startServer({ ...config, host: '0.0.0.0' as '127.0.0.1' })).rejects.toThrow('INVALID_LOOPBACK_LISTEN');
    await expect(startServer({ ...config, appDataDir: join(config.vaultRealRoot, 'state') })).rejects.toThrow('outside the vault');
  });

  it('rejects legacy health configuration from a direct-read adapter', async () => {
    const config = await fixture();
    await expect(startServer({ ...config, legacyHealth: {
      gateway: config.gateway, writeEnabled: true, profileDirectory: join(config.appDataDir, 'profiles')
    } })).rejects.toThrow('INVALID_LEGACY_ADAPTER');
  });

  it('keeps fresh legacy development API-only while production requires built assets', async () => {
    const config = await fixture();
    const legacyConfig = { ...config, adapter: 'local-rest' as const, clientRoot: join(config.clientRoot, 'not-built'),
      legacyHealth: { gateway: config.gateway, writeEnabled: false, profileDirectory: join(config.appDataDir, 'profiles'), development: true } };
    const server = await startServer(legacyConfig);
    cleanup.push(() => server.close());
    expect((await fetch(`${server.origin}/api/v1/health`, { headers: { origin: 'http://127.0.0.1:5173' } })).status).toBe(200);
    expect((await fetch(`${server.origin}/`, { headers: { accept: 'text/html' } })).status).toBe(404);
    await server.close();
    await expect(startServer({ ...legacyConfig, legacyHealth: { ...legacyConfig.legacyHealth, development: false } })).rejects.toThrow();
  });
});
