import type { FastifyInstance } from 'fastify';
import type { AssistantAdapter } from '../../assistant/types.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import { workdiskSearchRequestSchema, workdiskSearchResponseSchema, type WorkdiskSearchResponse } from '../../../shared/api/workdisk-search.js';
import { createWorkdiskSearchPlanner } from '../../workdisk/search-assistant.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

export function registerWorkdiskSearchRoutes(app: FastifyInstance, adapter?: AssistantAdapter): void {
  const planner = createWorkdiskSearchPlanner(adapter ? { adapter } : {});
  const shutdown = new AbortController();
  const pending = new Set<Promise<WorkdiskSearchResponse>>();
  app.addHook('preClose', async () => { shutdown.abort(); await Promise.allSettled(pending); });
  app.post('/api/v1/workdisk/search-plan', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const input = parseApiInput(workdiskSearchRequestSchema, request.body);
    if (pending.size >= 4) throw new PublicApiError('WORKDISK_SEARCH_BUSY', '正在理解其他查找请求，请稍后再试。', 429);
    const disconnected = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) disconnected.abort(); };
    reply.raw.on('close', onClose);
    const operation = planner(input, AbortSignal.any([shutdown.signal, disconnected.signal]));
    pending.add(operation);
    try {
      return parseApiOutput(workdiskSearchResponseSchema, { version: API_VERSION, data: await operation });
    } finally { pending.delete(operation); reply.raw.off('close', onClose); }
  });
}
