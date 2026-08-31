import type { FastifyInstance } from 'fastify';
import {
  API_VERSION,
  indexJobParamsSchema,
  indexJobResponseSchema,
  indexJobSchema,
  rebuildBodySchema,
  rebuildHeadersSchema
} from '../../../shared/api/schemas.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import type { IndexJobService } from '../../services/index-job-service.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

export function registerIndexJobRoutes(app: FastifyInstance, service?: IndexJobService): void {
  app.post('/api/v1/index-jobs/rebuild', async (request, reply) => {
    if (service === undefined) {
      throw new PublicApiError('READ_API_UNAVAILABLE', 'Read API is unavailable', 503);
    }
    const body = parseApiInput(rebuildBodySchema, request.body);
    const headers = parseApiInput(rebuildHeadersSchema, request.headers);
    const created = service.createRebuild({
      expectedIndexVersion: body.indexVersion,
      idempotencyKey: headers['idempotency-key']
    });
    const job = created.created ? service.start(created.job.id) : created.job;
    const data = parseApiOutput(indexJobSchema, job);
    return reply.code(202).send(parseApiOutput(indexJobResponseSchema, {
      data,
      version: API_VERSION,
      operationId: data.operationId
    }));
  });

  app.get('/api/v1/index-jobs/:id', async (request) => {
    if (service === undefined) {
      throw new PublicApiError('READ_API_UNAVAILABLE', 'Read API is unavailable', 503);
    }
    const params = parseApiInput(indexJobParamsSchema, request.params);
    const job = service.get(params.id);
    if (job === undefined) {
      throw new PublicApiError('INDEX_JOB_NOT_FOUND', 'Index job was not found', 404);
    }
    const data = parseApiOutput(indexJobSchema, job);
    return parseApiOutput(indexJobResponseSchema, { data, version: API_VERSION });
  });
}
