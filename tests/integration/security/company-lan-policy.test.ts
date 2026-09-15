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
  resolveCompanyListenOptions
} from '../../../src/server/security/origin-host.js';

const HOST = '192.168.1.20:4399';
const ORIGIN = `http://${HOST}`;
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
      list: async () => [{ id: 'project-1' }],
      create: async (_input, user) => { calls.push(`create:${user.role}`); return { id: 'project-1' }; },
      confirm: async (id, user) => { calls.push(`confirm:${user.role}:${id}`); return { id }; },
      listProposals: async () => [{ id: 'proposal-1' }],
      approveProposal: async (id, user) => { calls.push(`approve:${user.role}:${id}`); return { id }; },
      updateWorkspacePath: async (path, user) => { calls.push(`path:${user.role}:${path}`); return { path }; }
    }
  });
  const server = buildServer({
    runtimeMode: 'company',
    companyRuntime: runtime,
    httpPolicy: createCompanyHttpPolicy({ host: '192.168.1.20', port: 4399 })
  });
  servers.push(server);
  return { db, runtime, server, calls };
}

async function bootstrap(server: ReturnType<typeof buildServer>) {
  const response = await server.inject({
    method: 'POST',
    url: '/api/company/v1/auth/bootstrap',
    headers: headers(),
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
    expect(() => resolveCompanyListenOptions({ COMPANY_HOST: '192.168.1.20' })).toThrow('COMPANY_PORT');
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

  it('keeps company sessions and CSRF separate from personal sessions and enforces roles', async () => {
    const { server, calls } = fixture();
    await bootstrap(server);

    const personal = await server.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: headers() });
    const personalCookie = cookie(personal);
    const personalAsCompany = await server.inject({
      method: 'GET', url: '/api/company/v1/projects', headers: headers({ cookie: personalCookie })
    });
    expect(personalAsCompany.statusCode).toBe(401);

    const operator = await login(server, 'Operator', 'operator-secret');
    const reviewer = await login(server, 'Reviewer', 'reviewer-secret');
    const projects = await server.inject({ method: 'GET', url: '/api/company/v1/projects', headers: headers({ cookie: operator.cookie }) });
    expect(projects.statusCode).toBe(200);

    const missingCsrf = await server.inject({
      method: 'POST', url: '/api/company/v1/projects', headers: headers({ cookie: operator.cookie }), payload: { name: 'A' }
    });
    expect(missingCsrf.statusCode).toBe(403);

    const created = await server.inject({
      method: 'POST', url: '/api/company/v1/projects', headers: headers({ cookie: operator.cookie, 'x-csrf-token': operator.csrfToken }), payload: { name: 'A' }
    });
    expect(created.statusCode).toBe(200);
    const confirmed = await server.inject({
      method: 'POST', url: '/api/company/v1/projects/project-1/confirm', headers: headers({ cookie: operator.cookie, 'x-csrf-token': operator.csrfToken })
    });

    const reviewerCreate = await server.inject({
      method: 'POST', url: '/api/company/v1/projects', headers: headers({ cookie: reviewer.cookie, 'x-csrf-token': reviewer.csrfToken }), payload: { name: 'A' }
    });
    const reviewerProposals = await server.inject({
      method: 'GET', url: '/api/company/v1/proposals', headers: headers({ cookie: reviewer.cookie })
    });
    const reviewerApprove = await server.inject({
      method: 'POST', url: '/api/company/v1/proposals/proposal-1/approve', headers: headers({ cookie: reviewer.cookie, 'x-csrf-token': reviewer.csrfToken })
    });
    const reviewerPath = await server.inject({
      method: 'PATCH', url: '/api/company/v1/workspace/path', headers: headers({ cookie: reviewer.cookie, 'x-csrf-token': reviewer.csrfToken }), payload: { path: '/tmp/other' }
    });
    expect(reviewerCreate.statusCode).toBe(403);
    expect(confirmed.statusCode).toBe(200);
    expect(reviewerProposals.statusCode).toBe(200);
    expect(reviewerApprove.statusCode).toBe(200);
    expect(reviewerPath.statusCode).toBe(403);
    expect(calls).toEqual(['create:operator', 'confirm:operator:project-1', 'approve:reviewer:proposal-1']);
  });
});
