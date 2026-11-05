import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PublicApiError } from '../../../shared/api/errors.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { autoloopConfigurationInputSchema, autoloopConfigurationSchema, autoloopGlobalStateSchema, autoloopTraceSchema, autoloopSavedSchema, autoloopEventInputSchema, autoloopEventResultSchema, autoloopManageAnswerSchema, autoloopResolveSchema, autoloopTemplateSchema, autoloopTemplatesSchema, autoloopManagementResponse, type AutoloopManagementService } from '../../../shared/api/autoloop-management.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';
const idSchema = z.strictObject({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const actionSchema = z.strictObject({ ok: z.literal(true) });
const empty = z.strictObject({});
export function registerAutoloopManagementRoutes(app: FastifyInstance, service?: AutoloopManagementService) {
  const prefix = '/api/v1/autoloop/manage';
  const required = () => { if (!service) throw new PublicApiError('AUTOLOOP_UNAVAILABLE', '自动任务管理暂时不可用，请先连接个人大脑。', 503); return service; };
  const output = <T extends z.ZodType>(schema: T, data: unknown) => parseApiOutput(autoloopManagementResponse(schema), { version: API_VERSION, data });
  app.get(prefix + '/state', async (request, reply) => { reply.header('cache-control', 'no-store'); const query = parseApiInput(z.strictObject({ before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }), request.query); return output(autoloopGlobalStateSchema, await required().state(query.before)); });
  app.get(prefix + '/configuration', async (_request, reply) => { reply.header('cache-control', 'no-store'); return output(autoloopConfigurationSchema, await required().configuration()); });
  app.post(prefix + '/configuration', async (request, reply) => { reply.header('cache-control', 'no-store'); return output(autoloopSavedSchema, await required().save(parseApiInput(autoloopConfigurationInputSchema, request.body))); });
  app.get(prefix + '/runs/:id/trace', async (request, reply) => { reply.header('cache-control', 'no-store'); const { id } = parseApiInput(idSchema, request.params); return output(autoloopTraceSchema, await required().trace(id)); });
  app.post(prefix + '/runs/:id/cancel', async (request, reply) => { reply.header('cache-control', 'no-store'); const { id } = parseApiInput(idSchema, request.params); parseApiInput(empty, request.body); return output(actionSchema, await required().cancel(id)); });
  app.post(prefix + '/cards/:id/answer', async (request, reply) => { reply.header('cache-control', 'no-store'); const { id } = parseApiInput(idSchema, request.params); return output(actionSchema, await required().answer(id, parseApiInput(autoloopManageAnswerSchema, request.body))); });
  app.post(prefix + '/cards/:id/resolve', async (request, reply) => { reply.header('cache-control', 'no-store'); const { id } = parseApiInput(idSchema, request.params); const { reason } = parseApiInput(autoloopResolveSchema, request.body); return output(actionSchema, await required().resolve(id, reason)); });
  app.post(prefix + '/events', async (request, reply) => { reply.header('cache-control', 'no-store'); return output(autoloopEventResultSchema, await required().event(parseApiInput(autoloopEventInputSchema, request.body))); });
  app.post(prefix + '/rules/:name/trigger', async (request, reply) => { reply.header('cache-control', 'no-store'); const { name } = parseApiInput(z.strictObject({ name: z.string().min(1).max(300) }), request.params); const { id } = parseApiInput(z.strictObject({ id: z.string().min(1).max(100) }), request.body); return output(autoloopEventResultSchema, await required().trigger(name, id)); });
  app.get(prefix + '/templates', async (_request, reply) => { reply.header('cache-control', 'no-store'); return output(autoloopTemplatesSchema, await required().templates()); });
  app.post(prefix + '/templates/:id/prepare', async (request, reply) => { reply.header('cache-control', 'no-store'); const { id } = parseApiInput(z.strictObject({ id: z.string().regex(/^[a-z-]+$/u) }), request.params); parseApiInput(empty, request.body); return output(autoloopTemplateSchema, await required().prepareTemplate(id)); });
  app.get(prefix + '/templates/:id', async (request, reply) => { reply.header('cache-control', 'no-store'); const { id } = parseApiInput(z.strictObject({ id: z.string().regex(/^[a-z-]+$/u) }), request.params); return output(autoloopTemplateSchema, await required().template(id)); });
}
