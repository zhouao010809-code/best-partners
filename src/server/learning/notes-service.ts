import type Database from 'better-sqlite3';
import { z } from 'zod';
import { PublicApiError } from '../../shared/api/errors.js';
import { learningNoteFieldsSchema, learningNoteQuerySchema, learningNoteSaveSchema, learningNoteSchema,
  type LearningNote, type LearningNoteList, type LearningNoteQuery, type LearningNoteSave } from '../../shared/api/learning-notes.js';

export interface LearningNotesService {
  list(query: LearningNoteQuery): LearningNoteList;
  save(id: string, input: LearningNoteSave): { note: LearningNote };
}
type Row = { id: string; revision: number; payload: string; created_at: string; updated_at: string };

export function createLearningNotesService({ database, vaultId }: { database: Database.Database; vaultId: string }): LearningNotesService {
  if (!/^[a-f0-9]{64}$/u.test(vaultId)) throw new Error('LEARNING_NOTES_VAULT_ID_REQUIRED');
  const get = (id: string) => database.prepare('SELECT * FROM learning_notes WHERE vault_id = ? AND id = ?').get(vaultId, id) as Row | undefined;
  const decode = (row: Row): LearningNote => learningNoteSchema.parse({ ...JSON.parse(row.payload), id: row.id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at });
  const conflict = () => new PublicApiError('LEARNING_NOTE_CONFLICT', '这条笔记已在其他窗口更新。你的文字仍保留，请重新打开最新笔记后合并修改。', 409);
  return {
    list(raw) {
      const query = learningNoteQuerySchema.parse(raw);
      const rows = database.prepare(`SELECT * FROM learning_notes WHERE vault_id = ?${query.path ? ' AND source_path = ?' : ''}${query.conversationId ? ' AND conversation_id = ?' : ''} ORDER BY updated_at DESC, id DESC`)
        .all(vaultId, ...(query.path ? [query.path] : []), ...(query.conversationId ? [query.conversationId] : [])) as Row[];
      return { notes: rows.map(decode) };
    },
    save(rawId, raw) {
      const id = z.uuid().parse(rawId);
      const input = learningNoteSaveSchema.parse(raw);
      const { expectedRevision, ...fields } = input;
      const payload = JSON.stringify(learningNoteFieldsSchema.parse(fields));
      return database.transaction(() => {
        const previous = get(id);
        if (previous) {
          const note = decode(previous);
          if (JSON.stringify(note.selection) !== JSON.stringify(fields.selection)
            || note.conversationId !== fields.conversationId || note.messageId !== fields.messageId) {
            throw new PublicApiError('LEARNING_NOTE_SOURCE_IMMUTABLE', '已保存笔记的出处不能替换。请保留原出处，另存新的理解。', 409);
          }
          // A lost acknowledgement may be retried with its original revision/body.
          if (previous.revision === expectedRevision + 1 && previous.payload === payload) return { note };
        }
        if ((previous?.revision ?? 0) !== expectedRevision) throw conflict();
        const updatedAt = new Date().toISOString();
        database.prepare(`INSERT INTO learning_notes(vault_id,id,source_path,conversation_id,revision,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(vault_id,id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at`)
          .run(vaultId, id, fields.selection.path, fields.conversationId, expectedRevision + 1, payload, previous?.created_at ?? updatedAt, updatedAt);
        return { note: decode(get(id)!) };
      }).immediate();
    }
  };
}
