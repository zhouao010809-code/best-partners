import type { FastifyInstance } from 'fastify';
import { discussionHistoryDetailResponseSchema, discussionHistoryQuerySchema, discussionHistoryResponseSchema, discussionActionSchema, discussionListResponseSchema, discussionResponseSchema, type DiscussionService } from '../../../shared/api/discussion.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

export function registerDiscussionRoutes(app: FastifyInstance, service?: DiscussionService): void {
  function requireService(): DiscussionService {
    if (!service) throw new PublicApiError('DISCUSSION_UNAVAILABLE', '请在个人桌面应用连接新版小兆大脑后打开探讨。', 503);
    return service;
  }
  app.get('/api/v1/discussions', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return parseApiOutput(discussionListResponseSchema, { version: API_VERSION, data: await requireService().list() });
  });
  app.get('/api/v1/discussions/history', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return parseApiOutput(discussionHistoryResponseSchema, { version: API_VERSION, data: await requireService().history() });
  });
  app.get('/api/v1/discussions/history/note', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { path } = parseApiInput(discussionHistoryQuerySchema, request.query);
    return parseApiOutput(discussionHistoryDetailResponseSchema, { version: API_VERSION, data: await requireService().readHistory(path) });
  });
  app.post('/api/v1/discussions/actions', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const action = parseApiInput(discussionActionSchema, request.body);
    return parseApiOutput(discussionResponseSchema, { version: API_VERSION, data: await requireService().act(action) });
  });
}
