import type { FastifyInstance } from 'fastify';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import { intakeListResponseSchema, intakeOutcomeResponseSchema, intakePreviewRequestSchema,
  intakePreviewResponseSchema, intakeResumeSchema, intakeTokenSchema } from '../../../shared/api/intake.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';
import type { IntakeService } from '../../services/intake-service.js';

export function registerIntakeRoutes(app: FastifyInstance, service?: IntakeService): void {
  function required(): IntakeService {
    if (!service) throw new PublicApiError('RECOVERY_REQUIRED', '请从个人桌面 App 打开收件箱。当前连接不具备归档权限。', 503);
    return service;
  }
  app.get('/api/v1/intake', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const data = service ? await service.list() : { available: false, automaticArchive: false, items: [], operations: [],
      problem: '当前连接仅支持读取。请使用新版个人桌面 App 的收件箱。' };
    return parseApiOutput(intakeListResponseSchema, { data, version: API_VERSION });
  });
  app.post('/api/v1/intake/preview', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return parseApiOutput(intakePreviewResponseSchema, { data: await required().preview(parseApiInput(intakePreviewRequestSchema, request.body)), version: API_VERSION });
  });
  app.post('/api/v1/intake/commit', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return parseApiOutput(intakeOutcomeResponseSchema, { data: await required().commit(parseApiInput(intakeTokenSchema, request.body).token), version: API_VERSION });
  });
  app.post('/api/v1/intake/resume', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return parseApiOutput(intakeOutcomeResponseSchema, { data: await required().resume(parseApiInput(intakeResumeSchema, request.body).id), version: API_VERSION });
  });
}
