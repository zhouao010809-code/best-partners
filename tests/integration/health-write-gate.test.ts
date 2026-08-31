import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server/app.js';
import type { NormalStateKernel, StateKernel } from '../../src/server/db/database.js';
import { createHealthService } from '../../src/server/services/health-service.js';
import {
  buildContractProfile,
  type ContractEvidence,
  type ContractFingerprint,
  type ContractProfileInput,
  writeContractProfile
} from '../../src/server/vault/contract-profile-store.js';
import type { VaultGateway } from '../../src/server/vault/VaultGateway.js';

const HOST = '127.0.0.1:4317';
const CHECKED_AT = '2026-08-31T00:00:00.000Z';
const OPEN_API = 'openapi: 3.0.0\ninfo:\n  title: Local REST API\n';
const FINGERPRINT = {
  pluginId: 'obsidian-local-rest-api',
  pluginVersion: '5.1.0',
  obsidianVersion: '1.13.7'
} as const;
const READY_INDEX = {
  status: 'ready' as const,
  version: 7,
  refreshedAt: CHECKED_AT
};
const CAPABILITY_ORDER = [
  'safeRead',
  'safeCreate',
  'safeReplace',
  'safeRestore',
  'safeDelete',
  'rereadVerified',
  'externalMutationObservation',
  'restartPersistence'
] as const;
const PRIMITIVES = {
  safeRead: 'RAW_REREAD',
  safeCreate: 'PUT_REJECT_IF_CONTENT_PREEXISTS',
  safeReplace: 'PATCH_IF_MATCH',
  safeRestore: 'PATCH_IF_MATCH',
  safeDelete: 'DELETE_NON_PERMANENT',
  rereadVerified: 'RAW_REREAD',
  externalMutationObservation: 'DIRECTORY_POLL',
  restartPersistence: 'RAW_REREAD'
} as const;

type HealthGateway = Pick<VaultGateway, 'fingerprint' | 'readOpenApi'>;

const roots: string[] = [];
const servers: Array<ReturnType<typeof buildServer>> = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xiaozhao-health-gate-'));
  roots.push(root);
  return root;
}

function openApiSha256(document = OPEN_API): string {
  return createHash('sha256').update(document, 'utf8').digest('hex');
}

function contractFingerprint(document = OPEN_API): ContractFingerprint {
  return { ...FINGERPRINT, openApiSha256: openApiSha256(document) };
}

function evidence(): ContractEvidence[] {
  return CAPABILITY_ORDER.map((operation) => ({
    operation,
    status: 'passed',
    timestamp: CHECKED_AT,
    reasonCode: operation === 'safeDelete'
      ? 'CONDITIONAL_NONPERMANENT_DELETE_VERIFIED'
      : 'EXECUTABLE_PROBE_PASSED',
    primitive: PRIMITIVES[operation]
  }));
}

function profileInput(
  overrides: Partial<ContractProfileInput> = {},
  document = OPEN_API
): ContractProfileInput {
  return {
    ...contractFingerprint(document),
    checkedAt: CHECKED_AT,
    safeRead: true,
    safeCreate: true,
    safeReplace: true,
    safeRestore: true,
    safeDelete: true,
    rereadVerified: true,
    externalMutationObservation: 'passed',
    restartPersistence: 'passed',
    evidence: evidence(),
    ...overrides
  };
}

function gateway(options: {
  readonly fingerprint?: typeof FINGERPRINT;
  readonly readOpenApi?: () => Promise<string>;
} = {}): HealthGateway {
  return {
    fingerprint: async () => options.fingerprint ?? FINGERPRINT,
    readOpenApi: options.readOpenApi ?? (async () => OPEN_API)
  };
}

function normalKernel(recoveryDir: string): StateKernel {
  return {
    mode: 'normal',
    db: {} as NormalStateKernel['db'],
    path: join(recoveryDir, '..', 'state.sqlite3'),
    backupsDir: join(recoveryDir, '..', 'backups'),
    recoveryDir,
    close: () => {}
  };
}

async function fixture(overrides: Partial<ContractProfileInput> = {}): Promise<{
  readonly profileDirectory: string;
  readonly recoveryDir: string;
  readonly stateKernel: StateKernel;
  readonly indexState: { snapshot(): typeof READY_INDEX };
}> {
  const root = await createRoot();
  const profileDirectory = join(root, 'profiles');
  const recoveryDir = join(root, 'recovery');
  await mkdir(recoveryDir, { mode: 0o700 });
  await writeContractProfile(profileDirectory, buildContractProfile(profileInput(overrides)));
  return {
    profileDirectory,
    recoveryDir,
    stateKernel: normalKernel(recoveryDir),
    indexState: { snapshot: () => READY_INDEX }
  };
}

async function healthResponse(input: Parameters<typeof createHealthService>[0]) {
  const server = buildServer({ healthService: createHealthService(input) });
  servers.push(server);
  const response = await server.inject({
    method: 'GET',
    url: '/api/v1/health',
    headers: { host: HOST }
  });
  expect(response.statusCode).toBe(200);
  return response.json<unknown>();
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GET /api/v1/health write gate', () => {
  it('reports the exact missing executable capabilities and WRITE_ENABLED cannot override them', async () => {
    const context = await fixture({
      safeCreate: false,
      safeDelete: false,
      restartPersistence: 'failed'
    });

    await expect(healthResponse({
      writeEnabled: true,
      gateway: gateway(),
      ...context
    })).resolves.toEqual({
      data: {
        status: 'ready',
        index: READY_INDEX,
        writeGate: {
          status: 'blocked',
          missing: ['safeCreate', 'safeDelete', 'restartPersistence'],
          fingerprintMatches: true
        }
      },
      version: 1
    });
  });

  it('requires both a passed field and the correct executable evidence primitive', async () => {
    const wrongEvidence = evidence().map((record) => record.operation === 'safeReplace'
      ? { ...record, primitive: 'RAW_REREAD' as const }
      : record);
    const context = await fixture({ evidence: wrongEvidence });

    await expect(healthResponse({
      writeEnabled: true,
      gateway: gateway(),
      ...context
    })).resolves.toMatchObject({
      data: {
        status: 'ready',
        writeGate: {
          status: 'blocked',
          missing: ['safeReplace'],
          fingerprintMatches: true
        }
      }
    });
  });

  it('enables writes only when configuration, contract, database, and recovery are all clear', async () => {
    const context = await fixture();

    await expect(healthResponse({
      writeEnabled: true,
      gateway: gateway(),
      ...context
    })).resolves.toMatchObject({
      data: {
        status: 'ready',
        writeGate: { status: 'enabled', missing: [], fingerprintMatches: true }
      }
    });

    await expect(healthResponse({
      writeEnabled: false,
      gateway: gateway(),
      ...context
    })).resolves.toMatchObject({
      data: {
        status: 'ready',
        writeGate: { status: 'blocked', missing: ['writeEnabled'], fingerprintMatches: true }
      }
    });
  });

  it('recomputes the fingerprint on every snapshot and rejects a stale exact profile', async () => {
    const context = await fixture();
    let document = OPEN_API;
    const mutableGateway = gateway({ readOpenApi: async () => document });
    const service = createHealthService({
      writeEnabled: true,
      gateway: mutableGateway,
      ...context
    });

    await expect(service.getSnapshot()).resolves.toMatchObject({
      writeGate: { fingerprintMatches: true }
    });
    document = `${OPEN_API}paths: {}\n`;
    await expect(service.getSnapshot()).resolves.toEqual({
      status: 'ready',
      index: READY_INDEX,
      writeGate: { status: 'blocked', missing: ['profile'], fingerprintMatches: false }
    });
  });

  it('fails closed without leaking upstream fingerprint errors', async () => {
    const context = await fixture();
    const secret = 'Authorization: Bearer top-secret /Users/ao/\u6211\u7684\u5927\u8111/private.md';
    const failingGateway: HealthGateway = {
      fingerprint: async () => { throw new Error(secret); },
      readOpenApi: async () => { throw new Error(secret); }
    };
    const snapshot = await createHealthService({
      writeEnabled: true,
      gateway: failingGateway,
      ...context
    }).getSnapshot();

    expect(snapshot).toEqual({
      status: 'ready',
      index: READY_INDEX,
      writeGate: { status: 'blocked', missing: ['profile'], fingerprintMatches: false }
    });
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(JSON.stringify(snapshot)).not.toContain('/Users/ao');
  });

  it('blocks in database recovery-only mode without returning recovery entry names', async () => {
    const context = await fixture();
    const secretEntry = 'private-recovery-entry';
    const stateKernel: StateKernel = {
      mode: 'recovery-only',
      reason: 'database-corrupt',
      recovery: { entries: [secretEntry], count: 1 }
    };
    const snapshot = await createHealthService({
      writeEnabled: true,
      gateway: gateway(),
      ...context,
      stateKernel
    }).getSnapshot();

    expect(snapshot).toEqual({
      status: 'recovery-only',
      index: { status: 'unavailable', reason: 'RECOVERY_ONLY' },
      writeGate: { status: 'blocked', missing: ['database'], fingerprintMatches: true }
    });
    expect(JSON.stringify(snapshot)).not.toContain(secretEntry);
  });

  it('blocks a normal database when recovery contains an entry without following symlinks', async () => {
    const context = await fixture();
    const target = join(await createRoot(), 'do-not-read.txt');
    await writeFile(target, 'MODEL_API_KEY=top-secret', { mode: 0o600 });
    const secretEntry = 'secret-recovery-link';
    await symlink(target, join(context.recoveryDir, secretEntry));

    const snapshot = await createHealthService({
      writeEnabled: true,
      gateway: gateway(),
      ...context
    }).getSnapshot();

    expect(snapshot).toEqual({
      status: 'recovery-only',
      index: { status: 'unavailable', reason: 'RECOVERY_ONLY' },
      writeGate: { status: 'blocked', missing: ['recovery'], fingerprintMatches: true }
    });
    expect(JSON.stringify(snapshot)).not.toContain(secretEntry);
    expect(JSON.stringify(snapshot)).not.toContain('top-secret');
  });

  it('fails closed when a normal database recovery directory cannot be scanned', async () => {
    const context = await fixture();
    const missingRecoveryDir = join(await createRoot(), 'missing-recovery');

    await expect(createHealthService({
      writeEnabled: true,
      gateway: gateway(),
      ...context,
      stateKernel: normalKernel(missingRecoveryDir)
    }).getSnapshot()).resolves.toEqual({
      status: 'recovery-only',
      index: { status: 'unavailable', reason: 'RECOVERY_ONLY' },
      writeGate: { status: 'blocked', missing: ['recovery'], fingerprintMatches: true }
    });
  });

  it('uses the same fail-closed snapshot shape when no health service is injected', async () => {
    const server = buildServer();
    servers.push(server);
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: HOST }
    });

    expect(response.json()).toEqual({
      data: {
        status: 'recovery-only',
        index: { status: 'unavailable', reason: 'READ_API_UNAVAILABLE' },
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
