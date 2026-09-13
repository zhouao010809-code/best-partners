import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import type { IngestionBatch, IngestionPreview, IngestionRecoveryPreview, IngestionReview, ReviewCandidate } from '../../src/shared/api/ingestion.js';
import { API_VERSION } from '../../src/shared/api/schemas.js';

const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { for (const app of servers.splice(0)) await app.close(); });
const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
const runId = '11111111-1111-4111-8111-111111111111', batchId = '22222222-2222-4222-8222-222222222222';
const candidate: ReviewCandidate = { id: 'candidate-1', version: 1, state: 'pending', decision: 'keep', target: { mode: 'new' },
  draft: { title: '知识', knowledgeType: '方法', suggestedPath: '02知识库/09学习', topics: [], coreContent: '核查证据', value: '减少误判',
    draft: { keywords: [], scenarios: [], conclusion: '', keyPoints: [], boundary: '', quotes: [], summaries: [] } } };
const batch: IngestionBatch = { id: batchId, runId, status: 'committed', indexed: true, createdAt: '2026-09-07T00:00:00.000Z',
  knowledgePaths: ['02知识库/09学习/知识.md'], pendingCount: 0, sourceStatus: '已入库' };
const review: IngestionReview = { runId, materialPath: '01图书馆/来自个人/原文.md', title: '原文', candidates: [candidate],
  directories: ['02知识库/09学习'], sourceStatus: '未提炼', sourceChanged: false, complete: false, relatedRuns: [], batches: [] };
const preview: IngestionPreview = { id: batchId, runId, expiresAt: '2026-09-07T01:00:00.000Z', files: [],
  selectedCount: 1, discardedCount: 0, pendingCount: 0, sourceStatus: '已入库' };
const recovery: IngestionRecoveryPreview = { id: batchId, batchId, expiresAt: preview.expiresAt, files: [], sourceChoice: 'current', hasPreservedSource: false };
const save = { candidateId: candidate.id, version: candidate.version, draft: candidate.draft, target: candidate.target, decision: candidate.decision };
const stub = () => ({ review: vi.fn(async () => review), save: vi.fn(() => candidate), matches: vi.fn(async () => ({ items: [] })),
  preview: vi.fn(async () => preview), commit: vi.fn(async () => batch), batch: vi.fn(() => batch), resume: vi.fn(async () => batch),
  recoveryPreview: vi.fn(async () => recovery), resolve: vi.fn(async () => batch), recover: vi.fn(async () => {}), close: vi.fn(async () => {}) });
function server(service = stub()) { const app = buildServer({ ingestionService: service }); servers.push(app); return { app, service }; }
async function auth(app: ReturnType<typeof buildServer>) {
  const response = await app.inject({ url: '/api/v1/bootstrap', headers });
  return { ...headers, cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': response.json().data.csrfToken as string };
}
const mutations = [
  { url: `/api/v1/ingestion/reviews/${runId}/candidates`, payload: save, method: 'save', args: [runId, save], result: candidate },
  { url: '/api/v1/ingestion/previews', payload: { runId, versions: [{ id: candidate.id, version: 1 }] }, method: 'preview', args: [{ runId, versions: [{ id: candidate.id, version: 1 }] }], result: preview },
  { url: '/api/v1/ingestion/commit', payload: { id: batchId }, method: 'commit', args: [batchId], result: batch },
  { url: `/api/v1/ingestion/batches/${batchId}/resume`, payload: {}, method: 'resume', args: [batchId], result: batch },
  { url: `/api/v1/ingestion/batches/${batchId}/recovery-preview`, payload: {}, method: 'recoveryPreview', args: [batchId, undefined, undefined], result: recovery },
  { url: '/api/v1/ingestion/resolve', payload: { id: batchId }, method: 'resolve', args: [batchId], result: batch }
] as const;

it('serves reviews, matches and batches without triggering vault mutations or automatic recovery', async () => {
  const { app, service } = server();
  for (const [url, expected] of [[`/api/v1/ingestion/reviews/${runId}`, review],
    [`/api/v1/ingestion/reviews/${runId}/matches?candidateId=${candidate.id}&search=证据`, { items: [] }],
    [`/api/v1/ingestion/batches/${batchId}`, batch]] as const) {
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ version: API_VERSION, data: expected });
    expect(response.headers['cache-control']).toBe('no-store');
  }
  expect(service.review).toHaveBeenCalledExactlyOnceWith(runId);
  expect(service.matches).toHaveBeenCalledExactlyOnceWith(runId, candidate.id, '证据');
  expect(service.batch).toHaveBeenCalledExactlyOnceWith(batchId);
  for (const method of ['save', 'preview', 'commit', 'resume', 'recoveryPreview', 'resolve', 'recover'] as const) expect(service[method]).not.toHaveBeenCalled();
});

it.each(mutations)('protects $method by origin, session and CSRF and returns its strict envelope', async ({ url, payload, method, args, result }) => {
  const { app, service } = server();
  expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(401);
  const allowed = await auth(app);
  const { 'x-csrf-token': _csrf, ...withoutCsrf } = allowed;
  expect((await app.inject({ method: 'POST', url, headers: withoutCsrf, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url, headers: { ...allowed, origin: 'https://evil.example' }, payload })).statusCode).toBe(403);
  expect(service[method]).not.toHaveBeenCalled();
  const response = await app.inject({ method: 'POST', url, headers: allowed, payload });
  expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ version: API_VERSION, data: result });
  expect(response.headers['cache-control']).toBe('no-store'); expect(service[method]).toHaveBeenCalledExactlyOnceWith(...args);
});

it('returns a specific unavailable 503 when the personal ingestion service is absent', async () => {
  const app = buildServer(); servers.push(app); const allowed = await auth(app);
  for (const url of [`/api/v1/ingestion/reviews/${runId}`, `/api/v1/ingestion/reviews/${runId}/matches?candidateId=${candidate.id}`, `/api/v1/ingestion/batches/${batchId}`]) {
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(503); expect(response.json()).toMatchObject({ error: { code: 'INGESTION_UNAVAILABLE' } });
  }
  for (const { url, payload } of mutations) {
    const response = await app.inject({ method: 'POST', url, headers: allowed, payload });
    expect(response.statusCode).toBe(503); expect(response.json()).toMatchObject({ error: { code: 'INGESTION_UNAVAILABLE' } });
  }
});

it('rejects malformed IDs, unknown fields, arbitrary bytes and unbounded match queries before invoking services', async () => {
  const { app, service } = server(), allowed = await auth(app);
  for (const url of ['/api/v1/ingestion/reviews/not-a-uuid', `/api/v1/ingestion/reviews/${runId}?write=true`,
    `/api/v1/ingestion/reviews/${runId}/matches?candidateId=x&search=${'a'.repeat(201)}`,
    `/api/v1/ingestion/reviews/${runId}/matches?candidateId=x&unknown=true`]) {
    expect((await app.inject({ url, headers })).statusCode).toBe(400);
  }
  for (const { url, payload } of mutations) expect((await app.inject({ method: 'POST', url, headers: allowed, payload: { ...payload, bytes: 'arbitrary' } })).statusCode).toBe(400);
  expect(service.review).not.toHaveBeenCalled(); expect(service.matches).not.toHaveBeenCalled();
  for (const { method } of mutations) expect(service[method]).not.toHaveBeenCalled();
});

it('rejects malformed service output without leaking internal fields', async () => {
  const { app, service } = server();
  service.review.mockResolvedValue({ ...review, privatePath: '/private/secret' } as IngestionReview);
  const response = await app.inject({ url: `/api/v1/ingestion/reviews/${runId}`, headers });
  expect(response.statusCode).toBe(500); expect(response.body).not.toContain('/private/secret');
  expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
});

it.each(['current', 'preserved'] as const)('passes the explicit %s source choice to recovery preview after validation', async (sourceChoice) => {
  const { app, service } = server(), allowed = await auth(app);
  const url = `/api/v1/ingestion/batches/${batchId}/recovery-preview`;
  const result = { ...recovery, sourceChoice, hasPreservedSource: true };
  service.recoveryPreview.mockResolvedValue(result);
  const response = await app.inject({ method: 'POST', url, headers: allowed, payload: { sourceChoice } });
  expect(response.statusCode).toBe(200); expect(response.json().data).toEqual(result);
  expect(service.recoveryPreview).toHaveBeenCalledExactlyOnceWith(batchId, sourceChoice, undefined);
  expect((await app.inject({ method: 'POST', url, headers: allowed, payload: { sourceChoice: 'overwrite' } })).statusCode).toBe(400);
  expect(service.recoveryPreview).toHaveBeenCalledOnce();
});

it('waits for ingestion to finish before releasing its external resources', async () => {
  const service = stub(), order: string[] = [];
  let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
  service.close.mockImplementation(async () => { order.push('ingestion-closing'); await pending; order.push('ingestion-finished'); });
  const app = buildServer({ ingestionService: service, onClose: () => { order.push('native-and-database'); } });
  await app.ready(); const closing = app.close();
  await vi.waitFor(() => expect(order).toEqual(['ingestion-closing']));
  release(); await closing;
  expect(order).toEqual(['ingestion-closing', 'ingestion-finished', 'native-and-database']);
});

it('passes only validated explicit alternative knowledge paths into recovery', async () => {
  const { app, service } = server(), allowed = await auth(app);
  const newTargets = { '02知识库/09学习/旧知识.md': '02知识库/09学习/新知识.md' };
  const url = `/api/v1/ingestion/batches/${batchId}/recovery-preview`;
  expect((await app.inject({ method: 'POST', url, headers: allowed, payload: { newTargets } })).statusCode).toBe(200);
  expect(service.recoveryPreview).toHaveBeenCalledExactlyOnceWith(batchId, undefined, newTargets);
  expect((await app.inject({ method: 'POST', url, headers: allowed, payload: { newTargets: { x: 123 } } })).statusCode).toBe(400);
  expect(service.recoveryPreview).toHaveBeenCalledOnce();
});
