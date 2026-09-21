import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { parseAttachment } from '../attachments/parser.js';
import { canonicalProjectRoot } from './project-paths.js';

export interface ProjectScanEntry {
  readonly relativePath: string;
  readonly kind: 'file' | 'directory';
  readonly bytes?: number;
  readonly modifiedAt?: string;
  readonly sha256?: string;
  readonly parseStatus?: 'readable' | 'unsupported' | 'too-large' | 'failed';
  readonly problem?: string;
  readonly content?: string;
  readonly origin: 'source' | 'output';
}

export interface ProjectScanResult {
  readonly sourceRoot: string;
  readonly sourceSha256: string;
  readonly suggestedName: string;
  readonly ignoredCount: number;
  readonly entries: readonly ProjectScanEntry[];
  readonly issues: readonly string[];
}

const DEFAULT_MAX_INDEXED_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 200_000;
const IGNORED_DIRECTORY_NAMES = new Set(['.git', '.hg', '.svn', 'node_modules', 'system']);
const SUPPORTED_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

type ScanOptions = { signal?: AbortSignal; protectedRoots?: readonly string[]; maxIndexedBytes?: number; beforeVerify?: () => void | Promise<void> };
type FileSnapshot = { relativePath: string; kind: 'file' | 'directory'; bytes?: number; modifiedAt?: string; sha256?: string; parseStatus?: ProjectScanEntry['parseStatus'] };
type ScanState = { entries: ProjectScanEntry[]; snapshots: FileSnapshot[]; issues: string[]; ignoredCount: number };

function errorWithCode(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? errorWithCode('ABORT_ERR', 'The operation was aborted');
}

function comparePath(a: { relativePath: string }, b: { relativePath: string }): number {
  return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
}

function toRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sizeOf(value: { size: number | bigint }): number {
  const size = typeof value.size === 'bigint' ? Number(value.size) : value.size;
  if (!Number.isSafeInteger(size) || size < 0) throw errorWithCode('PROJECT_FILE_TOO_LARGE', 'Project file size is not safe');
  return size;
}

function stableProblem(status: 'encrypted' | 'needs-ocr' | 'failed', fallback?: string): string {
  if (status === 'encrypted') return 'PDF_ENCRYPTED';
  if (status === 'needs-ocr') return 'PDF_NEEDS_OCR';
  return fallback?.trim() || 'PARSE_FAILED';
}

async function parsedContent(bytes: Buffer, path: string, maxIndexedBytes: number, signal?: AbortSignal): Promise<Pick<ProjectScanEntry, 'parseStatus' | 'problem' | 'content'>> {
  checkAborted(signal);
  const lower = path.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf('.'));
  if (!SUPPORTED_TEXT_EXTENSIONS.has(extension) && extension !== '.pdf') return { parseStatus: 'unsupported' };
  if (bytes.length > maxIndexedBytes) return { parseStatus: 'too-large', problem: 'FILE_TOO_LARGE_FOR_INDEX' };
  const mediaType = extension === '.pdf' ? 'application/pdf' : extension === '.md' || extension === '.markdown' ? 'text/markdown' : 'text/plain';
  const parsed = await parseAttachment(bytes, mediaType, signal ?? new AbortController().signal);
  checkAborted(signal);
  if (parsed.status !== 'ready') return { parseStatus: 'failed', problem: stableProblem(parsed.status, parsed.problem) };
  const content = parsed.pages.map(page => page.text).join('\n').slice(0, MAX_TEXT_CHARACTERS);
  if (!content.trim()) return { parseStatus: 'failed', problem: 'NO_READABLE_TEXT' };
  return { parseStatus: 'readable', content };
}

function extensionFor(path: string): string {
  const lower = path.toLowerCase();
  return lower.slice(lower.lastIndexOf('.'));
}

function unsupportedOrTooLarge(path: string, bytes: number, maxIndexedBytes: number): Pick<ProjectScanEntry, 'parseStatus' | 'problem'> {
  const extension = extensionFor(path);
  if (!SUPPORTED_TEXT_EXTENSIONS.has(extension) && extension !== '.pdf') return { parseStatus: 'unsupported' };
  return bytes > maxIndexedBytes ? { parseStatus: 'too-large', problem: 'FILE_TOO_LARGE_FOR_INDEX' } : { parseStatus: 'failed', problem: 'PARSE_SKIPPED' };
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  checkAborted(signal);
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  const aborted = () => stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error('The operation was aborted'));
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    for await (const chunk of stream) {
      checkAborted(signal);
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } finally {
    signal?.removeEventListener('abort', aborted);
    stream.destroy();
  }
}

async function walk(root: string, current: string, options: Required<Pick<ScanOptions, 'maxIndexedBytes'>> & { signal?: AbortSignal; parse?: boolean }, state: ScanState): Promise<void> {
  checkAborted(options.signal);
  const children = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const child of children) {
    checkAborted(options.signal);
    const absolutePath = join(current, child.name);
    const path = toRelative(root, absolutePath);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      state.issues.push(`SYMLINK_SKIPPED:${path}`);
      continue;
    }
    if (info.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(child.name)) {
        state.ignoredCount += 1;
        continue;
      }
      const modifiedAt = info.mtime.toISOString();
      state.entries.push({ relativePath: path, kind: 'directory', modifiedAt, origin: 'source' });
      state.snapshots.push({ relativePath: path, kind: 'directory', modifiedAt });
      await walk(root, absolutePath, options, state);
      continue;
    }
    if (!info.isFile()) {
      state.issues.push(`UNSUPPORTED_ENTRY:${path}`);
      continue;
    }
    const bytes = sizeOf(info);
    const sha256 = await hashFile(absolutePath, options.signal);
    const afterRead = await lstat(absolutePath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile() || sizeOf(afterRead) !== bytes || afterRead.mtimeMs !== info.mtimeMs) throw errorWithCode('PROJECT_SOURCE_CHANGED', `Project source changed: ${path}`);
    const parsed = options.parse === false
      ? unsupportedOrTooLarge(path, bytes, options.maxIndexedBytes)
      : bytes > options.maxIndexedBytes
        ? unsupportedOrTooLarge(path, bytes, options.maxIndexedBytes)
        : await parsedContent(await readFile(absolutePath), path, options.maxIndexedBytes, options.signal);
    const modifiedAt = info.mtime.toISOString();
    state.entries.push({ relativePath: path, kind: 'file', bytes, modifiedAt, sha256, ...parsed, origin: 'source' });
    state.snapshots.push({ relativePath: path, kind: 'file', bytes, modifiedAt, sha256, parseStatus: parsed.parseStatus });
  }
}

function manifest(entries: readonly ProjectScanEntry[]): string {
  return JSON.stringify([...entries].sort(comparePath).map(entry => ({
    path: entry.relativePath,
    kind: entry.kind,
    ...(entry.bytes === undefined ? {} : { size: entry.bytes }),
    ...(entry.modifiedAt === undefined ? {} : { mtime: entry.modifiedAt }),
    ...(entry.sha256 === undefined ? {} : { hash: entry.sha256 }),
    ...(entry.parseStatus === undefined ? {} : { parseStatus: entry.parseStatus })
  })));
}

function sameSnapshot(a: readonly FileSnapshot[], b: readonly FileSnapshot[]): boolean {
  const normalize = (items: readonly FileSnapshot[]) => JSON.stringify([...items].sort(comparePath).map(({ parseStatus: _parseStatus, ...item }) => item));
  return normalize(a) === normalize(b);
}

async function verifySnapshot(root: string, first: ScanState, options: Required<Pick<ScanOptions, 'maxIndexedBytes'>> & { signal?: AbortSignal }): Promise<void> {
  const second: ScanState = { entries: [], snapshots: [], issues: [], ignoredCount: 0 };
  await walk(root, root, { ...options, parse: false }, second);
  if (!sameSnapshot(first.snapshots, second.snapshots)) throw errorWithCode('PROJECT_SOURCE_CHANGED', 'Project source changed during scan');
}

export async function scanProjectFolder(selectedPath: string, input: ScanOptions = {}): Promise<ProjectScanResult> {
  const maxIndexedBytes = input.maxIndexedBytes ?? DEFAULT_MAX_INDEXED_BYTES;
  if (!Number.isSafeInteger(maxIndexedBytes) || maxIndexedBytes < 0) throw new Error('Invalid maxIndexedBytes');
  checkAborted(input.signal);
  const root = await canonicalProjectRoot(selectedPath, { protectedRoots: input.protectedRoots ?? [] });
  const state: ScanState = { entries: [], snapshots: [], issues: [], ignoredCount: 0 };
  const options = { maxIndexedBytes, ...(input.signal === undefined ? {} : { signal: input.signal }) };
  await walk(root, root, options, state);
  await input.beforeVerify?.();
  await verifySnapshot(root, state, options);
  state.entries.sort(comparePath);
  state.issues = [...new Set(state.issues)].sort();
  return {
    sourceRoot: root,
    sourceSha256: digest(manifest(state.entries)),
    suggestedName: basename(root),
    ignoredCount: state.ignoredCount,
    entries: state.entries,
    issues: state.issues
  };
}
