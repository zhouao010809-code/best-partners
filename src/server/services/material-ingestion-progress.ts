import type Database from 'better-sqlite3';
import { hasPersonalTable, readDeletedSourceCutoffs } from './material-visibility.js';

/** Discussion belongs to the vault. Extraction progress belongs to confirmed app batches. */
export function currentMaterialIngestionProgress(database?: Database.Database): Map<string, '部分入库' | '已入库'> {
  const progress = new Map<string, '部分入库' | '已入库'>();
  if (!database || !hasPersonalTable(database, 'personal_ingestion_batches')) return progress;
  const deleted = readDeletedSourceCutoffs(database);
  const rows = database.prepare(`SELECT r.material_path, r.created_at,
    json_extract(b.plan_json,'$.preview.sourceStatus') AS status
    FROM personal_ingestion_batches b JOIN personal_extraction_runs r ON r.id=b.run_id
    WHERE b.status='committed' ORDER BY b.created_at,b.rowid`).all() as Array<{ material_path: string; created_at: string; status: string }>;
  for (const row of rows) {
    if (Date.parse(row.created_at) <= (deleted.get(row.material_path) ?? 0)) continue;
    if (row.status === '部分入库' || row.status === '已入库') progress.set(row.material_path, row.status);
  }
  return progress;
}
