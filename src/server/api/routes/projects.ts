import type { FastifyInstance } from 'fastify';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import {
  projectBindRequestSchema,
  projectFilePageResponseSchema,
  projectFileQuerySchema,
  projectFileReadQuerySchema,
  projectFileResponseSchema,
  projectIdParamSchema,
  projectListResponseSchema,
  projectReconnectRequestSchema,
  projectScanPreviewResponseSchema,
  projectScanRequestSchema,
  projectSummaryResponseSchema,
  type ProjectService
} from '../../../shared/api/projects.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

function requiredService(service: ProjectService | undefined): ProjectService {
  if (service === undefined) {
    throw new PublicApiError('PROJECTS_UNAVAILABLE', 'Project service is unavailable', 503);
  }
  return service;
}

function projectError(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  const code = error instanceof Error && 'code' in error ? String((error as Error & { code: string }).code) : undefined;
  if (code === 'PROJECT_NOT_FOUND' || code === 'PROJECT_SCAN_NOT_FOUND' || code === 'PROJECT_FILE_NOT_FOUND') {
    throw new PublicApiError(code, 'Project resource not found', 404);
  }
  if (code !== undefined && (code.startsWith('PROJECT_') || code.startsWith('FILE_'))) {
    throw new PublicApiError(code, 'Project request could not be completed', 400);
  }
  throw error;
}

async function safely<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return projectError(error);
  }
}

export function registerProjectRoutes(app: FastifyInstance, service?: ProjectService): void {
  app.post('/api/v1/projects/scan', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const body = parseApiInput(projectScanRequestSchema, request.body);
    const result = await safely(() => requiredService(service).scan(body.rootPath));
    return parseApiOutput(projectScanPreviewResponseSchema, { data: result, version: API_VERSION });
  });

  app.post('/api/v1/projects', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const body = parseApiInput(projectBindRequestSchema, request.body);
    const result = await safely(() => requiredService(service).bind(body.scanId, {
      sourceSha256: body.sourceSha256,
      ...(body.displayName === undefined ? {} : { displayName: body.displayName })
    }));
    return parseApiOutput(projectSummaryResponseSchema, { data: result, version: API_VERSION });
  });

  app.post('/api/v1/projects/:id/reconnect', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(projectIdParamSchema, request.params);
    const body = parseApiInput(projectReconnectRequestSchema, request.body);
    const result = await safely(() => requiredService(service).reconnect(id, body.scanId, {
      sourceSha256: body.sourceSha256,
      ...(body.displayName === undefined ? {} : { displayName: body.displayName })
    }));
    return parseApiOutput(projectSummaryResponseSchema, { data: result, version: API_VERSION });
  });

  app.get('/api/v1/projects', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const result = await safely(() => requiredService(service).list());
    return parseApiOutput(projectListResponseSchema, { data: { projects: result }, version: API_VERSION });
  });

  app.get('/api/v1/projects/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(projectIdParamSchema, request.params);
    const result = await safely(() => requiredService(service).get(id));
    return parseApiOutput(projectSummaryResponseSchema, { data: result, version: API_VERSION });
  });

  app.post('/api/v1/projects/:id/refresh', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(projectIdParamSchema, request.params);
    const result = await safely(() => requiredService(service).refresh(id));
    return parseApiOutput(projectSummaryResponseSchema, { data: result, version: API_VERSION });
  });

  app.get('/api/v1/projects/:id/files', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(projectIdParamSchema, request.params);
    const query = parseApiInput(projectFileQuerySchema, request.query);
    const result = await safely(() => requiredService(service).listFiles(id, {
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.origin === undefined ? {} : { origin: query.origin }),
      limit: query.limit
    }));
    return parseApiOutput(projectFilePageResponseSchema, { data: result, version: API_VERSION });
  });

  app.get('/api/v1/projects/:id/file', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = parseApiInput(projectIdParamSchema, request.params);
    const { path } = parseApiInput(projectFileReadQuerySchema, request.query);
    const result = await safely(() => requiredService(service).readFile(id, path));
    return parseApiOutput(projectFileResponseSchema, { data: result, version: API_VERSION });
  });

}
