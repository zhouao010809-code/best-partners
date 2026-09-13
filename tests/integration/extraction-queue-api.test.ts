import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { createExtractionService } from '../../src/server/services/extraction-service.js';
import { createExtractionQueueService } from '../../src/server/services/extraction-queue-service.js';
import { assertMaterialAvailableForExtraction } from '../../src/server/services/material-visibility.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';
import type { MaterialRecord } from '../../src/shared/domain/records.js';
import type { ExtractionRun } from '../../src/shared/api/extraction.js';
import type { IndexState } from '../../src/server/index/index-state.js';

const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture() {
  const db = new Database(':memory:'); applyMigrations(db); cleanup.push(() => { db.close(); });
  const repository = createIndexRepository(db);
  const gateway = Object.assign(new FakeVaultGateway({}), { openInObsidian: vi.fn(async () => {}) });
  const forbidden = vi.fn(() => { throw new Error('Read API must not access credentials or provider'); });
  const service = createExtractionService({ database: db, repository, gateway,
    credentials: { status: forbidden, getKey: forbidden, setKey: forbidden, clear: forbidden },
    provider: { generate: forbidden } });
  let state: IndexState = { status: 'ready', version: 1, refreshedAt: '2026-09-06T00:00:00.000Z' };
  const app = buildServer({ extractionService: service, readApi: {
    repository, database: db, gateway, currentIndexVersion: () => state.version,
    indexScheduler: { requestFocusRefresh: forbidden, snapshot: () => ({ state,
      refresh: { status: 'ready', checked: 0, total: 0, version: state.version } }) }
  } });
  cleanup.push(() => app.close());
  const material = (name: string, overrides: Partial<MaterialRecord> = {}) => {
    const record: MaterialRecord = { path: `01图书馆/来自个人/${name}.md`, title: name,
      rawSha256: 'a'.repeat(64), sourcePlatform: '个人', processingStatus: '已归档',
      knowledgeStatus: '未提炼', generatedKnowledge: [], ...overrides };
    repository.replaceFile({ kind: 'material', record }); return record;
  };
  let sequence = 0;
  const run = (source: Pick<MaterialRecord, 'path' | 'title'>, status: ExtractionRun['status'], candidates = 1) => {
    const id = randomUUID();
    const createdAt = new Date(Date.UTC(2026, 8, 1, 0, 0, sequence++)).toISOString();
    const result = { briefing: { sentences: ['第一句。', '第二句。', '第三句。'], keyPoints: [], usefulness: '判断' },
      candidates: Array.from({ length: candidates }, () => ({ title: '候选', knowledgeType: '方法', suggestedPath: '02知识库/09学习', topics: [], coreContent: 'private-candidate-body', value: '价值' })) };
    db.prepare('INSERT INTO personal_extraction_runs (id,preview_token,material_path,title,reading_state,source_raw_sha256,rule_fingerprint,model,created_at,status,result_json,problem) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, randomUUID(), source.path, source.title, '未看', 'a'.repeat(64), 'b'.repeat(64), 'deepseek-v4-flash', createdAt, status,
        status === 'ready' ? JSON.stringify(result) : null, status === 'failed' ? '提炼未完成。' : status === 'cancelled' ? '已取消。' : null);
    return { id, createdAt };
  };
  const get = (endpoint: 'queue' | 'queue/source' | 'history', query: Record<string, string | number> = {}) => app.inject({
    url: `/api/v1/extraction-${endpoint}?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`, headers
  });
  const visibility = async (materialPath: string, removed: boolean) => {
    const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers });
    return app.inject({ method: 'POST', url: '/api/v1/extraction-queue/visibility', payload: { materialPath, removed },
      headers: { ...headers, cookie: String(bootstrap.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': bootstrap.json().data.csrfToken } });
  };
  return { app, db, repository, gateway, forbidden, material, run, get, visibility, setState: (next: IndexState) => { state = next; } };
}

it('removes and re-adds pending and historical sources idempotently without losing original records or any history', async () => {
  const f = fixture(); const pending = f.material('暂不处理'); const historical = f.material('保留所有历史');
  const ready = f.run(historical, 'ready', 2); review(f, ready.id, 0, 'committed');
  for (let i = 0; i < 55; i++) f.run(historical, 'failed');
  const originalRows = f.db.prepare('SELECT * FROM personal_extraction_runs').all();
  const reviews = f.db.prepare('SELECT * FROM personal_candidate_reviews').all();
  for (const source of [pending, historical]) {
    const response = await f.visibility(source.path, true); expect(response.statusCode).toBe(200);
    expect(response.json().data.item).toMatchObject({ materialPath: source.path, removedAt: expect.any(String), canExtract: false });
    expect((await f.visibility(source.path, true)).json()).toEqual(response.json());
  }
  expect((await f.get('queue')).json().data.counts).toEqual({ pending: 0, generating: 0, ready: 0, unfinished: 0 });
  const restarted = createExtractionQueueService({ database: f.db, repository: f.repository });
  expect(restarted.queue({ visibility: 'removed' }).items[0]?.materialPath).toBe(pending.path);
  expect(restarted.queue({ visibility: 'removed', view: 'unfinished' }).items[0]).toMatchObject({ latestReadyRun: { id: ready.id }, pendingCandidateCount: 1 });
  expect((await f.get('queue/source', { materialPath: historical.path })).json().data.item.removedAt).toBeTruthy();
  expect(restarted.history({ materialPath: historical.path, limit: 200 }).items).toHaveLength(56);
  expect((await f.app.inject({ url: '/api/v1/materials', headers })).json().data.items.map((record: MaterialRecord) => record.path)).toEqual(expect.arrayContaining([pending.path, historical.path]));
  for (const source of [pending, historical]) {
    expect((await f.visibility(source.path, false)).json().data.item.removedAt).toBeUndefined();
    expect((await f.visibility(source.path, false)).statusCode).toBe(200);
  }
  expect(restarted.queue({}).items[0]?.canExtract).toBe(true);
  expect(f.db.prepare('SELECT * FROM personal_extraction_runs').all()).toEqual(originalRows);
  expect(f.db.prepare('SELECT * FROM personal_candidate_reviews').all()).toEqual(reviews);
  expect(f.gateway.rawReadPaths).toEqual([]); expect(f.forbidden).not.toHaveBeenCalled();
});

it('blocks removal during active extraction or unfinished ingestion and rejects unknown sources', async () => {
  const f = fixture(); const source = f.material('进行中'); const active = f.run(source, 'generating');
  const blocked = await f.visibility(source.path, true); expect(blocked.statusCode).toBe(409); expect(blocked.body).toContain('先停止本次提炼');
  f.db.prepare("UPDATE personal_extraction_runs SET status='ready',result_json=? WHERE id=?").run('{"candidates":[]}', active.id);
  f.db.prepare('INSERT INTO personal_ingestion_batches VALUES (?,?,?,?,0,?,NULL)').run('batch', active.id, '2026-09-07T00:00:00.000Z', 'needs-review', '{}');
  const recovering = await f.visibility(source.path, true); expect(recovering.statusCode).toBe(409); expect(recovering.body).toContain('完成入库恢复');
  expect((await f.visibility('01图书馆/不存在.md', true)).statusCode).toBe(404);
  expect(f.db.prepare('SELECT * FROM personal_queue_visibility').all()).toEqual([]);
});

it('invalidates queue cursors after visibility changes and excludes all unfinished trash operations immediately', async () => {
  const f = fixture(); const a = f.material('a'); f.material('b');
  const first = await f.get('queue', { limit: 1 });
  expect((await f.visibility(a.path, true)).statusCode).toBe(200);
  expect((await f.get('queue', { limit: 1, cursor: first.json().data.nextCursor })).statusCode).toBe(409);
  f.run(a, 'ready');
  for (const status of ['moving', 'trashed', 'restoring', 'needs-review'] as const) {
    f.db.prepare('INSERT OR REPLACE INTO personal_trash_entries(id,material_path,title,created_at,status,manifest_json) VALUES (?,?,?,?,?,?)').run('trash', a.path, a.title, '2026-09-07T00:00:00.000Z', status, '{}');
    expect((await f.get('queue', { view: 'ready', visibility: 'removed' })).json().data.items).toEqual([]);
    expect((await f.get('queue/source', { materialPath: a.path })).json().data.item).toBeNull();
    expect((await f.visibility(a.path, false)).statusCode).toBe(409);
  }
  f.db.prepare("UPDATE personal_trash_entries SET status='restored'").run();
  expect((await f.get('queue', { view: 'ready', visibility: 'removed' })).json().data.items).toHaveLength(1);
});

it('requires session, CSRF and exact request fields for queue visibility writes', async () => {
  const f = fixture(); const source = f.material('授权');
  const request = { method: 'POST' as const, url: '/api/v1/extraction-queue/visibility', payload: { materialPath: source.path, removed: true } };
  expect((await f.app.inject({ ...request, headers })).statusCode).toBe(401);
  const bootstrap = await f.app.inject({ url: '/api/v1/bootstrap', headers });
  const cookie = String(bootstrap.headers['set-cookie']).split(';')[0]!;
  expect((await f.app.inject({ ...request, headers: { ...headers, cookie } })).statusCode).toBe(403);
  const auth = { ...headers, cookie, 'x-csrf-token': bootstrap.json().data.csrfToken };
  expect((await f.app.inject({ ...request, headers: { ...auth, origin: 'https://evil.example' } })).statusCode).toBe(403);
  expect((await f.app.inject({ ...request, headers: auth, payload: { ...request.payload, deleteHistory: true } })).statusCode).toBe(400);
  expect((await f.get('queue', { visibility: 'invalid' })).statusCode).toBe(400);
});

it('keeps permanently deleted source runs as history without returning them to the queue or poisoning a new same-path document', async () => {
  const f = fixture(); const source = f.material('删除后同名'); const old = f.run(source, 'ready');
  f.db.prepare('INSERT INTO personal_queue_visibility VALUES (?,?)').run(source.path, '2026-09-06T00:00:00.000Z');
  f.repository.removeFile(source.path);
  f.db.prepare("INSERT INTO personal_trash_entries(id,material_path,title,created_at,status,manifest_json,deleted_at) VALUES(?,?,?,?,'deleted','{}',?)")
    .run(randomUUID(), source.path, source.title, '2026-09-07T00:00:00.000Z', '2026-09-07T01:00:00.000Z');
  expect((await f.get('queue', { view: 'ready' })).json().data.items).toEqual([]);
  expect((await f.get('queue/source', { materialPath: source.path })).json().data.item).toBeNull();
  expect((await f.get('history', { materialPath: source.path })).json().data.items).toMatchObject([{ id: old.id }]);
  f.material('删除后同名', { rawSha256: 'c'.repeat(64) });
  const replacement = (await f.get('queue/source', { materialPath: source.path })).json().data.item;
  expect(replacement).toMatchObject({ view: 'pending', canExtract: true, sourceRawSha256: 'c'.repeat(64) });
  expect(replacement.latestRun).toBeUndefined();
  expect(() => assertMaterialAvailableForExtraction(f.db, source.path)).not.toThrow();
  expect((await f.visibility(source.path, true)).json().data.item.removedAt).toBeDefined();
  expect((await f.get('queue', { visibility: 'removed' })).json().data.items).toHaveLength(1);
  await f.visibility(source.path, false);
  const fresh = f.run(source, 'ready');
  f.db.prepare('UPDATE personal_extraction_runs SET created_at=?,source_raw_sha256=? WHERE id=?')
    .run('2026-09-07T02:00:00.000Z', 'c'.repeat(64), fresh.id);
  expect((await f.get('queue/source', { materialPath: source.path })).json().data.item.latestRun.id).toBe(fresh.id);
  expect(f.db.prepare('SELECT id FROM personal_extraction_runs').all()).toHaveLength(2);
});

it('hides trash from the original library immediately and invalidates material cursors while queue removal leaves it readable', async () => {
  const f = fixture(); const a = f.material('a'); const b = f.material('b');
  const list = () => f.app.inject({ url: '/api/v1/materials?limit=1', headers });
  const first = await list();
  await f.visibility(a.path, true);
  expect((await list()).json().data.items[0].path).toBe(a.path);
  f.db.prepare('INSERT INTO personal_trash_entries(id,material_path,title,created_at,status,manifest_json) VALUES (?,?,?,?,?,?)').run('trash', a.path, a.title, '2026-09-07T00:00:00.000Z', 'moving', '{}');
  expect((await list()).json().data.items[0].path).toBe(b.path);
  expect((await f.app.inject({ url: `/api/v1/materials?limit=1&cursor=${first.json().data.nextCursor}`, headers })).statusCode).toBe(409);
  f.db.prepare("UPDATE personal_trash_entries SET status='restored'").run();
  expect((await list()).json().data.items[0].path).toBe(a.path);
});

function review(f: ReturnType<typeof fixture>, runId: string, ordinal: number, state: 'pending' | 'discarded' | 'committed') {
  f.db.prepare('INSERT INTO personal_candidate_reviews (id,run_id,ordinal,version,state,decision,draft_json,target_json) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(), runId, ordinal, 1, state, state === 'discarded' ? 'discard' : 'keep', '{}', '{}');
}

it('summarizes all unresolved runs and filters completed source reviews without reading candidate text', async () => {
  const f = fixture(); const olderPending = f.material('旧轮次未决'); const old = f.run(olderPending, 'ready', 2);
  review(f, old.id, 0, 'committed');
  for (let i = 0; i < 55; i++) f.run(olderPending, 'failed');
  f.run(olderPending, 'ready', 0);
  const complete = f.material('已处理但无需入库'); const done = f.run(complete, 'ready', 2);
  review(f, done.id, 0, 'discarded'); review(f, done.id, 1, 'discarded');
  const partial = f.material('部分入库继续', { knowledgeStatus: '部分入库', rawSha256: 'c'.repeat(64) });
  const partialRun = f.run(partial, 'ready', 2); review(f, partialRun.id, 0, 'committed'); review(f, partialRun.id, 1, 'pending');
  f.db.prepare('INSERT INTO personal_ingestion_source_heads VALUES (?,?,?,?)').run(partialRun.id, partial.path, partial.rawSha256, 'e'.repeat(64));
  const response = await f.get('queue', { view: 'ready', reviewState: 'pending' });
  expect(response.statusCode).toBe(200);
  expect(response.json().data.items).toHaveLength(2);
  expect(response.json().data.items.find((item: { materialPath: string }) => item.materialPath === olderPending.path)).toMatchObject({ reviewComplete: false, pendingCandidateCount: 1 });
  expect(response.json().data.items.find((item: { materialPath: string }) => item.materialPath === partial.path)).toMatchObject({ reviewComplete: false, pendingCandidateCount: 1, canExtract: false, latestReadyRun: { currentSourceSha256: partial.rawSha256 } });
  const processed = await f.get('queue', { view: 'ready', reviewState: 'complete' });
  expect(processed.json().data.items).toEqual([expect.objectContaining({ materialPath: complete.path, reviewComplete: true, pendingCandidateCount: 0 })]);
  expect(response.body + processed.body).not.toContain('private-candidate-body');
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('invalidates a queue cursor when candidate decisions change without an index revision', async () => {
  const f = fixture(); const a = f.material('a'); const b = f.material('b'); const run = f.run(a, 'ready'); f.run(b, 'ready');
  review(f, run.id, 0, 'pending');
  const first = await f.get('queue', { view: 'ready', limit: 1 });
  f.db.prepare("UPDATE personal_candidate_reviews SET state='discarded' WHERE run_id=?").run(run.id);
  expect((await f.get('queue', { view: 'ready', limit: 1, cursor: first.json().data.nextCursor })).statusCode).toBe(409);
});

it('retains complete source decisions after a later failed attempt and reopens them for new ready candidates', async () => {
  const f = fixture(); const source = f.material('已处理后失败'); const first = f.run(source, 'ready');
  review(f, first.id, 0, 'discarded'); f.run(source, 'failed');
  const completed = await f.get('queue', { view: 'unfinished', reviewState: 'complete' });
  expect(completed.json().data.items).toHaveLength(1);
  expect(completed.json().data.items[0]).toMatchObject({ reviewComplete: true, pendingCandidateCount: 0 });
  f.run(source, 'ready', 1);
  const reopened = await f.get('queue', { view: 'ready', reviewState: 'pending' });
  expect(reopened.json().data.items[0]).toMatchObject({ reviewComplete: false, pendingCandidateCount: 1 });
});

it('supports old read-only databases without candidate-review or source-head tables', () => {
  const f = fixture(); const source = f.material('旧版资料'); f.run(source, 'ready', 2);
  f.db.exec('DROP TABLE personal_candidate_reviews; DROP TABLE personal_ingestion_source_heads;');
  f.db.exec('DROP TABLE personal_queue_visibility; DROP TABLE personal_trash_entries;');
  const service = createExtractionQueueService({ database: f.db, repository: f.repository });
  expect(service.queue({ view: 'ready' }).items[0]).toMatchObject({ reviewComplete: false, pendingCandidateCount: 2 });
});

it('only queues indexed archived unrefined materials without any recorded run', async () => {
  const f = fixture(); const pending = f.material('待提炼', { collectedAt: '2026-09-06' });
  f.material('未归档', { processingStatus: '未归档' });
  f.material('部分入库', { knowledgeStatus: '部分入库' }); f.material('已入库', { knowledgeStatus: '已入库' });
  const ready = f.material('已提炼'); f.run(ready, 'ready');
  const before = f.db.prepare('SELECT total_changes() AS count').get();
  const response = await f.get('queue');
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({ items: [{ materialPath: pending.path, view: 'pending', canExtract: true }], counts: { pending: 1, generating: 0, ready: 1, unfinished: 0 } });
  expect(response.json().data.items).toHaveLength(1);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(f.gateway.rawReadPaths).toEqual([]); expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
});

it('finds a success older than the latest 50 runs and paginates complete source history without candidate bodies', async () => {
  const f = fixture(); const old = f.material('较早成功'); const olderReady = f.run(old, 'ready');
  const many = f.material('多轮资料'); const firstReady = f.run(many, 'ready');
  for (let i = 0; i < 55; i++) f.run(many, 'failed');
  const readyPage = await f.get('queue', { view: 'ready' });
  expect(readyPage.statusCode).toBe(200);
  expect(readyPage.json().data.items[0]).toMatchObject({ materialPath: old.path, latestReadyRun: { id: olderReady.id, candidateCount: 1 } });
  const unfinished = await f.get('queue', { view: 'unfinished' });
  expect(unfinished.json().data.items[0]).toMatchObject({ latestRun: { status: 'failed' }, latestReadyRun: { id: firstReady.id } });
  const history = await f.get('history', { materialPath: many.path, limit: 50 });
  expect(history.statusCode).toBe(200); expect(history.json().data.items).toHaveLength(50);
  const next = await f.get('history', { materialPath: many.path, limit: 50, cursor: history.json().data.nextCursor });
  expect(next.json().data.items).toHaveLength(6); expect(next.json().data.items.at(-1).id).toBe(firstReady.id);
  expect(next.json().data.nextCursor).toBeUndefined();
  expect([readyPage.body, unfinished.body, history.body, next.body].join('')).not.toContain('private-candidate-body');
  expect((await f.app.inject({ url: `/api/v1/extractions/${firstReady.id}`, headers })).json().data.result.candidates).toHaveLength(1);
});

it('gives active work precedence while retaining latest failure and the earlier zero-candidate success', async () => {
  const f = fixture(); const source = f.material('进行中'); const success = f.run(source, 'ready', 0);
  const active = f.run(source, 'generating'); const latest = f.run(source, 'failed');
  const response = await f.get('queue', { view: 'generating' }); expect(response.statusCode).toBe(200);
  expect(response.json().data.items[0]).toMatchObject({ view: 'generating', canExtract: false,
    latestRun: { id: latest.id, status: 'failed' }, activeRun: { id: active.id }, latestReadyRun: { id: success.id, candidateCount: 0 } });
  f.db.prepare("UPDATE personal_extraction_runs SET status='cancelled' WHERE id=?").run(active.id);
  expect((await f.get('queue', { view: 'unfinished' })).json().data.counts).toEqual({ pending: 0, generating: 0, ready: 0, unfinished: 1 });
  const zero = f.material('零候选'); f.run(zero, 'ready', 0);
  expect((await f.get('queue', { view: 'ready' })).json().data.items[0]).toMatchObject({ latestRun: { candidateCount: 0 } });
});

it('preserves history for missing or ineligible sources and distinguishes a changed source hash', async () => {
  const f = fixture(); const changed = f.material('变更'); f.run(changed, 'ready');
  f.repository.replaceFile({ kind: 'material', record: { ...changed, rawSha256: 'c'.repeat(64) } });
  const missing = f.material('暂未索引'); const saved = f.run(missing, 'ready'); f.repository.removeFile(missing.path);
  const ingested = f.material('已正式入库', { knowledgeStatus: '已入库' }); f.run(ingested, 'ready');
  const response = await f.get('queue', { view: 'ready' }); expect(response.statusCode).toBe(200);
  const items = response.json().data.items;
  expect(items.find((item: { materialPath: string }) => item.materialPath === changed.path)).toMatchObject({ sourceRawSha256: 'c'.repeat(64), latestRun: { sourceRawSha256: 'a'.repeat(64) }, canExtract: true });
  const absent = items.find((item: { materialPath: string }) => item.materialPath === missing.path);
  expect(absent).toMatchObject({ title: missing.title, canExtract: false, latestReadyRun: { id: saved.id } });
  expect(absent.sourceRawSha256).toBeUndefined(); expect(absent.sourcePlatform).toBeUndefined(); expect(absent.collectedAt).toBeUndefined();
  expect(items.find((item: { materialPath: string }) => item.materialPath === ingested.path)).toMatchObject({ canExtract: false, sourcePlatform: '个人', sourceRawSha256: ingested.rawSha256 });
});

it('orders recent collection first, then undated, with stable path ties and filter-wide counts', async () => {
  const f = fixture(); const older = f.material('目标-older', { collectedAt: '2026-09-01' });
  const z = f.material('目标-z', { collectedAt: '2026-09-06' }); const a = f.material('目标-a', { collectedAt: '2026-09-06' });
  const undated = f.material('目标-undated'); const ready = f.material('目标-ready', { collectedAt: '2026-09-04' }); f.run(ready, 'ready');
  f.material('other', { sourcePlatform: 'B站', collectedAt: '2026-09-04' });
  const first = await f.get('queue', { title: '目标', sourcePlatform: '个人', limit: 2 }); expect(first.statusCode).toBe(200);
  expect(first.json().data.items.map((item: { materialPath: string }) => item.materialPath)).toEqual([a.path, z.path]);
  expect(first.json().data.counts).toEqual({ pending: 4, generating: 0, ready: 1, unfinished: 0 });
  const next = await f.get('queue', { title: '目标', sourcePlatform: '个人', limit: 2, cursor: first.json().data.nextCursor });
  expect(next.json().data.items.map((item: { materialPath: string }) => item.materialPath)).toEqual([older.path, undated.path]);
  expect(next.json().data.nextCursor).toBeUndefined();
  const dates = await f.get('queue', { collectedFrom: '2026-09-02', collectedTo: '2026-09-06', sourcePlatform: '个人' });
  expect(dates.json().data.counts).toEqual({ pending: 2, generating: 0, ready: 1, unfinished: 0 });
});

it('includes sources beyond the repository first page', async () => {
  const f = fixture(); for (let i = 0; i < 205; i++) f.material(`资料-${String(i).padStart(3, '0')}`);
  const first = await f.get('queue', { limit: 200 }); expect(first.statusCode).toBe(200);
  expect(first.json().data.counts.pending).toBe(205); expect(first.json().data.items).toHaveLength(200);
  expect((await f.get('queue', { limit: 200, cursor: first.json().data.nextCursor })).json().data.items).toHaveLength(5);
});

it('rejects tampered and changed-context cursors and changed queue or history snapshots', async () => {
  const f = fixture(); const a = f.material('a'); f.material('b');
  const first = await f.get('queue', { limit: 1 }); expect(first.statusCode).toBe(200); const cursor = first.json().data.nextCursor as string;
  expect((await f.get('queue', { limit: 1, cursor: `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}` })).statusCode).toBe(400);
  expect((await f.get('queue', { view: 'ready', limit: 1, cursor })).statusCode).toBe(400);
  expect((await f.get('queue', { title: 'a', limit: 1, cursor })).statusCode).toBe(400);
  f.run(a, 'failed'); expect((await f.get('queue', { limit: 1, cursor })).statusCode).toBe(409);
  f.run(a, 'ready'); const history = await f.get('history', { materialPath: a.path, limit: 1 });
  const historyCursor = history.json().data.nextCursor;
  expect((await f.get('history', { materialPath: '01图书馆/不同.md', limit: 1, cursor: historyCursor })).statusCode).toBe(400);
  expect((await f.get('queue', { limit: 1, cursor: historyCursor })).statusCode).toBe(400);
  f.run(a, 'cancelled'); expect((await f.get('history', { materialPath: a.path, limit: 1, cursor: historyCursor })).statusCode).toBe(409);
  const pending = await f.get('queue', { view: 'unfinished', limit: 1 }); expect(pending.statusCode).toBe(200);
});

it('invalidates a queue cursor when indexed metadata changes', async () => {
  const f = fixture(); const a = f.material('a'); f.material('b'); const first = await f.get('queue', { limit: 1 });
  expect(first.statusCode).toBe(200); f.repository.replaceFile({ kind: 'material', record: { ...a, rawSha256: 'd'.repeat(64) } });
  expect((await f.get('queue', { limit: 1, cursor: first.json().data.nextCursor })).statusCode).toBe(409);
});

it('retains host/origin guards and rejects invalid filters before reading data', async () => {
  const f = fixture();
  expect((await f.app.inject({ url: '/api/v1/extraction-queue', headers: { ...headers, host: 'evil.example' } })).statusCode).toBe(421);
  expect((await f.app.inject({ url: '/api/v1/extraction-history?materialPath=a', headers: { ...headers, origin: 'https://evil.example' } })).statusCode).toBe(403);
  for (const query of [{ view: 'invalid' }, { collectedFrom: '2026-02-30' }, { collectedFrom: '2026-09-06', collectedTo: '2026-09-01' }, { limit: 0 }, { unknown: 'field' }]) {
    expect((await f.get('queue', query)).statusCode).toBe(400);
  }
  expect((await f.get('history')).statusCode).toBe(400);
  expect((await f.get('history', { materialPath: '01图书馆/a.md', limit: 201 })).statusCode).toBe(400);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('reports unavailable services or indexes instead of inventing an empty pending queue', async () => {
  const unavailable = buildServer(); cleanup.push(() => unavailable.close());
  expect((await unavailable.inject({ url: '/api/v1/extraction-queue', headers })).statusCode).toBe(503);
  expect((await unavailable.inject({ url: '/api/v1/extraction-history?materialPath=a', headers })).statusCode).toBe(503);
  const f = fixture(); const source = f.material('有历史'); f.run(source, 'ready');
  for (const status of ['building', 'failed', 'stale'] as const) {
    f.setState(status === 'building' ? { status, version: 1, startedAt: '2026-09-06T00:00:00.000Z' }
      : status === 'failed' ? { status, version: 1, reason: 'TEST_FAILURE' }
        : { status, version: 1, lastSuccessAt: '2026-09-06T00:00:00.000Z', reason: 'TEST_STALE' });
    expect((await f.get('queue')).statusCode).toBe(503);
    expect((await f.get('history', { materialPath: source.path })).statusCode).toBe(200);
  }
});

it('restores the selected source metadata as it moves from pending through generating to ready', async () => {
  const f = fixture(); const source = f.material('跨状态资料', { sourcePlatform: 'B站', collectedAt: '2026-09-06' });
  const selected = () => f.get('queue/source', { materialPath: source.path });
  const pending = await selected(); expect(pending.statusCode).toBe(200);
  const metadata = { materialPath: source.path, title: source.title, sourcePlatform: 'B站', collectedAt: '2026-09-06', sourceRawSha256: source.rawSha256 };
  expect(pending.json()).toMatchObject({ version: 1, data: { item: { ...metadata, view: 'pending', canExtract: true } } });
  const active = f.run(source, 'generating');
  expect((await selected()).json().data.item).toMatchObject({ ...metadata, view: 'generating', canExtract: false, activeRun: { id: active.id } });
  expect((await f.get('queue')).json().data.items).toEqual([]);
  f.db.prepare("UPDATE personal_extraction_runs SET status='cancelled' WHERE id=?").run(active.id);
  const completed = f.run(source, 'ready', 0);
  const ready = await selected();
  expect(ready.json().data.item).toMatchObject({ ...metadata, view: 'ready', latestReadyRun: { id: completed.id, candidateCount: 0 } });
  expect(ready.json().data.item.activeRun).toBeUndefined(); expect(ready.headers['cache-control']).toBe('no-store');
  expect(ready.body).not.toContain('private-candidate-body'); expect(f.forbidden).not.toHaveBeenCalled(); expect(f.gateway.rawReadPaths).toEqual([]);
});

it('returns a saved source without index metadata, and null for sources with no queue entry', async () => {
  const f = fixture(); const source = f.material('历史可找回'); const saved = f.run(source, 'ready'); f.repository.removeFile(source.path);
  const response = await f.get('queue/source', { materialPath: source.path }); expect(response.statusCode).toBe(200);
  expect(response.json().data.item).toMatchObject({ materialPath: source.path, title: source.title, view: 'ready', canExtract: false, latestReadyRun: { id: saved.id } });
  expect(response.json().data.item.sourceRawSha256).toBeUndefined();
  expect((await f.get('queue/source', { materialPath: '01图书馆/不存在.md' })).json().data).toEqual({ item: null });
  const ineligible = f.material('无历史未归档', { processingStatus: '未归档' });
  expect((await f.get('queue/source', { materialPath: ineligible.path })).json().data).toEqual({ item: null });
});

it('applies queue readiness and validates source lookup paths without reading or writing the vault', async () => {
  const f = fixture();
  for (const query of [{}, { materialPath: '' }, { materialPath: '../outside.md' }, { materialPath: '/tmp/outside.md' }, { materialPath: '01图书馆/a.md', view: 'ready' }]) {
    expect((await f.get('queue/source', query)).statusCode).toBe(400);
  }
  const before = f.db.prepare('SELECT total_changes() AS count').get();
  for (const state of [
    { status: 'building', version: 1, startedAt: '2026-09-06T00:00:00.000Z' },
    { status: 'failed', version: 1, reason: 'TEST_FAILURE' }
  ] satisfies IndexState[]) {
    f.setState(state); expect((await f.get('queue/source', { materialPath: '01图书馆/a.md' })).statusCode).toBe(503);
  }
  const unavailable = buildServer(); cleanup.push(() => unavailable.close());
  expect((await unavailable.inject({ url: '/api/v1/extraction-queue/source?materialPath=a', headers })).statusCode).toBe(503);
  expect(f.gateway.rawReadPaths).toEqual([]); expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
});
