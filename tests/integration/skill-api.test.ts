import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import type { SkillCatalogService } from '../../src/server/services/skill-catalog.js';
import type { SkillDetail, SkillSummary } from '../../src/shared/api/skills.js';
import { PublicApiError } from '../../src/shared/api/errors.js';

const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
const summary: SkillSummary = { id: 'a'.repeat(64), name: 'Writer', description: 'Drafts copy', revision: 'b'.repeat(64) };
const detail: SkillDetail = { ...summary, markdown: '# Writer\n', references: ['REFERENCE.md'] };
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

function fixture(catalog: Partial<SkillCatalogService> = {}): { app: ReturnType<typeof buildServer>; service: SkillCatalogService } {
  const service: SkillCatalogService = {
    list: vi.fn(async () => [summary]),
    get: vi.fn(async () => detail),
    ...catalog
  };
  const app = buildServer({ skillCatalog: service });
  servers.push(app);
  return { app, service };
}

it('serves strict list and detail envelopes without exposing filesystem paths', async () => {
  const { app, service } = fixture();
  const list = await app.inject({ url: '/api/v1/skills', headers });
  expect(list.statusCode).toBe(200);
  expect(list.headers['cache-control']).toBe('no-store');
  expect(list.json()).toEqual({ version: 1, data: { items: [summary] } });
  const detailResponse = await app.inject({ url: `/api/v1/skills/${summary.id}`, headers });
  expect(detailResponse.statusCode).toBe(200);
  expect(detailResponse.headers['cache-control']).toBe('no-store');
  expect(detailResponse.json()).toEqual({ version: 1, data: detail });
  expect(service.list).toHaveBeenCalledOnce();
  expect(service.get).toHaveBeenCalledWith(summary.id);
});

it('rejects malformed and unknown ids before reaching the catalog', async () => {
  const { app, service } = fixture({ get: vi.fn(async () => { throw new PublicApiError('SKILL_NOT_FOUND', 'Skill was not found.', 404); }) });
  const malformed = await app.inject({ url: '/api/v1/skills/not-an-id', headers });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.json().error.code).toBe('VALIDATION_ERROR');
  expect(service.get).not.toHaveBeenCalled();

  const unknown = await app.inject({ url: `/api/v1/skills/${'c'.repeat(64)}`, headers });
  expect(unknown.statusCode).toBe(404);
});

it('returns a typed 503 when no local catalog is configured', async () => {
  const app = buildServer();
  servers.push(app);
  const list = await app.inject({ url: '/api/v1/skills', headers });
  expect(list.statusCode).toBe(503);
  expect(list.json().error.code).toBe('SKILL_CATALOG_UNAVAILABLE');
  expect((await app.inject({ url: `/api/v1/skills/${summary.id}`, headers })).statusCode).toBe(503);
});
