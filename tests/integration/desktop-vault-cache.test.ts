import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { prepareVaultCacheDirectory } from '../../src/electron/vault-cache.js';
import { startServer, type StartedServer } from '../../src/server/start-server.js';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { FileSystemVaultGateway } from '../../src/server/vault/FileSystemVaultGateway.js';
import { createNativeReadVaultPortFactory } from '../../src/server/vault/NativeReadVaultPort.js';

let workspace: string;
let helperPath: string;
let clientRoot: string;
const servers: StartedServer[] = [];
const releaseScans: Array<() => void> = [];

beforeAll(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'xiaozhao-cache-isolation-')));
  helperPath = join(workspace, 'atomic-file-helper');
  await promisify(execFile)('xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-arch', 'arm64',
    '-mmacosx-version-min=13.0', resolve('native/macos/atomic-file-helper.c'), '-o', helperPath]);
  clientRoot = join(workspace, 'client');
  await mkdir(clientRoot);
  await writeFile(join(clientRoot, 'index.html'), '<html><meta name="csp-nonce" content="__CSP_NONCE__"><body>fixture</body></html>');
});
afterAll(async () => {
  for (const release of releaseScans) release();
  for (const server of servers) await server.close();
  vi.restoreAllMocks();
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

async function gateway(vaultRoot: string) {
  return FileSystemVaultGateway.create({ vaultRoot, nativeReader: createNativeReadVaultPortFactory(helperPath) });
}

async function createVault(name: string, noteName: string) {
  const root = join(workspace, name);
  await mkdir(root);
  for (const name of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂']) await mkdir(join(root, name));
  for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(root, path), 'fixture rule');
  await writeFile(join(root, '02知识库', `${noteName}.md`), await readFile(new URL('../fixtures/knowledge-valid.md', import.meta.url)));
  return { root, gateway: await gateway(root) };
}

async function launch(vault: { root: string; gateway: FileSystemVaultGateway }, userDataDir: string) {
  const appDataDir = prepareVaultCacheDirectory({ userDataDir, vaultRoot: vault.root, cacheKey: vault.gateway.cacheKey });
  const server = await startServer({ host: '127.0.0.1', port: 0, appDataDir, vaultRealRoot: vault.root,
    clientRoot, modelBaseUrl: 'https://model.invalid', gateway: vault.gateway, adapter: 'filesystem' });
  servers.push(server);
  return { server, appDataDir };
}

function holdThenFailScan(source: FileSystemVaultGateway) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  releaseScans.push(release);
  vi.spyOn(source, 'listDirectory').mockImplementation(async () => {
    await held;
    throw new Error('FIXTURE_INDEX_FAILED');
  });
  return release;
}

async function paths(server: StartedServer) {
  const response = await fetch(`${server.origin}/api/v1/knowledge`);
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { items: Array<{ path: string }> } };
  return body.data.items.map((item) => item.path);
}

it('never returns A rows when B uses the same desktop settings directory but its first scan stalls or fails', async () => {
  const userDataDir = join(workspace, 'shared-user-data');
  const first = await createVault('vault-a', 'A-only');
  const a = await launch(first, userDataDir);
  await a.server.requestRefresh();
  expect(await paths(a.server)).toEqual(['02知识库/A-only.md']);
  await a.server.close();
  await writeFile(join(userDataDir, 'state.sqlite3'), 'old shared cache stays untouched');

  const second = await createVault('vault-b', 'B-only');
  const release = holdThenFailScan(second.gateway);
  const b = await launch(second, userDataDir);
  expect(b.appDataDir).not.toBe(a.appDataDir);
  expect(await paths(b.server)).toEqual([]);
  release();
  expect(await b.server.requestRefresh()).toMatchObject({ outcome: 'failed' });
  expect(await paths(b.server)).toEqual([]);
  const health = await (await fetch(`${b.server.origin}/api/v1/health`)).text();
  expect(health).not.toContain(first.gateway.cacheKey);
  expect(health).not.toContain(second.gateway.cacheKey);
  expect(await readFile(join(userDataDir, 'state.sqlite3'), 'utf8')).toBe('old shared cache stays untouched');
  await b.server.close();

  const reopened = { root: first.root, gateway: await gateway(first.root) };
  expect(reopened.gateway.cacheKey).toBe(first.gateway.cacheKey);
  const releaseReopened = holdThenFailScan(reopened.gateway);
  const resumed = await launch(reopened, userDataDir);
  expect(resumed.appDataDir).toBe(a.appDataDir);
  expect(await paths(resumed.server)).toEqual(['02知识库/A-only.md']);
  releaseReopened();
  await resumed.server.close();
});

it('uses a fresh namespace when a new directory replaces the old vault at the exact same path', async () => {
  const userDataDir = join(workspace, 'replacement-user-data');
  const original = await createVault('same-path-vault', 'original-only');
  const a = await launch(original, userDataDir);
  await a.server.requestRefresh();
  expect(await paths(a.server)).toEqual(['02知识库/original-only.md']);
  await a.server.close();
  await rename(original.root, join(workspace, 'held-original-vault'));
  const replacement = await createVault('same-path-vault', 'replacement-only');
  expect(replacement.root).toBe(original.root);
  expect(replacement.gateway.cacheKey).not.toBe(original.gateway.cacheKey);
  const release = holdThenFailScan(replacement.gateway);
  const b = await launch(replacement, userDataDir);
  expect(b.appDataDir).not.toBe(a.appDataDir);
  expect(await paths(b.server)).toEqual([]);
  release();
  expect(await b.server.requestRefresh()).toMatchObject({ outcome: 'failed' });
  expect(await paths(b.server)).toEqual([]);
  await b.server.close();
});
