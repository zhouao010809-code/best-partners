import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLIPPER_EXTENSION_ID, CLIPPER_HOST_NAME } from '../shared/api/clipper.js';
import { parseClipperHostConfig } from './clipper-host.js';

export type ClipperBridgeConfig = { version: 1; vaultRoot: string; token: string; extensionId: string };
export function hostManifest(wrapperPath: string) { return { name: CLIPPER_HOST_NAME, description: '最佳拍档浏览器收藏桥接', path: wrapperPath, type: 'stdio', allowed_origins: [`chrome-extension://${CLIPPER_EXTENSION_ID}/`] }; }
export function clipperPaths(home = homedir()) { return { chrome: join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${CLIPPER_HOST_NAME}.json`), edge: join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts', `${CLIPPER_HOST_NAME}.json`) }; }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
async function writePrivateFile(path: string, content: string, mode: number): Promise<void> {
  const file = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
  try { await file.writeFile(content); } finally { await file.close(); }
  await fs.chmod(path, mode);
}
export function createBridgeConfig(vaultRoot: string): ClipperBridgeConfig { return { version: 1, vaultRoot, token: randomUUID(), extensionId: CLIPPER_EXTENSION_ID }; }
export async function readClipperBridgeConfig(configPath: string): Promise<ClipperBridgeConfig> {
  const stat = await fs.lstat(configPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error('Native host 配置权限无效');
  return parseClipperHostConfig(JSON.parse(await fs.readFile(configPath, 'utf8'))) as ClipperBridgeConfig;
}
export async function installClipperHost(opts: { executablePath: string; configPath: string; vaultRoot?: string; home?: string; wrapperPath?: string }) {
  const paths = clipperPaths(opts.home); const wrapperPath = opts.wrapperPath ?? join(dirname(opts.configPath), 'clipper-host-wrapper');
  await fs.mkdir(dirname(opts.configPath), { recursive: true, mode: 0o700 });
  let config: ClipperBridgeConfig;
  try { config = await readClipperBridgeConfig(opts.configPath); } catch { if (opts.vaultRoot === undefined) throw new Error('需要指定大脑文件夹'); config = createBridgeConfig(opts.vaultRoot); }
  if (opts.vaultRoot !== undefined) config = { ...config, vaultRoot: opts.vaultRoot };
  await writePrivateFile(opts.configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
  const wrapper = `#!/bin/sh\nexec ${shellQuote(opts.executablePath)} --clipper-host "$@"\n`;
  await writePrivateFile(wrapperPath, wrapper, 0o755);
  for (const path of Object.values(paths)) { await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writePrivateFile(path, JSON.stringify(hostManifest(wrapperPath), null, 2), 0o600); }
  return { ...paths, paths, configPath: opts.configPath, wrapperPath, token: config.token };
}
export async function uninstallClipperHost(opts: { configPath?: string; wrapperPath?: string; home?: string }) { const paths = clipperPaths(opts.home); await Promise.all(Object.values(paths).map((p) => fs.rm(p, { force: true }))); if (opts.configPath) await fs.rm(opts.configPath, { force: true }); if (opts.wrapperPath) await fs.rm(opts.wrapperPath, { force: true }); }
