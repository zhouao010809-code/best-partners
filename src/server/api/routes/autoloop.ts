import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PublicApiError } from '../../../shared/api/errors.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import {
  autoloopChoicesResponseSchema, autoloopActionResponseSchema, autoloopAnswerInputSchema, autoloopCreateInputSchema,
  autoloopCreateResponseSchema, autoloopIdSchema, autoloopTaskDetailResponseSchema,
  autoloopTaskListResponseSchema, type AutoloopService
} from '../../../shared/api/autoloop.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

export function registerAutoloopRoutes(app: FastifyInstance, service?: AutoloopService) {
  function required() {
    if (!service) throw new PublicApiError('AUTOLOOP_UNAVAILABLE', '自动任务暂时不可用，请先连接个人大脑。', 503);
    return service;
  }
  app.get('/api/v1/autoloop/choices', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return parseApiOutput(autoloopChoicesResponseSchema, { version: API_VERSION, data: await required().choices() });
  });
  app.get('/api/v1/autoloop/tasks', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return parseApiOutput(autoloopTaskListResponseSchema, { version: API_VERSION, data: await required().list() });
  });
  app.post('/api/v1/autoloop/tasks', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return parseApiOutput(autoloopCreateResponseSchema, { version: API_VERSION, data: await required().create(parseApiInput(autoloopCreateInputSchema, request.body)) });
  });
  app.get('/api/v1/autoloop/tasks/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(autoloopIdSchema, request.params);
    return parseApiOutput(autoloopTaskDetailResponseSchema, { version: API_VERSION, data: await required().detail(id) });
  });
  app.post('/api/v1/autoloop/tasks/:id/answer', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(autoloopIdSchema, request.params);
    return parseApiOutput(autoloopActionResponseSchema, { version: API_VERSION, data: await required().answer(id, parseApiInput(autoloopAnswerInputSchema, request.body)) });
  });
  app.post('/api/v1/autoloop/tasks/:id/cancel', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(autoloopIdSchema, request.params);
    parseApiInput(z.strictObject({}), request.body);
    return parseApiOutput(autoloopActionResponseSchema, { version: API_VERSION, data: await required().cancel(id) });
  });
}
