import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PublicApiError } from '../../../shared/api/errors.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { learningNoteListResponseSchema, learningNoteQuerySchema, learningNoteResponseSchema, learningNoteSaveSchema } from '../../../shared/api/learning-notes.js';
import type { LearningNotesService } from '../../learning/notes-service.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

export function registerLearningNotesRoutes(app: FastifyInstance, service?: LearningNotesService): void {
  const required = () => { if (!service) throw new PublicApiError('LEARNING_NOTES_UNAVAILABLE', '学习笔记暂时不可用，请检查当前大脑连接。', 503); return service; };
  app.get('/api/v1/learning-notes', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return parseApiOutput(learningNoteListResponseSchema, { version: API_VERSION, data: required().list(parseApiInput(learningNoteQuerySchema, request.query)) });
  });
  app.put('/api/v1/learning-notes/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(z.strictObject({ id: z.uuid() }), request.params);
    return parseApiOutput(learningNoteResponseSchema, { version: API_VERSION, data: required().save(id, parseApiInput(learningNoteSaveSchema, request.body)) });
  });
}
