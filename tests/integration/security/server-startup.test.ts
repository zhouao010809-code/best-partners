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
  return {
    config,
    normalKernel,
    gateway,
    healthService,
    loadConfig: vi.fn(),
    openStateKernel: vi.fn(),
    localRest51Gateway: vi.fn(),
    createHealthService: vi.fn(),
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
      stateKernel: startup.normalKernel
    });
    expect(startup.buildServer).toHaveBeenCalledWith({ healthService: startup.healthService });
    expect(startup.addHook).toHaveBeenCalledWith('onClose', expect.any(Function));
    expect(startup.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 4317 });
  });

  it('closes a normal state kernel from the Fastify onClose lifecycle', async () => {
    await importServerEntrypoint();
    const onClose = startup.addHook.mock.calls[0]?.[1] as (() => Promise<void>) | undefined;

    expect(onClose).toBeTypeOf('function');
    await onClose?.();

    expect(startup.normalKernel.close).toHaveBeenCalledOnce();
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
    const onClose = startup.addHook.mock.calls[0]?.[1] as (() => Promise<void>) | undefined;
    await onClose?.();

    expect(startup.normalKernel.close).toHaveBeenCalledOnce();
  });
});
