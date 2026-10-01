import fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { sha256Bytes } from '../src/server/vault/raw-bytes.js';
import {
  parseKnowledgeNoteForRead,
  parseLibraryNoteForRead
} from '../src/server/rules/read-compatible-notes.js';
import type { KnowledgeRecord, MaterialRecord } from '../src/shared/domain/records.js';

const KNOWLEDGE_ROOT = '02知识库';
const SOURCE_ROOT = '01图书馆';
const REQUIRED_ROOTS = ['00大脑规则', SOURCE_ROOT, KNOWLEDGE_ROOT, '03大讲堂'] as const;
const MAX_BYTES = 100_000;
const DEFAULT_BYTES = MAX_BYTES;
const MAX_QUERY_LENGTH = 2_000;
// Keep malformed or unexpectedly huge files from reaching YAML parsing in one shot.
// Normal tool output remains bounded by MAX_BYTES below.
const MAX_PHYSICAL_BYTES = 16 * 1024 * 1024;

export type VaultReaderErrorCode =
  | 'INVALID_ROOT'
  | 'PATH_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'READ_FAILED'
  | 'FILE_TOO_LARGE'
  | 'INVALID_NOTE'
  | 'INVALID_LIMIT';

export class VaultReaderError extends Error {
  public readonly name = 'VaultReaderError';

  constructor(public readonly code: VaultReaderErrorCode, message = SAFE_MESSAGES[code]) {
    super(message);
  }
}

const SAFE_MESSAGES: Record<VaultReaderErrorCode, string> = {
  INVALID_ROOT: 'The configured vault is not a valid four-section brain.',
  PATH_NOT_ALLOWED: 'The path must be a Markdown file under 01图书馆/ or 02知识库/.',
  NOT_FOUND: 'The requested Markdown file was not found.',
  READ_FAILED: 'The Markdown file could not be read; retry after checking permissions.',
  FILE_TOO_LARGE: 'The Markdown file is larger than the safe read limit.',
  INVALID_NOTE: 'The Markdown frontmatter does not match the expected note schema.',
  INVALID_LIMIT: 'The request limit or query is outside the allowed range.'
};

export type RawMarkdown = {
  path: string;
  text: string;
  bytes: number;
  totalBytes: number;
  lineCount: number;
  rawSha256: string;
  truncated: boolean;
};

export type KnowledgeRead = RawMarkdown & {
  record: KnowledgeRecord;
  recallFields: KnowledgeRecord['recallFields'];
  title: string;
  usageStatus: KnowledgeRecord['usageStatus'];
  knowledgeType: string;
  body: string;
};

export type SourceRead = RawMarkdown & {
  record: MaterialRecord;
  title: string;
  sourcePlatform: string;
  processingStatus: MaterialRecord['processingStatus'];
  knowledgeStatus: MaterialRecord['knowledgeStatus'];
  body: string;
};

export type EvidencePassage = {
  excerpt: string;
  startLine: number;
  endLine: number;
  rawSha256: string;
};

export type EvidenceRead = {
  path: string;
  query: string;
  passages: EvidencePassage[];
  truncated: boolean;
};

export type VaultReader = {
  readonly root: string;
  readMarkdown(path: string, maxBytes?: number): Promise<RawMarkdown>;
  readKnowledge(path: string, maxBytes?: number): Promise<KnowledgeRead>;
  readKnowledgeForSearch(path: string): Promise<KnowledgeRead>;
  readSource(path: string, maxBytes?: number): Promise<SourceRead>;
  findEvidence(path: string, query: string, maxPassages?: number): Promise<EvidenceRead>;
  listKnowledgeFiles(): Promise<string[]>;
};

type Section = typeof SOURCE_ROOT | typeof KNOWLEDGE_ROOT;

function fail(code: VaultReaderErrorCode): never {
  throw new VaultReaderError(code);
}

function fsFailureCode(error: unknown): VaultReaderErrorCode {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'NOT_FOUND';
  if (code === 'ELOOP') return 'PATH_NOT_ALLOWED';
  return 'READ_FAILED';
}

function isWithin(base: string, candidate: string): boolean {
  const remainder = relative(base, candidate);
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function validateLimit(value: number | undefined, maximum = MAX_BYTES): number {
  const limit = value ?? DEFAULT_BYTES;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) fail('INVALID_LIMIT');
  return limit;
}

function validateQuery(query: string): string {
  if (typeof query !== 'string' || query.length < 1 || query.length > MAX_QUERY_LENGTH || query.includes('\0')) {
    fail('INVALID_LIMIT');
  }
  return query.normalize('NFC');
}

function validateRelativePath(input: string): { section: Section; parts: string[] } {
  if (typeof input !== 'string' || input.length === 0 || isAbsolute(input)
    || input.includes('\\') || input.includes('\0') || Buffer.byteLength(input, 'utf8') > 4096) {
    fail('PATH_NOT_ALLOWED');
  }
  const parts = input.split('/');
  if (parts.length < 2 || parts.some((part) => part.length === 0 || part === '.' || part === '..'
    || part.startsWith('.') || Buffer.byteLength(part, 'utf8') > 255)) {
    fail('PATH_NOT_ALLOWED');
  }
  const section = parts[0];
  if (section !== SOURCE_ROOT && section !== KNOWLEDGE_ROOT) fail('PATH_NOT_ALLOWED');
  if (!input.endsWith('.md')) fail('PATH_NOT_ALLOWED');
  return { section, parts };
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/u).length;
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('READ_FAILED');
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = maxBytes; end > 0; end -= 1) {
    try {
      const candidate = decoder.decode(bytes.subarray(0, end));
      if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) return candidate;
    } catch {
      // The cut landed inside a multibyte sequence; move to the previous byte.
    }
  }
  return '';
}

async function resolveRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) fail('INVALID_ROOT');
  let canonical: string;
  try {
    canonical = await fs.realpath(root);
    const rootStat = await fs.stat(canonical);
    if (!rootStat.isDirectory()) fail('INVALID_ROOT');
    for (const required of REQUIRED_ROOTS) {
      const requiredPath = await fs.realpath(join(canonical, required));
      const requiredStat = await fs.stat(requiredPath);
      if (!requiredStat.isDirectory() || !isWithin(canonical, requiredPath)) fail('INVALID_ROOT');
    }
  } catch (error) {
    if (error instanceof VaultReaderError) throw error;
    fail('INVALID_ROOT');
  }
  return canonical;
}

function toRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

async function createReader(root: string): Promise<VaultReader> {
  const canonicalRoot = await resolveRoot(root);

  async function resolveSection(section: Section): Promise<string> {
    try {
      const sectionRoot = await fs.realpath(join(canonicalRoot, section));
      if (!isWithin(canonicalRoot, sectionRoot) || !(await fs.stat(sectionRoot)).isDirectory()) {
        fail('PATH_NOT_ALLOWED');
      }
      return sectionRoot;
    } catch (error) {
      if (error instanceof VaultReaderError) throw error;
      fail(fsFailureCode(error));
    }
  }

  async function resolveFile(input: string): Promise<{ section: Section; absolute: string; relativePath: string; identity: BigIntStats }> {
    const { section, parts } = validateRelativePath(input);
    const absolute = join(canonicalRoot, ...parts);
    let canonicalFile: string;
    let identity: BigIntStats;
    let fileSize = 0;
    try {
      canonicalFile = await fs.realpath(absolute);
      const fileStat = await fs.stat(canonicalFile, { bigint: true });
      if (!fileStat.isFile()) fail('PATH_NOT_ALLOWED');
      identity = fileStat;
      fileSize = Number(fileStat.size);
    } catch (error) {
      if (error instanceof VaultReaderError) throw error;
      fail(fsFailureCode(error));
    }
    const sectionRoot = await resolveSection(section);
    if (!isWithin(sectionRoot, canonicalFile)) fail('PATH_NOT_ALLOWED');
    if (fileSize > MAX_PHYSICAL_BYTES) fail('FILE_TOO_LARGE');
    const realParts = toRelative(canonicalRoot, canonicalFile).split('/');
    if (realParts.some((part) => part.startsWith('.'))) fail('PATH_NOT_ALLOWED');
    return { section, absolute: canonicalFile, relativePath: toRelative(canonicalRoot, canonicalFile), identity };
  }

  function makeRaw(relativePath: string, bytes: Uint8Array, limit: number): RawMarkdown {
    const text = decode(bytes);
    const outputText = truncateUtf8(text, limit);
    return {
      path: relativePath,
      text: outputText,
      bytes: Buffer.byteLength(outputText, 'utf8'),
      totalBytes: bytes.byteLength,
      lineCount: countLines(text),
      rawSha256: sha256Bytes(bytes),
      truncated: bytes.byteLength > limit
    };
  }

  async function readResolved(resolved: { section: Section; absolute: string; relativePath: string; identity: BigIntStats }, limit: number): Promise<{ bytes: Uint8Array; raw: RawMarkdown }> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(resolved.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== resolved.identity.dev || opened.ino !== resolved.identity.ino) fail('PATH_NOT_ALLOWED');
      if (opened.size > BigInt(MAX_PHYSICAL_BYTES)) fail('FILE_TOO_LARGE');
      if (opened.size !== resolved.identity.size || opened.mtimeNs !== resolved.identity.mtimeNs || opened.ctimeNs !== resolved.identity.ctimeNs) fail('READ_FAILED');
      // Reading through the verified descriptor avoids reopening a path after
      // validation. One extra byte detects growth without an unbounded read.
      const buffer = Buffer.alloc(Number(opened.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const section = await resolveSection(resolved.section);
      const currentPath = await fs.realpath(resolved.absolute);
      const current = await fs.stat(currentPath, { bigint: true });
      if (!isWithin(section, currentPath) || !isWithin(canonicalRoot, currentPath)
        || current.dev !== opened.dev || current.ino !== opened.ino) fail('PATH_NOT_ALLOWED');
      if (after.size > BigInt(MAX_PHYSICAL_BYTES)) fail('FILE_TOO_LARGE');
      if (length !== Number(opened.size) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
        || current.size !== opened.size || current.mtimeNs !== opened.mtimeNs || current.ctimeNs !== opened.ctimeNs) fail('READ_FAILED');
      const bytes = buffer.subarray(0, length);
      return { bytes, raw: makeRaw(resolved.relativePath, bytes, limit) };
    } catch (error) {
      if (error instanceof VaultReaderError) throw error;
      return fail(fsFailureCode(error));
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async function readMarkdown(path: string, maxBytes?: number): Promise<RawMarkdown> {
    const limit = validateLimit(maxBytes);
    const resolved = await resolveFile(path);
    return (await readResolved(resolved, limit)).raw;
  }

  async function readKnowledgeAtLimit(path: string, maxBytes: number | undefined, allowPhysicalLimit: boolean): Promise<KnowledgeRead> {
    const limit = validateLimit(maxBytes, allowPhysicalLimit ? MAX_PHYSICAL_BYTES : MAX_BYTES);
    const resolved = await resolveFile(path);
    if (resolved.section !== KNOWLEDGE_ROOT) fail('PATH_NOT_ALLOWED');
    const { bytes, raw } = await readResolved(resolved, limit);
    const parsed = parseKnowledgeNoteForRead(bytes, resolved.relativePath);
    if (!parsed.record || parsed.issues.length > 0) fail('INVALID_NOTE');
    const body = truncateUtf8(decode(parsed.bodyBytes), limit);
    return {
      ...raw,
      record: parsed.record,
      recallFields: parsed.record.recallFields,
      title: parsed.record.title,
      usageStatus: parsed.record.usageStatus,
      knowledgeType: parsed.record.knowledgeType,
      body
    };
  }

  async function readKnowledge(path: string, maxBytes?: number): Promise<KnowledgeRead> {
    return readKnowledgeAtLimit(path, maxBytes, false);
  }

  async function readKnowledgeForSearch(path: string): Promise<KnowledgeRead> {
    return readKnowledgeAtLimit(path, MAX_PHYSICAL_BYTES, true);
  }

  async function readSource(path: string, maxBytes?: number): Promise<SourceRead> {
    const limit = validateLimit(maxBytes);
    const resolved = await resolveFile(path);
    if (resolved.section !== SOURCE_ROOT) fail('PATH_NOT_ALLOWED');
    const { bytes, raw } = await readResolved(resolved, limit);
    const parsed = parseLibraryNoteForRead(bytes, resolved.relativePath);
    if (!parsed.record || parsed.issues.length > 0) fail('INVALID_NOTE');
    return {
      ...raw,
      record: parsed.record,
      title: parsed.record.title,
      sourcePlatform: parsed.record.sourcePlatform,
      processingStatus: parsed.record.processingStatus,
      knowledgeStatus: parsed.record.knowledgeStatus,
      body: truncateUtf8(decode(parsed.bodyBytes), limit)
    };
  }

  async function findEvidence(path: string, query: string, maxPassages = 8): Promise<EvidenceRead> {
    const normalizedQuery = validateQuery(query).toLowerCase();
    if (!Number.isInteger(maxPassages) || maxPassages < 1 || maxPassages > 8) fail('INVALID_LIMIT');
    const raw = await readSource(path, DEFAULT_BYTES);
    const lines = raw.text.split(/\r?\n/u);
    const passages: EvidencePassage[] = [];
    for (let index = 0; index < lines.length && passages.length < maxPassages; index += 1) {
      if (!lines[index]!.normalize('NFC').toLowerCase().includes(normalizedQuery)) continue;
      passages.push({
        excerpt: lines[index]!,
        startLine: index + 1,
        endLine: index + 1,
        rawSha256: raw.rawSha256
      });
    }
    return { path: raw.path, query, passages, truncated: raw.truncated };
  }

  async function listKnowledgeFiles(): Promise<string[]> {
    const root = await resolveSection(KNOWLEDGE_ROOT);
    const output: string[] = [];
    const visited = new Set<string>();
    async function walk(directory: string): Promise<void> {
      if (visited.has(directory)) return;
      visited.add(directory);
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        fail(fsFailureCode(error));
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
        if (entry.name.startsWith('.')) continue;
        const candidate = join(directory, entry.name);
        let candidateReal: string;
        try {
          candidateReal = await fs.realpath(candidate);
        } catch (error) {
          const code = typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined;
          if (code === 'ENOENT' || code === 'ELOOP') continue;
          fail(fsFailureCode(error));
        }
        if (!isWithin(root, candidateReal)) continue;
        const candidateParts = toRelative(root, candidateReal).split('/');
        if (candidateParts.some((part) => part.startsWith('.'))) continue;
        let candidateStat;
        try {
          candidateStat = await fs.stat(candidateReal);
        } catch (error) {
          fail(fsFailureCode(error));
        }
        if (candidateStat.isDirectory()) {
          await walk(candidateReal);
        } else if (candidateStat.isFile() && entry.name.endsWith('.md')) {
          output.push(toRelative(canonicalRoot, candidateReal));
        }
      }
    }
    await walk(root);
    return output.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  return { root: canonicalRoot, readMarkdown, readKnowledge, readKnowledgeForSearch, readSource, findEvidence, listKnowledgeFiles };
}

export async function createVaultReader(root: string): Promise<VaultReader> {
  return createReader(root);
}
