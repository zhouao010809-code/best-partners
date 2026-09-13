import type { FastifyInstance } from 'fastify';
import {
  API_VERSION, documentIssueQuerySchema, documentIssuePageSchema,
  documentIssuePageResponseSchema, knowledgeFileQuerySchema,
  liveDocumentDetailSchema, liveDocumentDetailResponseSchema
} from '../../../shared/api/schemas.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import type { ReadService } from '../../services/read-service.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

export function registerDocumentRoutes(app: FastifyInstance, service?: ReadService): void {
  app.get('/api/v1/documents/issues', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (service === undefined) throw new PublicApiError('READ_API_UNAVAILABLE', 'Read API is unavailable', 503);
    const query = parseApiInput(documentIssueQuerySchema, request.query);
    const data = parseApiOutput(documentIssuePageSchema, service.listDocumentIssues(query));
    return parseApiOutput(documentIssuePageResponseSchema, { data, version: API_VERSION });
  });

  app.get('/api/v1/documents/file', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (service === undefined) throw new PublicApiError('READ_API_UNAVAILABLE', 'Read API is unavailable', 503);
    const query = parseApiInput(knowledgeFileQuerySchema, request.query);
    const data = parseApiOutput(liveDocumentDetailSchema, await service.getDocumentDetail(query.path));
    return parseApiOutput(liveDocumentDetailResponseSchema, { data, version: API_VERSION });
  });
}
