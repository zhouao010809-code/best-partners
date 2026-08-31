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
        plugin: {
          status: 'unavailable',
          reason: 'PLUGIN_UNAVAILABLE'
        },
        index: {
          status: 'unavailable',
          reason: 'READ_API_UNAVAILABLE'
        },
        model: {
          status: 'unavailable',
          reason: 'CONFIG_UNAVAILABLE'
        },
        writeGate: {
          status: 'blocked',
          missing: ['profile', 'database'],
          fingerprintMatches: false
        },
        schemaIssues: {
          status: 'unavailable',
          count: 0,
          reason: 'INDEX_UNAVAILABLE'
        }
      },
      version: 1
    });
  });

  it.each([
    {
      name: 'building',
      status: 'ready' as const,
      index: { status: 'building' as const, version: 0, startedAt: '2026-09-01T00:00:00.000Z' }
    },
    {
      name: 'recovery unavailable',
      status: 'recovery-only' as const,
      index: { status: 'unavailable' as const, reason: 'RECOVERY_ONLY' as const }
    }
  ])('strictly exposes a fail-closed $name index state', async ({ status, index }) => {
    const server = buildServer({
      healthService: {
        getSnapshot: async () => ({
          status,
          plugin: { status: 'unavailable', reason: 'PLUGIN_UNAVAILABLE' },
          writeGate: {
            status: 'blocked',
            missing: ['database'],
            fingerprintMatches: false
          },
          index,
          model: { status: 'unavailable', reason: 'CONFIG_UNAVAILABLE' },
          schemaIssues: {
            status: 'unavailable',
            count: 0,
            reason: 'INDEX_UNAVAILABLE'
          }
        })
      }
    });
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '127.0.0.1:4317' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { status, index }, version: 1 });
  });
});
