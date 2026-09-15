import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  API_VERSION,
} from '../../../shared/api/schemas.js';
import {
  companyBootstrapRequestSchema,
  companyBootstrapDataSchema,
  companyLoginRequestSchema,
  companySessionResponseSchema,
  companyUserResponseSchema
} from '../../../shared/api/company-auth.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';
import {
  requireCompanyUser,
  type CompanyAuthRequest,
  type CompanyAuthService,
  type CompanyPermission,
  type CompanyPrincipal
} from '../../company/company-auth-service.js';
import type { CompanyProjectService } from '../../company/company-runtime.js';

function authRequest(request: FastifyRequest): CompanyAuthRequest {
  return { headers: request.headers as unknown as NonNullable<CompanyAuthRequest['headers']> };
}

function forbidden(): PublicApiError {
  return new PublicApiError('COMPANY_FORBIDDEN', 'Company role is not permitted', 403);
}

async function requirePermission(
  auth: CompanyAuthService,
  request: FastifyRequest,
  permission: CompanyPermission
): Promise<CompanyPrincipal> {
  const user = await requireCompanyUser(auth, authRequest(request));
  if (!auth.can(user, permission)) throw forbidden();
  return user;
}

function projectMethod<T extends keyof CompanyProjectService>(
  projects: CompanyProjectService,
  method: T
): NonNullable<CompanyProjectService[T]> {
  const implementation = projects[method];
  if (typeof implementation !== 'function') {
    throw new PublicApiError('COMPANY_PROJECTS_UNAVAILABLE', 'Company project service is unavailable', 503);
  }
  return implementation as NonNullable<CompanyProjectService[T]>;
}

function projectId(request: FastifyRequest): string {
  const id = (request.params as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    throw new PublicApiError('VALIDATION_ERROR', 'Request validation failed', 400, { id: 'Invalid value' });
  }
  return id;
}

export function registerCompanyAuthRoutes(
  app: FastifyInstance,
  dependencies: { auth: CompanyAuthService; projects: CompanyProjectService }
): void {
  const { auth, projects } = dependencies;

  app.post('/api/company/v1/auth/bootstrap', async (request, reply) => {
    const result = await auth.bootstrap(parseApiInput(companyBootstrapRequestSchema, request.body));
    const data = parseApiOutput(companyBootstrapDataSchema, result);
    reply.header('cache-control', 'no-store');
    return parseApiOutput(companyUserResponseSchema, { data, version: API_VERSION });
  });

  app.post('/api/company/v1/auth/login', async (request, reply) => {
    const result = await auth.login(parseApiInput(companyLoginRequestSchema, request.body));
    reply.header('set-cookie', result.setCookie);
    reply.header('cache-control', 'no-store');
    return parseApiOutput(companySessionResponseSchema, {
      data: { user: result.user, csrfToken: result.csrfToken },
      version: API_VERSION
    });
  });

  app.get('/api/company/v1/auth/session', async (request, reply) => {
    const user = await requireCompanyUser(auth, authRequest(request));
    const csrfToken = await auth.csrfToken(authRequest(request));
    if (csrfToken === undefined) throw new PublicApiError('COMPANY_SESSION_REQUIRED', 'Company session required', 401);
    reply.header('cache-control', 'no-store');
    return parseApiOutput(companySessionResponseSchema, {
      data: { user, csrfToken },
      version: API_VERSION
    });
  });

  app.post('/api/company/v1/auth/logout', async (request, reply) => {
    await requireCompanyUser(auth, authRequest(request));
    const cookie = await auth.logout(authRequest(request));
    if (cookie !== undefined) reply.header('set-cookie', cookie);
    reply.header('cache-control', 'no-store');
    return { data: { loggedOut: true }, version: API_VERSION };
  });

  app.get('/api/company/v1/projects', async (request, reply) => {
    const user = await requireCompanyUser(auth, authRequest(request));
    const items = await projects.list(user);
    reply.header('cache-control', 'no-store');
    return { data: { items }, version: API_VERSION };
  });

  app.post('/api/company/v1/projects', async (request, reply) => {
    const user = await requirePermission(auth, request, 'project:create');
    const create = projectMethod(projects, 'create');
    return { data: { project: await create(request.body, user) }, version: API_VERSION };
  });

  app.post('/api/company/v1/projects/:id/confirm', async (request, reply) => {
    const user = await requirePermission(auth, request, 'project:confirm');
    const confirm = projectMethod(projects, 'confirm');
    return { data: { project: await confirm(projectId(request), user) }, version: API_VERSION };
  });

  app.get('/api/company/v1/proposals', async (request, reply) => {
    const user = await requirePermission(auth, request, 'proposal:read');
    const listProposals = projectMethod(projects, 'listProposals');
    return { data: { items: await listProposals(user) }, version: API_VERSION };
  });

  app.post('/api/company/v1/proposals/:id/approve', async (request, reply) => {
    const user = await requirePermission(auth, request, 'proposal:approve');
    const approveProposal = projectMethod(projects, 'approveProposal');
    return { data: { proposal: await approveProposal(projectId(request), user) }, version: API_VERSION };
  });

  app.patch('/api/company/v1/workspace/path', async (request, reply) => {
    const user = await requirePermission(auth, request, 'workspace:path:update');
    const updateWorkspacePath = projectMethod(projects, 'updateWorkspacePath');
    const body = parseApiInput(z.object({ path: z.string().trim().min(1).max(2048) }).strict(), request.body);
    return { data: { workspace: await updateWorkspacePath(body.path, user) }, version: API_VERSION };
  });
}
