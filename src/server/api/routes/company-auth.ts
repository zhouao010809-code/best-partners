import type { FastifyInstance, FastifyRequest } from 'fastify';
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
  type CompanyAuthService
} from '../../company/company-auth-service.js';

function authRequest(request: FastifyRequest): CompanyAuthRequest {
  return { headers: request.headers as unknown as NonNullable<CompanyAuthRequest['headers']> };
}

export function registerCompanyAuthRoutes(
  app: FastifyInstance,
  dependencies: { auth: CompanyAuthService }
): void {
  const { auth } = dependencies;

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

}
