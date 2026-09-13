import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIPPER_EXTENSION_ID, CLIPPER_HOST_NAME } from '../shared/api/clipper.js';
export function hostManifest(executablePath: string) { return { name: CLIPPER_HOST_NAME, description: '最佳拍档浏览器收藏桥接', path: executablePath, type: 'stdio', allowed_origins: [`chrome-extension://${CLIPPER_EXTENSION_ID}/`] }; }
export function clipperPaths(home = homedir()) { return { chrome: join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${CLIPPER_HOST_NAME}.json`), edge: join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts', `${CLIPPER_HOST_NAME}.json`) }; }
export async function installClipperHost(opts: { executablePath: string; configPath: string; home?: string }) { const paths = clipperPaths(opts.home); for (const path of Object.values(paths)) { await fs.mkdir(join(path, '..'), { recursive: true }); await fs.writeFile(path, JSON.stringify(hostManifest(opts.executablePath), null, 2), { mode: 0o600 }); } await fs.chmod(opts.configPath, 0o600).catch(() => undefined); return paths; }
export async function uninstallClipperHost(opts: { configPath?: string; home?: string }) { const paths = clipperPaths(opts.home); await Promise.all(Object.values(paths).map(p => fs.rm(p, { force: true }))); if (opts.configPath) await fs.rm(opts.configPath, { force: true }); }
