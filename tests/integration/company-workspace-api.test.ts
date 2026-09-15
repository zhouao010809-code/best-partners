import { afterEach, describe, expect, it } from 'vitest';
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
    const companyRoute = await server.inject({ url: '/api/company/v1/projects', headers: { host: '127.0.0.1:4317' } });

    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().data.runtimeMode).toBe('personal');
    expect(companyRoute.statusCode).toBe(404);
  });

  it('registers the company namespace against the isolated company project service', async () => {
    const companyRuntime = createCompanyRuntime({ workspaceRoot: '/srv/company-workspace' });
    const server = buildServer({ runtimeMode: 'company', companyRuntime });
    servers.push(server);

    const bootstrap = await server.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:4317' } });
    const companyRoute = await server.inject({ url: '/api/company/v1/projects', headers: { host: '127.0.0.1:4317' } });

    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().data.runtimeMode).toBe('company');
    expect(companyRoute.statusCode).toBe(200);
    expect(companyRoute.json()).toEqual({ data: { items: [] }, version: 1 });
    expect(companyRuntime.workspace.rootPath).toBe('/srv/company-workspace');
    expect(companyRuntime).not.toHaveProperty('vaultRealRoot');
    expect(companyRuntime).not.toHaveProperty('gateway');
  });
});
