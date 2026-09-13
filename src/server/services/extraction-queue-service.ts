import type Database from 'better-sqlite3';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PublicApiError } from '../../shared/api/errors.js';
import { extractionHistoryQuerySchema, extractionQueueQuerySchema, extractionQueueSourceQuerySchema, extractionQueueVisibilityRequestSchema, type ExtractionHistoryPage,
  type ExtractionHistoryQuery, type ExtractionQueueItem, type ExtractionQueuePage, type ExtractionQueueQuery,
  type ExtractionQueueSource, type ExtractionRunSummary } from '../../shared/api/extraction-queue.js';
import type { MaterialRecord } from '../../shared/domain/records.js';
import { canonicalJson, type IndexRepository } from '../index/index-repository.js';
import { validateFilesystemPath } from '../vault/filesystem-path.js';
import { assertMaterialIdle, hasPersonalTable, readDeletedSourceCutoffs, readMaterialVisibility } from './material-visibility.js';
import { isPartialExtractionJson } from './extraction-coverage.js';

type SummaryRow = {
  id: string; material_path: string; title: string; created_at: string;
  source_raw_sha256: string; status: ExtractionRunSummary['status'];
  candidate_count: number | null; problem: string | null;
  pending_candidate_count: number | null; current_source_sha256: string | null;
  source_range_json: string | null;
};
export interface ExtractionQueueService {
  queue(query: ExtractionQueueQuery): ExtractionQueuePage;
  source(materialPath: string): ExtractionQueueSource;
  setVisibility(materialPath: string, removed: boolean): ExtractionQueueSource;
  history(query: ExtractionHistoryQuery): ExtractionHistoryPage;
}

const cursorPayloadSchema = z.strictObject({
  version: z.literal(1), kind: z.enum(['extraction-queue', 'extraction-history']),
  filterSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
});
type CursorPayload = z.output<typeof cursorPayloadSchema>;
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
const invalidCursor = () => new PublicApiError('VALIDATION_ERROR', 'Request validation failed', 400, { cursor: 'Invalid cursor or request context' });

function summary(row: SummaryRow): ExtractionRunSummary {
  return { id: row.id, status: row.status, createdAt: row.created_at, sourceRawSha256: row.source_raw_sha256,
    ...(row.candidate_count === null ? {} : { candidateCount: row.candidate_count }),
    ...(row.pending_candidate_count === null ? {} : { pendingCandidateCount: row.pending_candidate_count, reviewComplete: row.pending_candidate_count === 0 }),
    ...(row.current_source_sha256 === null ? {} : { currentSourceSha256: row.current_source_sha256 }),
    ...(row.problem === null ? {} : { problem: row.problem }) };
}

function collectMaterials(repository: IndexRepository): MaterialRecord[] {
  const records: MaterialRecord[] = [];
  // Explicit statuses retain historical sources even if default library queries exclude ingested notes.
  for (const knowledgeStatus of ['未提炼', '部分入库', '已入库'] as const) {
    for (let page = 1; ; page++) {
      const result = repository.listMaterials({ knowledgeStatus, page, pageSize: 200 });
      records.push(...result.items);
      if (page * result.pageSize >= result.total || result.items.length === 0) break;
    }
  }
  return records;
}

function queueOrder(left: ExtractionQueueItem, right: ExtractionQueueItem): number {
  if (left.collectedAt !== right.collectedAt) {
    if (left.collectedAt === undefined) return 1;
    if (right.collectedAt === undefined) return -1;
    return left.collectedAt > right.collectedAt ? -1 : 1;
  }
  return left.materialPath < right.materialPath ? -1 : left.materialPath > right.materialPath ? 1 : 0;
}

export function createExtractionQueueService(input: {
  database: Database.Database; repository: IndexRepository;
}): ExtractionQueueService {
  const secret = randomBytes(32);
  // SQLite returns counts only: complete candidate bodies never enter the list read model.
  const hasTable = (name: string) => input.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
  const hasReviews = hasTable('personal_candidate_reviews');
  const hasHeads = hasTable('personal_ingestion_source_heads');
  const candidateCount = "json_array_length(r.result_json, '$.candidates')";
  const pendingCount = hasReviews ? `${candidateCount} - (SELECT COUNT(*) FROM personal_candidate_reviews c WHERE c.run_id=r.id AND c.state IN ('discarded','committed'))` : candidateCount;
  const columns = `r.id, r.material_path, r.title, r.created_at, r.source_raw_sha256, r.status, r.problem,r.source_range_json,
    CASE WHEN r.status='ready' THEN ${candidateCount} ELSE NULL END AS candidate_count,
    CASE WHEN r.status='ready' THEN MAX(0, ${pendingCount}) ELSE NULL END AS pending_candidate_count,
    ${hasHeads ? '(SELECT h.current_raw_sha256 FROM personal_ingestion_source_heads h WHERE h.run_id=r.id AND h.material_path=r.material_path)' : 'NULL'} AS current_source_sha256`;
  const allRuns = input.database.prepare(`SELECT ${columns} FROM personal_extraction_runs r ORDER BY r.created_at DESC, r.rowid DESC`);
  const sourceRuns = input.database.prepare(`SELECT ${columns} FROM personal_extraction_runs r WHERE r.material_path=? ORDER BY r.created_at DESC, r.rowid DESC`);
  const sign = (body: string) => createHmac('sha256', secret).update(body, 'ascii').digest('hex');

  function readSnapshot() {
    const materials = collectMaterials(input.repository);
    const runs = allRuns.all() as SummaryRow[];
    const visibility = readMaterialVisibility(input.database);
    const deletedCutoffs = readDeletedSourceCutoffs(input.database);
    const grouped = new Map<string, { latest: SummaryRow; active?: SummaryRow; ready?: SummaryRow; pendingCount: number }>();
    for (const row of runs) {
      if (Date.parse(row.created_at) <= (deletedCutoffs.get(row.material_path) ?? 0)) continue;
      const group = grouped.get(row.material_path) ?? { latest: row, pendingCount: 0 };
      if (row.status === 'generating' && group.active === undefined) group.active = row;
      if (row.status === 'ready' && group.ready === undefined) group.ready = row;
      group.pendingCount += row.pending_candidate_count ?? 0;
      grouped.set(row.material_path, group);
    }
    const indexed = new Map(materials.map((record) => [record.path, record]));
    const items: ExtractionQueueItem[] = [];
    for (const materialPath of new Set([...indexed.keys(), ...grouped.keys()])) {
      if (visibility.trashed.has(materialPath)) continue;
      const record = indexed.get(materialPath);
      const group = grouped.get(materialPath);
      const coveragePending = group?.ready !== undefined && isPartialExtractionJson(group.ready.source_range_json);
      const eligible = record?.processingStatus === '已归档' && (record.knowledgeStatus === '未提炼'
        || record.knowledgeStatus === '部分入库' && coveragePending && group?.pendingCount === 0);
      if (!group && !eligible) continue;
      const view = group?.active ? 'generating' : group?.latest.status === 'ready' ? coveragePending && group.pendingCount === 0 ? 'pending' : 'ready' : group ? 'unfinished' : 'pending';
      items.push({ materialPath, title: record?.title ?? group!.latest.title, view,
        canExtract: eligible && group?.active === undefined && !visibility.removed.has(materialPath),
        ...(visibility.removed.has(materialPath) ? { removedAt: visibility.removed.get(materialPath)! } : {}),
        ...(record ? { sourcePlatform: record.sourcePlatform, sourceRawSha256: record.rawSha256,
          ...(record.collectedAt === undefined ? {} : { collectedAt: record.collectedAt }) } : {}),
        ...(group ? { latestRun: summary(group.latest) } : {}),
        ...(group?.active ? { activeRun: summary(group.active) } : {}),
        ...(group?.ready ? { latestReadyRun: summary(group.ready) } : {}) });
      if (group?.ready) Object.assign(items.at(-1)!, { pendingCandidateCount: group.pendingCount,
        reviewComplete: group.pendingCount === 0 && !group.active && !coveragePending });
    }
    return { materials, runs, items, visibility: { removed: [...visibility.removed], trashed: [...visibility.trashed], deleted: [...deletedCutoffs] } };
  }

  function paginate<T>(items: T[], query: { cursor?: string | undefined; limit?: number | undefined }, context: Omit<CursorPayload, 'offset' | 'version'>): { items: T[]; nextCursor?: string } {
    let offset = 0;
    if (query.cursor !== undefined) {
      const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/u.exec(query.cursor);
      if (!match || !timingSafeEqual(Buffer.from(match[2]!, 'hex'), Buffer.from(sign(match[1]!), 'hex'))) throw invalidCursor();
      let decoded: unknown;
      try { decoded = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')); } catch { throw invalidCursor(); }
      const parsed = cursorPayloadSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.kind !== context.kind || parsed.data.filterSha256 !== context.filterSha256) throw invalidCursor();
      if (parsed.data.snapshotSha256 !== context.snapshotSha256) throw new PublicApiError('VERSION_CONFLICT', '提炼列表已变化，请刷新列表后继续。', 409);
      offset = parsed.data.offset;
      if (offset >= items.length) throw invalidCursor();
    }
    const page = items.slice(offset, offset + (query.limit ?? 50));
    if (offset + page.length >= items.length) return { items: page };
    const body = Buffer.from(JSON.stringify({ version: 1, ...context, offset: offset + page.length }), 'utf8').toString('base64url');
    return { items: page, nextCursor: `${body}.${sign(body)}` };
  }

  return {
    queue(request) {
      const query = extractionQueueQuerySchema.parse(request);
      return input.database.transaction(() => {
        const { materials, runs, items, visibility } = readSnapshot();
        const matches = items.filter((item) => (query.visibility === 'removed' ? item.removedAt !== undefined : item.removedAt === undefined)
          && (query.title === undefined || item.title.toLocaleLowerCase().includes(query.title.toLocaleLowerCase()))
          && (query.sourcePlatform === undefined || item.sourcePlatform === query.sourcePlatform)
          && (query.collectedFrom === undefined || (item.collectedAt !== undefined && item.collectedAt >= query.collectedFrom))
          && (query.collectedTo === undefined || (item.collectedAt !== undefined && item.collectedAt <= query.collectedTo)));
        const counts = { pending: 0, generating: 0, ready: 0, unfinished: 0 };
        for (const item of matches) counts[item.view]++;
        const { cursor: _cursor, ...filters } = query;
        return { ...paginate(matches.filter((item) => item.view === query.view
          && (query.reviewState === undefined || (query.reviewState === 'complete' ? item.reviewComplete === true : item.reviewComplete === false))).sort(queueOrder), query, {
          kind: 'extraction-queue', filterSha256: hash({ ...filters, limit: query.limit ?? 50 }), snapshotSha256: hash({ materials, runs, visibility })
        }), counts };
      })();
    },
    source(materialPath) {
      extractionQueueSourceQuerySchema.parse({ materialPath });
      try { validateFilesystemPath(materialPath); } catch { throw new PublicApiError('PATH_NOT_ALLOWED', 'Path is not allowed', 400); }
      if (!materialPath.startsWith('01图书馆/') || !materialPath.endsWith('.md')) throw new PublicApiError('PATH_NOT_ALLOWED', 'Path is not allowed', 400);
      return input.database.transaction(() => ({ item: readSnapshot().items.find((item) => item.materialPath === materialPath) ?? null }))();
    },
    setVisibility(materialPath, removed) {
      extractionQueueVisibilityRequestSchema.parse({ materialPath, removed });
      try { validateFilesystemPath(materialPath); } catch { throw new PublicApiError('PATH_NOT_ALLOWED', 'Path is not allowed', 400); }
      if (!materialPath.startsWith('01图书馆/') || !materialPath.endsWith('.md')) throw new PublicApiError('PATH_NOT_ALLOWED', 'Path is not allowed', 400);
      if (!hasPersonalTable(input.database, 'personal_queue_visibility')) throw new PublicApiError('QUEUE_VISIBILITY_UNAVAILABLE', '当前版本暂不支持调整队列，请重新打开最新桌面 App。', 503);
      return input.database.transaction(() => {
        const snapshot = readSnapshot();
        if (snapshot.visibility.trashed.includes(materialPath)) throw new PublicApiError('SOURCE_IN_TRASH', '请先在回收站完成恢复，再重新安排队列。', 409);
        const item = snapshot.items.find((entry) => entry.materialPath === materialPath);
        if (!item) throw new PublicApiError('SOURCE_NOT_FOUND', '没有找到这份队列资料，请刷新后重试。', 404);
        if (removed === (item.removedAt !== undefined)) return { item };
        assertMaterialIdle(input.database, materialPath);
        if (removed) input.database.prepare('INSERT INTO personal_queue_visibility(material_path,removed_at) VALUES (?,?) ON CONFLICT(material_path) DO UPDATE SET removed_at=excluded.removed_at').run(materialPath, new Date().toISOString());
        else input.database.prepare('DELETE FROM personal_queue_visibility WHERE material_path=?').run(materialPath);
        return { item: readSnapshot().items.find((entry) => entry.materialPath === materialPath) ?? null };
      })();
    },
    history(request) {
      const query = extractionHistoryQuerySchema.parse(request);
      const rows = sourceRuns.all(query.materialPath) as SummaryRow[];
      return paginate(rows.map(summary), query, { kind: 'extraction-history',
        filterSha256: hash({ materialPath: query.materialPath, limit: query.limit ?? 50 }), snapshotSha256: hash(rows) });
    }
  };
}
