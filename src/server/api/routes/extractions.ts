import type { FastifyInstance } from 'fastify';
import { PublicApiError } from '../../../shared/api/errors.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { deepSeekKeyRequestSchema, deepSeekSettingsResponseSchema, extractionEmptyBodySchema, extractionIdSchema,
  extractionListResponseSchema, extractionPreviewRequestSchema, extractionPreviewResponseSchema, extractionQuerySchema,
  extractionRunResponseSchema, extractionTokenSchema } from '../../../shared/api/extraction.js';
import type { ExtractionService } from '../../services/extraction-service.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';
import { extractionHistoryQuerySchema, extractionHistoryResponseSchema, extractionQueueQuerySchema, extractionQueueVisibilityRequestSchema,
  extractionQueueResponseSchema, extractionQueueSourceQuerySchema, extractionQueueSourceResponseSchema } from '../../../shared/api/extraction-queue.js';
import type { IndexState } from '../../index/index-state.js';

export function registerExtractionRoutes(app: FastifyInstance, service?: ExtractionService, indexState?: () => IndexState | undefined): void {
  function required(): ExtractionService {
    if (!service) throw new PublicApiError('EXTRACTION_UNAVAILABLE', '请使用个人桌面 App 安全配置模型并提炼资料。', 503);
    return service;
  }
  function requireReadyIndex(): void {
    const state = indexState?.();
    if (state?.status !== 'ready') throw new PublicApiError(state ? `INDEX_${state.status.toUpperCase()}` : 'READ_API_UNAVAILABLE', '资料索引暂未就绪，请稍后刷新。', 503);
  }
  app.get('/api/v1/extraction-queue', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const extraction = required();
    const query = parseApiInput(extractionQueueQuerySchema, request.query);
    requireReadyIndex();
    return parseApiOutput(extractionQueueResponseSchema, { version: API_VERSION, data: extraction.queue(query) });
  });
  app.get('/api/v1/extraction-queue/source', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const extraction = required();
    const { materialPath } = parseApiInput(extractionQueueSourceQuerySchema, request.query);
    requireReadyIndex();
    return parseApiOutput(extractionQueueSourceResponseSchema, { version: API_VERSION, data: extraction.source(materialPath) });
  });
  app.get('/api/v1/extraction-history', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const extraction = required();
    const query = parseApiInput(extractionHistoryQuerySchema, request.query);
    return parseApiOutput(extractionHistoryResponseSchema, { version: API_VERSION, data: extraction.history(query) });
  });
  app.post('/api/v1/extraction-queue/visibility', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const extraction = required();
    const { materialPath, removed } = parseApiInput(extractionQueueVisibilityRequestSchema, request.body);
    requireReadyIndex();
    return parseApiOutput(extractionQueueSourceResponseSchema, { version: API_VERSION, data: extraction.setVisibility(materialPath, removed) });
  });
  app.get('/api/v1/deepseek', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return parseApiOutput(deepSeekSettingsResponseSchema, { version: API_VERSION, data: service?.settings() ?? {
      available: false, configured: false, providerHost: 'api.deepseek.com', model: 'deepseek-v4-pro', problem: '请使用个人桌面 App 安全配置模型密钥。'
    } });
  });
  app.post('/api/v1/deepseek/key', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { apiKey } = parseApiInput(deepSeekKeyRequestSchema, request.body);
    return parseApiOutput(deepSeekSettingsResponseSchema, { version: API_VERSION, data: required().setKey(apiKey) });
  });
  app.post('/api/v1/deepseek/clear', async (request, reply) => {
    reply.header('cache-control', 'no-store'); parseApiInput(extractionEmptyBodySchema, request.body);
    return parseApiOutput(deepSeekSettingsResponseSchema, { version: API_VERSION, data: required().clearKey() });
  });
  app.post('/api/v1/deepseek/verify', async (request, reply) => {
    reply.header('cache-control', 'no-store'); parseApiInput(extractionEmptyBodySchema, request.body);
    return parseApiOutput(deepSeekSettingsResponseSchema, { version: API_VERSION, data: await required().verifyConnection() });
  });
  app.get('/api/v1/extractions', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { materialPath } = parseApiInput(extractionQuerySchema, request.query);
    return parseApiOutput(extractionListResponseSchema, { version: API_VERSION, data: service?.list(materialPath) ?? { items: [] } });
  });
  app.get('/api/v1/extractions/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store'); const { id } = parseApiInput(extractionIdSchema, request.params);
    return parseApiOutput(extractionRunResponseSchema, { version: API_VERSION, data: required().get(id) });
  });
  app.post('/api/v1/extractions/preview', async (request, reply) => {
    reply.header('cache-control', 'no-store'); const body = parseApiInput(extractionPreviewRequestSchema, request.body);
    return parseApiOutput(extractionPreviewResponseSchema, { version: API_VERSION, data: await required().preview(body) });
  });
  app.post('/api/v1/extractions/start', async (request, reply) => {
    reply.header('cache-control', 'no-store'); const { token } = parseApiInput(extractionTokenSchema, request.body);
    return parseApiOutput(extractionRunResponseSchema, { version: API_VERSION, data: await required().start(token) });
  });
  app.post('/api/v1/extractions/:id/cancel', async (request, reply) => {
    reply.header('cache-control', 'no-store'); parseApiInput(extractionEmptyBodySchema, request.body);
    const { id } = parseApiInput(extractionIdSchema, request.params);
    return parseApiOutput(extractionRunResponseSchema, { version: API_VERSION, data: required().cancel(id) });
  });
}
