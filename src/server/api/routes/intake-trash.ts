import type { FastifyInstance } from 'fastify';
import { PublicApiError } from '../../../shared/api/errors.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { intakeTrashEmptySchema, intakeTrashEntryResponseSchema, intakeTrashIdRequestSchema,
  intakeTrashListResponseSchema, intakeTrashNameRequestSchema, intakeTrashPreviewResponseSchema } from '../../../shared/api/intake-trash.js';
import { intakeTrashDeletePreviewResponseSchema, intakeTrashDeleteRequestSchema } from '../../../shared/api/intake-trash.js';
import type { IntakeTrashService } from '../../trash/intake-trash-service.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

export function registerIntakeTrashRoutes(app: FastifyInstance, service?: IntakeTrashService) {
  function required() {
    if (!service) throw new PublicApiError('INTAKE_TRASH_UNAVAILABLE', '收件箱回收站暂不可用，请重新打开新版个人 App。', 503);
    return service;
  }
  app.get('/api/v1/intake-trash', async (request, reply) => {
    reply.header('cache-control', 'no-store'); parseApiInput(intakeTrashEmptySchema, request.query);
    return parseApiOutput(intakeTrashListResponseSchema, { version: API_VERSION, data: required().list() });
  });
  app.get('/api/v1/intake-trash/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store'); parseApiInput(intakeTrashEmptySchema, request.query);
    const { id } = parseApiInput(intakeTrashIdRequestSchema, request.params);
    return parseApiOutput(intakeTrashEntryResponseSchema, { version: API_VERSION, data: required().get(id) });
  });
  app.post('/api/v1/intake-trash/preview', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { name } = parseApiInput(intakeTrashNameRequestSchema, request.body);
    return parseApiOutput(intakeTrashPreviewResponseSchema, { version: API_VERSION, data: await required().preview(name) });
  });
  app.post('/api/v1/intake-trash/:id/delete-preview', async (request, reply) => {
    reply.header('cache-control', 'no-store'); parseApiInput(intakeTrashEmptySchema, request.body);
    const { id } = parseApiInput(intakeTrashIdRequestSchema, request.params), handler = required().previewDelete;
    if (!handler) throw new PublicApiError('INTAKE_TRASH_UNAVAILABLE', '当前版本暂不支持整包彻底删除，请重新打开新版个人 App。', 503);
    return parseApiOutput(intakeTrashDeletePreviewResponseSchema, { version: API_VERSION, data: await handler(id) });
  });
  app.post('/api/v1/intake-trash/:id/delete', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(intakeTrashIdRequestSchema, request.params);
    const { token } = parseApiInput(intakeTrashDeleteRequestSchema, request.body), handler = required().delete;
    if (!handler) throw new PublicApiError('INTAKE_TRASH_UNAVAILABLE', '当前版本暂不支持整包彻底删除，请重新打开新版个人 App。', 503);
    return parseApiOutput(intakeTrashEntryResponseSchema, { version: API_VERSION, data: await handler(id, token) });
  });
  for (const action of ['commit', 'restore', 'retry'] as const) {
    app.post(`/api/v1/intake-trash/:id/${action}`, async (request, reply) => {
      reply.header('cache-control', 'no-store'); parseApiInput(intakeTrashEmptySchema, request.body);
      const { id } = parseApiInput(intakeTrashIdRequestSchema, request.params);
      return parseApiOutput(intakeTrashEntryResponseSchema, { version: API_VERSION, data: await required()[action](id) });
    });
  }
}
