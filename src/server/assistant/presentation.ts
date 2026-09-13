import type Database from 'better-sqlite3';
import type { AssistantAction, AssistantEvidence, AssistantMessage } from '../../shared/api/assistant.js';

/** A bounded preview of text actually supplied to the model, never a generated quote. */
export function evidenceFragment(markdown: string, revision: string, offset = 0, length = markdown.length): AssistantEvidence | undefined {
  let excerpt = markdown.slice(offset, offset + Math.min(length, 2400));
  // Avoid cutting an emoji surrogate pair at the preview boundary.
  if (/[\uD800-\uDBFF]$/u.test(excerpt)) excerpt = excerpt.slice(0, -1);
  if (!excerpt) return undefined;
  const startLine = markdown.slice(0, offset).split('\n').length;
  const endLine = startLine + excerpt.replace(/\n$/u, '').split('\n').length - 1;
  return { excerpt, revision, offset, length: excerpt.length, startLine, endLine };
}

export function contextTitle(database: Database.Database, path: string): string {
  const row = database.prepare('SELECT yaml_json FROM search_index WHERE path=?').get(path) as { yaml_json: string } | undefined;
  if (row) {
    try {
      const value: unknown = JSON.parse(row.yaml_json);
      if (value && typeof value === 'object' && 'title' in value && typeof value.title === 'string' && value.title.trim()) return value.title.slice(0, 1000);
    } catch { /* A display title must not prevent sending when an index entry is incomplete. */ }
  }
  return path.split('/').at(-1)!.replace(/\.md$/u, '');
}

/** Read-only projection: opening a conversation never creates reviews or changes recency. */
export function refreshReviewAction(database: Database.Database, action: AssistantAction): AssistantAction {
  if (action.type !== 'review') return action;
  const run = database.prepare('SELECT material_path,title,status,result_json,source_range_json FROM personal_extraction_runs WHERE id=?').get(action.runId) as { material_path: string; title: string; status: string; result_json: string | null; source_range_json: string | null } | undefined;
  if (!run || run.status !== 'ready' || !run.result_json) return { ...action, status: 'unavailable' };
  const result = JSON.parse(run.result_json) as { candidates?: unknown[] };
  const reviews = database.prepare('SELECT state FROM personal_candidate_reviews WHERE run_id=?').all(action.runId) as Array<{ state: string }>;
  const candidateCount = Math.max(result.candidates?.length ?? 0, reviews.length);
  const committedCount = reviews.filter(review => review.state === 'committed').length;
  const discardedCount = reviews.filter(review => review.state === 'discarded').length;
  const batches = database.prepare("SELECT status FROM personal_ingestion_batches WHERE run_id=? AND status!='committed'").all(action.runId) as Array<{ status: string }>;
  const status: AssistantAction['status'] = batches.some(batch => batch.status === 'needs-review') ? 'needs-review'
    : batches.length ? 'writing'
    : candidateCount === 0 ? 'empty'
    : candidateCount > 0 && committedCount + discardedCount >= candidateCount ? committedCount ? 'committed' : 'discarded'
    : committedCount ? 'partial' : 'ready';
  return { ...action, ...(status === 'empty' ? { label: '查看导读' } : {}), ...(run.source_range_json ? { sourceRange: JSON.parse(run.source_range_json) } : {}), materialPath: run.material_path, materialTitle: run.title, candidateCount, committedCount, discardedCount, status };
}

export function finishMessage(message: AssistantMessage, status: 'failed' | 'stopped', finishedAt?: string): void {
  delete message.activity;
  // Old history has no reliable start time, so do not fabricate its timing.
  if (finishedAt && message.startedAt && !message.finishedAt) message.finishedAt = finishedAt;
  for (const step of message.steps ?? []) {
    if (step.status === 'running') { step.status = status; if (finishedAt) step.finishedAt = finishedAt; }
  }
}
