import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

export type UpdatePackageMode = 'preview' | 'release';
export type UpdatePackageCommand = (command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);
const execute: UpdatePackageCommand = async (command, args) => execFileAsync(command, [...args], {
  encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }
});
const repository = 'https://github.com/zhouao010809-code/best-partners';

export function parseUpdatePackageArgs(args: readonly string[]): { mode: UpdatePackageMode } {
  if (args.length === 0) return { mode: 'release' };
  if (args.length === 1 && args[0] === '--preview') return { mode: 'preview' };
  throw new Error('未知参数。使用 --preview 生成手动安装包；不带参数要求签名和公证。');
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function assertBundleVersion(app: string, version: string, run: UpdatePackageCommand): Promise<void> {
  const plist = join(app, 'Contents/Info.plist');
  for (const field of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const result = await run('/usr/libexec/PlistBuddy', ['-c', `Print :${field}`, plist]);
    if (result.stdout.trim() !== version) throw new Error(`应用版本不一致：${field}=${result.stdout.trim()}，package.json=${version}。请重新构建桌面应用。`);
  }
  const arch = await run('/usr/bin/lipo', ['-archs', join(app, 'Contents/MacOS/最佳拍档')]);
  if (arch.stdout.trim() !== 'arm64') throw new Error('安装包只支持 arm64，请使用对应架构的桌面应用。');
}

async function assertReleaseIdentity(app: string, run: UpdatePackageCommand): Promise<void> {
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    const identity = await run('/usr/bin/codesign', ['--display', '--verbose=4', app]);
    const signature = `${identity.stdout}\n${identity.stderr}`;
    if (!/^Authority=Developer ID Application: .+$/mu.test(signature) || !/^TeamIdentifier=[A-Z0-9]{10}$/mu.test(signature)) {
      throw new Error('A Developer ID Application signature is required');
    }
    const assessment = await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    if (!/^source=Notarized Developer ID$/mu.test(`${assessment.stdout}\n${assessment.stderr}`)) throw new Error('Notarization was not verified');
    await run('/usr/bin/xcrun', ['stapler', 'validate', app]);
  } catch (cause) {
    throw new Error('正式更新包的签名和公证校验未通过。请先完成 Developer ID 签名、公证并装订公证票据；当前可使用 --preview 生成手动安装 DMG。', { cause });
  }
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export async function packageDesktopUpdate(input: {
  root: string;
  mode: UpdatePackageMode;
  run?: UpdatePackageCommand;
  now?: () => Date;
}): Promise<{ version: string; mode: UpdatePackageMode; directory: string; assets: string[] }> {
  const root = resolve(input.root);
  const run = input.run ?? execute;
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error('package.json 必须包含 X.Y.Z 格式的发布版本。');
  }
  const app = join(root, 'dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app');
  const status = await lstat(app);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('请先构建有效的 最佳拍档.app 应用目录。');
  const outputRoot = join(root, 'dist/updates');
  const directory = join(outputRoot, `v${version}`);
  if (await exists(directory)) throw new Error(`发布目录已存在：${directory}。请先核对并移走旧产物，避免混用同一版本。`);
  await mkdir(outputRoot, { recursive: true });
  const temporary = await mkdtemp(join(outputRoot, `.v${version}-`));
  try {
    const diskContents = join(temporary, 'disk-contents');
    const assetsRoot = join(temporary, 'assets');
    await mkdir(diskContents); await mkdir(assetsRoot);
    const stagedApp = join(diskContents, '最佳拍档.app');
    // ditto preserves the bundle's extended attributes and signed resources.
    // Verify this exact staged copy, which is shared by the DMG and update ZIP.
    await run('/usr/bin/ditto', [app, stagedApp]);
    await assertBundleVersion(stagedApp, version, run);
    if (input.mode === 'release') await assertReleaseIdentity(stagedApp, run);
    await symlink('/Applications', join(diskContents, 'Applications'));
    const dmg = `best-partners-${version}-arm64.dmg`;
    await run('/usr/bin/hdiutil', ['create', '-volname', '最佳拍档', '-srcfolder', diskContents, '-format', 'UDZO', '-fs', 'HFS+', join(assetsRoot, dmg)]);
    const assets = [dmg];
    if (input.mode === 'release') {
      const zip = `best-partners-${version}-arm64.zip`;
      await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stagedApp, join(assetsRoot, zip)]);
      // Electron's static serverType: 'json' format, not a dynamic Squirrel response.
      const manifest = { currentRelease: version, releases: [{ version, updateTo: {
        version, pub_date: (input.now ?? (() => new Date()))().toISOString(), name: `最佳拍档 v${version}`, notes: '',
        url: `${repository}/releases/download/v${version}/${zip}`
      } }] };
      await writeFile(join(assetsRoot, 'RELEASES.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      assets.push(zip, 'RELEASES.json');
    }
    const sums: string[] = [];
    for (const asset of assets) sums.push(`${await sha256(join(assetsRoot, asset))}  ${asset}\n`);
    await writeFile(join(assetsRoot, 'SHA256SUMS'), sums.join(''));
    assets.push('SHA256SUMS');
    await rename(assetsRoot, directory);
    return { version, mode: input.mode, directory, assets };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
