import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
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

const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_ADDRESS_LIMIT = 20;
const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;

export function registerCompanyAuthRoutes(
  app: FastifyInstance,
  dependencies: { auth: CompanyAuthService; bootstrapToken?: string }
): void {
  const { auth, bootstrapToken } = dependencies;
  const loginFailures = new Map<string, { count: number; resetAt: number }>();

  function reserve(key: string, limit: number): void {
    const timestamp = Date.now();
    const state = loginFailures.get(key);
    if (state === undefined || state.resetAt <= timestamp) {
      loginFailures.set(key, { count: 1, resetAt: timestamp + LOGIN_FAILURE_WINDOW_MS });
      return;
    }
    if (state.count >= limit) {
      throw new PublicApiError('COMPANY_LOGIN_RATE_LIMITED', 'Too many company login attempts', 429);
    }
    loginFailures.set(key, { ...state, count: state.count + 1 });
  }

  function loginKeys(address: string, displayName: string): readonly [string, string] {
    return [`address:${address}`, `account:${address}\0${displayName}`];
  }

  function reserveLoginAttempt(address: string, displayName: string): void {
    const [addressKey, accountKey] = loginKeys(address, displayName);
    reserve(addressKey, LOGIN_ADDRESS_LIMIT);
    reserve(accountKey, LOGIN_FAILURE_LIMIT);
  }

  app.post('/api/company/v1/auth/bootstrap', async (request, reply) => {
    const provided = request.headers['x-company-bootstrap-token'];
    const actual = typeof provided === 'string' ? Buffer.from(provided, 'utf8') : Buffer.alloc(0);
    const expected = Buffer.from(
      bootstrapToken !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(bootstrapToken) ? bootstrapToken : '',
      'utf8'
    );
    if (expected.length === 0 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new PublicApiError('COMPANY_BOOTSTRAP_FORBIDDEN', 'Company bootstrap is not authorized', 403);
    }
    const result = await auth.bootstrap(parseApiInput(companyBootstrapRequestSchema, request.body));
    const data = parseApiOutput(companyBootstrapDataSchema, result);
    reply.header('cache-control', 'no-store');
    return parseApiOutput(companyUserResponseSchema, { data, version: API_VERSION });
  });

  app.post('/api/company/v1/auth/login', async (request, reply) => {
    const input = parseApiInput(companyLoginRequestSchema, request.body);
    reserveLoginAttempt(request.ip, input.displayName);
    const result = await auth.login(input);
    for (const key of loginKeys(request.ip, input.displayName)) loginFailures.delete(key);
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
