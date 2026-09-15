import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildServer } from '../../src/server/app.js';
import { createCompanyRuntime } from '../../src/server/company/company-runtime.js';

const servers: Array<ReturnType<typeof buildServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
});

describe('runtime mode boundary', () => {
  it('keeps personal mode as the default and does not expose company routes', async () => {
    const server = buildServer();
    servers.push(server);

    const bootstrap = await server.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:4317' } });
    const companyRequests = await Promise.all([
      server.inject({ url: '/api/company/v1/projects', headers: { host: '127.0.0.1:4317' } }),
      server.inject({ method: 'POST', url: '/api/company/v1/projects', headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' } }),
      server.inject({ method: 'PATCH', url: '/api/company/v1/projects/one', headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' } }),
      server.inject({ method: 'DELETE', url: '/api/company/v1/projects/one', headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' } })
    ]);

    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().data.runtimeMode).toBe('personal');
    expect(companyRequests.map(response => response.statusCode)).toEqual([404, 404, 404, 404]);

    const versionPrefixCollision = await server.inject({
      method: 'POST',
      url: '/api/company/v10/auth/login',
      headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' }
    });
    expect(versionPrefixCollision.statusCode).toBe(401);
  });

  it('registers the company namespace against the isolated company project service', async () => {
    const companyRuntime = createCompanyRuntime({ workspaceRoot: '/srv/company-workspace' });
    const server = buildServer({ runtimeMode: 'company', companyRuntime });
    servers.push(server);

    const bootstrap = await server.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:4317' } });
    const companyRoute = await server.inject({ url: '/api/company/v1/projects', headers: { host: '127.0.0.1:4317' } });

    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().data.runtimeMode).toBe('company');
    expect(companyRoute.statusCode).toBe(401);
    expect(companyRuntime.workspace).toEqual({
      id: 'company',
      displayName: 'Company workspace',
      rootPath: '/srv/company-workspace',
      incomingPath: join('/srv/company-workspace', 'incoming'),
      projectsPath: join('/srv/company-workspace', 'projects'),
      skillsPath: join('/srv/company-workspace', 'skills'),
      systemPath: join('/srv/company-workspace', 'system')
    });
    expect(companyRuntime.paths.rootPath).toBe('/srv/company-workspace');
    expect(companyRuntime.paths.resolve('projects')).toBe(join('/srv/company-workspace', 'projects'));
    expect(companyRuntime.database).toEqual({ kind: 'company' });
    expect(await companyRuntime.auth.authenticate({})).toBeUndefined();
    expect(await companyRuntime.projects.list()).toEqual([]);
    expect(companyRuntime).not.toHaveProperty('vaultRealRoot');
    expect(companyRuntime).not.toHaveProperty('gateway');
  });
});
