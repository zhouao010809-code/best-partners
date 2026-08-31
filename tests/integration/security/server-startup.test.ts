import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => {
  const config = {
    appHost: '127.0.0.1',
    appPort: 4317,
    appDataDir: '/tmp/xiaozhao-app-data',
    vaultRealRoot: '/tmp/xiaozhao-vault',
    obsidianApiUrl: 'https://127.0.0.1:27124',
    obsidianApiKey: 'test-api-key',
    modelBaseUrl: 'https://model.invalid',
    writeEnabled: false
  } as const;
  const normalKernel = {
    mode: 'normal' as const,
    db: {},
    path: '/tmp/xiaozhao-app-data/state.sqlite3',
    backupsDir: '/tmp/xiaozhao-app-data/backups',
    recoveryDir: '/tmp/xiaozhao-app-data/recovery',
    close: vi.fn()
  };
  const gateway = { name: 'gateway' };
  const healthService = { getSnapshot: vi.fn() };
  const repository = { name: 'repository' };
  const indexer = { version: 0, refresh: vi.fn() };
  const indexState = { name: 'index-state' };
  const indexScheduler = {
    start: vi.fn(),
    requestFocusRefresh: vi.fn(),
    stopAndWait: vi.fn(),
    snapshot: vi.fn()
  };
  return {
    config,
    normalKernel,
    gateway,
    healthService,
    loadConfig: vi.fn(),
    openStateKernel: vi.fn(),
    localRest51Gateway: vi.fn(),
    createHealthService: vi.fn(),
    createIndexRepository: vi.fn(),
    searchIndexer: vi.fn(),
    indexStateController: vi.fn(),
    indexSchedulerConstructor: vi.fn(),
    loadPersistedIndexVersion: vi.fn(),
    repository,
    indexer,
    indexState,
    indexScheduler,
    buildServer: vi.fn(),
    addHook: vi.fn(),
    listen: vi.fn()
  };
});

vi.mock('../../../src/server/config.js', () => ({
  loadConfig: startup.loadConfig
}));

vi.mock('../../../src/server/db/database.js', () => ({
  openStateKernel: startup.openStateKernel
}));

vi.mock('../../../src/server/vault/LocalRest51Gateway.js', () => ({
  LocalRest51Gateway: class {
    constructor(...args: unknown[]) {
      return startup.localRest51Gateway(...args);
    }
  }
}));

vi.mock('../../../src/server/services/health-service.js', () => ({
  createHealthService: startup.createHealthService
}));

vi.mock('../../../src/server/index/index-repository.js', () => ({
  createIndexRepository: startup.createIndexRepository
}));

vi.mock('../../../src/server/index/SearchIndexer.js', () => ({
  SearchIndexer: class {
    constructor(...args: unknown[]) {
      return startup.searchIndexer(...args);
    }
  }
}));

vi.mock('../../../src/server/index/index-state.js', () => ({
  IndexStateController: class {
    constructor(...args: unknown[]) {
      return startup.indexStateController(...args);
    }
  }
}));

vi.mock('../../../src/server/index/index-scheduler.js', () => ({
  IndexScheduler: class {
    constructor(...args: unknown[]) {
      return startup.indexSchedulerConstructor(...args);
    }
  }
}));

vi.mock('../../../src/server/services/index-job-service.js', () => ({
  loadPersistedIndexVersion: startup.loadPersistedIndexVersion
}));

vi.mock('../../../src/server/app.js', () => ({
  buildServer: startup.buildServer
}));

async function importServerEntrypoint(): Promise<void> {
  vi.resetModules();
  await import('../../../src/server/index.js');
}

beforeEach(() => {
  startup.loadConfig.mockReturnValue(startup.config);
  startup.openStateKernel.mockReturnValue(startup.normalKernel);
  startup.localRest51Gateway.mockReturnValue(startup.gateway);
  startup.createHealthService.mockReturnValue(startup.healthService);
  startup.createIndexRepository.mockReturnValue(startup.repository);
  startup.searchIndexer.mockReturnValue(startup.indexer);
  startup.indexStateController.mockReturnValue(startup.indexState);
  startup.indexSchedulerConstructor.mockReturnValue(startup.indexScheduler);
  startup.loadPersistedIndexVersion.mockReturnValue(4);
  startup.indexer.version = 0;
  startup.indexer.refresh.mockResolvedValue({ status: 'ready', checked: 1, total: 1, version: 5 });
  startup.indexScheduler.requestFocusRefresh.mockResolvedValue(undefined);
  startup.indexScheduler.stopAndWait.mockResolvedValue(undefined);
  startup.buildServer.mockReturnValue({
    addHook: startup.addHook,
    listen: startup.listen
  });
  startup.listen.mockResolvedValue('http://127.0.0.1:4317');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('server listen boundary', () => {
  it.each([
    ['APP_HOST', '0.0.0.0', '4317'],
    ['APP_PORT', '127.0.0.1', '4318'],
    ['APP_PORT', '127.0.0.1', 'not-a-port']
  ])('rejects invalid %s before config, state, construction, or listening', async (
    field,
    host,
    port
  ) => {
    vi.stubEnv('APP_HOST', host);
    vi.stubEnv('APP_PORT', port);

    await expect(importServerEntrypoint()).rejects.toThrow(field);
    expect(startup.loadConfig).not.toHaveBeenCalled();
    expect(startup.openStateKernel).not.toHaveBeenCalled();
    expect(startup.localRest51Gateway).not.toHaveBeenCalled();
    expect(startup.buildServer).not.toHaveBeenCalled();
    expect(startup.listen).not.toHaveBeenCalled();
  });

  it('wires exact config, state, gateway, profile directory, and health dependencies', async () => {
    vi.stubEnv('APP_HOST', '127.0.0.1');
    vi.stubEnv('APP_PORT', '4317');

    await importServerEntrypoint();

    expect(startup.loadConfig).toHaveBeenCalledWith(process.env);
    expect(startup.openStateKernel).toHaveBeenCalledWith({
      appDataDir: startup.config.appDataDir,
      vaultRealRoot: startup.config.vaultRealRoot
    });
    expect(startup.localRest51Gateway).toHaveBeenCalledWith(
      startup.config.obsidianApiUrl,
      startup.config.obsidianApiKey,
      fetch
    );
    expect(startup.createHealthService).toHaveBeenCalledWith({
      writeEnabled: false,
      gateway: startup.gateway,
      profileDirectory: '/tmp/xiaozhao-app-data/contract-profiles',
      stateKernel: startup.normalKernel,
      indexState: { snapshot: expect.any(Function) }
    });
    expect(startup.createIndexRepository).toHaveBeenCalledWith(startup.normalKernel.db);
    expect(startup.loadPersistedIndexVersion).toHaveBeenCalledWith(startup.normalKernel.db, 0);
    expect(startup.searchIndexer).toHaveBeenCalledWith({
      gateway: startup.gateway,
      repository: startup.repository,
      maxRawReadsPerPoll: 50
    });
    expect(startup.indexer.version).toBe(4);
    expect(startup.buildServer).toHaveBeenCalledWith({
      healthService: startup.healthService,
      onClose: expect.any(Function),
      readApi: expect.objectContaining({
        repository: startup.repository,
        gateway: startup.gateway,
        database: startup.normalKernel.db,
        indexScheduler: startup.indexScheduler,
        currentIndexVersion: expect.any(Function)
      })
    });
    expect(startup.indexScheduler.start).toHaveBeenCalledOnce();
    expect(startup.indexScheduler.requestFocusRefresh).toHaveBeenCalledOnce();
    expect(startup.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 4317 });
  });

  it('closes a normal state kernel from the Fastify onClose lifecycle', async () => {
    await importServerEntrypoint();
    const options = startup.buildServer.mock.calls[0]?.[0] as {
      onClose?: () => Promise<void>;
    } | undefined;
    const onClose = options?.onClose;

    expect(onClose).toBeTypeOf('function');
    await onClose?.();

    expect(startup.indexScheduler.stopAndWait).toHaveBeenCalledOnce();
    expect(startup.normalKernel.close).toHaveBeenCalledOnce();
    expect(startup.indexScheduler.stopAndWait.mock.invocationCallOrder[0])
      .toBeLessThan(startup.normalKernel.close.mock.invocationCallOrder[0]!);
  });

  it('keeps recovery-only startup read-safe without constructing index database dependencies', async () => {
    startup.openStateKernel.mockReturnValueOnce({
      mode: 'recovery-only',
      reason: 'database-corrupt',
      recovery: { entries: [], count: 0 }
    });

    await importServerEntrypoint();

    expect(startup.createIndexRepository).not.toHaveBeenCalled();
    expect(startup.searchIndexer).not.toHaveBeenCalled();
    expect(startup.indexSchedulerConstructor).not.toHaveBeenCalled();
    expect(startup.buildServer).toHaveBeenCalledWith({
      healthService: startup.healthService,
      onClose: expect.any(Function)
    });
    expect(startup.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 4317 });
  });

  it('closes a normal state kernel when gateway construction fails', async () => {
    startup.localRest51Gateway.mockImplementationOnce(() => {
      throw new Error('gateway construction failed');
    });

    await expect(importServerEntrypoint()).rejects.toThrow('gateway construction failed');

    expect(startup.normalKernel.close).toHaveBeenCalledOnce();
    expect(startup.buildServer).not.toHaveBeenCalled();
  });

  it('closes a normal state kernel once when listen and later onClose both run cleanup', async () => {
    startup.listen.mockRejectedValueOnce(new Error('listen failed'));

    await expect(importServerEntrypoint()).rejects.toThrow('listen failed');
    const options = startup.buildServer.mock.calls[0]?.[0] as {
      onClose?: () => Promise<void>;
    } | undefined;
    const onClose = options?.onClose;
    await onClose?.();

    expect(startup.normalKernel.close).toHaveBeenCalledOnce();
  });
});
