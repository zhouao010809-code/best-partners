import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKnowledgeNoteForRead } from '../src/server/rules/read-compatible-notes.js';
import { RULE_APPROVAL_SOURCE_PATHS } from '../src/shared/domain/rule-approval.js';
import { lintVault, type VaultLintReport } from './vault-lint.js';
import { verificationPlan } from './run-verification.js';
import { verifyBuildManifest } from './build-provenance.js';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_DIRECTORIES = ['00大脑规则', '01图书馆', '02知识库', '03大讲堂'];
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;
type Issue = { code: string; severity: 'warning' | 'error'; path?: string };
type SourceLink = { path: string; target: string; status: 'unique' | 'missing' | 'ambiguous'; candidates: string[] };
export type BrainDoctorOptions = { vaultRoot: string; repositoryRoot?: string; userDataRoot?: string; snapshotRoot?: string };

function within(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder === '' || (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`));
}
function sufficientNode(version: string): boolean {
  const parts = version.split('.').map(Number);
  return (parts[0] ?? 0) > 22 || (parts[0] === 22 && ((parts[1] ?? 0) > 22 || (parts[1] === 22 && (parts[2] ?? 0) >= 3)));
}
async function regularFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}
async function collectFiles(root: string, start: string, issues: Issue[]): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) { issues.push({ code: 'SYMLINK_SKIPPED', severity: 'warning', path: relative(root, path) }); continue; }
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(relative(root, path).split(sep).join('/'));
    }
  }
  await visit(join(root, start));
  return result;
}

export function resolveSourceLink(target: string, sourcePaths: readonly string[]): SourceLink['candidates'] {
  const normalized = target.normalize('NFC').replace(/^\[\[|\]\]$/gu, '').split('|')[0]!.split('#')[0]!.trim();
  if (!normalized || isAbsolute(normalized) || normalized.split('/').some((part) => part === '..' || part === '.')) return [];
  const match = /\.[a-z0-9]+$/iu.test(normalized) ? normalized : `${normalized}.md`;
  const exact = sourcePaths.filter((path) => path.normalize('NFC') === match);
  if (exact.length > 0) return exact;
  return sourcePaths.filter((path) => {
    const candidate = path.normalize('NFC');
    return candidate === match || candidate.endsWith(`/${match}`);
  });
}

export async function runBrainDoctor(options: BrainDoctorOptions) {
  const issues: Issue[] = [];
  const repository = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const root = resolve(options.vaultRoot);
  let canonicalRoot: string | undefined;
  const directoryStatus: Record<string, boolean> = {};
  try { canonicalRoot = await realpath(root); if (!(await stat(canonicalRoot)).isDirectory()) canonicalRoot = undefined; } catch { /* report below */ }
  for (const name of REQUIRED_DIRECTORIES) {
    let valid = false;
    if (canonicalRoot) {
      try { const path = await realpath(join(canonicalRoot, name)); valid = within(canonicalRoot, path) && (await stat(path)).isDirectory(); } catch { /* invalid */ }
    }
    directoryStatus[name] = valid;
    if (!valid) issues.push({ code: 'REQUIRED_DIRECTORY_INVALID', severity: 'error', path: name });
  }
  const ruleFiles: { path: string; sha256: string | null }[] = [];
  for (const path of RULE_APPROVAL_SOURCE_PATHS) {
    let hash: string | null = null;
    if (canonicalRoot && directoryStatus['00大脑规则']) {
      try {
        const absolute = join(canonicalRoot, path);
        if ((await lstat(absolute)).isFile()) hash = createHash('sha256').update(await readFile(absolute)).digest('hex');
      } catch { /* missing */ }
    }
    ruleFiles.push({ path, sha256: hash });
    if (!hash) issues.push({ code: 'RULE_FILE_MISSING', severity: 'error', path });
  }
  let lint: VaultLintReport | undefined;
  const sourceLinks: SourceLink[] = [];
  if (canonicalRoot && REQUIRED_DIRECTORIES.every((name) => directoryStatus[name])) {
    const library = await collectFiles(canonicalRoot, '01图书馆', issues);
    const knowledge = (await collectFiles(canonicalRoot, '02知识库', issues)).filter((path) => path.endsWith('.md'));
    const oversized = (await Promise.all([...library.filter((path) => path.toLowerCase().endsWith('.md')), ...knowledge].map(async (path) =>
      (await lstat(join(canonicalRoot!, path))).size > MAX_MARKDOWN_BYTES ? path : undefined))).filter((path): path is string => path !== undefined);
    for (const path of oversized) issues.push({ code: 'MARKDOWN_TOO_LARGE', severity: 'error', path });
    if (oversized.length === 0) {
      lint = await lintVault(canonicalRoot);
      issues.push(...lint.issues.map(({ code, path, severity }) => ({ code, path, severity })));
    }
    for (const path of knowledge.filter((path) => !oversized.includes(path))) {
      const parsed = parseKnowledgeNoteForRead(await readFile(join(canonicalRoot, path)), path);
      for (const rawTarget of parsed.record?.sourceMaterials ?? []) {
        const target = rawTarget.split('|')[0]!.split('#')[0]!.trim();
        const candidates = resolveSourceLink(target, [...library, ...knowledge]);
        const status = candidates.length === 1 ? 'unique' : candidates.length === 0 ? 'missing' : 'ambiguous';
        sourceLinks.push({ path, target, status, candidates });
        if (status !== 'unique') issues.push({ code: status === 'missing' ? 'SOURCE_LINK_MISSING' : 'SOURCE_LINK_AMBIGUOUS', severity: 'warning', path });
        else if (!candidates[0]!.startsWith('01图书馆/')) issues.push({ code: 'SOURCE_LINK_NOT_LIBRARY', severity: 'warning', path });
      }
    }
  }
  const packageJson = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')) as { version: string; engines: { node: string }; devDependencies: { electron: string }; scripts: Record<string, string> };
  if (!sufficientNode(process.versions.node)) issues.push({ code: 'NODE_VERSION_UNSUPPORTED', severity: 'error' });
  const discoveries: { config: string; directory: string; files: number; covered: boolean }[] = [];
  let gatesAvailable = true;
  try {
    const plan = verificationPlan('full', { platform: process.platform, arch: process.arch });
    for (const discovery of plan.discoveries) {
      const paths = await collectFiles(repository, discovery.directory, []);
      const files = paths.filter((path) => /\.test\.tsx?$/u.test(path)).length;
      const config = await readFile(join(repository, discovery.config), 'utf8');
      const commandName = { 'tests/unit': 'test:unit', 'tests/integration': 'test:integration', 'tests/component': 'test:component',
        'tests/native': 'test:native', 'tests/archive': 'test:archive', 'tests/mcp': 'test:mcp', 'tests/company-mcp': 'test:company-mcp' }[discovery.directory];
      const command = commandName ? packageJson.scripts[commandName] ?? '' : '';
      const tokens = command.split(/\s+/u);
      // A child file or hand-maintained list is not directory discovery. Company MCP
      // deliberately lets its dedicated config select the whole test directory.
      const directoryArgument = tokens.includes(discovery.directory) || discovery.directory === 'tests/company-mcp';
      const covered = config.includes(`${discovery.directory}/**/`) && files > 0 && !!commandName
        && plan.checks.includes(commandName) && tokens.includes(discovery.config) && directoryArgument;
      discoveries.push({ ...discovery, files, covered });
      if (!covered) issues.push({ code: 'TEST_DISCOVERY_GAP', severity: 'error', path: discovery.directory });
    }
    const expected = ['tests/unit', 'tests/integration', 'tests/component', 'tests/native', 'tests/archive', 'tests/mcp', 'tests/company-mcp'];
    for (const directory of expected) if (!discoveries.some((entry) => entry.directory === directory)) issues.push({ code: 'TEST_DISCOVERY_GAP', severity: 'error', path: directory });
  } catch {
    gatesAvailable = false;
    issues.push({ code: 'FULL_GATE_UNAVAILABLE', severity: 'warning' });
  }
  let state: { expectedCacheKey: string; present: boolean; cacheDirectories: number } | undefined;
  if (canonicalRoot && options.userDataRoot) {
    const userData = resolve(options.userDataRoot);
    if (within(canonicalRoot, userData) || within(userData, canonicalRoot)) issues.push({ code: 'STATE_ROOT_OVERLAP', severity: 'error' });
    const identity = await stat(canonicalRoot, { bigint: true });
    const expectedCacheKey = createHash('sha256').update(JSON.stringify([canonicalRoot, String(identity.dev), String(identity.ino)])).digest('hex');
    let cacheDirectories = 0;
    try { cacheDirectories = (await readdir(join(userData, 'vaults'), { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name)).length; } catch { /* new userData */ }
    state = { expectedCacheKey, present: await regularFile(join(userData, 'vaults', expectedCacheKey, 'state.sqlite3')), cacheDirectories };
    if (!state.present) issues.push({ code: 'CURRENT_VAULT_STATE_ABSENT', severity: 'warning' });
  }
  let snapshot: Record<string, unknown> | undefined;
  if (options.snapshotRoot) {
    try {
      const { verifyPersonalBackup } = await import('../src/server/operations/personal-backup.js');
      const verified = await verifyPersonalBackup(options.snapshotRoot);
      snapshot = { snapshotIntegrity: verified.snapshotIntegrity, sqliteIntegrity: verified.sqliteIntegrity,
        applicationRestore: verified.applicationRestore, requiresIdentityRebind: verified.requiresIdentityRebind,
        files: verified.manifest.fileCount, bytes: verified.manifest.totalBytes, databases: verified.databases };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'SNAPSHOT_CHECK_FAILED';
      issues.push({ code, severity: 'error' });
      // This code is raised only after the original and copied manifest trees pass.
      const sqliteFailed = code === 'PERSONAL_BACKUP_SQLITE_INTEGRITY_FAILED';
      snapshot = { snapshotIntegrity: sqliteFailed ? 'passed' : 'failed',
        sqliteIntegrity: sqliteFailed ? 'failed' : 'unverified',
        applicationRestore: 'unverified', requiresIdentityRebind: true };
    }
  }
  const buildManifestPresent = await regularFile(join(repository, 'dist', 'build-manifest.json'));
  let buildVerification: 'passed' | 'failed' | 'unverified' = 'unverified';
  if (!buildManifestPresent) issues.push({ code: 'BUILD_PROVENANCE_ABSENT', severity: 'warning' });
  else {
    try { await verifyBuildManifest(repository); buildVerification = 'passed'; }
    catch { buildVerification = 'failed'; issues.push({ code: 'BUILD_PROVENANCE_STALE', severity: 'warning' }); }
  }
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), root,
    environment: { node: process.versions.node, requiredNode: packageJson.engines.node, platform: process.platform, arch: process.arch, applicationVersion: packageJson.version, electron: packageJson.devDependencies.electron },
    directories: directoryStatus, rules: ruleFiles, ...(lint ? { lint } : {}), sourceLinks,
    gates: { available: gatesAvailable, discoveries },
    build: { manifestPresent: buildManifestPresent, verification: buildVerification },
    ...(state ? { state } : {}), ...(snapshot ? { snapshot } : {}),
    summary: { errors: issues.filter((issue) => issue.severity === 'error').length, warnings: issues.filter((issue) => issue.severity === 'warning').length }, issues
  };
}

function argumentsMap(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!; const equal = token.indexOf('=');
    const key = equal < 0 ? token : token.slice(0, equal);
    const value = equal < 0 ? args[++index] : token.slice(equal + 1);
    if (!['--vault', '--user-data', '--snapshot', '--output'].includes(key) || !value || value.startsWith('--') || result.has(key)) throw new Error('INVALID_ARGUMENT');
    result.set(key, value);
  }
  return result;
}
async function main(): Promise<void> {
  try {
    const args = argumentsMap(process.argv.slice(2)); const vaultRoot = args.get('--vault');
    if (!vaultRoot) throw new Error('VAULT_REQUIRED');
    const report = await runBrainDoctor({ vaultRoot,
      ...(args.has('--user-data') ? { userDataRoot: args.get('--user-data')! } : {}),
      ...(args.has('--snapshot') ? { snapshotRoot: args.get('--snapshot')! } : {}) });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.has('--output')) await writeFile(resolve(args.get('--output')!), json, { flag: 'wx', mode: 0o600 });
    process.stdout.write(json); process.exitCode = report.summary.errors > 0 ? 2 : 0;
  } catch { process.stderr.write('BRAIN_DOCTOR_FAILED\n'); process.exitCode = 2; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
