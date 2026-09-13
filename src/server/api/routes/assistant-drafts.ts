import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PublicApiError } from '../../../shared/api/errors.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { assistantDraftDeleteResponseSchema, assistantDraftListResponseSchema, assistantDraftResponseSchema, assistantDraftSaveSchema } from '../../../shared/api/assistant-drafts.js';
import type { AssistantDraftService } from '../../assistant/draft-service.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

export function registerAssistantDraftRoutes(app: FastifyInstance, options: { assistantDrafts?: AssistantDraftService | undefined }) {
  const required = () => { if (!options.assistantDrafts) throw new PublicApiError('ASSISTANT_DRAFTS_UNAVAILABLE', '草稿保存暂时不可用，请检查大脑连接。', 503); return options.assistantDrafts; };
  const idSchema = z.strictObject({ id: z.uuid() });
  app.get('/api/v1/assistant/drafts', async (_request, reply) => { reply.header('cache-control', 'no-store'); return parseApiOutput(assistantDraftListResponseSchema, { version: API_VERSION, data: required().list() }); });
  app.put('/api/v1/assistant/drafts/:id', async (request, reply) => { reply.header('cache-control', 'no-store'); const { id } = parseApiInput(idSchema, request.params); return parseApiOutput(assistantDraftResponseSchema, { version: API_VERSION, data: required().save(id, parseApiInput(assistantDraftSaveSchema, request.body)) }); });
  app.delete('/api/v1/assistant/drafts/:id', async (request, reply) => { reply.header('cache-control', 'no-store'); const { id } = parseApiInput(idSchema, request.params); const { revision } = parseApiInput(z.strictObject({ revision: z.coerce.number().int().nonnegative() }), request.query); return parseApiOutput(assistantDraftDeleteResponseSchema, { version: API_VERSION, data: required().delete(id, revision) }); });
}
