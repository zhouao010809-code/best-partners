import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/server/app.js';
import { createCompanyAuthService } from '../../../src/server/company/company-auth-service.js';
import { createCompanyRuntime } from '../../../src/server/company/company-runtime.js';
import { applyMigrations } from '../../../src/server/db/migrate.js';
import {
  createCompanyHttpPolicy
} from '../../../src/server/security/loopback-policy.js';
import {
  resolveCompanyBootstrapToken,
  resolveCompanyListenOptions
} from '../../../src/server/security/origin-host.js';

const HOST = '192.168.1.20:4399';
const ORIGIN = `http://${HOST}`;
const COMPANY_BOOTSTRAP_TOKEN = 'b'.repeat(43);
const databases: Database.Database[] = [];
const servers: ReturnType<typeof buildServer>[] = [];

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { host: HOST, origin: ORIGIN, ...extra };
}

function cookie(response: Awaited<ReturnType<ReturnType<typeof buildServer>['inject']>>): string {
  const value = response.headers['set-cookie'];
  if (typeof value !== 'string') throw new Error('missing cookie');
  return value.split(';', 1)[0]!;
}

function fixture() {
  const db = new Database(':memory:');
  applyMigrations(db);
  databases.push(db);
  const calls: string[] = [];
  const runtime = createCompanyRuntime({
    database: db,
    workspaceRoot: '/srv/company-workspace',
    projects: {
      list: async () => [{
        id: 'project-1',
        workspaceId: 'company',
        name: 'Security fixture project',
        status: 'draft',
        projectRoot: '/srv/company-workspace/projects/project-1',
        sourceRoot: '/srv/company-workspace/incoming/project-1',
        configSha256: 'a'.repeat(64),
        confidence: {},
        selectedSkillIds: [],
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
        dataCoverage: 'not_configured'
      }],
      create: async (_input, user) => { calls.push(`create:${user.role}`); return { id: 'project-1' }; },
      listProposals: async () => [{ id: 'proposal-1' }],
      approveProposal: async (id, user) => { calls.push(`approve:${user.role}:${id}`); return { id }; },
      updateWorkspacePath: async (path, user) => { calls.push(`path:${user.role}:${path}`); return { path }; }
    }
  });
  const server = buildServer({
    runtimeMode: 'company',
    companyRuntime: runtime,
    companyBootstrapToken: COMPANY_BOOTSTRAP_TOKEN,
    httpPolicy: createCompanyHttpPolicy({ host: '192.168.1.20', port: 4399 })
  });
  servers.push(server);
  return { db, runtime, server, calls };
}

async function bootstrap(server: ReturnType<typeof buildServer>) {
  const response = await server.inject({
    method: 'POST',
    url: '/api/company/v1/auth/bootstrap',
    headers: headers({ 'x-company-bootstrap-token': COMPANY_BOOTSTRAP_TOKEN }),
    payload: {
      operator: { displayName: 'Operator', password: 'operator-secret' },
      reviewer: { displayName: 'Reviewer', password: 'reviewer-secret' }
    }
  });
  expect(response.statusCode).toBe(200);
}

async function login(server: ReturnType<typeof buildServer>, displayName: string, password: string) {
  const response = await server.inject({
    method: 'POST',
    url: '/api/company/v1/auth/login',
    headers: headers(),
    payload: { displayName, password }
  });
  expect(response.statusCode).toBe(200);
  return { cookie: cookie(response), csrfToken: response.json<{ data: { csrfToken: string } }>().data.csrfToken };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const db of databases.splice(0)) db.close();
});

describe('company LAN authority and namespace security', () => {
  it('requires explicit non-wildcard company host and port', () => {
    expect(resolveCompanyListenOptions({ COMPANY_HOST: '192.168.1.20', COMPANY_PORT: '4399' })).toEqual({
      host: '192.168.1.20', port: 4399
    });
    expect(() => resolveCompanyListenOptions({ COMPANY_HOST: '0.0.0.0', COMPANY_PORT: '4399' })).toThrow();
    for (const host of [
      '0:0:0:0:0:0:0:0', '[::]', '::0', '[::ffff:0.0.0.0]', '::ffff:0:0',
      '000.000.000.000', '0', '0.0', '0x0'
    ]) {
      expect(() => resolveCompanyListenOptions({ COMPANY_HOST: host, COMPANY_PORT: '4399' })).toThrow(host);
    }
    expect(resolveCompanyListenOptions({ COMPANY_HOST: '[fe80::1]', COMPANY_PORT: '4399' })).toEqual({ host: 'fe80::1', port: 4399 });
    expect(resolveCompanyListenOptions({ COMPANY_HOST: '127.0.0.1', COMPANY_PORT: '4399' })).toEqual({ host: '127.0.0.1', port: 4399 });
    expect(resolveCompanyListenOptions({ COMPANY_HOST: '100.64.0.10', COMPANY_PORT: '4399' })).toEqual({ host: '100.64.0.10', port: 4399 });
    expect(resolveCompanyListenOptions({ COMPANY_HOST: '192.168.1.20', COMPANY_PORT: '4399' }).host).toBe('192.168.1.20');
    expect(resolveCompanyListenOptions({ COMPANY_HOST: 'mac-mini.local', COMPANY_PORT: '4399' }).host).toBe('mac-mini.local');
    expect(() => resolveCompanyListenOptions({ COMPANY_HOST: '8.8.8.8', COMPANY_PORT: '4399' })).toThrow('COMPANY_HOST');
    expect(() => resolveCompanyListenOptions({ COMPANY_HOST: 'company.example.com', COMPANY_PORT: '4399' })).toThrow('COMPANY_HOST');
    expect(() => resolveCompanyListenOptions({ COMPANY_HOST: '192.168.1.20' })).toThrow('COMPANY_PORT');
    const bootstrapToken = 'b'.repeat(43);
    expect(resolveCompanyBootstrapToken({ COMPANY_BOOTSTRAP_TOKEN: bootstrapToken })).toBe(bootstrapToken);
    expect(() => resolveCompanyBootstrapToken({})).toThrow('COMPANY_BOOTSTRAP_TOKEN');
    expect(() => resolveCompanyBootstrapToken({ COMPANY_BOOTSTRAP_TOKEN: 'short-secret' })).toThrow('COMPANY_BOOTSTRAP_TOKEN');
  });

  it('requires the startup bootstrap secret before creating company users', async () => {
    const { runtime } = fixture();
    const bootstrapToken = 'b'.repeat(43);
    const unconfigured = buildServer({
      runtimeMode: 'company',
      companyRuntime: runtime,
      httpPolicy: createCompanyHttpPolicy({ host: '192.168.1.20', port: 4399 })
    });
    servers.push(unconfigured);
    const weaklyConfigured = buildServer({
      runtimeMode: 'company',
      companyRuntime: runtime,
      companyBootstrapToken: 'guessable',
      httpPolicy: createCompanyHttpPolicy({ host: '192.168.1.20', port: 4399 })
    });
    servers.push(weaklyConfigured);
    const server = buildServer({
      runtimeMode: 'company',
      companyRuntime: runtime,
      companyBootstrapToken: bootstrapToken,
      httpPolicy: createCompanyHttpPolicy({ host: '192.168.1.20', port: 4399 })
    });
    servers.push(server);
    const payload = {
      operator: { displayName: 'Operator', password: 'operator-secret' },
      reviewer: { displayName: 'Reviewer', password: 'reviewer-secret' }
    };

    const disabled = await unconfigured.inject({
      method: 'POST', url: '/api/company/v1/auth/bootstrap', headers: headers({ 'x-company-bootstrap-token': bootstrapToken }), payload
    });
    const weak = await weaklyConfigured.inject({
      method: 'POST', url: '/api/company/v1/auth/bootstrap', headers: headers({ 'x-company-bootstrap-token': 'guessable' }), payload
    });
    const missing = await server.inject({
      method: 'POST', url: '/api/company/v1/auth/bootstrap', headers: headers(), payload
    });
    const wrong = await server.inject({
      method: 'POST', url: '/api/company/v1/auth/bootstrap', headers: headers({ 'x-company-bootstrap-token': 'w'.repeat(43) }), payload
    });
    const allowed = await server.inject({
      method: 'POST', url: '/api/company/v1/auth/bootstrap', headers: headers({ 'x-company-bootstrap-token': bootstrapToken }), payload
    });

    expect(disabled.statusCode).toBe(403);
    expect(weak.statusCode).toBe(403);
    expect(missing.statusCode).toBe(403);
    expect(wrong.statusCode).toBe(403);
    expect(missing.json().error.code).toBe('COMPANY_BOOTSTRAP_FORBIDDEN');
    expect(allowed.statusCode).toBe(200);
  });

  it('rejects unknown Host and unknown or missing mutation Origin', async () => {
    const { server } = fixture();
    const unknownHost = await server.inject({ method: 'GET', url: '/api/company/v1/projects', headers: { host: 'evil.test' } });
    expect(unknownHost.statusCode).toBe(421);

    const unknownOrigin = await server.inject({
      method: 'POST', url: '/api/company/v1/auth/login', headers: headers({ origin: 'http://evil.test' }),
      payload: { displayName: 'Operator', password: 'secret' }
    });
    const missingOrigin = await server.inject({
      method: 'POST', url: '/api/company/v1/auth/login', headers: { host: HOST },
      payload: { displayName: 'Operator', password: 'secret' }
    });
    expect(unknownOrigin.statusCode).toBe(403);
    expect(missingOrigin.statusCode).toBe(403);
  });

  it('caps concurrent failed login work before password derivation can fan out', async () => {
    const { server } = fixture();
    await bootstrap(server);
    const attempts = await Promise.all(Array.from({ length: 8 }, () => server.inject({
      method: 'POST',
      url: '/api/company/v1/auth/login',
      headers: headers(),
      payload: { displayName: 'Operator', password: 'wrong-password' }
    })));
    expect(attempts.filter((response) => response.statusCode === 401)).toHaveLength(4);
    expect(attempts.filter((response) => response.statusCode === 429)).toHaveLength(4);
    expect(new Set(attempts
      .filter((response) => response.statusCode === 429)
      .map((response) => response.json().error.code)))
      .toEqual(new Set(['COMPANY_LOGIN_BUSY', 'COMPANY_LOGIN_RATE_LIMITED']));
  });

  it('keeps company sessions and CSRF separate from personal sessions', async () => {
    const { server } = fixture();
    await bootstrap(server);

    const personal = await server.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: headers() });
    const personalCookie = cookie(personal);
    const personalAsCompany = await server.inject({
      method: 'GET', url: '/api/company/v1/projects', headers: headers({ cookie: personalCookie })
    });
    expect(personalAsCompany.statusCode).toBe(401);

    const operator = await login(server, 'Operator', 'operator-secret');
    const reviewer = await login(server, 'Reviewer', 'reviewer-secret');
    const session = await server.inject({
      method: 'GET', url: '/api/company/v1/auth/session', headers: headers({ cookie: operator.cookie })
    });
    const projects = await server.inject({
      method: 'GET', url: '/api/company/v1/projects', headers: headers({ cookie: operator.cookie })
    });
    expect(session.statusCode).toBe(200);
    expect(projects.statusCode).toBe(200);
    expect(projects.json()).toMatchObject({
      data: { items: [{ id: 'project-1', status: 'draft', dataCoverage: 'not_configured' }] },
      version: 1
    });

    const missingCsrf = await server.inject({
      method: 'POST', url: '/api/company/v1/projects', headers: headers({ cookie: operator.cookie }), payload: { name: 'A' }
    });
    const unknownCompanyRoute = await server.inject({
      method: 'POST', url: '/api/company/v1/projects', headers: headers({ cookie: operator.cookie, 'x-csrf-token': operator.csrfToken }), payload: { name: 'A' }
    });
    const logout = await server.inject({
      method: 'POST', url: '/api/company/v1/auth/logout', headers: headers({ cookie: reviewer.cookie, 'x-csrf-token': reviewer.csrfToken })
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(unknownCompanyRoute.statusCode).toBe(404);
    expect(logout.statusCode).toBe(200);
  });
});
