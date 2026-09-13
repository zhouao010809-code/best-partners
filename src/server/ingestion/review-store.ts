import type Database from 'better-sqlite3';
import { PublicApiError } from '../../shared/api/errors.js';
import { extractionRunSchema, type ExtractionRun } from '../../shared/api/extraction.js';
import { reviewCandidateSchema, type ReviewCandidate, type SaveCandidateRequest } from '../../shared/api/ingestion.js';
import { readDeletedSourceCutoffs } from '../services/material-visibility.js';

type CandidateRow = { id: string; version: number; state: ReviewCandidate['state']; decision: ReviewCandidate['decision']; draft_json: string; target_json: string; committed_path: string | null; batch_id: string | null };
const emptyContent = () => ({ keywords: [], scenarios: [], conclusion: '', keyPoints: [], boundary: '', quotes: [], summaries: [] });
export function createReviewStore(db: Database.Database) {
  function run(id: string): ExtractionRun {
    const row = db.prepare('SELECT * FROM personal_extraction_runs WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new PublicApiError('EXTRACTION_NOT_FOUND', '没有找到这次提炼记录。', 404);
    return extractionRunSchema.parse({ id: row.id, materialPath: row.material_path, title: row.title, readingState: row.reading_state,
      sourceRawSha256: row.source_raw_sha256, ruleFingerprint: row.rule_fingerprint, model: row.model, createdAt: row.created_at,
      ...(row.source_range_json ? { sourceRange: JSON.parse(String(row.source_range_json)) } : {}),
      status: row.status, ...(row.result_json ? { result: JSON.parse(String(row.result_json)) } : {}), ...(row.problem ? { problem: row.problem } : {}) });
  }
  function ensure(id: string): ExtractionRun {
    const value = run(id);
    if (value.status !== 'ready' || !value.result) throw new PublicApiError('RESULT_NOT_READY', '请先完成提炼，再审阅候选。', 409);
    db.transaction(() => {
      for (const [ordinal, candidate] of value.result!.candidates.entries()) {
        const draft = { ...candidate, draft: candidate.draft ?? emptyContent() };
        db.prepare("INSERT OR IGNORE INTO personal_candidate_reviews (id,run_id,ordinal,version,state,decision,draft_json,target_json) VALUES (?,?,?,1,'pending','later',?,?)")
          .run(`${id}:${ordinal}`, id, ordinal, JSON.stringify(draft), JSON.stringify({ mode: 'new' }));
      }
    }).immediate();
    return value;
  }
  function project(row: CandidateRow): ReviewCandidate {
    return reviewCandidateSchema.parse({ id: row.id, version: row.version, state: row.state, decision: row.decision,
      draft: JSON.parse(row.draft_json), target: JSON.parse(row.target_json),
      ...(row.committed_path ? { committedPath: row.committed_path } : {}), ...(row.batch_id ? { batchId: row.batch_id } : {}) });
  }
  function list(id: string): ReviewCandidate[] {
    return (db.prepare('SELECT * FROM personal_candidate_reviews WHERE run_id=? ORDER BY ordinal').all(id) as CandidateRow[]).map(project);
  }
  function save(id: string, request: SaveCandidateRequest): ReviewCandidate {
    ensure(id);
    const current = list(id).find((item) => item.id === request.candidateId);
    if (!current || current.version !== request.version) throw new PublicApiError('VERSION_CONFLICT', '草稿已有新版本，请保留当前编辑并重新读取后比较。', 409);
    if (current.state !== 'pending' || current.batchId) throw new PublicApiError('CANDIDATE_LOCKED', '这条候选已处理或正在入库，不能重复修改。', 409);
    db.prepare('UPDATE personal_candidate_reviews SET version=version+1,draft_json=?,target_json=?,decision=? WHERE id=? AND version=?')
      .run(JSON.stringify(request.draft), JSON.stringify(request.target), request.decision, current.id, request.version);
    return list(id).find((item) => item.id === current.id)!;
  }
  function sourceRuns(materialPath: string): ExtractionRun[] {
    const cutoff = readDeletedSourceCutoffs(db).get(materialPath) ?? 0;
    const ids = db.prepare("SELECT id,created_at FROM personal_extraction_runs WHERE material_path=? AND status='ready' ORDER BY created_at DESC,rowid DESC").all(materialPath) as { id: string; created_at: string }[];
    // Earlier runs remain readable by ID, but belong to the deleted document.
    return ids.flatMap((item) => Date.parse(item.created_at) <= cutoff ? [] : [ensure(item.id)]);
  }
  return { run, ensure, list, save, sourceRuns };
}
