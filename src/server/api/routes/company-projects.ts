import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_VERSION } from '../../../shared/api/schemas.js';
import {
  requireCompanyUser,
  type CompanyAuthRequest,
  type CompanyAuthService
} from '../../company/company-auth-service.js';
import type { CompanyProjectService } from '../../company/company-runtime.js';

function authRequest(request: FastifyRequest): CompanyAuthRequest {
  return { headers: request.headers as unknown as NonNullable<CompanyAuthRequest['headers']> };
}

/**
 * The project route owner for the company namespace. Task7 extends this file
 * with scan, proposal, confirmation, and detail routes; it must not register
 * a second handler for the list path.
 */
export function registerCompanyProjectRoutes(
  app: FastifyInstance,
  dependencies: { auth: CompanyAuthService; projects: CompanyProjectService }
): void {
  app.get('/api/company/v1/projects', async (request, reply) => {
    const user = await requireCompanyUser(dependencies.auth, authRequest(request));
    reply.header('cache-control', 'no-store');
    return reply.send({
      data: { items: await dependencies.projects.list(user) },
      version: API_VERSION
    });
  });
}
