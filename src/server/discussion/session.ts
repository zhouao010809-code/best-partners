import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { PublicApiError } from '../../shared/api/errors.js';
import {
  discussionStatusSchema,
  type DiscussionSession,
  type DiscussionStatus,
  type DiscussionSummary
} from '../../shared/api/discussion.js';
import { parseCurrentMaterial } from '../rules/current-vault-notes.js';
import type { ReadVaultGateway } from '../vault/VaultGateway.js';
import { validateFilesystemPath } from '../vault/filesystem-path.js';

export type StoredSession = {
  value: DiscussionSession;
  day: string;
  startedAt: string;
  endedAt?: string;
  continuedPaths?: string[];
  keywords: string[];
  observed: Record<string, DiscussionStatus>;
};
export function chinaDay(date: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}
export function newSession(date: Date): StoredSession {
  const startedAt = date.toISOString();
  return {
    day: chinaDay(date),
    startedAt,
    keywords: [],
    observed: {},
    value: {
      id: randomUUID(),
      title: '',
      phase: 'active',
      materialPaths: [],
      messages: [],
      proposals: [],
      knowledgePaths: [],
      updatedAt: startedAt
    }
  };
}

type Row = { payload: string };
export function sessionStore(db: Database.Database, now: () => Date) {
  const row = db.prepare('SELECT payload FROM personal_discussions WHERE id=?');
  const requested = db.prepare('SELECT payload FROM personal_discussions WHERE request_id=?');
  const insert = db.prepare(
    'INSERT INTO personal_discussions(id,day,updated_at,request_id,payload) VALUES (?,?,?,?,?)'
  );
  const update = db.prepare('UPDATE personal_discussions SET updated_at=?,payload=? WHERE id=?');
  const decode = (r: unknown) => (r ? (JSON.parse((r as Row).payload) as StoredSession) : undefined);
  return {
    get(id: string) {
      const result = decode(row.get(id));
      if (!result) throw new PublicApiError('DISCUSSION_NOT_FOUND', '找不到这次探讨。', 404);
      return result;
    },
    chatPaths() {
      const paths = db
        .prepare(
          "SELECT json_extract(payload,'$.value.chatPath') AS path FROM personal_discussions WHERE json_type(payload,'$.value.chatPath') = 'text'"
        )
        .all() as Array<{ path: string }>;
      return new Set(paths.map((row) => row.path));
    },
    byRequest: (id: string) => decode(requested.get(id)),
    day: (day: string) =>
      db
        .prepare('SELECT payload FROM personal_discussions WHERE day=? ORDER BY rowid')
        .all(day)
        .map((r) => decode(r)!),
    list: () =>
      db
        .prepare(
          "SELECT id, updated_at AS updatedAt, json_extract(payload,'$.value.title') AS title, json_extract(payload,'$.value.phase') AS phase, json_extract(payload,'$.value.materialPaths') AS paths FROM personal_discussions ORDER BY updated_at DESC"
        )
        .all()
        .map((r) => {
          const { paths, ...other } = r as Omit<DiscussionSummary, 'materialPaths'> & { paths: string };
          return { ...other, materialPaths: JSON.parse(paths) as string[] };
        }),
    create(s: StoredSession, requestId?: string) {
      insert.run(s.value.id, s.day, s.value.updatedAt, requestId ?? null, JSON.stringify(s));
    },
    save(s: StoredSession) {
      s.value.updatedAt = new Date(Math.max(now().getTime(), Date.parse(s.value.updatedAt) + 1)).toISOString();
      update.run(s.value.updatedAt, JSON.stringify(s), s.value.id);
    }
  };
}

export async function readMaterials(gateway: ReadVaultGateway, paths: string[]) {
  return Promise.all(
    [...new Set(paths)].map(async (path) => {
      validateFilesystemPath(path);
      if (!/^01图书馆\/(?:01公域资料|02个人资料)\/.+\.md$/u.test(path)) {
        throw new PublicApiError('DISCUSSION_SOURCE_INVALID', '请先将资料归档到图书馆，再选择探讨。', 400);
      }
      let raw;
      try {
        raw = await gateway.readRaw(path);
      } catch {
        throw new PublicApiError(
          'DISCUSSION_SOURCE_MISSING',
          '无法读取已选的资料「' + path + '」，请检查图书馆。',
          409
        );
      }
      const parsed = parseCurrentMaterial(raw.bytes, path);
      const record = parsed.record;
      const status = discussionStatusSchema.safeParse(record?.knowledgeStatus);
      if (!record || !status.success)
        throw new PublicApiError('DISCUSSION_SOURCE_INVALID', '所选文件缺少新版图书馆资料属性。', 409);
      return {
        path,
        title: record.title,
        status: status.data,
        text: new TextDecoder('utf-8', { fatal: true }).decode(parsed.bodyBytes)
      };
    })
  );
}
