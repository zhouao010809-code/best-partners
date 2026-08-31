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
import type { KnowledgeRecord, MaterialRecord } from '../../shared/domain/records.js';
import type {
  knowledgeQuerySchema,
  materialQuerySchema
} from '../../shared/api/schemas.js';
import type { z } from 'zod';
import { createHash } from 'node:crypto';

type MaterialApiQuery = z.output<typeof materialQuerySchema>;
type KnowledgeApiQuery = z.output<typeof knowledgeQuerySchema>;

export interface ReadService {
  listMaterials(query: MaterialApiQuery): Page<MaterialRecord>;
  listKnowledge(query: KnowledgeApiQuery): Page<KnowledgeRecord>;
  getKnowledgeDetail(path: string): Promise<{
    path: string;
    title: string;
    markdown: string;
    versionMarker: { rawSha256: string; upstreamVersion?: string };
  }>;
  openKnowledge(path: string): Promise<{ opened: true; path: string }>;
}

const REPOSITORY_PAGE_SIZE = 200;
const DEFAULT_API_PAGE_SIZE = 50;

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

function opaqueCursor(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex');
}

function cursorOffset<T extends { path: string }>(records: readonly T[], cursor?: string): number {
  if (cursor === undefined) return 0;
  const matches = records
    .map((record, index) => ({ index, cursor: opaqueCursor(record.path) }))
    .filter((entry) => entry.cursor === cursor);
  if (matches.length !== 1) {
    throw new PublicApiError('VALIDATION_ERROR', 'Request validation failed', 400, {
      cursor: 'Unknown cursor'
    });
  }
  return matches[0]!.index + 1;
}

function paginateByPath<T extends { path: string }>(
  records: readonly T[],
  cursor: string | undefined,
  requestedLimit: number | undefined
): Page<T> {
  const limit = requestedLimit ?? DEFAULT_API_PAGE_SIZE;
  const eligible = records.slice(cursorOffset(records, cursor));
  const items = eligible.slice(0, limit);
  const finalItem = items.at(-1);
  return {
    items: [...items],
    ...(eligible.length > items.length && finalItem !== undefined
      ? { nextCursor: opaqueCursor(finalItem.path) }
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

export function createReadService(input: {
  repository: IndexRepository;
  gateway: OpenableVaultGateway;
}): ReadService {
  return {
    listMaterials: (query) => {
      const records = collectMaterials(input.repository, {
        ...(query.status === undefined ? {} : { knowledgeStatus: query.status }),
        ...(query.sourcePlatform === undefined ? {} : { sourcePlatform: query.sourcePlatform }),
        ...(query.collectedFrom === undefined ? {} : { collectedFrom: query.collectedFrom }),
        ...(query.collectedTo === undefined ? {} : { collectedTo: query.collectedTo }),
        ...(query.title === undefined ? {} : { title: query.title })
      }).filter((record) => query.status !== undefined
        || record.knowledgeStatus === '未提炼'
        || record.knowledgeStatus === '部分入库');
      return paginateByPath(records, query.cursor, query.limit);
    },

    listKnowledge: (query) => {
      const records = collectKnowledge(input.repository, {
        ...(query.includeObsolete === undefined ? {} : { includeObsolete: query.includeObsolete }),
        ...(query.usageStatus === undefined ? {} : { usageStatus: query.usageStatus }),
        ...(query.knowledgeType === undefined ? {} : { knowledgeType: query.knowledgeType }),
        ...(query.topic === undefined ? {} : { topic: query.topic }),
        ...(query.search === undefined ? {} : { search: query.search })
      });
      return paginateByPath(records, query.cursor, query.limit);
    },

    getKnowledgeDetail: async (requestedPath) => {
      const path = normalizeKnowledgePath(requestedPath);
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
      return {
        path,
        title: after.title,
        markdown,
        versionMarker: {
          rawSha256: computedSha256,
          ...(live.upstreamVersion === undefined ? {} : { upstreamVersion: live.upstreamVersion })
        }
      };
    },

    openKnowledge: async (requestedPath) => {
      const path = normalizeKnowledgePath(requestedPath);
      if (input.repository.getKnowledge(path) === undefined) {
        throw new PublicApiError('KNOWLEDGE_NOT_FOUND', 'Knowledge note was not found', 404);
      }
      await input.gateway.openInObsidian(path);
      return { opened: true, path };
    }
  };
}
