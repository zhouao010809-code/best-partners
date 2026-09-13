import type Database from 'better-sqlite3';
import { PublicApiError } from '../../shared/api/errors.js';
import { assistantDraftFieldsSchema, assistantDraftSaveSchema, assistantDraftSchema, type AssistantDraft, type AssistantDraftList, type AssistantDraftSave } from '../../shared/api/assistant-drafts.js';

export interface AssistantDraftService {
  list(): AssistantDraftList;
  save(id: string, input: AssistantDraftSave): { draft: AssistantDraft };
  delete(id: string, revision: number): { deleted: true };
}
type Row = { id: string; revision: number; payload: string | null; updated_at: string; last_active: number };

export function createAssistantDraftService({ database }: { database: Database.Database }): AssistantDraftService {
  const conflict = () => new PublicApiError('ASSISTANT_DRAFT_CONFLICT', '草稿已在其他窗口更新。当前文字仍保留，请另存为新的草稿。', 409);
  const get = (id: string) => database.prepare('SELECT * FROM assistant_drafts WHERE id = ?').get(id) as Row | undefined;
  const decode = (row: Row): AssistantDraft => assistantDraftSchema.parse({ ...JSON.parse(row.payload!), id: row.id, revision: row.revision, updatedAt: row.updated_at, lastActive: new Date(row.last_active).toISOString() });
  return {
    list() {
      const drafts = (database.prepare('SELECT * FROM assistant_drafts WHERE payload IS NOT NULL ORDER BY last_active DESC, id DESC').all() as Row[]).map(decode);
      return { drafts, ...(drafts[0] ? { activeId: drafts[0].id } : {}) };
    },
    save(id, raw) {
      const input = assistantDraftSaveSchema.parse(raw);
      const { expectedRevision: _revision, active: _active, ...fields } = input;
      const payload = JSON.stringify(assistantDraftFieldsSchema.parse(fields));
      return database.transaction(() => {
        const previous = get(id);
        // Repeating an acknowledged write after a lost response is safe, but a
        // different body at that revision must never replace another window.
        if (previous && previous.revision === input.expectedRevision + 1 && previous.payload === payload) return { draft: decode(previous) };
        if ((previous?.revision ?? 0) !== input.expectedRevision || previous?.payload === null) throw conflict();
        const max = database.prepare('SELECT MAX(last_active) AS value FROM assistant_drafts').get() as { value: number | null };
        const lastActive = Math.max(Date.now(), (max.value ?? 0) + 1);
        const updatedAt = new Date().toISOString();
        database.prepare('INSERT INTO assistant_drafts(id,revision,payload,updated_at,last_active) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at,last_active=excluded.last_active')
          .run(id, input.expectedRevision + 1, payload, updatedAt, lastActive);
        return { draft: decode(get(id)!) };
      }).immediate();
    },
    delete(id, revision) {
      return database.transaction(() => {
        const previous = get(id);
        if (!previous || previous.payload === null && previous.revision === revision + 1) return { deleted: true as const };
        if (previous.revision !== revision) throw conflict();
        // A tombstone prevents a delayed save from recreating explicitly cleared content.
        database.prepare('UPDATE assistant_drafts SET payload=NULL,revision=revision+1,updated_at=? WHERE id=?').run(new Date().toISOString(), id);
        return { deleted: true as const };
      }).immediate();
    }
  };
}
