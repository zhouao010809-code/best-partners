import { createHash } from 'node:crypto';
import {
  copyFile as copyFileFs,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertCompanyRelativePath } from './company-paths.js';

/** A deterministic, model-free description of one source tree entry. */
export interface ProjectSourceEntry {
  readonly relativePath: string;
  readonly kind: 'file' | 'directory';
  readonly bytes?: number;
  readonly modifiedAt?: string;
  readonly sha256?: string;
}

export interface ProjectFieldProposal {
  readonly value?: string;
  readonly confidence: 'inferred' | 'unknown';
  readonly evidencePaths: readonly string[];
}

export interface ProjectScanProposal {
  readonly sourceRoot: string;
  readonly sourceSha256: string;
  readonly suggestedName: string;
  readonly suggestedClientName?: string;
  readonly suggestedStatus: 'draft' | 'active';
  readonly fields: Readonly<Record<string, ProjectFieldProposal>>;
  readonly selectedSkillIds: readonly string[];
  readonly entries: readonly ProjectSourceEntry[];
  readonly issues: readonly string[];
}

export interface ProjectScanOptions {
  readonly maxFileBytes?: number;
  readonly metadataMaxBytes?: number;
  readonly ignoredDirectoryNames?: readonly string[];
}

export interface StageProjectSourceOptions extends ProjectScanOptions {
  readonly sourceRoot: string;
  readonly incomingRoot: string;
  readonly runId: string;
  readonly copyFile?: (source: string, destination: string) => Promise<void>;
}

export interface StagedProjectSource {
  readonly stagingRoot: string;
  readonly manifestPath: string;
  readonly proposal: ProjectScanProposal;
}

const DEFAULT_IGNORED_DIRECTORIES = ['.git', '.hg', '.svn', 'node_modules', 'system'];
const DEFAULT_METADATA_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;

function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function sameOrContainedBy(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function normalizedOptions(options: ProjectScanOptions = {}): Required<Pick<ProjectScanOptions, 'maxFileBytes' | 'metadataMaxBytes' | 'ignoredDirectoryNames'>> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const metadataMaxBytes = options.metadataMaxBytes ?? DEFAULT_METADATA_MAX_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0) throw new Error('Invalid maxFileBytes');
  if (!Number.isSafeInteger(metadataMaxBytes) || metadataMaxBytes < 0) throw new Error('Invalid metadataMaxBytes');
  const ignoredDirectoryNames = [...(options.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORIES)]
    .filter(name => name.length > 0)
    .sort();
  return { maxFileBytes, metadataMaxBytes, ignoredDirectoryNames };
}

async function assertRealDirectory(path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`);
  return realpath(path);
}

async function assertNoSymlink(path: string, label: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${label} contains a symlink`);
  return info;
}

function pathForEntry(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/');
  return assertCompanyRelativePath(value);
}

function stableEntriesJson(entries: readonly ProjectSourceEntry[]): string {
  return JSON.stringify(entries.map(entry => ({
    relativePath: entry.relativePath,
    kind: entry.kind,
    ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
    ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 })
  })));
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function unknownField(evidencePaths: readonly string[] = []): ProjectFieldProposal {
  return { confidence: 'unknown', evidencePaths };
}

function inferredField(value: string, evidencePaths: readonly string[]): ProjectFieldProposal {
  return { value, confidence: 'inferred', evidencePaths };
}

function cleanValue(value: string): string | undefined {
  const cleaned = value.replace(/^[#*\s]+|[\s*]+$/gu, '').trim().replace(/^(["'])(.*)\1$/u, '$2').trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function extractMetadata(text: string, path: string): Record<string, { value: string; evidencePath: string }> {
  const result: Record<string, { value: string; evidencePath: string }> = {};
  const patterns: readonly [string, RegExp][] = [
    ['clientName', /(?:客户(?:名称)?|机构(?:名称)?|甲方|client(?:name)?|client_name|organization(?:name)?|organization_name)\s*[:：=]\s*([^\n\r#]+)/iu],
    ['serviceStart', /(?:服务开始|开始日期|合作开始|项目开始|service(?:start|_start)|startDate|start_date)\s*[:：=]\s*["']?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/iu],
    ['serviceEnd', /(?:服务结束|结束日期|合作结束|项目结束|service(?:end|_end)|endDate|end_date)\s*[:：=]\s*["']?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/iu]
  ];
  for (const [field, pattern] of patterns) {
    const match = text.match(pattern);
    const value = match?.[1] ? cleanValue(match[1]) : undefined;
    if (value) result[field] = { value: value.replaceAll('/', '-').replaceAll('.', '-'), evidencePath: path };
  }
  return result;
}

function metadataCandidate(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.yaml') || lower.endsWith('.yml')
    ? /(?:机构|项目|客户|project|client|config|说明|介绍)/iu.test(basename(path))
    : false;
}

function proposalFields(metadata: Record<string, Array<{ value: string; evidencePath: string }>>): Record<string, ProjectFieldProposal> {
  const fields: Record<string, ProjectFieldProposal> = {};
  for (const field of ['clientName', 'serviceStart', 'serviceEnd']) {
    const values = metadata[field] ?? [];
    const distinct = [...new Set(values.map(item => item.value))];
    if (distinct.length === 1) fields[field] = inferredField(distinct[0]!, [...new Set(values.map(item => item.evidencePath))].sort());
    else if (distinct.length > 1) fields[field] = unknownField([...new Set(values.map(item => item.evidencePath))].sort());
    else fields[field] = unknownField();
  }
  return fields;
}

async function walkProject(
  root: string,
  options: ReturnType<typeof normalizedOptions>,
  current: string,
  entries: ProjectSourceEntry[],
  metadata: Record<string, Array<{ value: string; evidencePath: string }>>,
  issues: string[]
): Promise<void> {
  const children = (await readdir(current, { withFileTypes: true }))
    .sort((a, b) => compareStable(a.name, b.name));
  for (const child of children) {
    const childPath = join(current, child.name);
    const relativePath = pathForEntry(root, childPath);
    // lstat is intentional: even ignored names must fail closed if they are symlinks.
    const info = await assertNoSymlink(childPath, relativePath);
    if (info.isDirectory()) {
      if (options.ignoredDirectoryNames.includes(child.name)) continue;
      entries.push({ relativePath, kind: 'directory', modifiedAt: info.mtime.toISOString() });
      await walkProject(root, options, childPath, entries, metadata, issues);
      continue;
    }
    if (!info.isFile()) {
      issues.push(`Unsupported entry type: ${relativePath}`);
      continue;
    }
    const size = typeof info.size === 'bigint' ? Number(info.size) : info.size;
    if (!Number.isSafeInteger(size) || size > options.maxFileBytes) throw new Error(`File exceeds size limit: ${relativePath}`);
    const bytes = await readFile(childPath);
    const entry: ProjectSourceEntry = {
      relativePath,
      kind: 'file',
      bytes: size,
      modifiedAt: info.mtime.toISOString(),
      sha256: sha256(bytes)
    };
    if (child.name !== '.DS_Store') {
      entries.push(entry);
      if (metadataCandidate(relativePath) && size <= options.metadataMaxBytes) {
        const extracted = extractMetadata(bytes.toString('utf8'), relativePath);
        for (const [field, value] of Object.entries(extracted)) (metadata[field] ??= []).push(value);
      }
    }
  }
}

export async function scanProjectFolder(sourceRoot: string, options: ProjectScanOptions = {}): Promise<ProjectScanProposal> {
  const normalized = normalizedOptions(options);
  const root = await assertRealDirectory(sourceRoot, 'Project source');
  const entries: ProjectSourceEntry[] = [];
  const metadata: Record<string, Array<{ value: string; evidencePath: string }>> = {};
  const issues: string[] = [];
  await walkProject(root, normalized, root, entries, metadata, issues);
  entries.sort((a, b) => compareStable(a.relativePath, b.relativePath));
  const fields = proposalFields(metadata);
  const suggestedClientName = fields.clientName?.confidence === 'inferred' ? fields.clientName.value : undefined;
  const proposal: ProjectScanProposal = {
    sourceRoot: root,
    sourceSha256: sha256(stableEntriesJson(entries)),
    suggestedName: basename(root),
    ...(suggestedClientName === undefined ? {} : { suggestedClientName }),
    suggestedStatus: 'draft',
    fields,
    selectedSkillIds: [],
    entries,
    issues: [...new Set(issues)].sort()
  };
  return proposal;
}

async function copyTree(
  sourceRoot: string,
  targetRoot: string,
  proposal: ProjectScanProposal,
  copyFile: (source: string, destination: string) => Promise<void>
): Promise<void> {
  for (const entry of proposal.entries) {
    const source = join(sourceRoot, ...entry.relativePath.split('/'));
    const target = join(targetRoot, ...entry.relativePath.split('/'));
    if (entry.kind === 'directory') {
      const sourceInfo = await assertNoSymlink(source, `source path ${entry.relativePath}`);
      if (!sourceInfo.isDirectory()) throw new Error(`Source path changed type: ${entry.relativePath}`);
      await mkdir(target, { recursive: true, mode: 0o700 });
      const info = await assertNoSymlink(target, `staging path ${entry.relativePath}`);
      if (!info.isDirectory()) throw new Error(`Staging path is not a directory: ${entry.relativePath}`);
      continue;
    }
    const sourceInfo = await assertNoSymlink(source, `source path ${entry.relativePath}`);
    if (!sourceInfo.isFile()) throw new Error(`Source path changed type: ${entry.relativePath}`);
    const sourceSize = typeof sourceInfo.size === 'bigint' ? Number(sourceInfo.size) : sourceInfo.size;
    if (sourceSize !== entry.bytes) throw new Error(`Source changed during staging: ${entry.relativePath}`);
    const sourceBytes = await readFile(source);
    if (sha256(sourceBytes) !== entry.sha256) throw new Error(`Source changed during staging: ${entry.relativePath}`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const parentInfo = await assertNoSymlink(dirname(target), `staging parent ${entry.relativePath}`);
    if (!parentInfo.isDirectory()) throw new Error(`Staging parent is not a directory: ${entry.relativePath}`);
    try {
      await lstat(target);
      throw new Error(`Staging path already exists: ${entry.relativePath}`);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await copyFile(source, temporary);
      const copied = await assertNoSymlink(temporary, `staged file ${entry.relativePath}`);
      if (!copied.isFile()) throw new Error(`Staged path is not a file: ${entry.relativePath}`);
      const copiedBytes = await readFile(temporary);
      if (sha256(copiedBytes) !== entry.sha256) throw new Error(`Staged bytes do not match source: ${entry.relativePath}`);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function sameFileIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Publish a completed temporary tree without ever replacing an existing run.
 * The destination is reserved with exclusive mkdir; files are then linked
 * from the same-filesystem temporary tree, where link() is no-replace.
 * The manifest is linked last and acts as the completion marker.
 */
async function publishStagedTree(
  temporaryRoot: string,
  finalRoot: string,
  entries: readonly ProjectSourceEntry[]
): Promise<void> {
  await mkdir(finalRoot, { recursive: false, mode: 0o700 });
  const reservation = await lstat(finalRoot);
  try {
    for (const entry of entries) {
      const target = join(finalRoot, ...entry.relativePath.split('/'));
      if (entry.kind === 'directory') {
        await mkdir(target, { recursive: false, mode: 0o700 });
        continue;
      }
      const source = join(temporaryRoot, ...entry.relativePath.split('/'));
      await link(source, target);
    }
    await link(join(temporaryRoot, 'source-manifest.json'), join(finalRoot, 'source-manifest.json'));
  } catch (error) {
    try {
      const current = await lstat(finalRoot);
      if (sameFileIdentity(current, reservation)) await rm(finalRoot, { recursive: true, force: true });
    } catch {
      // Preserve any path that no longer belongs to this publish attempt.
    }
    throw error;
  }
}

export async function stageProjectSource(options: StageProjectSourceOptions): Promise<StagedProjectSource> {
  const proposal = await scanProjectFolder(options.sourceRoot, options);
  const sourceRoot = proposal.sourceRoot;
  const incomingRoot = await assertRealDirectory(options.incomingRoot, 'Incoming root');
  // A submitted folder may itself live below incoming (the normal desktop
  // drop flow). Reject only a source that contains incoming, because that
  // would make the staging destination part of the scanned tree.
  if (sameOrContainedBy(sourceRoot, incomingRoot)) {
    throw new Error('Source root must not contain incoming root');
  }
  const runId = assertCompanyRelativePath(options.runId);
  if (runId.includes('/')) throw new Error('runId must be a single path segment');
  const finalRoot = join(incomingRoot, runId);
  if (sameOrContainedBy(sourceRoot, finalRoot) || sameOrContainedBy(finalRoot, sourceRoot)) {
    throw new Error('Staging destination overlaps source root');
  }
  const temporaryRoot = join(incomingRoot, `.${runId}.staging-${randomUUID()}`);
  const copyFile = options.copyFile ?? (async (source: string, destination: string) => copyFileFs(source, destination));
  let published = false;
  try {
    await mkdir(temporaryRoot, { recursive: false, mode: 0o700 });
    await copyTree(sourceRoot, temporaryRoot, proposal, copyFile);
    const afterCopy = await scanProjectFolder(sourceRoot, options);
    if (afterCopy.sourceSha256 !== proposal.sourceSha256) throw new Error('Source changed during staging');
    const manifestPath = join(temporaryRoot, 'source-manifest.json');
    const manifest = JSON.stringify({ version: 1, sourceRoot, sourceSha256: proposal.sourceSha256, entries: proposal.entries }, null, 2);
    const temporaryManifest = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryManifest, manifest, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryManifest, manifestPath);
    } finally {
      await rm(temporaryManifest, { force: true }).catch(() => undefined);
    }
    await publishStagedTree(temporaryRoot, finalRoot, proposal.entries);
    published = true;
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    return { stagingRoot: finalRoot, manifestPath: join(finalRoot, 'source-manifest.json'), proposal };
  } catch (error) {
    if (!published) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
