import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server/app.js';

describe('GET /api/v1/health', () => {
  const servers: Array<ReturnType<typeof buildServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('returns a versioned fail-closed health snapshot', async () => {
    const server = buildServer();
    servers.push(server);
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '127.0.0.1:4317' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        status: 'recovery-only',
        writeGate: {
          status: 'blocked',
          missing: ['profile', 'database'],
          fingerprintMatches: false
        }
      },
      version: 1
    });
  });
});
