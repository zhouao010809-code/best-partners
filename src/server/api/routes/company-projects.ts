import type { FastifyInstance, FastifyRequest } from 'fastify';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import {
  companyProjectConfirmRequestSchema,
  companyProjectConfirmResponseSchema,
  companyProjectDetailResponseSchema,
  companyProjectDraftResponseSchema,
  companyProjectIdParamsSchema,
  companyProjectListResponseSchema,
  companyProjectRunParamsSchema,
  companyProjectScanRequestSchema,
  companyProjectScanResponseSchema
} from '../../../shared/api/company-projects.js';
import { assertCompanyRelativePath } from '../../company/company-paths.js';
import {
  requireCompanyUser,
  type CompanyAuthRequest,
  type CompanyAuthService,
  type CompanyPermission,
  type CompanyPrincipal
} from '../../company/company-auth-service.js';
import type { CompanyProjectService, CompanyRuntime } from '../../company/company-runtime.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

function authRequest(request: FastifyRequest): CompanyAuthRequest {
  return { headers: request.headers as unknown as NonNullable<CompanyAuthRequest['headers']> };
}

function forbidden(auth: CompanyAuthService, user: CompanyPrincipal, permission: CompanyPermission): void {
  if (!auth.can(user, permission)) throw new PublicApiError('COMPANY_FORBIDDEN', 'Company role is not permitted', 403);
}

function requiredMethod<T extends keyof CompanyProjectService>(
  projects: CompanyProjectService,
  method: T
): NonNullable<CompanyProjectService[T]> {
  const handler = projects[method];
  if (typeof handler !== 'function') {
    throw new PublicApiError('COMPANY_PROJECT_SERVICE_UNAVAILABLE', 'Company project service is unavailable', 503);
  }
  return handler as NonNullable<CompanyProjectService[T]>;
}

function pathInside(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

/** Resolve a browser-provided path strictly inside the company incoming area. */
async function resolveIncomingPath(
  runtime: CompanyRuntime,
  input: { readonly incomingPath?: string; readonly sourcePath?: string; readonly uploadId?: string }
): Promise<string> {
  if (input.uploadId !== undefined) {
    throw new PublicApiError('COMPANY_UPLOAD_NOT_FOUND', 'Registered upload was not found', 404);
  }
  const requested = input.incomingPath ?? input.sourcePath;
  if (requested === undefined) {
    throw new PublicApiError('COMPANY_PROJECT_SOURCE_PATH_INVALID', 'Incoming project path is required', 400);
  }
  let normalized: string;
  try {
    normalized = assertCompanyRelativePath(requested);
  } catch {
    throw new PublicApiError('COMPANY_PROJECT_SOURCE_PATH_INVALID', 'Incoming project path is invalid', 400);
  }
  const relativePath = normalized === 'incoming'
    ? ''
    : normalized.startsWith('incoming/') ? normalized.slice('incoming/'.length) : normalized;
  if (relativePath.length === 0) {
    throw new PublicApiError('COMPANY_PROJECT_SOURCE_PATH_INVALID', 'Incoming project path is invalid', 400);
  }
  const incomingRoot = runtime.workspace.incomingPath;
  const candidate = join(incomingRoot, ...relativePath.split('/'));
  if (!pathInside(incomingRoot, candidate)) {
    throw new PublicApiError('COMPANY_PROJECT_SOURCE_PATH_INVALID', 'Incoming project path is invalid', 400);
  }
  let root: string;
  let canonicalIncoming: string;
  try {
    // Inspect the configured path before realpath so a symlink cannot be used
    // to point at an otherwise-contained directory. The scanner applies the
    // same fail-closed rule to descendants after this boundary check.
    let current = incomingRoot;
    const segments = relative(incomingRoot, candidate).split(sep).filter(Boolean);
    for (const segment of ['', ...segments]) {
      if (segment !== '') current = segment === '' ? current : join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new PublicApiError('COMPANY_PROJECT_SOURCE_PATH_INVALID', 'Incoming project path is invalid', 400);
      }
    }
    canonicalIncoming = await realpath(incomingRoot);
    root = await realpath(candidate);
  } catch (error) {
    if (error instanceof PublicApiError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new PublicApiError('COMPANY_PROJECT_SOURCE_NOT_FOUND', 'Incoming project folder was not found', 404);
    }
    throw new PublicApiError('COMPANY_PROJECT_SOURCE_PATH_INVALID', 'Incoming project path is invalid', 400);
  }
  if (!pathInside(canonicalIncoming, root)) {
    throw new PublicApiError('COMPANY_PROJECT_SOURCE_PATH_INVALID', 'Incoming project path is invalid', 400);
  }
  const info = await lstat(root).catch(() => undefined);
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    throw new PublicApiError('COMPANY_PROJECT_SOURCE_NOT_FOUND', 'Incoming project folder was not found', 404);
  }
  return root;
}

export function registerCompanyProjectRoutes(
  app: FastifyInstance,
  dependencies: { auth: CompanyAuthService; projects: CompanyProjectService; runtime?: CompanyRuntime }
): void {
  const { auth, projects } = dependencies;

  app.get('/api/company/v1/projects', async (request, reply) => {
    const user = await requireCompanyUser(auth, authRequest(request));
    forbidden(auth, user, 'proposal:read');
    const items = await projects.list(user);
    reply.header('cache-control', 'no-store');
    return parseApiOutput(companyProjectListResponseSchema, { data: { items }, version: API_VERSION });
  });

  app.post('/api/company/v1/projects/scan', async (request, reply) => {
    const user = await requireCompanyUser(auth, authRequest(request));
    forbidden(auth, user, 'project:create');
    if (dependencies.runtime === undefined) {
      throw new PublicApiError('COMPANY_PROJECT_SERVICE_UNAVAILABLE', 'Company project workspace is unavailable', 503);
    }
    const input = parseApiInput(companyProjectScanRequestSchema, request.body);
    const sourceRoot = await resolveIncomingPath(dependencies.runtime, input);
    const scan = requiredMethod(projects, 'scan');
    const result = await scan({ sourceRoot, actorId: user.id });
    reply.header('cache-control', 'no-store');
    return parseApiOutput(companyProjectScanResponseSchema, { data: result, version: API_VERSION });
  });

  app.get('/api/company/v1/projects/drafts/:id', async (request, reply) => {
    const user = await requireCompanyUser(auth, authRequest(request));
    forbidden(auth, user, 'proposal:read');
    const { id } = parseApiInput(companyProjectRunParamsSchema, request.params);
    const getDraft = requiredMethod(projects, 'getDraft');
    const result = await getDraft(id);
    reply.header('cache-control', 'no-store');
    return parseApiOutput(companyProjectDraftResponseSchema, { data: result, version: API_VERSION });
  });

  app.post('/api/company/v1/projects/drafts/:id/confirm', async (request, reply) => {
    const user = await requireCompanyUser(auth, authRequest(request));
    forbidden(auth, user, 'project:confirm');
    const { id } = parseApiInput(companyProjectRunParamsSchema, request.params);
    const body = parseApiInput(companyProjectConfirmRequestSchema, request.body);
    const confirm = requiredMethod(projects, 'confirm');
    const result = await confirm(id, {
      name: body.name,
      status: body.status,
      sourceSha256: body.sourceSha256,
      selectedSkillIds: body.selectedSkillIds,
      actorId: user.id,
      ...(body.clientName === undefined ? {} : { clientName: body.clientName })
    });
    reply.header('cache-control', 'no-store');
    return parseApiOutput(companyProjectConfirmResponseSchema, { data: result, version: API_VERSION });
  });

  app.get('/api/company/v1/projects/:id', async (request, reply) => {
    const user = await requireCompanyUser(auth, authRequest(request));
    forbidden(auth, user, 'proposal:read');
    const { id } = parseApiInput(companyProjectIdParamsSchema, request.params);
    const get = requiredMethod(projects, 'get');
    const project = await get(id);
    reply.header('cache-control', 'no-store');
    return parseApiOutput(companyProjectDetailResponseSchema, { data: project, version: API_VERSION });
  });
}
