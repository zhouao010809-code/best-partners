import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveNodeHeaders } from '../../scripts/node-headers.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'archive-headers-')); directories.push(directory); return directory;
}
async function seedHeaders(path: string, version: string) {
  await mkdir(path, { recursive: true });
  await Promise.all(['node_api.h', 'js_native_api.h', 'node_api_types.h', 'js_native_api_types.h'].map(name => writeFile(join(path, name), '/* test header */')));
  const [major, minor, patch] = version.split('.');
  await writeFile(join(path, 'node_version.h'), `#define NODE_MAJOR_VERSION ${major}\n#define NODE_MINOR_VERSION ${minor}\n#define NODE_PATCH_VERSION ${patch}\n`);
}

it.each(['24.8.0', process.versions.node])('uses the exact runtime version %s when its cache is available', async version => {
  const cache = await temporaryDirectory(); const headers = join(cache, version, 'include/node');
  await seedHeaders(headers, version); await seedHeaders(join(cache, '22.22.3-other', 'include/node'), '22.22.3');
  const install = vi.fn();
  expect(await resolveNodeHeaders({ version, environment: { XIAOZHAO_NODE_GYP_CACHE: cache }, install })).toBe(headers);
  expect(install).not.toHaveBeenCalled();
});

it('installs only the current version into an empty cache and validates the result', async () => {
  const cache = await temporaryDirectory(); const version = '24.8.0'; const headers = join(cache, version, 'include/node');
  const install = vi.fn(async () => { await seedHeaders(headers, version); });
  expect(await resolveNodeHeaders({ version, environment: { XIAOZHAO_NODE_GYP_CACHE: cache }, install })).toBe(headers);
  expect(install).toHaveBeenCalledExactlyOnceWith(version, cache);
});

it('rejects a successful installer that did not provide matching complete headers', async () => {
  const cache = await temporaryDirectory();
  await expect(resolveNodeHeaders({ version: '24.8.0', environment: { XIAOZHAO_NODE_GYP_CACHE: cache },
    install: async () => seedHeaders(join(cache, '24.8.0/include/node'), '22.22.3') })).rejects.toThrow('NODE_HEADERS_INSTALL_INVALID');
});

it('repairs incomplete current-version headers even when node-gyp has an installVersion marker', async () => {
  const cache = await temporaryDirectory(); const version = '24.8.0'; const headers = join(cache, version, 'include/node');
  await seedHeaders(headers, version); await rm(join(headers, 'node_api.h'));
  await writeFile(join(cache, version, 'installVersion'), '11\n');
  const other = join(cache, '22.22.3/include/node'); await seedHeaders(other, '22.22.3');
  const install = vi.fn(async () => seedHeaders(headers, version));
  expect(await resolveNodeHeaders({ version, environment: { XIAOZHAO_NODE_GYP_CACHE: cache }, install })).toBe(headers);
  expect(install).toHaveBeenCalledExactlyOnceWith(version, cache);
  expect(await readFile(join(other, 'node_api.h'), 'utf8')).toBe('/* test header */');
});

it('uses a validated offline override without installing or falling back to caches', async () => {
  const headers = await temporaryDirectory(); await seedHeaders(headers, process.versions.node);
  const install = vi.fn();
  expect(await resolveNodeHeaders({ environment: { XIAOZHAO_NODE_HEADERS: headers }, install })).toBe(headers);
  expect(install).not.toHaveBeenCalled();
});

it.each(['relative/include/node', '', '/tmp/invalid\0headers'])('rejects the malformed offline override %j before installing', async headers => {
  const install = vi.fn();
  await expect(resolveNodeHeaders({ environment: { XIAOZHAO_NODE_HEADERS: headers }, install })).rejects.toThrow('NODE_HEADERS_OVERRIDE_INVALID');
  expect(install).not.toHaveBeenCalled();
});

it.each(['wrong-version', 'missing-api-header'] as const)('rejects an offline directory with %s', async invalid => {
  const headers = await temporaryDirectory(); await seedHeaders(headers, invalid === 'wrong-version' ? '1.2.3' : process.versions.node);
  if (invalid === 'missing-api-header') await rm(join(headers, 'js_native_api.h'));
  const install = vi.fn();
  await expect(resolveNodeHeaders({ environment: { XIAOZHAO_NODE_HEADERS: headers }, install })).rejects.toThrow('NODE_HEADERS_OVERRIDE_INVALID');
  expect(install).not.toHaveBeenCalled();
});

it('rejects an invalid cache path or runtime version without running an installer', async () => {
  const install = vi.fn();
  await expect(resolveNodeHeaders({ environment: { XIAOZHAO_NODE_GYP_CACHE: 'relative-cache' }, install })).rejects.toThrow('NODE_HEADERS_CACHE_INVALID');
  await expect(resolveNodeHeaders({ version: '--latest', environment: {}, install })).rejects.toThrow('NODE_HEADERS_VERSION_INVALID');
  expect(install).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('rejects an invalid explicit offline header directory instead of using a machine-specific cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'archive-headers-')); directories.push(directory);
  await expect(promisify(execFile)(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'),
    resolve('scripts/build-sandbox-archive.ts'), '--personal'], {
    env: { ...process.env, XIAOZHAO_NODE_HEADERS: join(directory, 'missing-headers') }
  })).rejects.toThrow('NODE_HEADERS_OVERRIDE_INVALID');
});
