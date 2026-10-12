import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../../src/server/app.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';

const servers: ReturnType<typeof buildServer>[] = [];
const databases: Database.Database[] = [];
const roots: string[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); for (const db of databases.splice(0)) if (db.open) db.close(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function open(file = ':memory:') { const db = new Database(file); databases.push(db); applyMigrations(db); return db; }
function fixture(database = open(), cacheKey: string | undefined = 'a'.repeat(64)) {
  const gateway = Object.assign(new FakeVaultGateway({}), { openInObsidian: async () => {}, ...(cacheKey ? { cacheKey } : {}) });
  const app = buildServer({ readApi: { database, gateway, repository: createIndexRepository(database), currentIndexVersion: () => 1,
    indexScheduler: { snapshot: () => ({ state: { status: 'ready', version: 1, refreshedAt: new Date().toISOString() }, refresh: { status: 'ready', checked: 0, total: 0, version: 1 } }), requestFocusRefresh: async () => ({ generation: 1, outcome: 'succeeded', refresh: { status: 'ready', checked: 0, total: 0, version: 1 } }) }
  } }); servers.push(app); return app;
}
const payload = () => ({ expectedRevision: 0, title: '我的理解', body: '由我确认的正文', selection: { path: '01图书馆/测试.md', title: '测试资料', revision: 'a'.repeat(64), text: '保存时选择的片段' }, conversationId: randomUUID(), messageId: randomUUID() });
async function headers(app: ReturnType<typeof buildServer>) {
  const response = await app.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:4317' } });
  const cookie = String(response.headers['set-cookie']).split(';')[0]!;
  return { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie, 'x-csrf-token': response.json().data.csrfToken };
}
async function save(app: ReturnType<typeof buildServer>, id: string, body: Record<string, unknown>) { return app.inject({ method: 'PUT', url: `/api/v1/learning-notes/${id}`, payload: body, headers: await headers(app) }); }
async function list(app: ReturnType<typeof buildServer>, query: string) { return app.inject({ url: `/api/v1/learning-notes?${query}`, headers: { host: '127.0.0.1:4317' } }); }

it('persists independent notes across a closed database and server restart, without a source or conversation row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'learning-notes-')); roots.push(root); const file = join(root, 'data.sqlite');
  const db = open(file); const app = fixture(db); const id = randomUUID(); const input = payload();
  const saved = await save(app, id, input); expect(saved.statusCode).toBe(200); expect(saved.json().data.note).toMatchObject({ id, revision: 1, body: input.body, selection: input.selection });
  await app.close(); db.close(); const restarted = fixture(open(file));
  const restored = await list(restarted, `conversationId=${input.conversationId}`); expect(restored.statusCode).toBe(200); expect(restored.json().data.notes).toEqual([saved.json().data.note]);
});
it('repeats uncertain saves once and rejects conflicting edits without changing the note', async () => {
  const app = fixture(); const id = randomUUID(); const input = payload();
  const first = await save(app, id, input); expect(first.statusCode).toBe(200);
  expect((await save(app, id, input)).json().data.note).toEqual(first.json().data.note);
  const edit = await save(app, id, { ...input, expectedRevision: 1, body: '另一个窗口的新正文' }); expect(edit.statusCode).toBe(200); expect(edit.json().data.note.revision).toBe(2);
  expect((await save(app, id, { ...input, expectedRevision: 1, body: '旧窗口修改' })).statusCode).toBe(409);
  expect((await save(app, id, { ...input, expectedRevision: 2, selection: { ...input.selection, revision: 'b'.repeat(64) } })).statusCode).toBe(409);
  expect((await list(app, `path=${encodeURIComponent(input.selection.path)}`)).json().data.notes[0].body).toBe('另一个窗口的新正文');
});
it('isolates the same note id across server vault identities and rejects client identity injection', async () => {
  const db = open(); const a = fixture(db); const b = fixture(db, 'b'.repeat(64)); const id = randomUUID(); const input = payload();
  expect((await save(a, id, input)).statusCode).toBe(200);
  expect((await list(b, `conversationId=${input.conversationId}`)).json().data.notes).toEqual([]);
  expect((await save(b, id, { ...input, body: '另一个大脑' })).statusCode).toBe(200);
  expect((await list(a, `conversationId=${input.conversationId}`)).json().data.notes[0].body).toBe(input.body);
  expect((await save(a, randomUUID(), { ...input, vaultId: 'other' })).statusCode).toBe(400);
  expect((await list(a, `conversationId=${input.conversationId}&vaultId=other`)).statusCode).toBe(400);
});
it('requires CSRF, an explicit filter, a stable uuid and a real server vault identity', async () => {
  const app = fixture(); const input = payload();
  expect((await app.inject({ method: 'PUT', url: `/api/v1/learning-notes/${randomUUID()}`, payload: input, headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' } })).statusCode).toBe(401);
  expect((await list(app, '')).statusCode).toBe(400);
  expect((await save(app, 'bad-id', input)).statusCode).toBe(400);
  expect((await list(fixture(open(), ''), `conversationId=${input.conversationId}`)).statusCode).toBe(503);
});
