import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PublicApiError } from '../../../shared/api/errors.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { assistantProvidersResponseSchema, assistantConversationResponseSchema, assistantHistoryResponseSchema, assistantHistoryQuerySchema, assistantLoginResponseSchema, assistantIdSchema, assistantSendSchema } from '../../../shared/api/assistant.js';
import type { AssistantService } from '../../assistant/service.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

export function registerAssistantRoutes(app: FastifyInstance, service?: AssistantService) {
  function required() { if (!service) throw new PublicApiError('ASSISTANT_UNAVAILABLE', '问问暂时不可用，请检查大脑连接后重试。', 503); return service; }
  app.get('/api/v1/assistant/providers', async (_request, reply) => { reply.header('cache-control', 'no-store'); return parseApiOutput(assistantProvidersResponseSchema, { version: API_VERSION, data: await required().providers() }); });
  app.get('/api/v1/assistant/conversations', async (request, reply) => { reply.header('cache-control', 'no-store'); return parseApiOutput(assistantHistoryResponseSchema, { version: API_VERSION, data: required().list(parseApiInput(assistantHistoryQuerySchema, request.query)) }); });
  app.get('/api/v1/assistant/conversations/:id', async (request, reply) => { reply.header('cache-control', 'no-store'); const { id } = parseApiInput(assistantIdSchema, request.params); return parseApiOutput(assistantConversationResponseSchema, { version: API_VERSION, data: required().get(id) }); });
  app.post('/api/v1/assistant/messages', async (request, reply) => { reply.header('cache-control', 'no-store'); return parseApiOutput(assistantConversationResponseSchema, { version: API_VERSION, data: await required().send(parseApiInput(assistantSendSchema, request.body)) }); });
  app.post('/api/v1/assistant/conversations/:id/stop', async (request, reply) => { reply.header('cache-control', 'no-store'); const { id } = parseApiInput(assistantIdSchema, request.params); parseApiInput(z.strictObject({}), request.body); return parseApiOutput(assistantConversationResponseSchema, { version: API_VERSION, data: required().stop(id) }); });
  app.post('/api/v1/assistant/providers/:id/login', async (request, reply) => { reply.header('cache-control', 'no-store'); const { id } = parseApiInput(z.strictObject({ id: z.string().min(1).max(80) }), request.params); parseApiInput(z.strictObject({}), request.body); return parseApiOutput(assistantLoginResponseSchema, { version: API_VERSION, data: await required().login(id) }); });
}
