import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { skillIdParamsSchema, skillsResponseSchema, skillResponseSchema } from '../../../shared/api/skills.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';
import {
  requireCompanyUser,
  type CompanyAuthRequest,
  type CompanyAuthService
} from '../../company/company-auth-service.js';
import type { SkillCatalogService } from '../../services/skill-catalog.js';
import { PublicApiError } from '../../../shared/api/errors.js';

function authRequest(request: FastifyRequest): CompanyAuthRequest {
  return { headers: request.headers as unknown as NonNullable<CompanyAuthRequest['headers']> };
}

function assertRead(auth: CompanyAuthService, user: Awaited<ReturnType<CompanyAuthService['authenticate']>>): void {
  if (user === undefined || !auth.can(user, 'proposal:read')) {
    throw new PublicApiError('COMPANY_FORBIDDEN', 'Company role is not permitted', 403);
  }
}

/** Read-only company Skill catalog. Mutations remain intentionally personal-only. */
export function registerCompanySkillRoutes(
  app: FastifyInstance,
  dependencies: { readonly auth: CompanyAuthService; readonly skills: SkillCatalogService }
): void {
  const { auth, skills } = dependencies;

  app.get('/api/company/v1/skills', async (request, reply) => {
    const user = await requireCompanyUser(auth, authRequest(request));
    assertRead(auth, user);
    const result = await skills.list();
    reply.header('cache-control', 'no-store');
    return parseApiOutput(skillsResponseSchema, { data: result, version: API_VERSION });
  });

  app.get('/api/company/v1/skills/:id', async (request, reply) => {
    const user = await requireCompanyUser(auth, authRequest(request));
    assertRead(auth, user);
    const { id } = parseApiInput(skillIdParamsSchema, request.params);
    const result = await skills.get(id);
    reply.header('cache-control', 'no-store');
    return parseApiOutput(skillResponseSchema, { data: result, version: API_VERSION });
  });
}
