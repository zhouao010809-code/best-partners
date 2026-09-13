import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type {
  KnowledgeRecord,
  KnowledgeStatus,
  MaterialRecord,
  SchemaIssue,
  SchemaIssueCode,
  UsageStatus
} from '../../shared/domain/records.js';

export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

type PaginationQuery = {
  readonly page?: number;
  readonly pageSize?: number;
};

export type MaterialQuery = PaginationQuery & {
  readonly knowledgeStatus?: KnowledgeStatus;
  readonly sourcePlatform?: string;
  readonly collectedFrom?: string;
  readonly collectedTo?: string;
  readonly title?: string;
};

export type KnowledgeQuery = PaginationQuery & {
  readonly includeObsolete?: boolean;
  readonly usageStatus?: UsageStatus;
  readonly knowledgeType?: string;
  readonly topic?: string;
  readonly search?: string;
};

export type IndexedFile =
  | { kind: 'material'; record: MaterialRecord }
  | { kind: 'knowledge'; record: KnowledgeRecord };

export type ManifestEntry = {
  path: string;
  kind: IndexedFile['kind'];
  rawSha256: string;
  upstreamVersion?: string;
  manifestSha256: string;
};

export type IndexBatch = {
  readonly files: ReadonlyArray<IndexedFile>;
  readonly issues: ReadonlyArray<SchemaIssue>;
};

export type IndexPublication = IndexBatch & {
  readonly expectedVersion: number;
  readonly manifestChanged: boolean;
};

export type IndexPublicationResult = {
  readonly projectionChanged: boolean;
  readonly version: number;
};

export interface IndexRepository {
  replaceFile(entry: IndexedFile): void;
  removeFile(path: string): void;
  replaceIssue(issue: SchemaIssue): void;
  clearIssue(path: string): void;
  listMaterials(query: MaterialQuery): Page<MaterialRecord>;
  listKnowledge(query: KnowledgeQuery): Page<KnowledgeRecord>;
  getKnowledge(path: string): KnowledgeRecord | undefined;
  publishBatch(publication: IndexPublication): IndexPublicationResult;
  listIssues(): SchemaIssue[];
  getManifestEntry(path: string): ManifestEntry | undefined;
}

type SearchRow = {
  path: string;
  kind: string;
  rawSha256: string;
  upstreamVersion: string | null;
  yamlJson: string;
  linksJson: string;
};

type IssueRow = {
  path: string;
  code: string;
  detail: string;
};

type IssueDetail = {
  message: string;
  field?: string;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) result[key] = canonicalValue(source[key]);
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function projection(entry: IndexedFile): { yamlJson: string; linksJson: string } {
  if (entry.kind === 'material') {
    const record = entry.record;
    return {
      yamlJson: canonicalJson({
        title: record.title,
        sourcePlatform: record.sourcePlatform,
        processingStatus: record.processingStatus,
        knowledgeStatus: record.knowledgeStatus,
        ...(record.topics === undefined ? {} : { topics: record.topics }),
        ...(record.collectedAt === undefined ? {} : { collectedAt: record.collectedAt })
      }),
      linksJson: canonicalJson(record.generatedKnowledge)
    };
  }
  const record = entry.record;
  return {
    yamlJson: canonicalJson({
      title: record.title,
      ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
      ...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
      sourceType: record.sourceType,
      usageStatus: record.usageStatus,
      knowledgeType: record.knowledgeType,
      recallFields: record.recallFields
    }),
    linksJson: canonicalJson(record.sourceMaterials)
  };
}

function materialFromRow(row: SearchRow): MaterialRecord {
  const yaml = JSON.parse(row.yamlJson) as {
    title: string;
    sourcePlatform: string;
    processingStatus: MaterialRecord['processingStatus'];
    knowledgeStatus: KnowledgeStatus;
    collectedAt?: string;
    topics?: string[];
  };
  return {
    path: row.path,
    rawSha256: row.rawSha256,
    ...(row.upstreamVersion === null ? {} : { upstreamVersion: row.upstreamVersion }),
    title: yaml.title,
    sourcePlatform: yaml.sourcePlatform,
    processingStatus: yaml.processingStatus,
    knowledgeStatus: yaml.knowledgeStatus,
    ...(yaml.collectedAt === undefined ? {} : { collectedAt: yaml.collectedAt }),
    ...(yaml.topics === undefined ? {} : { topics: yaml.topics }),
    generatedKnowledge: JSON.parse(row.linksJson) as string[]
  };
}

function knowledgeFromRow(row: SearchRow): KnowledgeRecord {
  const yaml = JSON.parse(row.yamlJson) as {
    title: string;
    createdAt?: string;
    updatedAt?: string;
    sourceType: KnowledgeRecord['sourceType'];
    usageStatus: UsageStatus;
    knowledgeType: string;
    recallFields: KnowledgeRecord['recallFields'];
  };
  return {
    path: row.path,
    rawSha256: row.rawSha256,
    ...(row.upstreamVersion === null ? {} : { upstreamVersion: row.upstreamVersion }),
    title: yaml.title,
    ...(yaml.createdAt === undefined ? {} : { createdAt: yaml.createdAt }),
    ...(yaml.updatedAt === undefined ? {} : { updatedAt: yaml.updatedAt }),
    sourceType: yaml.sourceType,
    usageStatus: yaml.usageStatus,
    knowledgeType: yaml.knowledgeType,
    recallFields: yaml.recallFields,
    sourceMaterials: JSON.parse(row.linksJson) as string[]
  };
}

function pathOrder<T extends { path: string }>(left: T, right: T): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function paginated<T>(records: T[], query: PaginationQuery): Page<T> {
  const page = Number.isSafeInteger(query.page) && (query.page ?? 0) > 0 ? query.page! : 1;
  const requestedSize = Number.isSafeInteger(query.pageSize) && (query.pageSize ?? 0) > 0
    ? query.pageSize!
    : 50;
  const pageSize = Math.min(requestedSize, 200);
  const start = (page - 1) * pageSize;
  return {
    items: records.slice(start, start + pageSize),
    total: records.length,
    page,
    pageSize
  };
}

function manifestFromRow(row: SearchRow): ManifestEntry {
  const manifestSha256 = sha256Text(canonicalJson({
    path: row.path,
    kind: row.kind,
    rawSha256: row.rawSha256,
    ...(row.upstreamVersion === null ? {} : { upstreamVersion: row.upstreamVersion }),
    metadata: JSON.parse(row.yamlJson) as unknown,
    links: JSON.parse(row.linksJson) as unknown
  }));
  return {
    path: row.path,
    kind: row.kind as IndexedFile['kind'],
    rawSha256: row.rawSha256,
    ...(row.upstreamVersion === null ? {} : { upstreamVersion: row.upstreamVersion }),
    manifestSha256
  };
}

export function createIndexRepository(
  database: Database.Database,
  now: () => string = () => new Date().toISOString()
): IndexRepository {
  const selectRows = database.prepare(`
    SELECT
      path,
      kind,
      raw_sha256 AS rawSha256,
      upstream_version AS upstreamVersion,
      yaml_json AS yamlJson,
      links_json AS linksJson
    FROM search_index
  `);
  const selectRow = database.prepare(`
    SELECT
      path,
      kind,
      raw_sha256 AS rawSha256,
      upstream_version AS upstreamVersion,
      yaml_json AS yamlJson,
      links_json AS linksJson
    FROM search_index
    WHERE path = ?
  `);
  const upsertFile = database.prepare(`
    INSERT INTO search_index (
      path, kind, raw_sha256, upstream_version, yaml_json, links_json, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      kind = excluded.kind,
      raw_sha256 = excluded.raw_sha256,
      upstream_version = excluded.upstream_version,
      yaml_json = excluded.yaml_json,
      links_json = excluded.links_json,
      indexed_at = excluded.indexed_at
  `);
  const deleteFile = database.prepare('DELETE FROM search_index WHERE path = ?');
  const upsertIssue = database.prepare(`
    INSERT INTO schema_issues (path, code, detail, observed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      code = excluded.code,
      detail = excluded.detail,
      observed_at = excluded.observed_at
  `);
  const deleteIssue = database.prepare('DELETE FROM schema_issues WHERE path = ?');
  const selectIssues = database.prepare('SELECT path, code, detail FROM schema_issues');

  const writeFile = (entry: IndexedFile): void => {
    const { yamlJson, linksJson } = projection(entry);
    upsertFile.run(
      entry.record.path,
      entry.kind,
      entry.record.rawSha256,
      entry.record.upstreamVersion ?? null,
      yamlJson,
      linksJson,
      now()
    );
  };
  const writeIssue = (issue: SchemaIssue): void => {
    upsertIssue.run(
      issue.path,
      issue.code,
      canonicalJson({ message: issue.message, ...(issue.field === undefined ? {} : { field: issue.field }) }),
      now()
    );
  };

  const replaceFileTransaction = database.transaction((entry: IndexedFile) => {
    writeFile(entry);
    deleteIssue.run(entry.record.path);
  });
  const replaceIssueTransaction = database.transaction((issue: SchemaIssue) => {
    writeIssue(issue);
    deleteFile.run(issue.path);
  });
  const publishBatchTransaction = database.transaction((publication: IndexPublication): IndexPublicationResult => {
    if (!Number.isSafeInteger(publication.expectedVersion) || publication.expectedVersion < 0) {
      throw new Error('INDEX_VERSION_INVALID');
    }
    const metadata = database.prepare(`
      SELECT version FROM index_metadata WHERE singleton = 1
    `).get() as { version: unknown } | undefined;
    if (
      metadata === undefined
      || !Number.isSafeInteger(metadata.version)
      || (metadata.version as number) < 0
      || metadata.version !== publication.expectedVersion
    ) {
      throw new Error('INDEX_METADATA_VERSION_CONFLICT');
    }

    const filePaths = new Set(publication.files.map((entry) => entry.record.path));
    const issuePaths = new Set(publication.issues.map((issue) => issue.path));
    if (
      filePaths.size !== publication.files.length
      || issuePaths.size !== publication.issues.length
      || [...filePaths].some((path) => issuePaths.has(path))
    ) {
      throw new Error('INDEX_BATCH_PATH_CONFLICT');
    }
    let changed = false;

    for (const row of selectRows.all() as SearchRow[]) {
      if (!filePaths.has(row.path)) {
        deleteFile.run(row.path);
        changed = true;
      }
    }
    const currentIssues = new Map(
      (selectIssues.all() as IssueRow[]).map((row) => [row.path, row] as const)
    );
    for (const row of currentIssues.values()) {
      if (!issuePaths.has(row.path)) {
        deleteIssue.run(row.path);
        changed = true;
      }
    }

    for (const entry of publication.files) {
      const current = selectRow.get(entry.record.path) as SearchRow | undefined;
      const { yamlJson, linksJson } = projection(entry);
      const nextRow: SearchRow = {
        path: entry.record.path,
        kind: entry.kind,
        rawSha256: entry.record.rawSha256,
        upstreamVersion: entry.record.upstreamVersion ?? null,
        yamlJson,
        linksJson
      };
      if (current === undefined || manifestFromRow(current).manifestSha256 !== manifestFromRow(nextRow).manifestSha256) {
        writeFile(entry);
        changed = true;
      }
      deleteIssue.run(entry.record.path);
    }
    for (const issue of publication.issues) {
      const detail = canonicalJson({
        message: issue.message,
        ...(issue.field === undefined ? {} : { field: issue.field })
      });
      const current = currentIssues.get(issue.path);
      if (current === undefined || current.code !== issue.code || current.detail !== detail) {
        writeIssue(issue);
        changed = true;
      }
      deleteFile.run(issue.path);
    }
    const advances = publication.expectedVersion === 0
      || changed
      || publication.manifestChanged;
    const version = publication.expectedVersion + (advances ? 1 : 0);
    if (!Number.isSafeInteger(version)) throw new Error('INDEX_VERSION_INVALID');
    const metadataUpdate = database.prepare(`
      UPDATE index_metadata
      SET version = ?, updated_at = ?
      WHERE singleton = 1 AND version = ?
    `).run(version, now(), publication.expectedVersion);
    if (metadataUpdate.changes !== 1) throw new Error('INDEX_METADATA_VERSION_CONFLICT');
    return { projectionChanged: changed, version };
  });

  return {
    replaceFile: (entry) => replaceFileTransaction.immediate(entry),
    removeFile: (path) => {
      deleteFile.run(path);
    },
    replaceIssue: (issue) => replaceIssueTransaction.immediate(issue),
    clearIssue: (path) => {
      deleteIssue.run(path);
    },
    listMaterials: (query) => {
      const records = (selectRows.all() as SearchRow[])
        .filter((row) => row.kind === 'material')
        .map(materialFromRow)
        .filter((record) => query.knowledgeStatus === undefined || record.knowledgeStatus === query.knowledgeStatus)
        .filter((record) => query.sourcePlatform === undefined || record.sourcePlatform === query.sourcePlatform)
        .filter((record) => query.collectedFrom === undefined
          || (record.collectedAt !== undefined && record.collectedAt >= query.collectedFrom))
        .filter((record) => query.collectedTo === undefined
          || (record.collectedAt !== undefined && record.collectedAt <= query.collectedTo))
        .filter((record) => query.title === undefined
          || record.title.toLocaleLowerCase().includes(query.title.toLocaleLowerCase()))
        .sort(pathOrder);
      return paginated(records, query);
    },
    listKnowledge: (query) => {
      const search = query.search?.trim().toLocaleLowerCase();
      const records = (selectRows.all() as SearchRow[])
        .filter((row) => row.kind === 'knowledge')
        .map(knowledgeFromRow)
        .filter((record) => query.includeObsolete === true
          || query.usageStatus === '过时'
          || record.usageStatus !== '过时')
        .filter((record) => query.usageStatus === undefined || record.usageStatus === query.usageStatus)
        .filter((record) => query.knowledgeType === undefined || record.knowledgeType === query.knowledgeType)
        .filter((record) => query.topic === undefined || record.recallFields.topics.includes(query.topic))
        .filter((record) => {
          if (search === undefined || search.length === 0) return true;
          return [
            record.title,
            ...record.recallFields.topics,
            ...record.recallFields.keywords,
            ...record.recallFields.scenarios,
            record.recallFields.conclusion,
            ...record.recallFields.keyPoints,
            record.recallFields.boundary
          ]
            .join('\0')
            .toLocaleLowerCase()
            .includes(search);
        })
        .sort(pathOrder);
      return paginated(records, query);
    },
    getKnowledge: (path) => {
      const row = selectRow.get(path) as SearchRow | undefined;
      return row?.kind === 'knowledge' ? knowledgeFromRow(row) : undefined;
    },
    publishBatch: (publication) => publishBatchTransaction.immediate(publication),
    listIssues: () => (database.prepare(`
      SELECT path, code, detail
      FROM schema_issues
      ORDER BY path
    `).all() as IssueRow[]).map((row) => {
      const detail = JSON.parse(row.detail) as IssueDetail;
      return {
        path: row.path,
        code: row.code as SchemaIssueCode,
        message: detail.message,
        ...(detail.field === undefined ? {} : { field: detail.field })
      };
    }),
    getManifestEntry: (path) => {
      const row = selectRow.get(path) as SearchRow | undefined;
      return row === undefined ? undefined : manifestFromRow(row);
    }
  };
}
