import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const requiredHeaders = ['node_api.h', 'js_native_api.h', 'node_api_types.h', 'js_native_api_types.h', 'node_version.h'];

function absoluteDirectory(path: string, code: string): string {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error(`${code}: expected an absolute directory path`);
  return resolve(path);
}

async function matchesVersion(headers: string, version: string): Promise<boolean> {
  try {
    for (const file of requiredHeaders) {
      const entry = await stat(resolve(headers, file));
      if (!entry.isFile() || entry.size === 0) return false;
    }
    const source = await readFile(resolve(headers, 'node_version.h'), 'utf8');
    const parts = ['MAJOR', 'MINOR', 'PATCH'].map(part => new RegExp(`^#define[ \\t]+NODE_${part}_VERSION[ \\t]+(\\d+)(?:\\s|$)`, 'mu').exec(source)?.[1]);
    return parts.every(part => part !== undefined) && parts.join('.') === version;
  } catch { return false; }
}

async function installNodeHeaders(version: string, cache: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const cli = require.resolve('node-gyp/bin/node-gyp.js');
  // node-gyp's npm config environment overrides CLI flags. Keep proxy/CA
  // settings, but do not let inherited targets or tarballs change this build.
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/^npm_(?:config_|package_config_node_gyp_)(?:target|devdir|nodedir|tarball|ensure|directory|dist[-_]?url)$/iu.test(key)));
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(resolve(cache, '.xiaozhao-node-headers-'));
  process.stdout.write(`Preparing Node ${version} headers in ${cache}\n`);
  try {
    // A fresh staging cache avoids --ensure accepting incomplete old installs,
    // and keeps node-gyp's failure rollback away from the user's existing cache.
    const result = await promisify(execFile)(process.execPath, [cli, 'install', `--target=${version}`, `--devdir=${staging}`, '--ensure'],
      { env, timeout: 120_000, maxBuffer: 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (!await matchesVersion(resolve(staging, version, 'include/node'), version)) throw new Error('NODE_HEADERS_DOWNLOAD_INVALID');
    await cp(resolve(staging, version), resolve(cache, version), { recursive: true });
  } catch (cause) {
    throw new Error('NODE_HEADERS_INSTALL_FAILED: check the network or set XIAOZHAO_NODE_HEADERS to matching offline headers', { cause });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Resolve headers for the running Node only; an explicit offline override never falls back. */
export async function resolveNodeHeaders(input: {
  version?: string;
  environment?: NodeJS.ProcessEnv;
  install?: (version: string, cache: string) => Promise<void>;
} = {}): Promise<string> {
  const version = input.version ?? process.versions.node;
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) throw new Error('NODE_HEADERS_VERSION_INVALID: expected a stable Node version');
  const environment = input.environment ?? process.env;
  if (environment.XIAOZHAO_NODE_HEADERS !== undefined) {
    const headers = absoluteDirectory(environment.XIAOZHAO_NODE_HEADERS, 'NODE_HEADERS_OVERRIDE_INVALID');
    if (!await matchesVersion(headers, version)) throw new Error(`NODE_HEADERS_OVERRIDE_INVALID: expected complete Node ${version} headers in ${headers}`);
    return headers;
  }
  const cache = absoluteDirectory(environment.XIAOZHAO_NODE_GYP_CACHE ?? resolve(homedir(), 'Library/Caches/node-gyp'), 'NODE_HEADERS_CACHE_INVALID');
  const headers = resolve(cache, version, 'include/node');
  if (!await matchesVersion(headers, version)) {
    await (input.install ?? ((target, directory) => installNodeHeaders(target, directory, environment)))(version, cache);
    if (!await matchesVersion(headers, version)) throw new Error(`NODE_HEADERS_INSTALL_INVALID: expected complete Node ${version} headers in ${headers}`);
  }
  return headers;
}
