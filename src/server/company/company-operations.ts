import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

export const COMPANY_SERVER_LOCK_NAME = 'company-server.lock.json';
const MANIFEST_NAME = 'manifest.json';

export class CompanyOperationsError extends Error {
  public readonly name = 'CompanyOperationsError';

  constructor(public readonly code: string) {
    super(code);
  }
}

const relativeEntryPathSchema = z.string().min(1).max(4096).refine((value) => {
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/')) return false;
  return !value.split('/').some((part) => part === '' || part === '.' || part === '..');
});
const directoryEntrySchema = z.object({
  path: relativeEntryPathSchema,
  type: z.literal('directory')
}).strict();
const fileEntrySchema = z.object({
  path: relativeEntryPathSchema,
  type: z.literal('file'),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
const companyBackupManifestSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  entries: z.array(z.discriminatedUnion('type', [directoryEntrySchema, fileEntrySchema])).max(1_000_000)
}).strict();

export type CompanyBackupManifest = z.infer<typeof companyBackupManifestSchema>;
type ManifestEntry = CompanyBackupManifest['entries'][number];

export interface CompanyBackupResult {
  readonly snapshotRoot: string;
  readonly manifest: CompanyBackupManifest;
}

function fail(code: string): never {
  throw new CompanyOperationsError(code);
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function existingDirectory(input: string, code: string): Promise<string> {
  if (!isAbsolute(input) || input.includes('\0')) fail(code);
  const lexical = resolve(input);
  let info;
  try { info = await lstat(lexical); } catch { fail(code); }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(code);
  const canonical = await realpath(lexical);
  return canonical;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function manifestPath(prefix: string, local: string): string {
  return local === '' ? prefix : `${prefix}/${local.split(sep).join('/')}`;
}

async function copyTree(
  sourceRoot: string,
  destinationRoot: string,
  prefix: 'workspace' | 'state',
  entries: ManifestEntry[],
  local = ''
): Promise<void> {
  const source = local === '' ? sourceRoot : join(sourceRoot, local);
  const destination = local === '' ? destinationRoot : join(destinationRoot, local);
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) fail('COMPANY_BACKUP_UNSAFE_SOURCE');
  await mkdir(destination, { mode: 0o700 });
  entries.push({ path: manifestPath(prefix, local), type: 'directory' });
  const namesBefore = (await readdir(source)).sort();
  for (const name of namesBefore) {
    if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      fail('COMPANY_BACKUP_UNSAFE_SOURCE');
    }
    const childLocal = local === '' ? name : join(local, name);
    const childSource = join(sourceRoot, childLocal);
    const childDestination = join(destinationRoot, childLocal);
    const before = await lstat(childSource);
    if (before.isSymbolicLink()) fail('COMPANY_BACKUP_SYMLINK_REJECTED');
    if (before.isDirectory()) {
      await copyTree(sourceRoot, destinationRoot, prefix, entries, childLocal);
      continue;
    }
    if (!before.isFile()) fail('COMPANY_BACKUP_SPECIAL_FILE_REJECTED');
    await copyFile(childSource, childDestination, constants.COPYFILE_EXCL);
    await chmod(childDestination, before.mode & 0o777);
    const after = await stat(childSource);
    if (
      before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || before.ino !== after.ino
    ) fail('COMPANY_BACKUP_SOURCE_CHANGED');
    const copied = await stat(childDestination);
    entries.push({
      path: manifestPath(prefix, childLocal),
      type: 'file',
      size: copied.size,
      sha256: await sha256(childDestination)
    });
  }
  const namesAfter = (await readdir(source)).sort();
  if (JSON.stringify(namesBefore) !== JSON.stringify(namesAfter)) fail('COMPANY_BACKUP_SOURCE_CHANGED');
}

function sortEntries(entries: ManifestEntry[]): ManifestEntry[] {
  return entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

function manifestFor(createdAt: Date, entries: ManifestEntry[]): CompanyBackupManifest {
  const files = entries.filter((entry): entry is Extract<ManifestEntry, { type: 'file' }> => entry.type === 'file');
  return {
    version: 1,
    createdAt: createdAt.toISOString(),
    fileCount: files.length,
    totalBytes: files.reduce((total, entry) => total + entry.size, 0),
    entries: sortEntries(entries)
  };
}

export async function createCompanyBackup(options: {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly destinationRoot: string;
  readonly now?: () => Date;
}): Promise<CompanyBackupResult> {
  const workspaceRoot = await existingDirectory(options.workspaceRoot, 'COMPANY_BACKUP_WORKSPACE_INVALID');
  const stateRoot = await existingDirectory(options.stateRoot, 'COMPANY_BACKUP_STATE_INVALID');
  const destinationRoot = await existingDirectory(options.destinationRoot, 'COMPANY_BACKUP_DESTINATION_INVALID');
  if (
    isInside(workspaceRoot, stateRoot)
    || isInside(stateRoot, workspaceRoot)
    || isInside(workspaceRoot, destinationRoot)
    || isInside(stateRoot, destinationRoot)
  ) fail('COMPANY_BACKUP_PATH_OVERLAP');
  if (existsSync(join(stateRoot, COMPANY_SERVER_LOCK_NAME))) fail('COMPANY_BACKUP_SERVER_RUNNING');

  const createdAt = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(createdAt.getTime())) fail('COMPANY_BACKUP_TIME_INVALID');
  const timestamp = createdAt.toISOString().replace(/[-:.]/gu, '');
  const snapshotName = `company-backup-${timestamp}-${randomUUID()}`;
  const snapshotRoot = join(destinationRoot, snapshotName);
  const partialRoot = `${snapshotRoot}.partial`;
  if (existsSync(snapshotRoot) || existsSync(partialRoot)) fail('COMPANY_BACKUP_EXISTS');
  await mkdir(partialRoot, { mode: 0o700 });
  try {
    const entries: ManifestEntry[] = [];
    await copyTree(workspaceRoot, join(partialRoot, 'workspace'), 'workspace', entries);
    await copyTree(stateRoot, join(partialRoot, 'state'), 'state', entries);
    const manifest = manifestFor(createdAt, entries);
    await writeFile(join(partialRoot, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    await rename(partialRoot, snapshotRoot);
    return { snapshotRoot, manifest };
  } catch (error) {
    await rm(partialRoot, { recursive: true, force: true });
    throw error;
  }
}

async function inspectTree(
  root: string,
  prefix: 'workspace' | 'state',
  entries: ManifestEntry[],
  local = ''
): Promise<void> {
  const path = local === '' ? join(root, prefix) : join(root, prefix, local);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('COMPANY_BACKUP_UNSAFE_SNAPSHOT');
  entries.push({ path: manifestPath(prefix, local), type: 'directory' });
  for (const name of (await readdir(path)).sort()) {
    const childLocal = local === '' ? name : join(local, name);
    const child = join(root, prefix, childLocal);
    const childInfo = await lstat(child);
    if (childInfo.isSymbolicLink()) fail('COMPANY_BACKUP_UNSAFE_SNAPSHOT');
    if (childInfo.isDirectory()) {
      await inspectTree(root, prefix, entries, childLocal);
    } else if (childInfo.isFile()) {
      entries.push({
        path: manifestPath(prefix, childLocal),
        type: 'file',
        size: childInfo.size,
        sha256: await sha256(child)
      });
    } else {
      fail('COMPANY_BACKUP_UNSAFE_SNAPSHOT');
    }
  }
}

export async function verifyCompanyBackup(snapshotInput: string): Promise<CompanyBackupResult> {
  const snapshotRoot = await existingDirectory(snapshotInput, 'COMPANY_BACKUP_SNAPSHOT_INVALID');
  const topLevel = (await readdir(snapshotRoot)).sort();
  if (JSON.stringify(topLevel) !== JSON.stringify([MANIFEST_NAME, 'state', 'workspace'])) {
    fail('COMPANY_BACKUP_UNSAFE_SNAPSHOT');
  }
  const manifestInfo = await lstat(join(snapshotRoot, MANIFEST_NAME));
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) fail('COMPANY_BACKUP_MANIFEST_INVALID');
  let raw: string;
  try { raw = await readFile(join(snapshotRoot, MANIFEST_NAME), 'utf8'); }
  catch { fail('COMPANY_BACKUP_MANIFEST_INVALID'); }
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { fail('COMPANY_BACKUP_MANIFEST_INVALID'); }
  const parsed = companyBackupManifestSchema.safeParse(decoded);
  if (!parsed.success) fail('COMPANY_BACKUP_MANIFEST_INVALID');
  for (const required of [
    'workspace/incoming',
    'workspace/projects',
    'workspace/skills',
    'workspace/system',
    'state/state.sqlite3'
  ]) {
    if (!parsed.data.entries.some((entry) => entry.path === required)) fail('COMPANY_BACKUP_REQUIRED_ENTRY_MISSING');
  }
  const actual: ManifestEntry[] = [];
  try {
    await inspectTree(snapshotRoot, 'workspace', actual);
    await inspectTree(snapshotRoot, 'state', actual);
  } catch (error) {
    if (error instanceof CompanyOperationsError) throw error;
    fail('COMPANY_BACKUP_MISMATCH');
  }
  const actualManifest = manifestFor(new Date(parsed.data.createdAt), actual);
  if (
    actualManifest.fileCount !== parsed.data.fileCount
    || actualManifest.totalBytes !== parsed.data.totalBytes
    || JSON.stringify(actualManifest.entries) !== JSON.stringify(parsed.data.entries)
  ) fail('COMPANY_BACKUP_MISMATCH');
  return { snapshotRoot, manifest: parsed.data };
}

export interface CompanyServerLock {
  readonly path: string;
  release(): void;
}

export function acquireCompanyServerLock(stateRootInput: string, now = new Date()): CompanyServerLock {
  const stateRoot = resolve(stateRootInput);
  const lockPath = join(stateRoot, COMPANY_SERVER_LOCK_NAME);
  const token = randomUUID();
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('COMPANY_SERVER_ALREADY_RUNNING_OR_UNCLEAN');
    throw error;
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify({ version: 1, pid: process.pid, startedAt: now.toISOString(), token })}\n`, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  let released = false;
  return {
    path: lockPath,
    release: () => {
      if (released) return;
      released = true;
      let current: unknown;
      try { current = JSON.parse(readFileSync(lockPath, 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (
        typeof current !== 'object'
        || current === null
        || !('token' in current)
        || current.token !== token
      ) fail('COMPANY_SERVER_LOCK_OWNERSHIP_CHANGED');
      unlinkSync(lockPath);
    }
  };
}

export function snapshotLabel(result: CompanyBackupResult): string {
  return basename(result.snapshotRoot);
}
