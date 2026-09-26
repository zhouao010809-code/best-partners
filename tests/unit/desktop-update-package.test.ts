import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { packageDesktopUpdate, parseUpdatePackageArgs, type UpdatePackageCommand } from '../../scripts/lib/desktop-update-package.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-update-package-')); roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  const app = join(root, 'dist/desktop/最佳拍档-darwin-arm64/最佳拍档.app');
  await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
  await writeFile(join(app, 'Contents/Info.plist'), 'isolated fixture');
  await writeFile(join(app, 'Contents/MacOS/最佳拍档'), 'isolated executable');
  const state = { shortVersion: '1.2.3', buildVersion: '1.2.3', signature: 'developer-id', notarized: true, stapled: true, arch: 'arm64', packagingFails: false };
  const run = vi.fn<UpdatePackageCommand>(async (command, args) => {
    if (command === '/usr/libexec/PlistBuddy') return { stdout: args[1]?.includes('CFBundleShortVersionString') ? state.shortVersion : state.buildVersion, stderr: '' };
    if (command === '/usr/bin/lipo') return { stdout: state.arch, stderr: '' };
    if (command === '/usr/bin/codesign') {
      if (state.signature === 'unsigned') throw new Error('code object is not signed');
      return { stdout: '', stderr: state.signature === 'ad-hoc' ? 'Signature=adhoc\nTeamIdentifier=not set\n' : 'Authority=Developer ID Application: Fixture (ABCDEFGHIJ)\nTeamIdentifier=ABCDEFGHIJ\n' };
    }
    if (command === '/usr/sbin/spctl') {
      if (!state.notarized) throw new Error('rejected');
      return { stdout: '', stderr: 'accepted\nsource=Notarized Developer ID\n' };
    }
    if (command === '/usr/bin/xcrun') {
      expect(args.slice(0, 2)).toEqual(['stapler', 'validate']);
      if (!state.stapled) throw new Error('ticket missing');
      return { stdout: 'The validate action worked!', stderr: '' };
    }
    if (command === '/usr/bin/ditto') {
      if (args.includes('--keepParent')) await writeFile(args.at(-1)!, 'synthetic update zip');
      else await cp(args[0]!, args[1]!, { recursive: true });
      return { stdout: '', stderr: '' };
    }
    if (command === '/usr/bin/hdiutil') {
      expect(args[0]).toBe('create');
      const stage = args[args.indexOf('-srcfolder') + 1]!;
      expect(await readlink(join(stage, 'Applications'))).toBe('/Applications');
      expect((await lstat(join(stage, '最佳拍档.app'))).isDirectory()).toBe(true);
      if (state.packagingFails) throw new Error('disk image creation failed');
      await writeFile(args.at(-1)!, 'synthetic manual dmg');
      return { stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  return { root, app, state, run };
}

it('requires an explicit preview option and rejects unknown arguments', () => {
  expect(parseUpdatePackageArgs([])).toEqual({ mode: 'release' });
  expect(parseUpdatePackageArgs(['--preview'])).toEqual({ mode: 'preview' });
  expect(() => parseUpdatePackageArgs(['--unsigned'])).toThrow('未知参数');
});

it('creates only a manual DMG and checksum for an unsigned preview', async () => {
  const f = await fixture(); f.state.signature = 'unsigned';
  const result = await packageDesktopUpdate({ root: f.root, mode: 'preview', run: f.run });
  expect(result.version).toBe('1.2.3');
  expect(result.directory).toBe(join(f.root, 'dist/updates/v1.2.3'));
  expect((await readdir(result.directory)).sort()).toEqual(['SHA256SUMS', 'best-partners-1.2.3-arm64.dmg']);
  const checksum = createHash('sha256').update('synthetic manual dmg').digest('hex');
  expect(await readFile(join(result.directory, 'SHA256SUMS'), 'utf8')).toBe(`${checksum}  best-partners-1.2.3-arm64.dmg\n`);
  expect(f.run.mock.calls.some(([command]) => command === '/usr/bin/codesign')).toBe(false);
  expect(f.run.mock.calls.some(([, args]) => args.includes('--keepParent'))).toBe(false);
  expect(await readdir(join(f.root, 'dist/updates'))).toEqual(['v1.2.3']);
});

it.each(['shortVersion', 'buildVersion'] as const)('rejects a stale app %s before creating release assets', async field => {
  const f = await fixture(); f.state[field] = '1.2.2';
  await expect(packageDesktopUpdate({ root: f.root, mode: 'preview', run: f.run })).rejects.toThrow('版本不一致');
  expect(await readdir(join(f.root, 'dist/updates'))).toEqual([]);
  expect(f.run.mock.calls.some(([command]) => command === '/usr/bin/hdiutil')).toBe(false);
});

it.each(['unsigned', 'ad-hoc', 'not-notarized', 'not-stapled'] as const)('does not publish any automatic update assets for %s apps', async scenario => {
  const f = await fixture();
  if (scenario === 'unsigned' || scenario === 'ad-hoc') f.state.signature = scenario;
  if (scenario === 'not-notarized') f.state.notarized = false;
  if (scenario === 'not-stapled') f.state.stapled = false;
  await expect(packageDesktopUpdate({ root: f.root, mode: 'release', run: f.run })).rejects.toThrow('签名和公证');
  expect(await readdir(join(f.root, 'dist/updates'))).toEqual([]);
  expect(f.run.mock.calls.some(([command]) => command === '/usr/bin/hdiutil')).toBe(false);
});

it('packages a verified release with the official static JSON feed and fixed GitHub URLs', async () => {
  const f = await fixture();
  const result = await packageDesktopUpdate({ root: f.root, mode: 'release', run: f.run, now: () => new Date('2026-09-26T00:00:00.000Z') });
  expect((await readdir(result.directory)).sort()).toEqual(['RELEASES.json', 'SHA256SUMS', 'best-partners-1.2.3-arm64.dmg', 'best-partners-1.2.3-arm64.zip']);
  expect(JSON.parse(await readFile(join(result.directory, 'RELEASES.json'), 'utf8'))).toEqual({ currentRelease: '1.2.3', releases: [{
    version: '1.2.3', updateTo: { version: '1.2.3', pub_date: '2026-09-26T00:00:00.000Z', name: '最佳拍档 v1.2.3', notes: '',
      url: 'https://github.com/zhouao010809-code/best-partners/releases/download/v1.2.3/best-partners-1.2.3-arm64.zip' }
  }] });
  const sums = await readFile(join(result.directory, 'SHA256SUMS'), 'utf8');
  for (const asset of ['best-partners-1.2.3-arm64.dmg', 'best-partners-1.2.3-arm64.zip', 'RELEASES.json']) {
    expect(sums).toContain(`${createHash('sha256').update(await readFile(join(result.directory, asset))).digest('hex')}  ${asset}\n`);
  }
  expect(f.run.mock.calls.find(([command]) => command === '/usr/sbin/spctl')?.[1]).toEqual(['--assess', '--type', 'execute', '--verbose=2', expect.stringContaining('最佳拍档.app')]);
});

it('cleans incomplete output on failure and never overwrites an existing version', async () => {
  const f = await fixture(); f.state.packagingFails = true;
  await expect(packageDesktopUpdate({ root: f.root, mode: 'preview', run: f.run })).rejects.toThrow('disk image creation failed');
  expect(await readdir(join(f.root, 'dist/updates'))).toEqual([]);
  f.state.packagingFails = false;
  const published = await packageDesktopUpdate({ root: f.root, mode: 'preview', run: f.run });
  f.run.mockClear();
  await expect(packageDesktopUpdate({ root: f.root, mode: 'release', run: f.run })).rejects.toThrow('已存在');
  expect(f.run).not.toHaveBeenCalled();
  expect((await readdir(published.directory)).sort()).toEqual(['SHA256SUMS', 'best-partners-1.2.3-arm64.dmg']);
});

it('rejects unsafe version strings and incorrectly labelled architectures', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ version: '../../elsewhere' }));
  await expect(packageDesktopUpdate({ root: f.root, mode: 'preview', run: f.run })).rejects.toThrow('X.Y.Z');
  expect(f.run).not.toHaveBeenCalled();
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  f.state.arch = 'x86_64';
  await expect(packageDesktopUpdate({ root: f.root, mode: 'preview', run: f.run })).rejects.toThrow('arm64');
  expect(await readdir(join(f.root, 'dist/updates'))).toEqual([]);
});
