import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const runFile = promisify(execFile);
const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const safePath = z.string().min(1).refine((path) => !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') && path.split('/').every((part) => part !== '.' && part !== '..' && part !== '' && !part.startsWith('.')));
const fileSchema = z.object({ path: safePath, size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const artifactSchema = fileSchema.extend({ packagedPath: safePath }).strict();
const stampSchema = z.object({ dev: z.string(), ino: z.string(), size: z.string(), mtimeNs: z.string(), ctimeNs: z.string() }).strict();
const sessionSchema = z.object({
  schemaVersion: z.literal(1), startedAt: z.string().datetime(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  node: z.string(), sources: z.array(fileSchema), outputStamps: z.array(z.object({ path: safePath, stamp: stampSchema }).strict())
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(1), builtAt: z.string().datetime(), version: z.string(), gitCommit: z.string().nullable(), dirty: z.boolean(),
  node: z.string(), electron: z.string(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sources: z.array(fileSchema), artifacts: z.array(artifactSchema).min(1),
  coverage: z.object({ artifacts: z.literal('listed-paths-only'), dependencies: z.literal('not-hashed'),
    electronFramework: z.literal('not-hashed'), icon: z.literal('reference-and-presence') }).strict()
}).strict();
export type BuildManifest = z.infer<typeof manifestSchema>;
const SOURCE_DIRECTORIES = ['src', 'scripts', 'native', 'browser-extension', 'templates', 'assets', 'mcp-server', 'company-mcp-server'];
const DISTRIBUTION_DIRECTORIES = [
  ['dist/client', 'app/dist/client'], ['dist/server', 'app/dist/server'], ['dist/electron', 'app/dist/electron'],
  ['templates/default-vault', 'templates/default-vault'], ['browser-extension', 'clipper-extension']
] as const;
const DISTRIBUTION_FILES = [
  ['dist/native/atomic-file-helper', 'app/dist/native/atomic-file-helper'],
  ['dist/native/personal-archive.node', 'app/dist/native/personal-archive.node'],
  ['dist/best-partners-clipper.zip', 'best-partners-clipper.zip']
] as const;
const REGENERATED_DIRECTORIES = ['dist/client', 'dist/server', 'dist/electron'] as const;
const REQUIRED_OUTPUTS = ['dist/client/index.html', 'dist/server/index.js', 'dist/electron/main.js', 'dist/electron/preload.cjs'] as const;
const SESSION_PATH = 'dist/.build-provenance-session.json';
const ZIP_PATH = 'dist/best-partners-clipper.zip';
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
function stamp(info: BigIntStats) {
  return { dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) };
}

async function filesUnder(root: string, path: string): Promise<string[]> {
  if (!(await lstat(join(root, path))).isDirectory()) throw Error('BUILD_DIRECTORY_UNSAFE');
  const output: string[] = [];
  async function visit(directory: string) {
    for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const candidate = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw Error('BUILD_SYMLINK_UNSUPPORTED');
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) output.push(candidate);
      else throw Error('BUILD_SPECIAL_FILE_UNSUPPORTED');
    }
  }
  await visit(path); return output;
}
async function fileRecord(root: string, path: string) {
  const info = await lstat(join(root, path), { bigint: true });
  if (!info.isFile()) throw Error('BUILD_FILE_UNSAFE');
  const bytes = await readFile(join(root, path));
  const after = await lstat(join(root, path), { bigint: true });
  if (!after.isFile() || JSON.stringify(stamp(info)) !== JSON.stringify(stamp(after))) throw Error('BUILD_FILE_CHANGED_DURING_READ');
  return { path, size: bytes.length, sha256: digest(bytes) };
}
async function sourceRecords(root: string) {
  const paths: string[] = [];
  for (const directory of SOURCE_DIRECTORIES) {
    try { await lstat(join(root, directory)); } catch (error) { if (isMissing(error)) continue; throw error; }
    paths.push(...await filesUnder(root, directory));
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && /^(?:package(?:-lock)?\.json|.*\.config\.(?:ts|js)|tsconfig.*\.json)$/u.test(entry.name)) paths.push(entry.name);
  }
  return Promise.all(paths.sort().map((path) => fileRecord(root, path)));
}
async function artifactRecords(root: string) {
  const artifacts: BuildManifest['artifacts'] = [];
  for (const [source, packaged] of DISTRIBUTION_DIRECTORIES) {
    const paths = await filesUnder(root, source);
    if (paths.length === 0) throw Error('BUILD_ARTIFACT_MISSING');
    for (const path of paths) artifacts.push({ ...await fileRecord(root, path), packagedPath: `${packaged}/${relative(source, path).split(sep).join('/')}` });
  }
  for (const [path, packagedPath] of DISTRIBUTION_FILES) {
    try { await lstat(join(root, path)); } catch (error) { if (isMissing(error) && path.endsWith('.zip')) continue; throw Error('BUILD_ARTIFACT_MISSING'); }
    artifacts.push({ ...await fileRecord(root, path), packagedPath });
  }
  if (REQUIRED_OUTPUTS.some(path => !artifacts.some(item => item.path === path))) throw Error('BUILD_ARTIFACT_MISSING');
  return artifacts.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
async function gitIdentity(root: string) {
  try {
    const commit = await runFile('git', ['rev-parse', 'HEAD'], { cwd: root });
    const status = await runFile('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root });
    return { gitCommit: commit.stdout.trim(), dirty: status.stdout.trim() !== '' };
  } catch { return { gitCommit: null, dirty: true }; }
}
async function atomicJson(root: string, path: string, value: unknown) {
  await mkdir(join(root, 'dist'), { recursive: true });
  const temporary = join(root, 'dist', `.build-provenance-${randomUUID()}.json`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(root, path));
  } finally { await rm(temporary, { force: true }); }
}
async function outputStamps(root: string, missingAllowed = false) {
  const records: z.infer<typeof sessionSchema>['outputStamps'] = [];
  for (const directory of REGENERATED_DIRECTORIES) {
    let paths: string[];
    try { paths = await filesUnder(root, directory); } catch (error) { if (missingAllowed && isMissing(error)) continue; throw error; }
    if (!missingAllowed && paths.length === 0) throw Error('BUILD_ARTIFACT_MISSING');
    for (const path of paths) {
      const info = await lstat(join(root, path), { bigint: true });
      if (!info.isFile()) throw Error('BUILD_FILE_UNSAFE');
      records.push({ path, stamp: stamp(info) });
    }
  }
  return records;
}
export async function beginBuildProvenance(root = rootDirectory) {
  const sources = await sourceRecords(root);
  const session = sessionSchema.parse({ schemaVersion: 1, startedAt: new Date().toISOString(), node: process.versions.node,
    sourceSha256: digest(JSON.stringify(sources)), sources, outputStamps: await outputStamps(root, true) });
  await atomicJson(root, SESSION_PATH, session);
  return session;
}
export async function writeBuildManifest(root = rootDirectory): Promise<BuildManifest> {
  let session: z.infer<typeof sessionSchema>;
  try { session = sessionSchema.parse(JSON.parse(await readFile(join(root, SESSION_PATH), 'utf8'))); }
  catch (error) { if (isMissing(error)) throw Error('BUILD_SESSION_REQUIRED'); throw error; }
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string; devDependencies: { electron: string } };
  const sources = await sourceRecords(root);
  if (session.sourceSha256 !== digest(JSON.stringify(session.sources)) || session.sourceSha256 !== digest(JSON.stringify(sources))) throw Error('BUILD_SOURCE_CHANGED');
  if (session.node !== process.versions.node) throw Error('BUILD_NODE_CHANGED');
  const previous = new Map(session.outputStamps.map(item => [item.path, item.stamp]));
  const outputs = await outputStamps(root);
  if (outputs.some(item => JSON.stringify(item.stamp) === JSON.stringify(previous.get(item.path)))) throw Error('BUILD_OUTPUT_NOT_REGENERATED');
  const manifest: BuildManifest = manifestSchema.parse({ schemaVersion: 1, builtAt: new Date().toISOString(), version: packageJson.version,
    ...await gitIdentity(root), node: process.versions.node, electron: packageJson.devDependencies.electron,
    sourceSha256: digest(JSON.stringify(sources)), sources, artifacts: await artifactRecords(root),
    coverage: { artifacts: 'listed-paths-only', dependencies: 'not-hashed', electronFramework: 'not-hashed', icon: 'reference-and-presence' } });
  if (session.sourceSha256 !== digest(JSON.stringify(await sourceRecords(root)))) throw Error('BUILD_SOURCE_CHANGED');
  if (JSON.stringify(outputs) !== JSON.stringify(await outputStamps(root))) throw Error('BUILD_ARTIFACT_CHANGED');
  await atomicJson(root, 'dist/build-manifest.json', manifest);
  await rm(join(root, SESSION_PATH));
  return manifest;
}
async function loadManifest(root: string): Promise<BuildManifest> {
  return manifestSchema.parse(JSON.parse(await readFile(join(root, 'dist', 'build-manifest.json'), 'utf8')));
}
async function verifyRecordedBuild(root: string, manifest: BuildManifest, refreshZip = false) {
  const sources = await sourceRecords(root);
  if (manifest.sourceSha256 !== digest(JSON.stringify(manifest.sources)) || manifest.sourceSha256 !== digest(JSON.stringify(sources))) throw Error('BUILD_SOURCE_CHANGED');
  const actualArtifacts = await artifactRecords(root);
  const included = (item: BuildManifest['artifacts'][number]) => !refreshZip || item.path !== ZIP_PATH;
  if (JSON.stringify(manifest.artifacts.filter(included)) !== JSON.stringify(actualArtifacts.filter(included))) throw Error('BUILD_ARTIFACT_CHANGED');
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string; devDependencies: { electron: string } };
  if (packageJson.version !== manifest.version || packageJson.devDependencies.electron !== manifest.electron) throw Error('BUILD_VERSION_CHANGED');
  return { status: 'passed' as const, sourceSha256: manifest.sourceSha256, artifacts: manifest.artifacts.length, version: manifest.version };
}
export async function verifyBuildManifest(root = rootDirectory) {
  return verifyRecordedBuild(root, await loadManifest(root));
}
export async function refreshExtensionManifest(root = rootDirectory): Promise<BuildManifest> {
  const original = await loadManifest(root);
  await verifyRecordedBuild(root, original, true);
  const zip = { ...await fileRecord(root, ZIP_PATH), packagedPath: 'best-partners-clipper.zip' };
  const manifest = manifestSchema.parse({ ...original, artifacts: [...original.artifacts.filter(item => item.path !== ZIP_PATH), zip].sort((a, b) => a.path.localeCompare(b.path, 'en')) });
  await verifyRecordedBuild(root, manifest);
  await atomicJson(root, 'dist/build-manifest.json', manifest);
  return manifest;
}
async function verifyPackagedIdentity(appRoot: string, repository: string, manifest: BuildManifest) {
  const resources = join(appRoot, 'Contents', 'Resources');
  try {
    // @electron/packager removes development metadata; compare the fields that
    // govern the packaged entry point and runtime dependency declarations.
    const original = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')) as Record<string, unknown>;
    const packagedRecord = await fileRecord(resources, 'app/package.json');
    const packaged = JSON.parse(await readFile(join(resources, packagedRecord.path), 'utf8')) as Record<string, unknown>;
    const runtimeFields = ['name', 'version', 'main', 'type', 'imports', 'exports', 'dependencies', 'optionalDependencies', 'peerDependencies'];
    for (const field of runtimeFields) if (JSON.stringify(original[field]) !== JSON.stringify(packaged[field])) throw Error('PACKAGED_IDENTITY_CHANGED');
    const main = safePath.parse(packaged.main);
    if (!manifest.artifacts.some(item => item.packagedPath === `app/${main}`)) throw Error('PACKAGED_IDENTITY_CHANGED');
    await fileRecord(resources, `app/${main}`);
    await fileRecord(appRoot, 'Contents/Info.plist');
    // plist is also the parser used by the installed packager. A string import
    // keeps its untyped CommonJS boundary limited to this explicit interface.
    const { default: plist }: { default: { parse(xml: string): unknown } } = await import('plist' as string);
    const info = plist.parse(await readFile(join(appRoot, 'Contents/Info.plist'), 'utf8')) as Record<string, unknown>;
    const expected = { CFBundleName: '最佳拍档', CFBundleDisplayName: '最佳拍档', CFBundleExecutable: '最佳拍档',
      CFBundleIdentifier: 'local.xiaozhao.brain', CFBundlePackageType: 'APPL', CFBundleShortVersionString: manifest.version, CFBundleVersion: manifest.version };
    for (const [key, value] of Object.entries(expected)) if (info[key] !== value) throw Error('PACKAGED_IDENTITY_CHANGED');
    const executable = await lstat(join(appRoot, 'Contents/MacOS/最佳拍档'));
    if (!executable.isFile() || executable.size === 0 || (executable.mode & 0o111) === 0) throw Error('PACKAGED_IDENTITY_CHANGED');
    // Packager can transcode icons. Verify the plist reference and presence,
    // rather than claiming the source image hash identifies the packaged icon.
    const icon = safePath.parse(info.CFBundleIconFile);
    if (icon !== 'electron.icns') throw Error('PACKAGED_IDENTITY_CHANGED');
    const iconRecord = await fileRecord(resources, icon);
    if (iconRecord.size === 0) throw Error('PACKAGED_IDENTITY_CHANGED');
  } catch { throw Error('PACKAGED_IDENTITY_CHANGED'); }
}
export async function verifyPackagedDesktop(appRoot: string, repository = rootDirectory) {
  const result = await verifyBuildManifest(repository);
  const manifest = await loadManifest(repository);
  const resources = join(appRoot, 'Contents', 'Resources');
  const embedded = manifestSchema.parse(JSON.parse(await readFile(join(resources, 'build-manifest.json'), 'utf8')));
  if (JSON.stringify(embedded) !== JSON.stringify(manifest)) throw Error('PACKAGED_MANIFEST_CHANGED');
  const actualPaths: string[] = [];
  for (const [, packaged] of DISTRIBUTION_DIRECTORIES) actualPaths.push(...await filesUnder(resources, packaged));
  for (const [, packaged] of DISTRIBUTION_FILES) {
    try { await lstat(join(resources, packaged)); actualPaths.push(packaged); } catch { /* comparison catches missing */ }
  }
  if (JSON.stringify(actualPaths.sort()) !== JSON.stringify(manifest.artifacts.map((item) => item.packagedPath).sort())) throw Error('PACKAGED_ARTIFACT_CHANGED');
  for (const item of manifest.artifacts) {
    const actual = await fileRecord(resources, item.packagedPath);
    if (actual.size !== item.size || actual.sha256 !== item.sha256) throw Error('PACKAGED_ARTIFACT_CHANGED');
  }
  await verifyPackagedIdentity(appRoot, repository, manifest);
  return { ...result, artifactScope: manifest.coverage.artifacts, dependencyScope: manifest.coverage.dependencies,
    electronFrameworkScope: manifest.coverage.electronFramework, iconScope: manifest.coverage.icon };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--begin', '--write', '--verify', '--refresh-extension'].includes(args[0]!)) throw Error('BUILD_PROVENANCE_ARGUMENT_REQUIRED');
  if (args[0] === '--verify') { process.stdout.write(`${JSON.stringify(await verifyBuildManifest())}\n`); return; }
  const result = args[0] === '--begin' ? await beginBuildProvenance() : args[0] === '--write' ? await writeBuildManifest() : await refreshExtensionManifest();
  process.stdout.write(`${JSON.stringify({ status: args[0] === '--begin' ? 'started' : 'recorded', sourceSha256: result.sourceSha256 })}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(() => { process.stderr.write('BUILD_PROVENANCE_FAILED\n'); process.exitCode = 1; });
