import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import * as archiveModule from '../../src/server/archive/sandbox-native.js';
import * as databaseModule from '../../src/server/db/database.js';
import * as ingestionModule from '../../src/server/ingestion/ingestion-service.js';
import * as trashModule from '../../src/server/trash/trash-service.js';
import * as intakeTrashModule from '../../src/server/trash/intake-trash-service.js';
import * as attachmentModule from '../../src/server/attachments/service.js';
import * as extractionModule from '../../src/server/services/extraction-service.js';
import * as skillModule from '../../src/server/services/skill-catalog.js';
import { IndexScheduler } from '../../src/server/index/index-scheduler.js';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { createPersonalRuntimeComposition } from '../../src/server/runtime/personal-composition.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xiaozhao-runtime-composition-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const vaultRealRoot = join(root, 'vault');
  await mkdir(vaultRealRoot);
  const gateway = new FakeVaultGateway({});
  Object.assign(gateway, { probeReadiness: async () => ({ status: 'ready' as const }) });
  for (const path of RULE_BUNDLE_SOURCE_PATHS) gateway.mutateFixture(path, `fixture rule ${path}`);
  const identity = { dev: '1', ino: '2' };
  const ingestionPort = { rootIdentity: identity, close: vi.fn() };
  const trashPort = { rootIdentity: identity, close: vi.fn() };
  const intakeTrashPort = { rootIdentity: identity, close: vi.fn() };
  const archivePort = {
    root: vaultRealRoot, rootIdentity: identity,
    openIngestion: vi.fn(() => ingestionPort), openTrash: vi.fn(() => trashPort),
    openIntakeTrash: vi.fn(() => intakeTrashPort), close: vi.fn()
  };
  const ingestionService = { recover: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const trashService = { recover: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  // This service owns its borrowed port, unlike ingestion and document trash.
  const intakeTrashService = {
    recover: vi.fn(async () => {}),
    close: vi.fn(async () => { intakeTrashPort.close(); })
  };
  const attachmentService = { ready: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const extractionService = {
    settings: vi.fn(() => ({ available: true, configured: false, providerHost: 'api.deepseek.com' })),
    close: vi.fn(async () => {})
  };
  vi.spyOn(archiveModule, 'openPersonalArchive').mockReturnValue(archivePort as unknown as archiveModule.PersonalArchivePort);
  vi.spyOn(ingestionModule, 'createIngestionService').mockReturnValue(ingestionService as unknown as ingestionModule.IngestionService);
  vi.spyOn(trashModule, 'createTrashService').mockReturnValue(trashService as unknown as trashModule.TrashService);
  vi.spyOn(intakeTrashModule, 'createIntakeTrashService').mockReturnValue(intakeTrashService as unknown as ReturnType<typeof intakeTrashModule.createIntakeTrashService>);
  vi.spyOn(attachmentModule, 'createAttachmentService').mockReturnValue(attachmentService as unknown as attachmentModule.AttachmentService);
  vi.spyOn(extractionModule, 'createExtractionService').mockReturnValue(extractionService as unknown as extractionModule.ExtractionService);
  const openKernel = vi.spyOn(databaseModule, 'openStateKernel');
  const stopIndex = vi.spyOn(IndexScheduler.prototype, 'stopAndWait');
  const config = {
    appDataDir: join(root, 'state'), vaultRealRoot, gateway, adapter: 'filesystem' as const,
    modelBaseUrl: 'https://models.invalid', personalArchiveAddonPath: '/isolated/fixture.node',
    modelCredentials: {
      status: () => ({ available: true, configured: false, revision: '1' }),
      getKey: () => '', setKey: () => {}, clear: () => {}
    }
  };
  return { config, openKernel, stopIndex, archivePort, ingestionPort, trashPort, intakeTrashPort,
    ingestionService, trashService, intakeTrashService, attachmentService, extractionService };
}

function containedErrors(error: unknown): unknown[] {
  return error instanceof AggregateError ? [error, ...error.errors.flatMap(containedErrors)] : [error];
}

it('releases every acquired resource when later capability construction fails', async () => {
  const f = await fixture();
  const failure = new Error('SKILL_INIT_FAILED');
  vi.spyOn(skillModule, 'createSkillCatalogService').mockImplementation(() => { throw failure; });

  await expect(createPersonalRuntimeComposition(f.config)).rejects.toBe(failure);

  for (const resource of [f.archivePort, f.ingestionPort, f.trashPort, f.intakeTrashPort,
    f.ingestionService, f.trashService, f.intakeTrashService, f.attachmentService, f.extractionService]) {
    expect(resource.close).toHaveBeenCalledOnce();
  }
  expect(f.stopIndex).toHaveBeenCalledOnce();
  const kernel = f.openKernel.mock.results[0]!.value as databaseModule.StateKernel;
  expect(kernel.mode === 'normal' && kernel.db.open).toBe(false);
});

it('disposes successful composition once with services before scheduler, native handles, and database', async () => {
  const f = await fixture();
  const composition = await createPersonalRuntimeComposition(f.config);
  const kernel = f.openKernel.mock.results[0]!.value as databaseModule.NormalStateKernel;
  const closeKernel = vi.spyOn(kernel, 'close');

  await Promise.all([composition.dispose(), composition.dispose()]);

  for (const service of [f.ingestionService, f.trashService, f.intakeTrashService,
    f.attachmentService, f.extractionService]) {
    expect(service.close).toHaveBeenCalledOnce();
    expect(service.close.mock.invocationCallOrder[0]).toBeLessThan(f.stopIndex.mock.invocationCallOrder[0]!);
  }
  for (const port of [f.archivePort, f.ingestionPort, f.trashPort]) {
    expect(port.close).toHaveBeenCalledOnce();
    expect(f.stopIndex.mock.invocationCallOrder[0]).toBeLessThan(port.close.mock.invocationCallOrder[0]!);
    expect(port.close.mock.invocationCallOrder[0]).toBeLessThan(closeKernel.mock.invocationCallOrder[0]!);
  }
  // Intake-trash already owns its port and closes it while draining its service.
  expect(f.intakeTrashPort.close).toHaveBeenCalledOnce();
  expect(closeKernel).toHaveBeenCalledOnce();
  expect(kernel.db.open).toBe(false);
});

it.each(['ingestionService', 'trashService', 'intakeTrashService'] as const)(
  'continues startup rollback when %s recovery and cleanup both fail', async (serviceName) => {
    const f = await fixture();
    const failure = new Error('RECOVERY_FAILED'), cleanupFailure = new Error('ROLLBACK_FAILED');
    f[serviceName].recover.mockRejectedValue(failure);
    f[serviceName].close.mockImplementation(async () => {
      if (serviceName === 'intakeTrashService') f.intakeTrashPort.close();
      throw cleanupFailure;
    });

    const result = await createPersonalRuntimeComposition(f.config).then(() => undefined, error => error);

    expect(containedErrors(result)).toContain(failure);
    expect(containedErrors(result)).toContain(cleanupFailure);
    expect(f[serviceName].close).toHaveBeenCalledOnce();
    expect(f.archivePort.close).toHaveBeenCalledOnce();
    expect(f.ingestionPort.close).toHaveBeenCalledOnce();
    expect(f.extractionService.close).toHaveBeenCalledOnce();
    expect(f.stopIndex).toHaveBeenCalledOnce();
    const kernel = f.openKernel.mock.results[0]!.value as databaseModule.StateKernel;
    expect(kernel.mode === 'normal' && kernel.db.open).toBe(false);
  }
);
