import type Database from 'better-sqlite3';
import { PublicApiError } from '../../shared/api/errors.js';

export function hasPersonalTable(database: Database.Database, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

export function readMaterialVisibility(database?: Database.Database): { removed: Map<string, string>; trashed: Set<string> } {
  const removed = new Map<string, string>(); const trashed = new Set<string>();
  if (!database) return { removed, trashed };
  if (hasPersonalTable(database, 'personal_queue_visibility')) {
    const rows = database.prepare('SELECT material_path,removed_at FROM personal_queue_visibility ORDER BY material_path').all() as Array<{ material_path: string; removed_at: string }>;
    for (const row of rows) removed.set(row.material_path, row.removed_at);
  }
  if (hasPersonalTable(database, 'personal_trash_entries')) {
    const rows = database.prepare("SELECT material_path FROM personal_trash_entries WHERE status NOT IN ('restored','deleted') ORDER BY material_path").all() as Array<{ material_path: string }>;
    for (const row of rows) trashed.add(row.material_path);
  }
  const deletedCutoffs = readDeletedSourceCutoffs(database);
  for (const [path, removedAt] of removed) {
    if (Date.parse(removedAt) <= (deletedCutoffs.get(path) ?? 0)) removed.delete(path);
  }
  return { removed, trashed };
}

export function assertMaterialAvailableForExtraction(database: Database.Database, materialPath: string): void {
  const visibility = readMaterialVisibility(database);
  if (visibility.trashed.has(materialPath)) throw new PublicApiError('SOURCE_IN_TRASH', '这份资料已移入回收站或正在恢复，请先在回收站完成恢复。', 409);
  if (visibility.removed.has(materialPath)) throw new PublicApiError('SOURCE_REMOVED_FROM_QUEUE', '这份资料已移出队列，请先在“已移出”中重新加入。', 409);
}

/** Queue history survives deletion, but does not belong to a later same-path document. */
export function readDeletedSourceCutoffs(database?: Database.Database): Map<string, number> {
  const result = new Map<string, number>();
  if (!database || !hasPersonalTable(database, 'personal_trash_entries')) return result;
  const rows = database.prepare("SELECT material_path,created_at FROM personal_trash_entries WHERE status='deleted'").all() as { material_path: string; created_at: string }[];
  for (const row of rows) {
    const time = Date.parse(row.created_at);
    if (Number.isFinite(time)) result.set(row.material_path, Math.max(result.get(row.material_path) ?? 0, time));
  }
  return result;
}

export function assertMaterialIdle(database: Database.Database, materialPath: string): void {
  if (hasPersonalTable(database, 'personal_extraction_runs')
    && database.prepare("SELECT id FROM personal_extraction_runs WHERE material_path=? AND status='generating' LIMIT 1").get(materialPath)) {
    throw new PublicApiError('RUN_ALREADY_ACTIVE', '请先停止本次提炼，再移出队列或移入回收站。', 409);
  }
  if (hasPersonalTable(database, 'personal_ingestion_batches') && hasPersonalTable(database, 'personal_extraction_runs')
    && database.prepare("SELECT b.id FROM personal_ingestion_batches b JOIN personal_extraction_runs r ON r.id=b.run_id WHERE r.material_path=? AND b.status!='committed' LIMIT 1").get(materialPath)) {
    throw new PublicApiError('INGESTION_IN_PROGRESS', '这份资料还有未完成的入库批次，请先在候选审阅中完成入库恢复。', 409);
  }
}
