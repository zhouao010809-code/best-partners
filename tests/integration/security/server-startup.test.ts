import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => ({
  buildServer: vi.fn(),
  createCompanyRuntime: vi.fn(),
  loadConfig: vi.fn(),
  startServer: vi.fn(),
  localRest51Gateway: vi.fn(),
  companyRuntime: { workspace: { id: 'company' } },
  companyApp: { listen: vi.fn() },
  gateway: { fixture: 'legacy-gateway' },
  config: {
    appHost: '127.0.0.1', appPort: 4317, appDataDir: '/tmp/xiaozhao-app-data',
    vaultRealRoot: '/tmp/xiaozhao-vault', obsidianApiUrl: 'https://127.0.0.1:27124',
    obsidianApiKey: 'fixture-api-key', modelBaseUrl: 'https://model.invalid',
    modelName: 'fixture-model', modelApiKey: 'model-secret-must-not-be-wired-to-health', writeEnabled: false
  }
}));

vi.mock('../../../src/server/app.js', () => ({ buildServer: startup.buildServer }));
vi.mock('../../../src/server/company/company-runtime.js', () => ({
  createCompanyRuntime: startup.createCompanyRuntime
}));
vi.mock('../../../src/server/config.js', () => ({ loadConfig: startup.loadConfig }));
vi.mock('../../../src/server/start-server.js', () => ({ startServer: startup.startServer }));
vi.mock('../../../src/server/vault/LocalRest51Gateway.js', () => ({
  LocalRest51Gateway: class { constructor(...args: unknown[]) { return startup.localRest51Gateway(...args); } }
}));

async function importEntrypoint() { vi.resetModules(); await import('../../../src/server/index.js'); }

beforeEach(() => {
  startup.buildServer.mockReturnValue(startup.companyApp);
  startup.createCompanyRuntime.mockReturnValue(startup.companyRuntime);
  startup.loadConfig.mockReturnValue(startup.config);
  startup.localRest51Gateway.mockReturnValue(startup.gateway);
  startup.startServer.mockResolvedValue({ origin: 'http://127.0.0.1:4317', port: 4317, close: vi.fn() });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('legacy CLI startup adapter', () => {
  it.each([
    ['APP_HOST', '0.0.0.0', '4317'], ['APP_PORT', '127.0.0.1', '4318'], ['APP_PORT', '127.0.0.1', 'not-a-port']
  ])('rejects invalid %s before config or construction', async (field, host, port) => {
    vi.stubEnv('APP_HOST', host);
    vi.stubEnv('APP_PORT', port);
    await expect(importEntrypoint()).rejects.toThrow(field);
    expect(startup.loadConfig).not.toHaveBeenCalled();
    expect(startup.localRest51Gateway).not.toHaveBeenCalled();
    expect(startup.startServer).not.toHaveBeenCalled();
  });

  it('delegates fixed local binding and private legacy configuration without model credentials', async () => {
    await importEntrypoint();
    expect(startup.localRest51Gateway).toHaveBeenCalledWith(startup.config.obsidianApiUrl, startup.config.obsidianApiKey, fetch);
    expect(startup.startServer).toHaveBeenCalledWith({
      host: '127.0.0.1', port: 4317, appDataDir: startup.config.appDataDir,
      vaultRealRoot: startup.config.vaultRealRoot, gateway: startup.gateway, adapter: 'local-rest',
      clientRoot: expect.stringMatching(/dist\/client$/u), modelBaseUrl: 'https://model.invalid', modelName: 'fixture-model',
      legacyHealth: { gateway: startup.gateway, writeEnabled: false, profileDirectory: '/tmp/xiaozhao-app-data/contract-profiles', development: false }
    });
    expect(JSON.stringify(startup.startServer.mock.calls[0])).not.toContain(startup.config.modelApiKey);
  });

  it('starts company mode without loading personal configuration or constructing Local REST', async () => {
    vi.stubEnv('RUNTIME_MODE', 'company');
    vi.stubEnv('APP_HOST', '127.0.0.1');
    vi.stubEnv('APP_PORT', '4317');
    vi.stubEnv('COMPANY_WORKSPACE_ROOT', '/srv/company-workspace');

    await importEntrypoint();

    expect(startup.loadConfig).not.toHaveBeenCalled();
    expect(startup.localRest51Gateway).not.toHaveBeenCalled();
    expect(startup.startServer).not.toHaveBeenCalled();
    expect(startup.createCompanyRuntime).toHaveBeenCalledWith({
      workspaceRoot: '/srv/company-workspace'
    });
    expect(startup.buildServer).toHaveBeenCalledWith({
      runtimeMode: 'company',
      companyRuntime: startup.companyRuntime
    });
    expect(startup.companyApp.listen).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 4317
    });
  });

  it('allows the known development UI origin only under explicit development mode', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    await importEntrypoint();
    expect(startup.startServer).toHaveBeenCalledWith(expect.objectContaining({ legacyHealth: expect.objectContaining({ development: true }) }));
  });

  it('does not open a runtime when constructing the legacy gateway fails', async () => {
    startup.localRest51Gateway.mockImplementationOnce(() => { throw new Error('fixture gateway failure'); });
    await expect(importEntrypoint()).rejects.toThrow('fixture gateway failure');
    expect(startup.startServer).not.toHaveBeenCalled();
  });

  it('propagates runtime startup failure', async () => {
    startup.startServer.mockRejectedValueOnce(new Error('fixture listen failure'));
    await expect(importEntrypoint()).rejects.toThrow('fixture listen failure');
  });
});
