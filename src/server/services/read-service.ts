import type {
  KnowledgeQuery,
  IndexRepository,
  MaterialQuery
} from '../index/index-repository.js';
import { normalizeVaultPath } from '../security/vault-path.js';
import type { OpenableVaultGateway } from '../vault/VaultGateway.js';
import { sha256Bytes } from '../vault/raw-bytes.js';
import { PublicApiError } from '../../shared/api/errors.js';
import type { Page } from '../../shared/api/envelopes.js';
import type { KnowledgeRecord, MaterialRecord, SchemaIssue } from '../../shared/domain/records.js';
import type {
  knowledgeQuerySchema,
  documentIssueQuerySchema,
  materialQuerySchema
} from '../../shared/api/schemas.js';
import type { z } from 'zod';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { extractWikiLinks } from '../rules/wikilinks.js';
import type Database from 'better-sqlite3';
import { readDeletedSourceCutoffs, readMaterialVisibility } from './material-visibility.js';
import type { LibraryPage, libraryQuerySchema } from '../../shared/api/library.js';
import { buildLibraryCatalog } from './library-catalog.js';
import type { KnowledgeCatalogPage, knowledgeCatalogQuerySchema } from '../../shared/api/knowledge-catalog.js';
import { buildKnowledgeCatalog, readKnowledgeDirectory } from './knowledge-catalog.js';

type MaterialApiQuery = z.output<typeof materialQuerySchema>;
type KnowledgeApiQuery = z.output<typeof knowledgeQuerySchema>;

export interface ReadService {
  listKnowledgeCatalog(query: z.output<typeof knowledgeCatalogQuerySchema>): Promise<KnowledgeCatalogPage>;
  listLibrary(query: z.output<typeof libraryQuerySchema>): LibraryPage;
  listDocumentIssues(query: z.output<typeof documentIssueQuerySchema>): Page<SchemaIssue>;
  getDocumentDetail(path: string): Promise<{
    path: string;
    title: string;
    markdown: string;
    versionMarker: { rawSha256: string; upstreamVersion?: string };
  }>;
  listMaterials(query: MaterialApiQuery): Page<MaterialRecord>;
  listKnowledge(query: KnowledgeApiQuery): Page<KnowledgeRecord>;
  getKnowledgeDetail(path: string): Promise<{
    record?: KnowledgeRecord;
    path: string;
    title: string;
    markdown: string;
    internalKnowledgeLinks: Array<{ path: string; title: string }>;
    versionMarker: { rawSha256: string; upstreamVersion?: string };
  }>;
  openKnowledge(path: string): Promise<{ opened: true; path: string }>;
}

const REPOSITORY_PAGE_SIZE = 200;
const DEFAULT_API_PAGE_SIZE = 50;
const CURSOR_FORMAT_VERSION = 1;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+\.([a-f0-9]{64})$/u;

type CursorKind = 'material' | 'knowledge' | 'issue' | 'library' | 'knowledge-catalog';

type CursorPayload = {
  readonly version: typeof CURSOR_FORMAT_VERSION;
  readonly kind: CursorKind;
  readonly filterSha256: string;
  readonly indexVersion: number;
  readonly afterPath: string;
  readonly snapshotSha256?: string;
};

type PaginationContext = {
  readonly kind: CursorKind;
  readonly filterSha256: string;
  readonly indexVersion: number;
  readonly afterPath?: string;
  readonly snapshotSha256?: string;
};

function publicPathError(): PublicApiError {
  return new PublicApiError('PATH_NOT_ALLOWED', 'Path is not allowed', 400);
}

function normalizeKnowledgePath(input: string): string {
  let path: string;
  try {
    path = normalizeVaultPath(input, 'read');
  } catch {
    throw publicPathError();
  }
  if (!path.startsWith('02知识库/') || !path.endsWith('.md')) {
    throw publicPathError();
  }
  return path;
}

function cursorValidationError(message = 'Invalid cursor'): PublicApiError {
  return new PublicApiError('VALIDATION_ERROR', 'Request validation failed', 400, {
    cursor: message
  });
}

function cursorVersionConflict(): PublicApiError {
  return new PublicApiError(
    'VERSION_CONFLICT',
    'Cursor index version is no longer current',
    409
  );
}

function readIndexVersion(currentIndexVersion: () => number): number {
  const indexVersion = currentIndexVersion();
  if (!Number.isSafeInteger(indexVersion) || indexVersion < 0) {
    throw new Error('INDEX_VERSION_INVALID');
  }
  return indexVersion;
}

function canonicalFilterSha256(filters: Readonly<Record<string, unknown>>): string {
  const canonical = Object.fromEntries(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  );
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).filter((key) => key !== 'snapshotSha256').sort().join(',') !== 'afterPath,filterSha256,indexVersion,kind,version') {
    return false;
  }
  return payload.version === CURSOR_FORMAT_VERSION
    && (payload.kind === 'material' || payload.kind === 'knowledge' || payload.kind === 'issue' || payload.kind === 'library' || payload.kind === 'knowledge-catalog')
    && typeof payload.filterSha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(payload.filterSha256)
    && typeof payload.indexVersion === 'number'
    && Number.isSafeInteger(payload.indexVersion)
    && payload.indexVersion >= 0
    && typeof payload.afterPath === 'string'
    && payload.afterPath.length > 0
    && payload.afterPath.length <= 1024
    && (payload.snapshotSha256 === undefined || typeof payload.snapshotSha256 === 'string' && /^[a-f0-9]{64}$/u.test(payload.snapshotSha256));
}

function signCursorBody(body: string, secret: Uint8Array): string {
  return createHmac('sha256', secret).update(body, 'ascii').digest('hex');
}

function encodeCursor(payload: CursorPayload, secret: Uint8Array): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${signCursorBody(body, secret)}`;
}

function decodeCursor(cursor: string, secret: Uint8Array): CursorPayload {
  const match = CURSOR_PATTERN.exec(cursor);
  if (match === null) throw cursorValidationError();
  const separator = cursor.lastIndexOf('.');
  const body = cursor.slice(0, separator);
  const suppliedSignature = Buffer.from(match[1]!, 'hex');
  const expectedSignature = Buffer.from(signCursorBody(body, secret), 'hex');
  if (!timingSafeEqual(suppliedSignature, expectedSignature)) {
    throw cursorValidationError();
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw cursorValidationError();
  }
  if (!isCursorPayload(decoded)) throw cursorValidationError();
  return decoded;
}

function resolvePaginationContext(input: {
  kind: CursorKind;
  filters: Readonly<Record<string, unknown>>;
  cursor?: string;
  currentIndexVersion: () => number;
  cursorSecret: Uint8Array;
  snapshotSha256?: string;
}): PaginationContext {
  const indexVersion = readIndexVersion(input.currentIndexVersion);
  const filterSha256 = canonicalFilterSha256(input.filters);
  if (input.cursor === undefined) {
    return { kind: input.kind, filterSha256, indexVersion, ...(input.snapshotSha256 ? { snapshotSha256: input.snapshotSha256 } : {}) };
  }
  const cursor = decodeCursor(input.cursor, input.cursorSecret);
  if (cursor.kind !== input.kind || cursor.filterSha256 !== filterSha256) {
    throw cursorValidationError('Cursor does not match request filters');
  }
  if (cursor.indexVersion !== indexVersion || cursor.snapshotSha256 !== input.snapshotSha256) {
    throw cursorVersionConflict();
  }
  return { kind: input.kind, filterSha256, indexVersion, afterPath: cursor.afterPath, ...(input.snapshotSha256 ? { snapshotSha256: input.snapshotSha256 } : {}) };
}

function assertIndexVersionUnchanged(
  expectedVersion: number,
  currentIndexVersion: () => number
): void {
  if (readIndexVersion(currentIndexVersion) !== expectedVersion) {
    throw cursorVersionConflict();
  }
}

function paginateByPath<T extends { path: string }>(
  records: readonly T[],
  requestedLimit: number | undefined,
  context: PaginationContext,
  cursorSecret: Uint8Array
): Page<T> {
  const limit = requestedLimit ?? DEFAULT_API_PAGE_SIZE;
  const eligible = context.afterPath === undefined
    ? records
    : records.filter((record) => record.path > context.afterPath!);
  const items = eligible.slice(0, limit);
  const finalItem = items.at(-1);
  return {
    items: [...items],
    ...(eligible.length > items.length && finalItem !== undefined
      ? { nextCursor: encodeCursor({
          version: CURSOR_FORMAT_VERSION,
          kind: context.kind,
          filterSha256: context.filterSha256,
          indexVersion: context.indexVersion,
          ...(context.snapshotSha256 ? { snapshotSha256: context.snapshotSha256 } : {}),
          afterPath: finalItem.path
        }, cursorSecret) }
      : {})
  };
}

function collectMaterials(repository: IndexRepository, query: MaterialQuery): MaterialRecord[] {
  const records: MaterialRecord[] = [];
  let page = 1;
  while (true) {
    const current = repository.listMaterials({ ...query, page, pageSize: REPOSITORY_PAGE_SIZE });
    records.push(...current.items);
    if (records.length >= current.total || current.items.length === 0) return records;
    page += 1;
  }
}

function collectKnowledge(repository: IndexRepository, query: KnowledgeQuery): KnowledgeRecord[] {
  const records: KnowledgeRecord[] = [];
  let page = 1;
  while (true) {
    const current = repository.listKnowledge({ ...query, page, pageSize: REPOSITORY_PAGE_SIZE });
    records.push(...current.items);
    if (records.length >= current.total || current.items.length === 0) return records;
    page += 1;
  }
}

function sameProjectionVersion(left: KnowledgeRecord, right: KnowledgeRecord): boolean {
  return left.path === right.path
    && left.rawSha256 === right.rawSha256
    && left.upstreamVersion === right.upstreamVersion;
}

type WikiTarget =
  | { readonly kind: 'exact'; readonly path: string }
  | { readonly kind: 'fallback'; readonly key: string };

type IndexedMarkdownIdentity = {
  readonly id: string;
  readonly kind: 'material' | 'knowledge';
  readonly path: string;
  readonly title: string;
};

function safeWikiTarget(target: string): WikiTarget | undefined {
  const heading = target.indexOf('#');
  const block = target.indexOf('^');
  const separators = [heading, block].filter((index) => index >= 0);
  const end = separators.length === 0 ? target.length : Math.min(...separators);
  const base = target.slice(0, end).trim().normalize('NFC');
  if (
    base.length === 0
    || base.length > 1024
    || base.startsWith('/')
    || base.includes('\\')
    || base.includes('\0')
    || /%[0-9a-f]{2}/iu.test(base)
    || /^[a-z][a-z0-9+.-]*:/iu.test(base)
    || /^(?:00大脑规则|01图书馆|03大讲堂)(?:\/|$)/u.test(base)
  ) {
    return undefined;
  }

  const filename = base.split('/').at(-1)!;
  const isMarkdownPath = filename.endsWith('.md');
  if (!isMarkdownPath && filename.includes('.')) return undefined;

  const validationPath = base.startsWith('02知识库/')
    ? `${base}${isMarkdownPath ? '' : '.md'}`
    : `02知识库/${base}${isMarkdownPath ? '' : '.md'}`;
  try {
    const path = normalizeKnowledgePath(validationPath);
    return isMarkdownPath ? { kind: 'exact', path } : { kind: 'fallback', key: base };
  } catch {
    return undefined;
  }
}

function indexedMarkdownIdentity(
  kind: IndexedMarkdownIdentity['kind'],
  record: MaterialRecord | KnowledgeRecord
): IndexedMarkdownIdentity | undefined {
  let path: string;
  try {
    path = normalizeVaultPath(record.path, 'read');
  } catch {
    return undefined;
  }
  if (
    !path.endsWith('.md')
    || (kind === 'material' && !path.startsWith('01图书馆/'))
    || (kind === 'knowledge' && !path.startsWith('02知识库/'))
  ) {
    return undefined;
  }
  return {
    id: `${kind}\0${record.path}`,
    kind,
    path,
    title: record.title
  };
}

function fallbackReferenceKeys(identity: IndexedMarkdownIdentity): string[] {
  const root = identity.kind === 'material' ? '01图书馆/' : '02知识库/';
  const relativePath = identity.path.slice(root.length);
  const filename = relativePath.split('/').at(-1)!;
  const pathWithoutExtension = identity.path.slice(0, -3);
  const relativeWithoutExtension = relativePath.slice(0, -3);
  const filenameWithoutExtension = filename.slice(0, -3);
  return [...new Set([
    pathWithoutExtension,
    relativeWithoutExtension,
    filenameWithoutExtension,
    identity.title.trim().normalize('NFC')
  ].filter((key) => key.length > 0))];
}

function markdownBody(markdown: string): string {
  const documentStart = markdown.startsWith('\uFEFF') ? 1 : 0;
  const firstNewline = markdown.indexOf('\n', documentStart);
  if (firstNewline < 0) return markdown;
  const opening = markdown.slice(documentStart, firstNewline).replace(/\r$/u, '');
  if (opening !== '---') return markdown;

  let lineStart = firstNewline + 1;
  while (lineStart <= markdown.length) {
    const newline = markdown.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? markdown.length : newline;
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/u, '');
    if (line === '---') return newline < 0 ? '' : markdown.slice(newline + 1);
    if (newline < 0) return '';
    lineStart = newline + 1;
  }
  return '';
}

function addCandidate(
  candidates: Map<string, Map<string, IndexedMarkdownIdentity>>,
  key: string,
  identity: IndexedMarkdownIdentity
): void {
  const matches = candidates.get(key) ?? new Map<string, IndexedMarkdownIdentity>();
  matches.set(identity.id, identity);
  candidates.set(key, matches);
}

function resolveInternalKnowledgeLinks(
  markdown: string,
  detailPath: string,
  materials: readonly MaterialRecord[],
  knowledge: readonly KnowledgeRecord[]
): Array<{ path: string; title: string }> {
  const exactCandidates = new Map<string, Map<string, IndexedMarkdownIdentity>>();
  const fallbackCandidates = new Map<string, Map<string, IndexedMarkdownIdentity>>();
  for (const [kind, records] of [
    ['material', materials],
    ['knowledge', knowledge]
  ] as const) {
    for (const record of records) {
      const identity = indexedMarkdownIdentity(kind, record);
      if (identity === undefined) continue;
      addCandidate(exactCandidates, identity.path, identity);
      for (const key of fallbackReferenceKeys(identity)) {
        addCandidate(fallbackCandidates, key, identity);
      }
    }
  }

  const resolved: Array<{ path: string; title: string }> = [];
  const seen = new Set<string>();
  for (const extracted of extractWikiLinks(markdownBody(markdown))) {
    const target = safeWikiTarget(extracted);
    if (target === undefined) continue;
    const matches = target.kind === 'exact'
      ? exactCandidates.get(target.path)
      : fallbackCandidates.get(target.key);
    if (matches === undefined || matches.size !== 1) continue;
    const identity = matches.values().next().value as IndexedMarkdownIdentity | undefined;
    if (
      identity === undefined
      || identity.kind !== 'knowledge'
      || identity.path === detailPath
      || seen.has(identity.path)
    ) {
      continue;
    }
    seen.add(identity.path);
    resolved.push({ path: identity.path, title: identity.title });
  }
  return resolved;
}

export function createReadService(input: {
  database?: Database.Database;
  repository: IndexRepository;
  gateway: OpenableVaultGateway;
  currentIndexVersion: () => number;
  cursorSecret: Uint8Array;
}): ReadService {
  const cursorSecret = Buffer.from(input.cursorSecret);
  if (cursorSecret.length < 16) throw new Error('CURSOR_SECRET_TOO_SHORT');
  function assertKnowledgeAvailable(path: string): void {
    if (readMaterialVisibility(input.database).trashed.has(path)) {
      throw new PublicApiError('KNOWLEDGE_IN_TRASH', '这篇知识已在回收站，请先恢复后再打开。', 409);
    }
    if (!input.repository.getKnowledge(path) && readDeletedSourceCutoffs(input.database).has(path)) {
      throw new PublicApiError('KNOWLEDGE_DELETED', '这篇知识已彻底删除，无法从回收站恢复。', 404);
    }
  }
  function assertMaterialVisible(path: string): void {
    if (readMaterialVisibility(input.database).trashed.has(path)) {
      throw new PublicApiError('SOURCE_IN_TRASH', '这份资料已移入回收站或正在恢复，请先在回收站完成恢复。', 409);
    }
  }
  return {
    listKnowledgeCatalog: async (query) => {
      const version = readIndexVersion(input.currentIndexVersion);
      const entries = await readKnowledgeDirectory(input.gateway, query.path);
      assertIndexVersionUnchanged(version, input.currentIndexVersion);
      const search = query.search?.trim() || undefined;
      const filters = {
        path: query.path,
        ...(query.includeObsolete === undefined ? {} : { includeObsolete: query.includeObsolete }),
        ...(query.usageStatus === undefined ? {} : { usageStatus: query.usageStatus }),
        ...(query.knowledgeType === undefined ? {} : { knowledgeType: query.knowledgeType }),
        ...(query.topic === undefined ? {} : { topic: query.topic }),
        ...(search === undefined ? {} : { search })
      };
      const { trashed } = readMaterialVisibility(input.database);
      const snapshotSha256 = createHash('sha256').update(JSON.stringify({ entries, trashed: [...trashed].sort() })).digest('hex');
      const context = resolvePaginationContext({
        kind: 'knowledge-catalog', filters,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        currentIndexVersion: input.currentIndexVersion, snapshotSha256, cursorSecret
      });
      const records = collectKnowledge(input.repository, filters).filter(record => !trashed.has(record.path));
      assertIndexVersionUnchanged(version, input.currentIndexVersion);
      const catalog = buildKnowledgeCatalog({ path: query.path, entries, records, ...(search === undefined ? {} : { search }) });
      return { ...catalog, ...paginateByPath(catalog.items, query.limit, context, cursorSecret), indexVersion: context.indexVersion };
    },
    listLibrary: (query) => {
      const { trashed } = readMaterialVisibility(input.database);
      const snapshotSha256 = createHash('sha256').update(JSON.stringify([...trashed].sort())).digest('hex');
      const filters = { mode: query.mode, path: query.path,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.title === undefined ? {} : { title: query.title }) };
      const context = resolvePaginationContext({
        kind: 'library', filters,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        currentIndexVersion: input.currentIndexVersion,
        snapshotSha256,
        cursorSecret
      });
      const materials = collectMaterials(input.repository, {});
      const knowledge = collectKnowledge(input.repository, { includeObsolete: true });
      assertIndexVersionUnchanged(context.indexVersion, input.currentIndexVersion);
      const currentVisibility = readMaterialVisibility(input.database).trashed;
      if (createHash('sha256').update(JSON.stringify([...currentVisibility].sort())).digest('hex') !== snapshotSha256) {
        throw cursorVersionConflict();
      }
      const catalog = buildLibraryCatalog({ materials, knowledge, trashed, query });
      return { ...catalog, ...paginateByPath(catalog.items, query.limit, context, cursorSecret), indexVersion: context.indexVersion };
    },
    listDocumentIssues: (query) => {
      const context = resolvePaginationContext({
        kind: 'issue', filters: {},
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        currentIndexVersion: input.currentIndexVersion, cursorSecret
      });
      // SQLite's Unicode ordering differs from the cursor's UTF-16 comparison.
      const issues = input.repository.listIssues().sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      assertIndexVersionUnchanged(context.indexVersion, input.currentIndexVersion);
      return paginateByPath(issues, query.limit, context, cursorSecret);
    },

    getDocumentDetail: async (requestedPath) => {
      let path: string;
      try { path = normalizeVaultPath(requestedPath, 'read'); }
      catch { throw publicPathError(); }
      if (!/^(?:01图书馆|02知识库)\/.+\.md$/u.test(path)) throw publicPathError();
      if (path.startsWith('02知识库/')) assertKnowledgeAvailable(path);
      else assertMaterialVisible(path);
      const indexVersion = readIndexVersion(input.currentIndexVersion);
      const before = input.repository.getManifestEntry(path);
      const issueBefore = input.repository.listIssues().find((issue) => issue.path === path);
      if (before === undefined && issueBefore === undefined) {
        throw new PublicApiError('DOCUMENT_NOT_FOUND', '资料不在当前索引中，请刷新后重试。', 404);
      }
      const live = await input.gateway.readRaw(path);
      const computedSha256 = sha256Bytes(live.bytes);
      const after = input.repository.getManifestEntry(path);
      const issueAfter = input.repository.listIssues().find((issue) => issue.path === path);
      assertIndexVersionUnchanged(indexVersion, input.currentIndexVersion);
      if (path.startsWith('02知识库/')) assertKnowledgeAvailable(path);
      else assertMaterialVisible(path);
      if (
        live.path !== path || live.rawSha256 !== computedSha256
        || JSON.stringify(before) !== JSON.stringify(after)
        || JSON.stringify(issueBefore) !== JSON.stringify(issueAfter)
        || (before !== undefined && (live.rawSha256 !== before.rawSha256 || live.upstreamVersion !== before.upstreamVersion))
      ) {
        throw new PublicApiError('VERSION_CONFLICT', '资料已变化，请刷新后重新打开。', 409);
      }
      let markdown: string;
      try {
        // Keep BOM and CRLF: this is a live original, not a rewritten projection.
        markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(live.bytes);
      } catch {
        throw new PublicApiError('MARKDOWN_ENCODING_INVALID', '此文件不是可读取的 UTF-8 文本，原文件未改动。', 422);
      }
      return {
        path, title: path.split('/').at(-1)!.slice(0, -3), markdown,
        versionMarker: {
          rawSha256: computedSha256,
          ...(live.upstreamVersion === undefined ? {} : { upstreamVersion: live.upstreamVersion })
        }
      };
    },

    listMaterials: (query) => {
      const { trashed } = readMaterialVisibility(input.database);
      const filters = {
        ...(query.status === undefined ? {} : { knowledgeStatus: query.status }),
        ...(query.sourcePlatform === undefined ? {} : { sourcePlatform: query.sourcePlatform }),
        ...(query.collectedFrom === undefined ? {} : { collectedFrom: query.collectedFrom }),
        ...(query.collectedTo === undefined ? {} : { collectedTo: query.collectedTo }),
        ...(query.title === undefined ? {} : { title: query.title })
      };
      const context = resolvePaginationContext({
        kind: 'material',
        filters,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        currentIndexVersion: input.currentIndexVersion,
        snapshotSha256: createHash('sha256').update(JSON.stringify([...trashed])).digest('hex'),
        cursorSecret
      });
      const records = collectMaterials(input.repository, filters).filter((record) => !trashed.has(record.path) && (query.status !== undefined
        || record.knowledgeStatus === '未提炼'
        || record.knowledgeStatus === '部分入库'));
      assertIndexVersionUnchanged(context.indexVersion, input.currentIndexVersion);
      return paginateByPath(records, query.limit, context, cursorSecret);
    },

    listKnowledge: (query) => {
      const { trashed } = readMaterialVisibility(input.database);
      const filters = {
        ...(query.includeObsolete === undefined ? {} : { includeObsolete: query.includeObsolete }),
        ...(query.usageStatus === undefined ? {} : { usageStatus: query.usageStatus }),
        ...(query.knowledgeType === undefined ? {} : { knowledgeType: query.knowledgeType }),
        ...(query.topic === undefined ? {} : { topic: query.topic }),
        ...(query.search === undefined ? {} : { search: query.search })
      };
      const context = resolvePaginationContext({
        kind: 'knowledge',
        filters,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        currentIndexVersion: input.currentIndexVersion,
        ...(trashed.size ? { snapshotSha256: createHash('sha256').update(JSON.stringify([...trashed].sort())).digest('hex') } : {}),
        cursorSecret
      });
      const records = collectKnowledge(input.repository, filters).filter(record => !trashed.has(record.path));
      assertIndexVersionUnchanged(context.indexVersion, input.currentIndexVersion);
      return paginateByPath(records, query.limit, context, cursorSecret);
    },

    getKnowledgeDetail: async (requestedPath) => {
      const path = normalizeKnowledgePath(requestedPath);
      assertKnowledgeAvailable(path);
      const indexVersion = readIndexVersion(input.currentIndexVersion);
      const before = input.repository.getKnowledge(path);
      if (before === undefined) {
        throw new PublicApiError('KNOWLEDGE_NOT_FOUND', 'Knowledge note was not found', 404);
      }

      const live = await input.gateway.readRaw(path);
      const computedSha256 = sha256Bytes(live.bytes);
      const after = input.repository.getKnowledge(path);
      if (
        live.path !== path
        || live.rawSha256 !== computedSha256
        || live.rawSha256 !== before.rawSha256
        || after === undefined
        || !sameProjectionVersion(before, after)
      ) {
        throw new PublicApiError('VERSION_CONFLICT', 'Knowledge note changed after indexing', 409);
      }

      let markdown: string;
      try {
        markdown = new TextDecoder('utf-8', { fatal: true }).decode(live.bytes);
      } catch {
        throw new PublicApiError('MARKDOWN_ENCODING_INVALID', 'Knowledge note is not valid UTF-8', 422);
      }
      const indexedMaterials = collectMaterials(input.repository, {});
      const indexedKnowledge = collectKnowledge(input.repository, { includeObsolete: true });
      assertIndexVersionUnchanged(indexVersion, input.currentIndexVersion);
      assertKnowledgeAvailable(path);
      return {
        path,
        title: after.title,
        markdown,
        record: after,
        internalKnowledgeLinks: resolveInternalKnowledgeLinks(
          markdown,
          path,
          indexedMaterials,
          indexedKnowledge
        ),
        versionMarker: {
          rawSha256: computedSha256,
          ...(live.upstreamVersion === undefined ? {} : { upstreamVersion: live.upstreamVersion })
        }
      };
    },

    openKnowledge: async (requestedPath) => {
      const path = normalizeKnowledgePath(requestedPath);
      assertKnowledgeAvailable(path);
      if (input.repository.getKnowledge(path) === undefined) {
        throw new PublicApiError('KNOWLEDGE_NOT_FOUND', 'Knowledge note was not found', 404);
      }
      await input.gateway.openInObsidian(path);
      return { opened: true, path };
    }
  };
}
