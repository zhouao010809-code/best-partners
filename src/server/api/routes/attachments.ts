import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ATTACHMENT_MAX_FILE_BYTES, attachmentArchiveRequestSchema, attachmentArchiveResponseSchema, attachmentListResponseSchema, attachmentPagesResponseSchema, attachmentResponseSchema, attachmentUploadQuerySchema } from '../../../shared/api/attachments.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import type { AttachmentService } from '../../attachments/service.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

const idSchema = z.strictObject({ id: z.uuid() });
const pagesQuerySchema = z.strictObject({ startPage: z.coerce.number().int().positive().optional(), endPage: z.coerce.number().int().positive().optional() });
const archiveBodySchema = attachmentArchiveRequestSchema.omit({ id: true });
export function registerAttachmentRoutes(app: FastifyInstance, service?: AttachmentService): void {
  function required(): AttachmentService { if (!service) throw new PublicApiError('ATTACHMENT_UNAVAILABLE', '本机文件暂存当前不可用，请重新打开桌面应用。', 503); return service; }
  // Encapsulating this parser leaves every existing JSON route's body limit intact.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: ATTACHMENT_MAX_FILE_BYTES }, (_request, body, done) => done(null, body));
    scope.addHook('onSend', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
    scope.get('/api/v1/assistant/attachments', async () => parseApiOutput(attachmentListResponseSchema, { version: API_VERSION, data: { attachments: required().list() } }));
    scope.post('/api/v1/assistant/attachments', { bodyLimit: ATTACHMENT_MAX_FILE_BYTES }, async (request) => {
      if (!Buffer.isBuffer(request.body)) throw new PublicApiError('ATTACHMENT_BODY_TYPE', '请以文件内容上传附件。', 415);
      const query = parseApiInput(attachmentUploadQuerySchema, request.query);
      return parseApiOutput(attachmentResponseSchema, { version: API_VERSION, data: { attachment: await required().upload({ ...query, bytes: request.body }) } });
    });
    scope.get('/api/v1/assistant/attachments/:id', async (request) => {
      const { id } = parseApiInput(idSchema, request.params);
      return parseApiOutput(attachmentResponseSchema, { version: API_VERSION, data: { attachment: required().get(id) } });
    });
    scope.get('/api/v1/assistant/attachments/:id/pages', async (request) => {
      const { id } = parseApiInput(idSchema, request.params), query = parseApiInput(pagesQuerySchema, request.query);
      return parseApiOutput(attachmentPagesResponseSchema, { version: API_VERSION, data: required().readPages({ id, ...(query.startPage !== undefined ? { startPage: query.startPage } : {}), ...(query.endPage !== undefined ? { endPage: query.endPage } : {}) }) });
    });
    scope.get('/api/v1/assistant/attachments/:id/content', async (request, reply) => {
      const { id } = parseApiInput(idSchema, request.params), original = required().readOriginal(id);
      return reply.type('application/octet-stream').header('x-content-type-options', 'nosniff')
        .header('content-disposition', `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(original.attachment.name).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`)
        .send(original.bytes);
    });
    scope.post('/api/v1/assistant/attachments/:id/retry', async (request) => {
      const { id } = parseApiInput(idSchema, request.params); parseApiInput(z.strictObject({}), request.body);
      return parseApiOutput(attachmentResponseSchema, { version: API_VERSION, data: { attachment: await required().retry(id) } });
    });
    scope.post('/api/v1/assistant/attachments/:id/cancel', async (request) => {
      const { id } = parseApiInput(idSchema, request.params); parseApiInput(z.strictObject({}), request.body);
      return parseApiOutput(attachmentResponseSchema, { version: API_VERSION, data: { attachment: required().cancel(id) } });
    });
    scope.post('/api/v1/assistant/attachments/:id/archive', async (request) => {
      const { id } = parseApiInput(idSchema, request.params), body = parseApiInput(archiveBodySchema, request.body);
      return parseApiOutput(attachmentArchiveResponseSchema, { version: API_VERSION, data: { result: await required().archive({ id, ...body }) } });
    });
  });
}
