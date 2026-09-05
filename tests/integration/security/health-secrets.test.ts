import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/server/app.js';
import type { NormalStateKernel } from '../../../src/server/db/database.js';
import { createHealthService } from '../../../src/server/services/health-service.js';

const roots: string[] = [];
const servers: Array<ReturnType<typeof buildServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('health secret containment', () => {
  it('fails closed when Connections sources throw without reflecting error text or URL credentials', async () => {
    const secret = 'MODEL_API_KEY=health-super-secret';
    const root = await mkdtemp(join(tmpdir(), 'xiaozhao-health-secret-'));
    roots.push(root);
    const recoveryDir = join(root, 'recovery');
    await mkdir(recoveryDir);
    const stateKernel: NormalStateKernel = {
      mode: 'normal',
      db: {} as NormalStateKernel['db'],
      path: join(root, 'state.sqlite3'),
      backupsDir: join(root, 'backups'),
      recoveryDir,
      close: () => {}
    };
    const server = buildServer({
      healthService: createHealthService({
        writeEnabled: false,
        gateway: {
          fingerprint: async () => { throw new Error(secret); },
          readOpenApi: async () => { throw new Error(secret); }
        },
        profileDirectory: join(root, 'profiles'),
        stateKernel,
        indexState: {
          snapshot: () => ({
            status: 'stale' as const,
            version: 4,
            lastSuccessAt: '2026-09-01T12:00:00.000Z',
            reason: secret
          })
        },
        model: {
          baseUrl: 'https://user:health-url-secret@models.example/v1?token=health-query-secret'
        },
        schemaIssues: { count: () => { throw new Error(secret); } }
      })
    });
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '127.0.0.1:4317' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        vaultSource: { status: 'unavailable', reason: 'VAULT_UNAVAILABLE' },
        index: {
          status: 'stale',
          version: 4,
          lastSuccessAt: '2026-09-01T12:00:00.000Z',
          reason: 'INDEX_STALE'
        },
        model: { status: 'unconfigured', providerHost: 'models.example' },
        schemaIssues: {
          status: 'unavailable',
          count: 0,
          reason: 'SCHEMA_ISSUES_UNAVAILABLE'
        }
      }
    });
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain('health-url-secret');
    expect(response.body).not.toContain('health-query-secret');
    expect(response.body).not.toContain('token');
  });
});
