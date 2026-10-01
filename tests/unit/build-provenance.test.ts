import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { beginBuildProvenance, refreshExtensionManifest, writeBuildManifest, verifyBuildManifest, verifyPackagedDesktop, type BuildManifest } from '../../scripts/build-provenance.js';

const roots: string[] = [];
const rebuilt = ['dist/client/index.html', 'dist/server/index.js', 'dist/electron/main.js', 'dist/electron/preload.cjs'];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'build-provenance-')); roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'xiaozhao-brain-console', version: '1.0.0', main: 'dist/electron/main.js', type: 'module', devDependencies: { electron: '44.1.0' } }));
  for (const path of ['src/server', 'dist/client', 'dist/server', 'dist/electron', 'dist/native', 'browser-extension', 'templates/default-vault']) await mkdir(join(root, path), { recursive: true });
  for (const path of ['src/server/index.ts', ...rebuilt, 'dist/native/atomic-file-helper', 'dist/native/personal-archive.node', 'browser-extension/manifest.json', 'templates/default-vault/readme.md']) await writeFile(join(root, path), path);
  return root;
}
async function regenerate(root: string, paths = rebuilt) {
  for (const path of paths) { await rm(join(root, path)); await writeFile(join(root, path), path); }
}
async function recordBuild(root: string) {
  await beginBuildProvenance(root); await regenerate(root); return writeBuildManifest(root);
}
const plistText = (version = '1.0.0') => `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleName</key><string>最佳拍档</string><key>CFBundleDisplayName</key><string>最佳拍档</string>
<key>CFBundleExecutable</key><string>最佳拍档</string><key>CFBundleIdentifier</key><string>local.xiaozhao.brain</string>
<key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIconFile</key><string>electron.icns</string></dict></plist>`;
async function packageFixture(root: string, manifest: BuildManifest) {
  const app = join(root, 'package/Example.app'); const resources = join(app, 'Contents/Resources');
  for (const item of manifest.artifacts) {
    const target = join(resources, item.packagedPath); await mkdir(join(target, '..'), { recursive: true }); await cp(join(root, item.path), target);
  }
  await cp(join(root, 'dist/build-manifest.json'), join(resources, 'build-manifest.json'));
  const original = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  delete original.devDependencies; // Packager intentionally sanitizes development fields.
  await writeFile(join(resources, 'app/package.json'), JSON.stringify(original));
  await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
  await writeFile(join(app, 'Contents/MacOS/最佳拍档'), 'executable'); await chmod(join(app, 'Contents/MacOS/最佳拍档'), 0o755);
  await writeFile(join(resources, 'electron.icns'), 'transcoded icon');
  await writeFile(join(app, 'Contents/Info.plist'), plistText());
  return app;
}
describe('build provenance', () => {
  it('refuses to relabel existing dist without a build session', async () => {
    const root = await fixture();
    await expect(writeBuildManifest(root)).rejects.toThrow('BUILD_SESSION_REQUIRED');
  });
  it('requires every client, server and Electron output to be regenerated after begin', async () => {
    const root = await fixture(); await beginBuildProvenance(root);
    await expect(writeBuildManifest(root)).rejects.toThrow('BUILD_OUTPUT_NOT_REGENERATED');
    await regenerate(root, rebuilt.slice(0, 2));
    await expect(writeBuildManifest(root)).rejects.toThrow('BUILD_OUTPUT_NOT_REGENERATED');
    await regenerate(root, rebuilt.slice(2));
    await expect(writeBuildManifest(root)).resolves.toMatchObject({ node: process.versions.node });
    await expect(writeBuildManifest(root)).rejects.toThrow('BUILD_SESSION_REQUIRED');
  });
  it('refuses source changes during build and preserves the previous evidence', async () => {
    const root = await fixture(); await recordBuild(root);
    const before = await readFile(join(root, 'dist/build-manifest.json'));
    await beginBuildProvenance(root); await regenerate(root); await writeFile(join(root, 'src/server/index.ts'), 'changed');
    await expect(writeBuildManifest(root)).rejects.toThrow('BUILD_SOURCE_CHANGED');
    expect(await readFile(join(root, 'dist/build-manifest.json'))).toEqual(before);
  });
  it('refuses a partial build that loses a required entry point', async () => {
    const root = await fixture(); await beginBuildProvenance(root); await regenerate(root);
    await rm(join(root, 'dist/server/index.js')); await writeFile(join(root, 'dist/server/unrelated.js'), 'different output');
    await expect(writeBuildManifest(root)).rejects.toThrow('BUILD_ARTIFACT_MISSING');
  });
  it('refuses a build finished by a different Node runtime', async () => {
    const root = await fixture(); await beginBuildProvenance(root); await regenerate(root);
    const path = join(root, 'dist/.build-provenance-session.json'); const session = JSON.parse(await readFile(path, 'utf8'));
    session.node = '0.0.0'; await writeFile(path, JSON.stringify(session));
    await expect(writeBuildManifest(root)).rejects.toThrow('BUILD_NODE_CHANGED');
  });
  it('detects source and artifact drift without rewriting evidence', async () => {
    const root = await fixture(); await recordBuild(root);
    const before = await readFile(join(root, 'dist/build-manifest.json'));
    await expect(verifyBuildManifest(root)).resolves.toMatchObject({ status: 'passed' });
    await writeFile(join(root, 'src/server/index.ts'), 'changed');
    await expect(verifyBuildManifest(root)).rejects.toThrow('BUILD_SOURCE_CHANGED');
    expect(await readFile(join(root, 'dist/build-manifest.json'))).toEqual(before);
    await recordBuild(root); await writeFile(join(root, 'dist/client/index.html'), 'old package');
    await expect(verifyBuildManifest(root)).rejects.toThrow('BUILD_ARTIFACT_CHANGED');
  });
  it('refreshes only extension ZIP evidence and keeps original build identity', async () => {
    const root = await fixture(); const original = await recordBuild(root);
    await writeFile(join(root, 'dist/best-partners-clipper.zip'), 'new zip');
    const refreshed = await refreshExtensionManifest(root);
    expect({ ...refreshed, artifacts: original.artifacts }).toEqual(original);
    expect(refreshed.artifacts.filter(item => !item.path.endsWith('.zip'))).toEqual(original.artifacts);
    await expect(verifyBuildManifest(root)).resolves.toMatchObject({ status: 'passed' });
    await writeFile(join(root, 'dist/best-partners-clipper.zip'), 'replacement zip');
    await refreshExtensionManifest(root);
    await expect(verifyBuildManifest(root)).resolves.toMatchObject({ status: 'passed' });
  });
  it.each(['src/server/index.ts', 'dist/client/index.html'])('refuses ZIP refresh if %s changed', async path => {
    const root = await fixture(); await recordBuild(root);
    const before = await readFile(join(root, 'dist/build-manifest.json'));
    await writeFile(join(root, 'dist/best-partners-clipper.zip'), 'new zip'); await writeFile(join(root, path), 'changed');
    await expect(refreshExtensionManifest(root)).rejects.toThrow(path.startsWith('src') ? 'BUILD_SOURCE_CHANGED' : 'BUILD_ARTIFACT_CHANGED');
    expect(await readFile(join(root, 'dist/build-manifest.json'))).toEqual(before);
  });
  it('proves packaged resources match recorded artifacts and explicitly limits dependency coverage', async () => {
    const root = await fixture(); const manifest = await recordBuild(root); const app = await packageFixture(root, manifest);
    await expect(verifyPackagedDesktop(app, root)).resolves.toMatchObject({ status: 'passed', dependencyScope: 'not-hashed' });
    await writeFile(join(app, 'Contents/Resources/clipper-extension/retired.js'), 'retired');
    await expect(verifyPackagedDesktop(app, root)).rejects.toThrow('PACKAGED_ARTIFACT_CHANGED');
  });
  it.each([['name', 'other-app'], ['version', '2.0.0'], ['main', 'dist/server/index.js']])('rejects altered packaged package.json %s', async (field, value) => {
    const root = await fixture(); const app = await packageFixture(root, await recordBuild(root));
    const path = join(app, 'Contents/Resources/app/package.json'); const metadata = JSON.parse(await readFile(path, 'utf8')); metadata[field!] = value;
    await writeFile(path, JSON.stringify(metadata));
    await expect(verifyPackagedDesktop(app, root)).rejects.toThrow('PACKAGED_IDENTITY_CHANGED');
  });
  it.each(['CFBundleIdentifier', 'CFBundleExecutable', 'CFBundleShortVersionString', 'CFBundleIconFile'])('rejects altered Info.plist %s', async key => {
    const root = await fixture(); const app = await packageFixture(root, await recordBuild(root));
    await writeFile(join(app, 'Contents/Info.plist'), plistText().replace(new RegExp(`(<key>${key}</key><string>)[^<]+`), '$1unexpected'));
    await expect(verifyPackagedDesktop(app, root)).rejects.toThrow('PACKAGED_IDENTITY_CHANGED');
  });
  it('rejects a missing referenced icon', async () => {
    const root = await fixture(); const app = await packageFixture(root, await recordBuild(root));
    await rm(join(app, 'Contents/Resources/electron.icns'));
    await expect(verifyPackagedDesktop(app, root)).rejects.toThrow('PACKAGED_IDENTITY_CHANGED');
  });
  it('rejects a substituted icon reference even when the replacement exists', async () => {
    const root = await fixture(); const app = await packageFixture(root, await recordBuild(root));
    await writeFile(join(app, 'Contents/Resources/replacement.icns'), 'replacement');
    await writeFile(join(app, 'Contents/Info.plist'), plistText().replace('electron.icns', 'replacement.icns'));
    await expect(verifyPackagedDesktop(app, root)).rejects.toThrow('PACKAGED_IDENTITY_CHANGED');
  });
});
