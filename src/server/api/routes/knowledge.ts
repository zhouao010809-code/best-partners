import type { FastifyInstance } from 'fastify';
import {
  API_VERSION,
  knowledgeFileQuerySchema,
  knowledgeOpenBodySchema,
  knowledgePageResponseSchema,
  knowledgePageSchema,
  knowledgeQuerySchema,
  liveKnowledgeDetailResponseSchema,
  liveKnowledgeDetailSchema,
  openKnowledgeResponseSchema,
  openKnowledgeResultSchema
} from '../../../shared/api/schemas.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import type { ReadService } from '../../services/read-service.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  input: { service?: ReadService; operationId: () => string }
): void {
  app.get('/api/v1/knowledge', async (request) => {
    if (input.service === undefined) {
      throw new PublicApiError('READ_API_UNAVAILABLE', 'Read API is unavailable', 503);
    }
    const query = parseApiInput(knowledgeQuerySchema, request.query);
    const data = parseApiOutput(knowledgePageSchema, input.service.listKnowledge(query));
    return parseApiOutput(knowledgePageResponseSchema, { data, version: API_VERSION });
  });

  app.get('/api/v1/knowledge/file', async (request) => {
    if (input.service === undefined) {
      throw new PublicApiError('READ_API_UNAVAILABLE', 'Read API is unavailable', 503);
    }
    const query = parseApiInput(knowledgeFileQuerySchema, request.query);
    const data = parseApiOutput(
      liveKnowledgeDetailSchema,
      await input.service.getKnowledgeDetail(query.path)
    );
    return parseApiOutput(liveKnowledgeDetailResponseSchema, { data, version: API_VERSION });
  });

  app.post('/api/v1/knowledge/open', async (request) => {
    if (input.service === undefined) {
      throw new PublicApiError('READ_API_UNAVAILABLE', 'Read API is unavailable', 503);
    }
    const body = parseApiInput(knowledgeOpenBodySchema, request.body);
    const data = parseApiOutput(
      openKnowledgeResultSchema,
      await input.service.openKnowledge(body.path)
    );
    const operationId = input.operationId();
    return parseApiOutput(openKnowledgeResponseSchema, {
      data,
      version: API_VERSION,
      operationId
    });
  });
}
