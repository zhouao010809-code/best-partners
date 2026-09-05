import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startServer, type StartedServer } from '../../src/server/start-server.js';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { FileSystemVaultGateway } from '../../src/server/vault/FileSystemVaultGateway.js';
import { createNativeReadVaultPortFactory } from '../../src/server/vault/NativeReadVaultPort.js';

let workspace: string;
let server: StartedServer;
let gateway: FileSystemVaultGateway;
let vaultRoot: string;
let now = 1_000;
beforeAll(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'xiaozhao-readiness-')));
  vaultRoot = join(workspace, 'vault');
  await mkdir(vaultRoot);
  for (const name of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂']) await mkdir(join(vaultRoot, name));
  for (const path of RULE_BUNDLE_SOURCE_PATHS) await writeFile(join(vaultRoot, path), 'fixture rule');
  await writeFile(join(vaultRoot, '02知识库', 'fixture.md'), await readFile(new URL('../fixtures/knowledge-valid.md', import.meta.url)));
  const helperPath = join(workspace, 'atomic-file-helper');
  await promisify(execFile)('xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-arch', 'arm64',
    '-mmacosx-version-min=13.0', resolve('native/macos/atomic-file-helper.c'), '-o', helperPath]);
  gateway = await FileSystemVaultGateway.create({ vaultRoot, nativeReader: createNativeReadVaultPortFactory(helperPath) });
  const clientRoot = join(workspace, 'client');
  await mkdir(clientRoot);
  await writeFile(join(clientRoot, 'index.html'), '<html><meta name="csp-nonce" content="__CSP_NONCE__"><body>fixture</body></html>');
  server = await startServer({ host: '127.0.0.1', port: 0, appDataDir: join(workspace, 'data'), vaultRealRoot: vaultRoot,
    clientRoot, modelBaseUrl: 'https://model.invalid', gateway, adapter: 'filesystem' });
  await server.requestRefresh();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await server?.close();
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

async function health() {
  now += 1_001;
  return (await (await fetch(`${server.origin}/api/v1/health`)).json()) as {
    data: { status: string; vaultSource: { status: string; reason?: string }; index: { version?: number } }
  };
}

it('reflects missing rules, required folders and root identity after startup without rereading notes or rebuilding', async () => {
  const reads = vi.spyOn(gateway, 'readRaw');
  const lists = vi.spyOn(gateway, 'listDirectory');
  const before = await health();
  expect(before.data.vaultSource.status).toBe('ready');
  const rule = join(vaultRoot, RULE_BUNDLE_SOURCE_PATHS[2]);
  const heldRule = join(workspace, 'held-rule.md');
  await rename(rule, heldRule);
  const missingRule = await health();
  expect(missingRule.data.vaultSource).toEqual({ status: 'unavailable', reason: 'VAULT_RULES_MISSING' });
  expect(missingRule.data.status).toBe('recovery-only');
  await rename(heldRule, rule);
  expect((await health()).data.vaultSource.status).toBe('ready');

  const required = join(vaultRoot, '03大讲堂');
  const heldDirectory = join(workspace, 'held-directory');
  await rename(required, heldDirectory);
  expect((await health()).data.vaultSource).toEqual({ status: 'unavailable', reason: 'VAULT_UNAVAILABLE' });
  await rename(heldDirectory, required);

  const movedRoot = join(workspace, 'moved-vault');
  await rename(vaultRoot, movedRoot);
  try {
    const missingRoot = await health();
    expect(missingRoot.data.vaultSource).toEqual({ status: 'unavailable', reason: 'VAULT_UNAVAILABLE' });
    expect(JSON.stringify(missingRoot)).not.toContain(workspace);
    await mkdir(vaultRoot);
    expect((await health()).data.vaultSource).toEqual({ status: 'unavailable', reason: 'VAULT_UNAVAILABLE' });
    await rm(vaultRoot, { recursive: true });
  } finally { await rename(movedRoot, vaultRoot); }
  const restored = await health();
  expect(restored.data.vaultSource.status).toBe('ready');
  expect(restored.data.index.version).toBe(before.data.index.version);
  expect(reads).not.toHaveBeenCalled();
  expect(lists).not.toHaveBeenCalled();
});
