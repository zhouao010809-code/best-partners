import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PublicApiError } from '../../../shared/api/errors.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { connectionIdSchema, autoloopConnectionsResponseSchema, autoloopConnectionSaveInputSchema, autoloopConnectionSaveResponseSchema, autoloopConnectionProbeResponseSchema, autoloopLifecycleInputSchema, autoloopLifecycleResponseSchema, type AutoloopConnectionsService } from '../../../shared/api/autoloop-connections.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

export function registerAutoloopConnectionsRoutes(app: FastifyInstance, service?: AutoloopConnectionsService) {
  const required = () => { if (!service) throw new PublicApiError('AUTOLOOP_UNAVAILABLE', '自动任务连接管理暂时不可用。', 503); return service; };
  const id = (params: unknown) => parseApiInput(z.strictObject({ id: connectionIdSchema }), params).id;
  app.get('/api/v1/autoloop/connections', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return parseApiOutput(autoloopConnectionsResponseSchema, { version: API_VERSION, data: await required().list() });
  });
  app.post('/api/v1/autoloop/connections/:id/save', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return parseApiOutput(autoloopConnectionSaveResponseSchema, { version: API_VERSION, data: await required().save(id(request.params), parseApiInput(autoloopConnectionSaveInputSchema, request.body)) });
  });
  app.post('/api/v1/autoloop/connections/:id/probe', async (request, reply) => {
    reply.header('cache-control', 'no-store'); parseApiInput(z.strictObject({}), request.body);
    return parseApiOutput(autoloopConnectionProbeResponseSchema, { version: API_VERSION, data: await required().probe(id(request.params)) });
  });
  app.post('/api/v1/autoloop/lifecycle', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return parseApiOutput(autoloopLifecycleResponseSchema, { version: API_VERSION, data: await required().lifecycle(parseApiInput(autoloopLifecycleInputSchema, request.body).action) });
  });
}
