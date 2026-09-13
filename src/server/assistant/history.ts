import type Database from 'better-sqlite3';
import { z } from 'zod';
import { assistantHistoryItemSchema, assistantHistoryQuerySchema, type AssistantHistoryPage, type AssistantHistoryQuery } from '../../shared/api/assistant.js';
import { PublicApiError } from '../../shared/api/errors.js';

const cursorSchema = z.strictObject({ version: z.literal(1), search: z.string(), updatedAt: z.string().min(1).max(100), id: z.string().min(1).max(200) });

export function listAssistantHistory(database: Database.Database, input: AssistantHistoryQuery = {}): AssistantHistoryPage {
  const query = assistantHistoryQuerySchema.parse(input);
  const search = query.search ?? '';
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))); }
    catch { throw new PublicApiError('ASSISTANT_HISTORY_CURSOR', '对话列表位置已失效，请重新读取。', 400); }
    if (cursor.search !== search) throw new PublicApiError('ASSISTANT_HISTORY_CURSOR', '搜索范围已变化，请重新搜索。', 400);
  }
  // Read metadata only. The stable timestamp/id pair also orders tied timestamps.
  const rows = database.prepare(`SELECT id, updated_at, json_remove(payload, '$.messages') AS metadata
    FROM assistant_conversations
    WHERE instr(lower(json_extract(payload, '$.title') || ' ' || coalesce(json_extract(payload, '$.contextPath'), '')), lower(@search)) > 0
      ${cursor ? 'AND (updated_at < @updatedAt OR (updated_at = @updatedAt AND id < @id))' : ''}
    ORDER BY updated_at DESC, id DESC LIMIT @limit`).all({ search, limit: query.limit + 1, ...(cursor ? { updatedAt: cursor.updatedAt, id: cursor.id } : {}) }) as Array<{ id: string; updated_at: string; metadata: string }>;
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    conversations: page.map(row => assistantHistoryItemSchema.parse(JSON.parse(row.metadata))), hasMore,
    ...(hasMore && last ? { nextCursor: Buffer.from(JSON.stringify({ version: 1, search, updatedAt: last.updated_at, id: last.id })).toString('base64url') } : {})
  };
}
