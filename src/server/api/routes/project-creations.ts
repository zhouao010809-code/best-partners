import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PublicApiError } from '../../../shared/api/errors.js';
import { creativeProfileResponseSchema, creativeProfileSaveSchema } from '../../../shared/api/creative-profile.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import {
  creationCreateSchema, creationSaveSchema, creationSnapshotSchema,
  creationProjectParamsSchema, creationParamsSchema, creationVersionParamsSchema,
  creationGenerateRequestSchema, creationListResponseSchema, creationDetailResponseSchema,
  creationSuggestionResponseSchema, creationExportResponseSchema,
  type CreationGenerator, type ProjectCreationService
} from '../../../shared/api/project-creations.js';
import { parseApiOutput } from '../route-validation.js';

function required(service: ProjectCreationService | undefined): ProjectCreationService {
  if (!service) throw new PublicApiError('CREATIONS_UNAVAILABLE', '创作服务暂不可用，请重新打开应用。', 503);
  return service;
}
function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new PublicApiError('CREATION_INVALID', '请求内容或版本号无效，请检查后重试。', 400);
  return result.data;
}

export function registerProjectCreationRoutes(app: FastifyInstance, service?: ProjectCreationService, generate?: CreationGenerator): void {
  const profilePath = '/api/v1/projects/:projectId/creative-profile';
  app.get(profilePath, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { projectId } = parse(creationProjectParamsSchema, request.params);
    return parseApiOutput(creativeProfileResponseSchema, { data: await required(service).getProfile(projectId), version: API_VERSION });
  });
  app.put(profilePath, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { projectId } = parse(creationProjectParamsSchema, request.params);
    const input = parse(creativeProfileSaveSchema, request.body);
    return parseApiOutput(creativeProfileResponseSchema, { data: await required(service).saveProfile(projectId, input), version: API_VERSION });
  });
  const base = '/api/v1/projects/:projectId/creations';
  app.get(base, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { projectId } = parse(creationProjectParamsSchema, request.params);
    return parseApiOutput(creationListResponseSchema, { data: { items: await required(service).list(projectId) }, version: API_VERSION });
  });
  app.post(base, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { projectId } = parse(creationProjectParamsSchema, request.params);
    const input = parse(creationCreateSchema, request.body);
    return parseApiOutput(creationDetailResponseSchema, { data: await required(service).create(projectId, input), version: API_VERSION });
  });
  app.get(`${base}/:creationId`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { projectId, creationId } = parse(creationParamsSchema, request.params);
    return parseApiOutput(creationDetailResponseSchema, { data: await required(service).get(projectId, creationId), version: API_VERSION });
  });
  app.put(`${base}/:creationId`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { projectId, creationId } = parse(creationParamsSchema, request.params);
    const input = parse(creationSaveSchema, request.body);
    return parseApiOutput(creationDetailResponseSchema, { data: await required(service).save(projectId, creationId, input), version: API_VERSION });
  });
  app.post(`${base}/:creationId/versions`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { projectId, creationId } = parse(creationParamsSchema, request.params);
    const input = parse(creationSnapshotSchema, request.body);
    return parseApiOutput(creationDetailResponseSchema, { data: await required(service).snapshot(projectId, creationId, input), version: API_VERSION });
  });
  app.post(`${base}/:creationId/versions/:versionId/export`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { projectId, creationId, versionId } = parse(creationVersionParamsSchema, request.params);
    parse(z.strictObject({}), request.body ?? {});
    return parseApiOutput(creationExportResponseSchema, { data: await required(service).exportVersion(projectId, creationId, versionId), version: API_VERSION });
  });
  app.post('/api/v1/projects/:projectId/creation-suggestions', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { projectId } = parse(creationProjectParamsSchema, request.params);
    const input = parse(creationGenerateRequestSchema, request.body);
    const creations = required(service);
    if (!generate) throw new PublicApiError('CREATION_GENERATOR_UNAVAILABLE', '创作助手暂不可用，请检查模型设置。', 503);
    if (input.itemId) {
      const { item } = await creations.get(projectId, input.itemId);
      if (item.revision !== input.expectedRevision) throw new PublicApiError('CREATION_REVISION_CONFLICT', '稿件已有更新，请保存并重新发起讨论。', 409);
      if (input.selection && item.body.slice(input.selection.start, input.selection.end) !== input.selection.text) throw new PublicApiError('CREATION_SELECTION_CONFLICT', '选中的原文已变化，请重新选择后再试。', 409);
    } else {
      // Non-item planning still belongs to a real personal project.
      await creations.list(projectId);
    }
    const controller = new AbortController();
    const aborted = () => controller.abort();
    const closed = () => { if (!reply.raw.writableEnded) controller.abort(); };
    request.raw.once('aborted', aborted);
    reply.raw.once('close', closed);
    try {
      const result = await generate(projectId, input, controller.signal);
      return parseApiOutput(creationSuggestionResponseSchema, { data: result, version: API_VERSION });
    } finally {
      request.raw.off('aborted', aborted);
      reply.raw.off('close', closed);
    }
  });
}
