import type { FastifyInstance } from 'fastify';
import {
  skillEmptyQuerySchema,
  skillFolderCreateRequestSchema,
  skillFolderResponseSchema,
  skillIdParamsSchema,
  skillMoveRequestSchema,
  skillMoveResponseSchema,
  skillResponseSchema,
  skillsResponseSchema
} from '../../../shared/api/skills.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import type { SkillCatalogService } from '../../services/skill-catalog.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

export function registerSkillRoutes(app: FastifyInstance, service?: SkillCatalogService): void {
  const required = (): SkillCatalogService => {
    if (service === undefined) throw new PublicApiError('SKILL_CATALOG_UNAVAILABLE', 'Skill catalog is unavailable.', 503);
    return service;
  };

  app.get('/api/v1/skills', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    parseApiInput(skillEmptyQuerySchema, request.query);
    return parseApiOutput(skillsResponseSchema, { data: await required().list(), version: API_VERSION });
  });

  app.get('/api/v1/skills/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(skillIdParamsSchema, request.params);
    return parseApiOutput(skillResponseSchema, { data: await required().get(id), version: API_VERSION });
  });

  app.post('/api/v1/skills/folders', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const body = parseApiInput(skillFolderCreateRequestSchema, request.body);
    return parseApiOutput(skillFolderResponseSchema, {
      data: await required().createFolder(body.name),
      version: API_VERSION
    });
  });

  app.post('/api/v1/skills/:id/move', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(skillIdParamsSchema, request.params);
    const body = parseApiInput(skillMoveRequestSchema, request.body);
    return parseApiOutput(skillMoveResponseSchema, {
      data: await required().move(id, body.folderId),
      version: API_VERSION
    });
  });
}
