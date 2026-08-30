import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server/app.js';

describe('GET /api/v1/health', () => {
  const servers: Array<ReturnType<typeof buildServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('returns a versioned boot snapshot', async () => {
    const server = buildServer();
    servers.push(server);
    const response = await server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        status: 'booting',
        apiVersion: 'v1',
        writeGate: 'closed'
      },
      version: 1
    });
  });
});
