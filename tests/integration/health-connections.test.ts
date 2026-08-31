import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import type { NormalStateKernel } from '../../src/server/db/database.js';
import { createHealthService } from '../../src/server/services/health-service.js';

const roots: string[] = [];
const servers: Array<ReturnType<typeof buildServer>> = [];

async function normalKernel(): Promise<NormalStateKernel> {
  const root = await mkdtemp(join(tmpdir(), 'xiaozhao-health-connections-'));
  roots.push(root);
  const recoveryDir = join(root, 'recovery');
  await mkdir(recoveryDir);
  return {
    mode: 'normal',
    db: {} as NormalStateKernel['db'],
    path: join(root, 'state.sqlite3'),
    backupsDir: join(root, 'backups'),
    recoveryDir,
    close: () => {}
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GET /api/v1/health Connections contract', () => {
  it('exposes only safe plugin, model, index, write-gate, and schema issue data', async () => {
    const stateKernel = await normalKernel();
    const service = createHealthService({
      writeEnabled: false,
      gateway: {
        fingerprint: async () => ({
          pluginId: 'obsidian-local-rest-api',
          pluginVersion: '5.1.0',
          obsidianVersion: '1.13.7',
          apiKey: 'plugin-extra-secret'
        }),
        readOpenApi: async () => { throw new Error('profile unavailable'); }
      },
      profileDirectory: join(stateKernel.recoveryDir, '..', 'profiles'),
      stateKernel,
      indexState: {
        snapshot: () => ({
          status: 'ready' as const,
          version: 9,
          refreshedAt: '2026-09-01T12:00:00.000Z'
        })
      },
      model: {
        baseUrl: 'https://user:password@models.example:8443/v1?api_key=top-secret',
        name: 'deepseek-chat'
      },
      schemaIssues: { count: () => 3 }
    });
    const server = buildServer({ healthService: service });
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '127.0.0.1:4317' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        status: 'ready',
        plugin: {
          status: 'connected',
          pluginId: 'obsidian-local-rest-api',
          pluginVersion: '5.1.0',
          obsidianVersion: '1.13.7'
        },
        index: {
          status: 'ready',
          version: 9,
          refreshedAt: '2026-09-01T12:00:00.000Z'
        },
        model: {
          status: 'configured',
          providerHost: 'models.example:8443',
          name: 'deepseek-chat'
        },
        writeGate: {
          status: 'blocked',
          missing: ['profile', 'writeEnabled'],
          fingerprintMatches: false
        },
        schemaIssues: { status: 'available', count: 3 }
      },
      version: 1
    });
    expect(response.body).not.toContain('top-secret');
    expect(response.body).not.toContain('password');
    expect(response.body).not.toContain('api_key');
    expect(response.body).not.toContain('plugin-extra-secret');
  });

  it('returns complete unavailable states when dependencies are absent', async () => {
    const server = buildServer();
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '127.0.0.1:4317' }
    });

    expect(response.json()).toEqual({
      data: {
        status: 'recovery-only',
        plugin: { status: 'unavailable', reason: 'PLUGIN_UNAVAILABLE' },
        index: { status: 'unavailable', reason: 'READ_API_UNAVAILABLE' },
        model: { status: 'unavailable', reason: 'CONFIG_UNAVAILABLE' },
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

  it('fails closed on a malformed runtime plugin fingerprint without exposing extra fields', async () => {
    const stateKernel = await normalKernel();
    const secret = 'plugin-runtime-secret';
    const service = createHealthService({
      writeEnabled: false,
      gateway: {
        fingerprint: async () => ({ apiKey: secret }) as never,
        readOpenApi: async () => 'openapi: 3.0.0'
      },
      profileDirectory: join(roots[0] ?? tmpdir(), 'profiles'),
      stateKernel,
      indexState: {
        snapshot: () => ({
          status: 'building' as const,
          version: 0,
          startedAt: '2026-09-01T12:00:00.000Z'
        })
      },
      model: { baseUrl: 'https://models.example' },
      schemaIssues: { count: () => 0 }
    });
    const server = buildServer({ healthService: service });
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '127.0.0.1:4317' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { plugin: { status: 'unavailable', reason: 'PLUGIN_UNAVAILABLE' } }
    });
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain('apiKey');
  });

  it.each([
    {
      name: 'building',
      index: {
        status: 'building' as const,
        version: 0,
        startedAt: '2026-09-01T12:00:00.000Z'
      }
    },
    {
      name: 'failed',
      index: {
        status: 'failed' as const,
        version: 0,
        reason: 'upstream secret must stay private'
      }
    }
  ])('keeps schema issues unavailable while a normal-database index is $name', async ({ index }) => {
    const stateKernel = await normalKernel();
    let indexSnapshotCalls = 0;
    let schemaIssueCountCalls = 0;
    const service = createHealthService({
      writeEnabled: false,
      gateway: {
        fingerprint: async () => ({
          pluginId: 'obsidian-local-rest-api',
          pluginVersion: '5.1.0',
          obsidianVersion: '1.13.7'
        }),
        readOpenApi: async () => { throw new Error('profile unavailable'); }
      },
      profileDirectory: join(roots[0] ?? tmpdir(), 'profiles'),
      stateKernel,
      indexState: {
        snapshot: () => {
          indexSnapshotCalls += 1;
          return index;
        }
      },
      model: { baseUrl: 'https://models.example' },
      schemaIssues: {
        count: () => {
          schemaIssueCountCalls += 1;
          return 0;
        }
      }
    });
    const server = buildServer({ healthService: service });
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '127.0.0.1:4317' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        index: {
          status: index.status,
          version: index.version,
          ...(index.status === 'failed' ? { reason: 'INDEX_FAILED' } : {})
        },
        schemaIssues: {
          status: 'unavailable',
          count: 0,
          reason: 'INDEX_UNAVAILABLE'
        }
      }
    });
    expect(indexSnapshotCalls).toBe(1);
    expect(schemaIssueCountCalls).toBe(0);
  });
});
