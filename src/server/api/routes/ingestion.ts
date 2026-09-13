import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PublicApiError } from '../../../shared/api/errors.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { ingestionBatchResponseSchema, ingestionIdRequestSchema, ingestionMatchQuerySchema, ingestionMatchesResponseSchema,
  ingestionPreviewRequestSchema, ingestionPreviewResponseSchema, ingestionRecoveryPreviewResponseSchema, ingestionRecoveryRequestSchema,
  ingestionReviewResponseSchema, reviewCandidateResponseSchema, saveCandidateRequestSchema } from '../../../shared/api/ingestion.js';
import type { IngestionService } from '../../ingestion/ingestion-service.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

const empty = z.strictObject({});

export function registerIngestionRoutes(app: FastifyInstance, service?: IngestionService): void {
  function required(): IngestionService {
    if (!service) throw new PublicApiError('INGESTION_UNAVAILABLE', '当前连接不具备知识入库权限，请使用个人桌面 App。', 503);
    return service;
  }
  app.get('/api/v1/ingestion/reviews/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(ingestionIdRequestSchema, request.params); parseApiInput(empty, request.query);
    return parseApiOutput(ingestionReviewResponseSchema, { version: API_VERSION, data: await required().review(id) });
  });
  app.post('/api/v1/ingestion/reviews/:id/candidates', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(ingestionIdRequestSchema, request.params);
    const body = parseApiInput(saveCandidateRequestSchema, request.body);
    return parseApiOutput(reviewCandidateResponseSchema, { version: API_VERSION, data: required().save(id, body) });
  });
  app.get('/api/v1/ingestion/reviews/:id/matches', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(ingestionIdRequestSchema, request.params);
    const { candidateId, search } = parseApiInput(ingestionMatchQuerySchema, request.query);
    return parseApiOutput(ingestionMatchesResponseSchema, { version: API_VERSION, data: await required().matches(id, candidateId, search) });
  });
  app.post('/api/v1/ingestion/previews', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const body = parseApiInput(ingestionPreviewRequestSchema, request.body);
    return parseApiOutput(ingestionPreviewResponseSchema, { version: API_VERSION, data: await required().preview(body) });
  });
  app.post('/api/v1/ingestion/commit', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(ingestionIdRequestSchema, request.body);
    return parseApiOutput(ingestionBatchResponseSchema, { version: API_VERSION, data: await required().commit(id) });
  });
  app.get('/api/v1/ingestion/batches/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(ingestionIdRequestSchema, request.params); parseApiInput(empty, request.query);
    return parseApiOutput(ingestionBatchResponseSchema, { version: API_VERSION, data: required().batch(id) });
  });
  app.post('/api/v1/ingestion/batches/:id/resume', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(ingestionIdRequestSchema, request.params); parseApiInput(empty, request.body);
    return parseApiOutput(ingestionBatchResponseSchema, { version: API_VERSION, data: await required().resume(id) });
  });
  app.post('/api/v1/ingestion/batches/:id/recovery-preview', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(ingestionIdRequestSchema, request.params);
    const { sourceChoice, newTargets } = parseApiInput(ingestionRecoveryRequestSchema, request.body);
    return parseApiOutput(ingestionRecoveryPreviewResponseSchema, { version: API_VERSION, data: await required().recoveryPreview(id, sourceChoice, newTargets) });
  });
  app.post('/api/v1/ingestion/resolve', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(ingestionIdRequestSchema, request.body);
    return parseApiOutput(ingestionBatchResponseSchema, { version: API_VERSION, data: await required().resolve(id) });
  });
}
