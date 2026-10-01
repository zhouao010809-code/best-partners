import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { RULE_BUNDLE_SOURCE_PATHS } from '../rules/rule-bundle.js';

const MANIFEST_NAME = 'manifest.json';
const CACHE_NAMES = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'GrShaderCache'] as const;
const RUNNING_MARKERS = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', '.clipper.lock', 'store.lock', 'company-server.lock.json'] as const;
const NOT_COVERED = ['external-project-originals', 'browser-pending-clipper-queue', 'system-keychain'] as const;

/** Deliberately narrow: session storage, Local Storage, updates and crash records stay backed up. */
export const PERSONAL_BACKUP_EXCLUSION_POLICY = {
  version: 1,
  directoryNames: ['node_modules'],
  userDataRootDirectories: [...CACHE_NAMES],
  runningMarkers: [...RUNNING_MARKERS],
  runningMarkerPolicy: 'reject'
} as const;

export class PersonalBackupError extends Error {
  public readonly name = 'PersonalBackupError';
  constructor(public readonly code: string) { super(code); }
}
function fail(code: string): never { throw new PersonalBackupError(code); }

const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'));
const relativePath = z.string().min(1).max(4096).refine(value => !value.includes('\0') && !value.includes('\\')
  && !value.startsWith('/') && !value.split('/').some(part => part === '' || part === '.' || part === '..'));
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z.object({ path: absolutePath, dev: z.string().regex(/^\d+$/u), ino: z.string().regex(/^\d+$/u) }).strict();
const entrySchema = z.discriminatedUnion('type', [
  z.object({ path: relativePath, type: z.literal('directory') }).strict(),
  z.object({ path: relativePath, type: z.literal('file'), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256, executable: z.boolean() }).strict()
]);
const manifestSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime(),
  source: z.object({
    vault: identity.extend({ cacheKey: sha256 }).strict(),
    userData: identity
  }).strict(),
  exclusions: z.object({ policy: z.unknown(), observed: z.array(relativePath).max(1_000_000) }).strict(),
  notCovered: z.tuple([z.literal(NOT_COVERED[0]), z.literal(NOT_COVERED[1]), z.literal(NOT_COVERED[2])]),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  entries: z.array(entrySchema).max(1_000_000)
}).strict();

export type PersonalBackupManifest = z.infer<typeof manifestSchema>;
type Entry = PersonalBackupManifest['entries'][number];
type Scope = 'vault' | 'user-data';
interface TrackedEntry { readonly entry: Entry; readonly stamp: string }
interface Tree { readonly entries: TrackedEntry[]; readonly excluded: Array<{ path: string; stamp: string }> }
interface DirectoryIdentity { readonly path: string; readonly dev: string; readonly ino: string }
interface DirectoryAuthority { readonly path: string; readonly ancestors: readonly DirectoryIdentity[] }
interface OwnedTree {
  readonly root: DirectoryAuthority;
  readonly directories: Map<string, DirectoryAuthority>;
  readonly files: Map<string, { dev: string; ino: string }>;
}
export interface PersonalBackupResult { readonly snapshotRoot: string; readonly manifest: PersonalBackupManifest }
export interface PersonalBackupVerification extends PersonalBackupResult {
  readonly snapshotIntegrity: 'passed';
  readonly sqliteIntegrity: 'passed';
  readonly applicationRestore: 'unverified';
  readonly requiresIdentityRebind: true;
  readonly databases: ReadonlyArray<{ path: string; integrity: 'passed'; foreignKeys: 'passed' }>;
}
export interface PersonalBackupOptions {
  readonly vaultRoot: string;
  readonly userDataRoot: string;
  readonly destinationRoot: string;
  readonly cold: boolean;
  readonly now?: () => Date;
}

function stamp(info: BigIntStats): string {
  return [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':');
}
function inside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function cacheKey(path: string, dev: string, ino: string): string {
  return createHash('sha256').update(JSON.stringify([path, dev, ino]), 'utf8').digest('hex');
}

function identityFor(path: string, info: BigIntStats): DirectoryIdentity {
  return { path, dev: String(info.dev), ino: String(info.ino) };
}
async function captureDirectory(input: string, code: string, unsafeCode = 'PERSONAL_BACKUP_SYMLINK_REJECTED'): Promise<DirectoryAuthority> {
  if (!absolutePath.safeParse(input).success) fail(code);
  const lexical = resolve(input);
  const parts = lexical.split(sep).filter(Boolean);
  let current: string = sep;
  const ancestors: DirectoryIdentity[] = [identityFor(sep, await fs.lstat(sep, { bigint: true }))];
  for (const part of parts) {
    current = join(current, part);
    let info: BigIntStats;
    try { info = await fs.lstat(current, { bigint: true }); } catch { fail(code); }
    if (info.isSymbolicLink()) fail(unsafeCode);
    if (!info.isDirectory()) fail(code);
    ancestors.push(identityFor(current, info));
  }
  return { path: lexical, ancestors };
}
async function directory(input: string, code: string, unsafeCode = 'PERSONAL_BACKUP_SYMLINK_REJECTED'): Promise<string> {
  return (await captureDirectory(input, code, unsafeCode)).path;
}
async function assertAuthority(authority: DirectoryAuthority, code: string): Promise<void> {
  for (const expected of authority.ancestors) {
    let info: BigIntStats;
    try { info = await fs.lstat(expected.path, { bigint: true }); } catch { fail(code); }
    if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== expected.dev || String(info.ino) !== expected.ino) fail(code);
  }
}
async function createdDirectory(path: string, parent: DirectoryAuthority, code: string): Promise<DirectoryAuthority> {
  await assertAuthority(parent, code);
  await fs.mkdir(path, { mode: 0o700 });
  await assertAuthority(parent, code);
  const info = await fs.lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) fail(code);
  const authority = { path, ancestors: [...parent.ancestors, identityFor(path, info)] };
  await assertAuthority(authority, code);
  return authority;
}
function ownedTree(root: DirectoryAuthority): OwnedTree {
  return { root, directories: new Map([[root.path, root]]), files: new Map() };
}

/** Only remove the exact nodes created by this operation. Never recurse through a replaced directory. */
async function cleanOwnedTree(tree: OwnedTree): Promise<boolean> {
  try { await assertAuthority(tree.root, 'PERSONAL_BACKUP_OUTPUT_CHANGED'); } catch { return false; }
  let safe = true;
  for (const [path, expected] of tree.files) {
    const parent = tree.directories.get(dirname(path));
    try {
      if (!parent) { safe = false; continue; }
      await assertAuthority(parent, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
      const info = await fs.lstat(path, { bigint: true });
      if (!info.isFile() || String(info.dev) !== expected.dev || String(info.ino) !== expected.ino) { safe = false; continue; }
      await fs.unlink(path);
    } catch { safe = false; }
  }
  for (const authority of [...tree.directories.values()].sort((a, b) => b.path.length - a.path.length)) {
    try {
      await assertAuthority(authority, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
      await fs.rmdir(authority.path); // Unknown new children make rmdir fail without deleting them.
    } catch { safe = false; }
  }
  return safe;
}

function relocatedTree(tree: OwnedTree, newRoot: DirectoryAuthority): OwnedTree {
  const output = ownedTree(newRoot);
  const rebase = (path: string) => join(newRoot.path, relative(tree.root.path, path));
  for (const [path, authority] of tree.directories) {
    if (path === tree.root.path) continue;
    const suffix = authority.ancestors.slice(tree.root.ancestors.length).map(point => ({ ...point, path: rebase(point.path) }));
    const rebased = rebase(path);
    output.directories.set(rebased, { path: rebased, ancestors: [...newRoot.ancestors, ...suffix] });
  }
  for (const [path, info] of tree.files) output.files.set(rebase(path), info);
  return output;
}

function excluded(path: string): boolean {
  const parts = path.split('/');
  return parts.slice(1).includes('node_modules')
    || (parts[0] === 'user-data' && parts.length === 2 && (CACHE_NAMES as readonly string[]).includes(parts[1]!));
}
function runningMarker(scope: Scope, local: string): boolean {
  const parts = local.split('/');
  const name = parts.at(-1)!;
  return (scope === 'user-data' && parts.length === 1 && ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(name))
    || (scope === 'vault' && local === '01图书馆/小兆clipper/.clipper.lock')
    || (scope === 'user-data' && ['store.lock', 'company-server.lock.json'].includes(name));
}

async function readFileStable(path: string, limit?: number): Promise<{ info: BigIntStats; hash: string; bytes?: Buffer }> {
  const before = await fs.lstat(path, { bigint: true });
  if (before.isSymbolicLink()) fail('PERSONAL_BACKUP_SYMLINK_REJECTED');
  if (!before.isFile()) fail('PERSONAL_BACKUP_SPECIAL_FILE_REJECTED');
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER) || (limit !== undefined && before.size > BigInt(limit))) fail('PERSONAL_BACKUP_SOURCE_INVALID');
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (stamp(await file.stat({ bigint: true })) !== stamp(before)) fail('PERSONAL_BACKUP_SOURCE_CHANGED');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    const chunks: Buffer[] = [];
    let consumed = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      consumed += bytesRead;
      if (BigInt(consumed) > before.size) fail('PERSONAL_BACKUP_SOURCE_CHANGED');
      hash.update(buffer.subarray(0, bytesRead));
      if (limit !== undefined) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (stamp(await file.stat({ bigint: true })) !== stamp(before)
      || stamp(await fs.lstat(path, { bigint: true })) !== stamp(before)) fail('PERSONAL_BACKUP_SOURCE_CHANGED');
    return { info: before, hash: hash.digest('hex'), ...(limit !== undefined ? { bytes: Buffer.concat(chunks) } : {}) };
  } finally { await file.close(); }
}

async function inspectTree(root: string, scope: Scope, omitCaches: boolean): Promise<Tree> {
  const tree: Tree = { entries: [], excluded: [] };
  async function walk(local = ''): Promise<void> {
    const path = local === '' ? root : join(root, local);
    const before = await fs.lstat(path, { bigint: true });
    if (before.isSymbolicLink()) fail('PERSONAL_BACKUP_SYMLINK_REJECTED');
    if (!before.isDirectory()) fail('PERSONAL_BACKUP_SPECIAL_FILE_REJECTED');
    const manifestPath = local === '' ? scope : `${scope}/${local}`;
    tree.entries.push({ entry: { path: manifestPath, type: 'directory' }, stamp: stamp(before) });
    const names = (await fs.readdir(path)).sort();
    for (const name of names) {
      if (name.includes('\\') || name.includes('/') || name.includes('\0') || name === '.' || name === '..') fail('PERSONAL_BACKUP_SOURCE_INVALID');
      const childLocal = local === '' ? name : `${local}/${name}`;
      const childPath = `${scope}/${childLocal}`;
      if (!relativePath.safeParse(childPath).success) fail('PERSONAL_BACKUP_SOURCE_INVALID');
      if (runningMarker(scope, childLocal)) fail('PERSONAL_BACKUP_SOURCE_RUNNING');
      const info = await fs.lstat(join(root, childLocal), { bigint: true });
      if (info.isSymbolicLink()) fail('PERSONAL_BACKUP_SYMLINK_REJECTED');
      if (!info.isDirectory() && !info.isFile()) fail('PERSONAL_BACKUP_SPECIAL_FILE_REJECTED');
      if (omitCaches && excluded(childPath)) {
        if (!info.isDirectory()) fail('PERSONAL_BACKUP_SOURCE_INVALID');
        tree.excluded.push({ path: childPath, stamp: stamp(info) });
      } else if (info.isDirectory()) await walk(childLocal);
      else {
        const read = await readFileStable(join(root, childLocal));
        tree.entries.push({ entry: { path: childPath, type: 'file', size: Number(read.info.size), sha256: read.hash, executable: (read.info.mode & 0o100n) !== 0n }, stamp: stamp(read.info) });
      }
    }
    if (stamp(await fs.lstat(path, { bigint: true })) !== stamp(before)
      || JSON.stringify((await fs.readdir(path)).sort()) !== JSON.stringify(names)) fail('PERSONAL_BACKUP_SOURCE_CHANGED');
  }
  await walk();
  tree.entries.sort((a, b) => a.entry.path.localeCompare(b.entry.path, 'en'));
  tree.excluded.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return tree;
}

async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten === 0) fail('PERSONAL_BACKUP_COPY_FAILED');
    offset += bytesWritten;
  }
}

async function copyTree(root: string, destinationRoot: string, tree: Tree, sourceAuthority: DirectoryAuthority, outputTree: OwnedTree): Promise<void> {
  // Directories first, including empty directories; every output is private and exclusive.
  for (const { entry } of tree.entries.filter(item => item.entry.type === 'directory').sort((a, b) => a.entry.path.length - b.entry.path.length)) {
    await assertAuthority(sourceAuthority, 'PERSONAL_BACKUP_SOURCE_CHANGED');
    const path = join(destinationRoot, entry.path);
    const parent = outputTree.directories.get(dirname(path));
    if (!parent) fail('PERSONAL_BACKUP_OUTPUT_CHANGED');
    outputTree.directories.set(path, await createdDirectory(path, parent, 'PERSONAL_BACKUP_OUTPUT_CHANGED'));
  }
  for (const tracked of tree.entries) {
    const entry = tracked.entry;
    if (entry.type !== 'file') continue;
    const local = entry.path.slice(entry.path.indexOf('/') + 1);
    const source = join(root, local);
    await assertAuthority(sourceAuthority, 'PERSONAL_BACKUP_SOURCE_CHANGED');
    // Recheck directory ancestry before opening; O_NOFOLLOW protects the leaf.
    await directory(dirname(source), 'PERSONAL_BACKUP_SOURCE_CHANGED');
    const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (stamp(await input.stat({ bigint: true })) !== tracked.stamp) fail('PERSONAL_BACKUP_SOURCE_CHANGED');
      await assertAuthority(sourceAuthority, 'PERSONAL_BACKUP_SOURCE_CHANGED');
      const outputPath = join(destinationRoot, entry.path);
      const parent = outputTree.directories.get(dirname(outputPath));
      if (!parent) fail('PERSONAL_BACKUP_OUTPUT_CHANGED');
      await assertAuthority(parent, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
      const output = await fs.open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.executable ? 0o700 : 0o600);
      try {
        await assertAuthority(parent, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
        const created = await output.stat({ bigint: true });
        if (!created.isFile() || created.nlink !== 1n) fail('PERSONAL_BACKUP_OUTPUT_CHANGED');
        outputTree.files.set(outputPath, { dev: String(created.dev), ino: String(created.ino) });
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(1024 * 1024); let copied = 0;
        while (true) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          copied += bytesRead;
          if (copied > entry.size) fail('PERSONAL_BACKUP_SOURCE_CHANGED');
          const bytes = buffer.subarray(0, bytesRead); hash.update(bytes);
          await writeAll(output, bytes);
        }
        if (copied !== entry.size || hash.digest('hex') !== entry.sha256
          || stamp(await input.stat({ bigint: true })) !== tracked.stamp
          || stamp(await fs.lstat(source, { bigint: true })) !== tracked.stamp) fail('PERSONAL_BACKUP_SOURCE_CHANGED');
        await assertAuthority(sourceAuthority, 'PERSONAL_BACKUP_SOURCE_CHANGED');
        await assertAuthority(parent, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
        const located = await fs.lstat(outputPath, { bigint: true });
        if (!located.isFile() || located.dev !== created.dev || located.ino !== created.ino) fail('PERSONAL_BACKUP_OUTPUT_CHANGED');
        await output.sync();
      } finally { await output.close(); }
    } finally { await input.close(); }
  }
  for (const { entry } of tree.entries.filter(item => item.entry.type === 'directory').reverse()) {
    const path = join(destinationRoot, entry.path);
    await syncDirectory(path, outputTree.directories.get(path));
  }
}

async function syncDirectory(path: string, authority?: DirectoryAuthority): Promise<void> {
  if (authority) await assertAuthority(authority, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (authority) {
      const expected = authority.ancestors.at(-1)!; const actual = await handle.stat({ bigint: true });
      if (String(actual.dev) !== expected.dev || String(actual.ino) !== expected.ino) fail('PERSONAL_BACKUP_OUTPUT_CHANGED');
    }
    await handle.sync();
    if (authority) await assertAuthority(authority, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
  } finally { await handle.close(); }
}
function requiredEntries(entries: readonly Entry[], key: string, errorCode: string): void {
  const map = new Map(entries.map(entry => [entry.path, entry]));
  const dirs = ['vault', 'user-data', ...['00大脑规则', '01图书馆', '02知识库', '03大讲堂'].map(path => `vault/${path}`),
    'user-data/config', 'user-data/vaults', `user-data/vaults/${key}`, `user-data/vaults/${key}/backups`, `user-data/vaults/${key}/recovery`];
  const files = ['user-data/config/app-config.json', `user-data/vaults/${key}/state.sqlite3`, ...RULE_BUNDLE_SOURCE_PATHS.map(path => `vault/${path}`)];
  if (dirs.some(path => map.get(path)?.type !== 'directory') || files.some(path => map.get(path)?.type !== 'file')) fail(errorCode);
}
async function configuredVaultRoot(userDataRoot: string): Promise<string> {
  let raw: Buffer | undefined;
  try { raw = (await readFileStable(join(userDataRoot, 'config/app-config.json'), 16_384)).bytes; }
  catch (error) {
    if (error instanceof PersonalBackupError) throw error;
    fail('PERSONAL_BACKUP_REQUIRED_ENTRY_MISSING');
  }
  try { return z.object({ vaultRoot: absolutePath }).strict().parse(JSON.parse(raw!.toString('utf8'))).vaultRoot; }
  catch { fail('PERSONAL_BACKUP_VAULT_BINDING_MISMATCH'); }
}
function entriesFor(trees: readonly Tree[]): Entry[] {
  return trees.flatMap(tree => tree.entries.map(item => item.entry)).sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function totals(entries: readonly Entry[]): { fileCount: number; totalBytes: number } {
  const files = entries.filter(entry => entry.type === 'file');
  return { fileCount: files.length, totalBytes: files.reduce((sum, entry) => sum + entry.size, 0) };
}

export async function createPersonalBackup(options: PersonalBackupOptions): Promise<PersonalBackupResult> {
  if (options.cold !== true) fail('PERSONAL_BACKUP_COLD_CONFIRMATION_REQUIRED');
  let partialRoot: string | undefined;
  let partialOwned: OwnedTree | undefined;
  let containerOwned: OwnedTree | undefined;
  let destinationAuthority: DirectoryAuthority | undefined;
  try {
    const vaultAuthority = await captureDirectory(options.vaultRoot, 'PERSONAL_BACKUP_VAULT_INVALID');
    const userDataAuthority = await captureDirectory(options.userDataRoot, 'PERSONAL_BACKUP_USER_DATA_INVALID');
    destinationAuthority = await captureDirectory(options.destinationRoot, 'PERSONAL_BACKUP_DESTINATION_INVALID');
    const vaultRoot = vaultAuthority.path, userDataRoot = userDataAuthority.path, destinationRoot = destinationAuthority.path;
    const paths = [vaultRoot, userDataRoot, destinationRoot];
    if (paths.some((a, i) => paths.some((b, j) => i !== j && inside(a, b)))) fail('PERSONAL_BACKUP_PATH_OVERLAP');
    const initial = [await inspectTree(vaultRoot, 'vault', true), await inspectTree(userDataRoot, 'user-data', true)];
    const configured = await configuredVaultRoot(userDataRoot);
    if (resolve(configured) !== vaultRoot) fail('PERSONAL_BACKUP_VAULT_BINDING_MISMATCH');
    const vaultInfo = await fs.lstat(vaultRoot, { bigint: true });
    const userDataInfo = await fs.lstat(userDataRoot, { bigint: true });
    const key = cacheKey(configured, String(vaultInfo.dev), String(vaultInfo.ino));
    const entries = entriesFor(initial);
    requiredEntries(entries, key, 'PERSONAL_BACKUP_REQUIRED_ENTRY_MISSING');
    const createdAt = (options.now ?? (() => new Date()))();
    if (!Number.isFinite(createdAt.getTime())) fail('PERSONAL_BACKUP_TIME_INVALID');
    const name = `personal-backup-${createdAt.toISOString().replace(/[-:.]/gu, '')}-${randomUUID()}`;
    const partial = join(destinationRoot, `${name}.partial`);
    partialOwned = ownedTree(await createdDirectory(partial, destinationAuthority, 'PERSONAL_BACKUP_DESTINATION_CHANGED'));
    partialRoot = partial;
    await copyTree(vaultRoot, partial, initial[0]!, vaultAuthority, partialOwned);
    await copyTree(userDataRoot, partial, initial[1]!, userDataAuthority, partialOwned);
    await assertAuthority(vaultAuthority, 'PERSONAL_BACKUP_SOURCE_CHANGED');
    await assertAuthority(userDataAuthority, 'PERSONAL_BACKUP_SOURCE_CHANGED');
    const after = [await inspectTree(vaultRoot, 'vault', true), await inspectTree(userDataRoot, 'user-data', true)];
    if (JSON.stringify(after) !== JSON.stringify(initial)) fail('PERSONAL_BACKUP_SOURCE_CHANGED');
    const manifest: PersonalBackupManifest = {
      version: 1, createdAt: createdAt.toISOString(),
      source: {
        vault: { path: configured, dev: String(vaultInfo.dev), ino: String(vaultInfo.ino), cacheKey: key },
        userData: { path: userDataRoot, dev: String(userDataInfo.dev), ino: String(userDataInfo.ino) }
      },
      exclusions: { policy: PERSONAL_BACKUP_EXCLUSION_POLICY, observed: initial.flatMap(tree => tree.excluded.map(item => item.path)).sort() },
      notCovered: [...NOT_COVERED], ...totals(entries), entries
    };
    await assertAuthority(partialOwned.root, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
    matchesManifest(await snapshotTrees(partial), manifest);
    const manifestPath = join(partial, MANIFEST_NAME);
    const manifestFile = await fs.open(manifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await assertAuthority(partialOwned.root, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
      const info = await manifestFile.stat({ bigint: true });
      partialOwned.files.set(manifestPath, { dev: String(info.dev), ino: String(info.ino) });
      await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await manifestFile.sync();
      await assertAuthority(partialOwned.root, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
    }
    finally { await manifestFile.close(); }
    await syncDirectory(partial, partialOwned.root);
    // Reserve a new container exclusively. Renaming into its absent snapshot child
    // cannot replace an earlier snapshot, including an existing empty directory.
    const finalContainer = join(destinationRoot, name);
    containerOwned = ownedTree(await createdDirectory(finalContainer, destinationAuthority, 'PERSONAL_BACKUP_DESTINATION_CHANGED'));
    const snapshotRoot = join(finalContainer, 'snapshot');
    await assertAuthority(vaultAuthority, 'PERSONAL_BACKUP_SOURCE_CHANGED');
    await assertAuthority(userDataAuthority, 'PERSONAL_BACKUP_SOURCE_CHANGED');
    await assertAuthority(destinationAuthority, 'PERSONAL_BACKUP_DESTINATION_CHANGED');
    await assertAuthority(partialOwned.root, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
    await assertAuthority(containerOwned.root, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
    await fs.rename(partial, snapshotRoot);
    const snapshotAuthority = { path: snapshotRoot, ancestors: [...containerOwned.root.ancestors, { ...partialOwned.root.ancestors.at(-1)!, path: snapshotRoot }] };
    const published = relocatedTree(partialOwned, snapshotAuthority);
    for (const [path, authority] of published.directories) containerOwned.directories.set(path, authority);
    for (const [path, info] of published.files) containerOwned.files.set(path, info);
    partialRoot = undefined; partialOwned = undefined;
    await assertAuthority(destinationAuthority, 'PERSONAL_BACKUP_DESTINATION_CHANGED');
    await assertAuthority(snapshotAuthority, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
    await syncDirectory(finalContainer, containerOwned.root); await syncDirectory(destinationRoot, destinationAuthority);
    await assertAuthority(vaultAuthority, 'PERSONAL_BACKUP_SOURCE_CHANGED');
    await assertAuthority(userDataAuthority, 'PERSONAL_BACKUP_SOURCE_CHANGED');
    await assertAuthority(destinationAuthority, 'PERSONAL_BACKUP_DESTINATION_CHANGED');
    containerOwned = undefined;
    return { snapshotRoot, manifest };
  } catch (error) {
    const copying = partialRoot !== undefined;
    if (destinationAuthority) await assertAuthority(destinationAuthority, 'PERSONAL_BACKUP_DESTINATION_CHANGED');
    const cleanPartial = partialOwned ? await cleanOwnedTree(partialOwned) : true;
    const cleanContainer = containerOwned ? await cleanOwnedTree(containerOwned) : true;
    if (!cleanPartial || !cleanContainer) fail('PERSONAL_BACKUP_OUTPUT_CHANGED');
    if (error instanceof PersonalBackupError) throw error;
    if (copying && typeof error === 'object' && error !== null && 'code' in error
      && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))) fail('PERSONAL_BACKUP_SOURCE_CHANGED');
    fail('PERSONAL_BACKUP_FAILED');
  }
}

async function readManifest(snapshotRoot: string): Promise<{ manifest: PersonalBackupManifest; fingerprint: string }> {
  const top = (await fs.readdir(snapshotRoot)).sort();
  if (JSON.stringify(top) !== JSON.stringify([MANIFEST_NAME, 'user-data', 'vault'])) fail('PERSONAL_BACKUP_UNSAFE_SNAPSHOT');
  let parsed: PersonalBackupManifest;
  let fingerprint: string;
  try {
    const read = await readFileStable(join(snapshotRoot, MANIFEST_NAME), 128 * 1024 * 1024);
    parsed = manifestSchema.parse(JSON.parse(read.bytes!.toString('utf8')));
    fingerprint = `${stamp(read.info)}:${read.hash}`;
  } catch { fail('PERSONAL_BACKUP_MANIFEST_INVALID'); }
  if (JSON.stringify(parsed.exclusions.policy) !== JSON.stringify(PERSONAL_BACKUP_EXCLUSION_POLICY)
    || new Set(parsed.entries.map(entry => entry.path)).size !== parsed.entries.length
    || new Set(parsed.exclusions.observed).size !== parsed.exclusions.observed.length
    || parsed.exclusions.observed.some(path => !excluded(path))
    || parsed.entries.some(entry => !['vault', 'user-data'].includes(entry.path.split('/')[0]!) || excluded(entry.path))
    || cacheKey(parsed.source.vault.path, parsed.source.vault.dev, parsed.source.vault.ino) !== parsed.source.vault.cacheKey) fail('PERSONAL_BACKUP_MANIFEST_INVALID');
  const map = new Map(parsed.entries.map(entry => [entry.path, entry]));
  if (parsed.entries.some(entry => entry.path.includes('/') && map.get(entry.path.slice(0, entry.path.lastIndexOf('/')))?.type !== 'directory')) fail('PERSONAL_BACKUP_MANIFEST_INVALID');
  requiredEntries(parsed.entries, parsed.source.vault.cacheKey, 'PERSONAL_BACKUP_MANIFEST_INVALID');
  const actualTotals = totals(parsed.entries);
  if (actualTotals.fileCount !== parsed.fileCount || actualTotals.totalBytes !== parsed.totalBytes) fail('PERSONAL_BACKUP_MANIFEST_INVALID');
  return { manifest: parsed, fingerprint };
}

async function snapshotTrees(snapshotRoot: string): Promise<Tree[]> {
  try { return [await inspectTree(join(snapshotRoot, 'vault'), 'vault', false), await inspectTree(join(snapshotRoot, 'user-data'), 'user-data', false)]; }
  catch (error) {
    if (error instanceof PersonalBackupError && ['PERSONAL_BACKUP_SYMLINK_REJECTED', 'PERSONAL_BACKUP_SPECIAL_FILE_REJECTED', 'PERSONAL_BACKUP_SOURCE_RUNNING'].includes(error.code)) fail('PERSONAL_BACKUP_UNSAFE_SNAPSHOT');
    fail('PERSONAL_BACKUP_MISMATCH');
  }
}
function matchesManifest(trees: Tree[], manifest: PersonalBackupManifest): void {
  const actual = entriesFor(trees);
  const expected = [...manifest.entries].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('PERSONAL_BACKUP_MISMATCH');
}

async function sqliteChecks(temporary: string, entries: readonly Entry[], tree: OwnedTree): Promise<PersonalBackupVerification['databases']> {
  const results: Array<{ path: string; integrity: 'passed'; foreignKeys: 'passed' }> = [];
  for (const entry of entries) {
    if (entry.type !== 'file' || /-(?:wal|shm|journal)$/u.test(entry.path)) continue;
    const path = join(temporary, entry.path);
    const parent = tree.directories.get(dirname(path));
    const expected = tree.files.get(path);
    if (!parent || !expected) fail('PERSONAL_BACKUP_OUTPUT_CHANGED');
    await assertAuthority(parent, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const header = Buffer.alloc(16);
    try {
      const actual = await file.stat({ bigint: true });
      if (String(actual.dev) !== expected.dev || String(actual.ino) !== expected.ino) fail('PERSONAL_BACKUP_OUTPUT_CHANGED');
      await assertAuthority(parent, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
      await file.read(header, 0, header.length, 0);
    } finally { await file.close(); }
    if (!/\.(?:sqlite3?|db)$/iu.test(entry.path) && !header.equals(Buffer.from('SQLite format 3\0'))) continue;
    let db: Database.Database | undefined;
    try {
      await assertAuthority(parent, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
      db = new Database(path, { readonly: true, fileMustExist: true });
      await assertAuthority(parent, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
      const current = await fs.lstat(path, { bigint: true });
      if (!current.isFile() || String(current.dev) !== expected.dev || String(current.ino) !== expected.ino) fail('PERSONAL_BACKUP_OUTPUT_CHANGED');
      const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      const foreignKeys = db.pragma('foreign_key_check') as unknown[];
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || foreignKeys.length !== 0) fail('PERSONAL_BACKUP_SQLITE_INTEGRITY_FAILED');
      results.push({ path: entry.path, integrity: 'passed', foreignKeys: 'passed' });
    } catch { fail('PERSONAL_BACKUP_SQLITE_INTEGRITY_FAILED'); }
    finally {
      db?.close();
      await assertAuthority(parent, 'PERSONAL_BACKUP_OUTPUT_CHANGED');
      for (const suffix of ['-wal', '-shm', '-journal']) {
        const sidecar = `${path}${suffix}`;
        if (tree.files.has(sidecar)) continue;
        let info: BigIntStats;
        try { info = await fs.lstat(sidecar, { bigint: true }); } catch { continue; }
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) fail('PERSONAL_BACKUP_OUTPUT_CHANGED');
        tree.files.set(sidecar, { dev: String(info.dev), ino: String(info.ino) });
      }
    }
  }
  return results;
}

export async function verifyPersonalBackup(snapshotInput: string): Promise<PersonalBackupVerification> {
  let temporary: string | undefined;
  let temporaryOwned: OwnedTree | undefined;
  try {
    const snapshotAuthority = await captureDirectory(snapshotInput, 'PERSONAL_BACKUP_SNAPSHOT_INVALID', 'PERSONAL_BACKUP_UNSAFE_SNAPSHOT');
    const snapshotRoot = snapshotAuthority.path;
    const rootStamp = stamp(await fs.lstat(snapshotRoot, { bigint: true }));
    const metadata = await readManifest(snapshotRoot);
    const manifest = metadata.manifest;
    const initial = await snapshotTrees(snapshotRoot); matchesManifest(initial, manifest);
    if (await configuredVaultRoot(join(snapshotRoot, 'user-data')) !== manifest.source.vault.path) fail('PERSONAL_BACKUP_VAULT_BINDING_MISMATCH');
    const temporaryParent = await captureDirectory(await fs.realpath(tmpdir()), 'PERSONAL_RESTORE_CHECK_FAILED');
    await assertAuthority(temporaryParent, 'PERSONAL_RESTORE_CHECK_FAILED');
    temporary = await fs.mkdtemp(join(temporaryParent.path, 'xiaozhao-personal-restore-check-'));
    await assertAuthority(temporaryParent, 'PERSONAL_RESTORE_CHECK_CLEANUP_FAILED');
    temporaryOwned = ownedTree(await captureDirectory(temporary, 'PERSONAL_RESTORE_CHECK_CLEANUP_FAILED'));
    await assertAuthority(temporaryParent, 'PERSONAL_RESTORE_CHECK_CLEANUP_FAILED');
    await copyTree(join(snapshotRoot, 'vault'), temporary, initial[0]!, snapshotAuthority, temporaryOwned);
    await copyTree(join(snapshotRoot, 'user-data'), temporary, initial[1]!, snapshotAuthority, temporaryOwned);
    matchesManifest(await snapshotTrees(temporary), manifest);
    // Only a temporary copy is opened. No migration, credential decryption,
    // Keychain access, application launch or writes to the original are allowed.
    const databases = await sqliteChecks(temporary, manifest.entries, temporaryOwned);
    await assertAuthority(snapshotAuthority, 'PERSONAL_BACKUP_UNSAFE_SNAPSHOT');
    const after = await snapshotTrees(snapshotRoot);
    if (JSON.stringify(after) !== JSON.stringify(initial)
      || stamp(await fs.lstat(snapshotRoot, { bigint: true })) !== rootStamp) fail('PERSONAL_BACKUP_MISMATCH');
    let metadataAfter: Awaited<ReturnType<typeof readManifest>>;
    try { metadataAfter = await readManifest(snapshotRoot); } catch { fail('PERSONAL_BACKUP_MISMATCH'); }
    if (metadataAfter.fingerprint !== metadata.fingerprint) fail('PERSONAL_BACKUP_MISMATCH');
    await assertAuthority(snapshotAuthority, 'PERSONAL_BACKUP_UNSAFE_SNAPSHOT');
    return { snapshotRoot, manifest, snapshotIntegrity: 'passed', sqliteIntegrity: 'passed', applicationRestore: 'unverified', requiresIdentityRebind: true, databases };
  } catch (error) {
    if (error instanceof PersonalBackupError) throw error;
    return fail('PERSONAL_RESTORE_CHECK_FAILED');
  } finally {
    if (temporaryOwned && !await cleanOwnedTree(temporaryOwned)) fail('PERSONAL_RESTORE_CHECK_CLEANUP_FAILED');
    else if (temporary && !temporaryOwned) fail('PERSONAL_RESTORE_CHECK_CLEANUP_FAILED');
  }
}

export const verifyPersonalSnapshot = verifyPersonalBackup;
