import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openStateKernel } from '../../src/server/db/database.js';
import { createDirectReadHealthService } from '../../src/server/services/health-service.js';
import { healthSnapshotSchema } from '../../src/shared/api/schemas.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('reports native reads and always blocks writes without approval or native write primitives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaozhao-direct-health-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const vaultRealRoot = join(root, 'vault');
  await mkdir(vaultRealRoot);
  const kernel = openStateKernel({ appDataDir: join(root, 'data'), vaultRealRoot });
  if (kernel.mode !== 'normal') throw new Error('fixture kernel unavailable');
  cleanup.push(() => kernel.close());
  const service = createDirectReadHealthService({
    stateKernel: kernel,
    indexState: { snapshot: () => ({ status: 'ready', version: 3, refreshedAt: '2026-09-05T00:00:00Z' }) },
    displayName: '测试大脑',
    probeReadiness: async () => ({ status: 'ready' }),
    schemaIssues: { count: () => 2 }
  });
  const snapshot = await service.getSnapshot();
  expect(healthSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  expect(snapshot).toMatchObject({
    status: 'ready',
    vaultSource: { status: 'ready', adapter: 'filesystem', displayName: '测试大脑' },
    writeGate: { status: 'blocked', missing: ['ruleApproval', 'nativeWritePrimitives', 'capabilityProfile', 'recoveryKernel'], fingerprintMatches: false, reasonCode: 'RULE_BUNDLE_UNAPPROVED' },
    schemaIssues: { status: 'available', count: 2 }
  });
  expect(JSON.stringify(snapshot)).not.toContain(root);
  await writeFile(join(kernel.recoveryDir, 'pending-operation'), 'pending');
  expect(await service.getSnapshot()).toMatchObject({
    status: 'recovery-only', index: { status: 'unavailable', reason: 'RECOVERY_ONLY' },
    writeGate: { status: 'blocked' }
  });
});

it('keeps corrupted state read-only and never exposes path-like display names', async () => {
  const snapshot = await createDirectReadHealthService({
    stateKernel: { mode: 'recovery-only', reason: 'database-corrupt', recovery: { entries: [], count: 0 } },
    indexState: { snapshot: () => { throw new Error('must not inspect index'); } },
    displayName: '/private/vault'
  }).getSnapshot();
  expect(snapshot.status).toBe('recovery-only');
  expect(JSON.stringify(snapshot)).not.toContain('/private/vault');
});

it('coalesces concurrent health probes and reuses results for one second', async () => {
  vi.useFakeTimers();
  let release!: (value: { status: 'ready' }) => void;
  const probe = vi.fn(() => new Promise<{ status: 'ready' }>((resolve) => { release = resolve; }));
  const service = createDirectReadHealthService({
    stateKernel: { mode: 'recovery-only', reason: 'database-corrupt', recovery: { entries: [], count: 0 } },
    indexState: { snapshot: () => { throw new Error('must not inspect index'); } },
    displayName: 'fixture', probeReadiness: probe
  });
  const requests = Array.from({ length: 20 }, () => service.getSnapshot());
  await Promise.resolve();
  expect(probe).toHaveBeenCalledTimes(1);
  release({ status: 'ready' });
  await Promise.all(requests);
  await service.getSnapshot();
  expect(probe).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_001);
  const next = service.getSnapshot();
  await Promise.resolve();
  expect(probe).toHaveBeenCalledTimes(2);
  release({ status: 'ready' });
  await next;
});

it('bounds probe duration and does not spawn more probes while an aborted probe remains unsettled', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const probe = vi.fn((received: AbortSignal) => {
    signal = received;
    return new Promise<never>(() => {});
  });
  const service = createDirectReadHealthService({
    stateKernel: { mode: 'recovery-only', reason: 'database-corrupt', recovery: { entries: [], count: 0 } },
    indexState: { snapshot: () => { throw new Error('must not inspect index'); } },
    displayName: 'fixture', probeReadiness: probe
  });
  const pending = service.getSnapshot();
  await vi.advanceTimersByTimeAsync(2_000);
  expect((await pending).vaultSource).toEqual({ status: 'unavailable', reason: 'VAULT_UNAVAILABLE' });
  expect(signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000);
  await service.getSnapshot();
  expect(probe).toHaveBeenCalledTimes(1);
});
