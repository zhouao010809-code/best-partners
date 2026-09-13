import type Database from 'better-sqlite3';
import type { ExtractionSourceRange } from '../../shared/api/extraction.js';
import { readDeletedSourceCutoffs } from './material-visibility.js';

/** Legacy full-source runs have no range. An old selected range has unknown coverage. */
export const isPartialExtraction = (range?: ExtractionSourceRange): boolean => range !== undefined && range.coversWholeSource !== true;
export const isPartialExtractionJson = (json: string | null): boolean => json !== null && isPartialExtraction(JSON.parse(json) as ExtractionSourceRange);

/** A finished page selection leaves the remainder eligible, without abandoning unresolved candidates. */
export function canContinuePartialExtraction(database: Database.Database, materialPath: string): boolean {
  const cutoff = readDeletedSourceCutoffs(database).get(materialPath) ?? 0;
  const rows = database.prepare(`SELECT r.source_range_json,r.created_at,
    MAX(0,json_array_length(r.result_json,'$.candidates') -
      (SELECT COUNT(*) FROM personal_candidate_reviews c WHERE c.run_id=r.id AND c.state IN ('discarded','committed'))) AS pending_count
    FROM personal_extraction_runs r WHERE r.material_path=? AND r.status='ready' ORDER BY r.created_at DESC,r.rowid DESC`).all(materialPath) as Array<{ source_range_json: string | null; created_at: string; pending_count: number }>;
  const current = rows.filter(row => Date.parse(row.created_at) > cutoff);
  return !!current[0] && isPartialExtractionJson(current[0].source_range_json) && current.every(row => row.pending_count === 0);
}
