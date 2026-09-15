import { readFile, readdir, realpath, stat } from 'node:fs/promises';
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

  constructor(public readonly code: VaultReaderErrorCode, message = code) {
    super(message);
  }
}

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
  readSource(path: string, maxBytes?: number): Promise<SourceRead>;
  findEvidence(path: string, query: string, maxPassages?: number): Promise<EvidenceRead>;
  listKnowledgeFiles(): Promise<string[]>;
};

type Section = typeof SOURCE_ROOT | typeof KNOWLEDGE_ROOT;

function fail(code: VaultReaderErrorCode): never {
  throw new VaultReaderError(code);
}

function isWithin(base: string, candidate: string): boolean {
  const remainder = relative(base, candidate);
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_BYTES;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BYTES) fail('INVALID_LIMIT');
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
    canonical = await realpath(root);
    const rootStat = await stat(canonical);
    if (!rootStat.isDirectory()) fail('INVALID_ROOT');
    for (const required of REQUIRED_ROOTS) {
      const requiredPath = await realpath(join(canonical, required));
      const requiredStat = await stat(requiredPath);
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

  async function resolveFile(input: string): Promise<{ section: Section; absolute: string; relativePath: string }> {
    const { section, parts } = validateRelativePath(input);
    const absolute = join(canonicalRoot, ...parts);
    let canonicalFile: string;
    let fileSize = 0;
    try {
      canonicalFile = await realpath(absolute);
      const fileStat = await stat(canonicalFile);
      if (!fileStat.isFile()) fail('PATH_NOT_ALLOWED');
      fileSize = fileStat.size;
    } catch (error) {
      if (error instanceof VaultReaderError) throw error;
      fail('NOT_FOUND');
    }
    const sectionRoot = await realpath(join(canonicalRoot, section));
    if (!isWithin(sectionRoot, canonicalFile)) fail('PATH_NOT_ALLOWED');
    if (fileSize > MAX_PHYSICAL_BYTES) fail('FILE_TOO_LARGE');
    const realParts = toRelative(canonicalRoot, canonicalFile).split('/');
    if (realParts.some((part) => part.startsWith('.'))) fail('PATH_NOT_ALLOWED');
    return { section, absolute: canonicalFile, relativePath: toRelative(canonicalRoot, canonicalFile) };
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

  async function readResolved(resolved: { absolute: string; relativePath: string }, limit: number): Promise<{ bytes: Uint8Array; raw: RawMarkdown }> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(resolved.absolute);
    } catch {
      fail('READ_FAILED');
    }
    return { bytes, raw: makeRaw(resolved.relativePath, bytes, limit) };
  }

  async function readMarkdown(path: string, maxBytes?: number): Promise<RawMarkdown> {
    const limit = validateLimit(maxBytes);
    const resolved = await resolveFile(path);
    return (await readResolved(resolved, limit)).raw;
  }

  async function readKnowledge(path: string, maxBytes?: number): Promise<KnowledgeRead> {
    const limit = validateLimit(maxBytes);
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
    const root = await realpath(join(canonicalRoot, KNOWLEDGE_ROOT));
    const output: string[] = [];
    async function walk(directory: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        fail('READ_FAILED');
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
        if (entry.name.startsWith('.')) continue;
        const candidate = join(directory, entry.name);
        let candidateReal: string;
        try {
          candidateReal = await realpath(candidate);
        } catch {
          continue;
        }
        if (!isWithin(root, candidateReal)) continue;
        const candidateStat = await stat(candidateReal);
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

  return { root: canonicalRoot, readMarkdown, readKnowledge, readSource, findEvidence, listKnowledgeFiles };
}

export async function createVaultReader(root: string): Promise<VaultReader> {
  return createReader(root);
}
