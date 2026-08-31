import { afterEach, describe, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => ({
  buildServer: vi.fn(),
  listen: vi.fn(async () => 'http://127.0.0.1:4317')
}));

vi.mock('../../../src/server/app.js', () => ({
  buildServer: startup.buildServer
}));

async function importServerEntrypoint(): Promise<void> {
  vi.resetModules();
  startup.buildServer.mockReturnValue({ listen: startup.listen });
  await import('../../../src/server/index.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('server listen boundary', () => {
  it.each([
    ['APP_HOST', '0.0.0.0', '4317'],
    ['APP_PORT', '127.0.0.1', '4318'],
    ['APP_PORT', '127.0.0.1', 'not-a-port']
  ])('rejects invalid %s before constructing or listening', async (field, host, port) => {
    vi.stubEnv('APP_HOST', host);
    vi.stubEnv('APP_PORT', port);

    await expect(importServerEntrypoint()).rejects.toThrow(field);
    expect(startup.buildServer).not.toHaveBeenCalled();
    expect(startup.listen).not.toHaveBeenCalled();
  });

  it('listens only on the fixed loopback host and port', async () => {
    vi.stubEnv('APP_HOST', '127.0.0.1');
    vi.stubEnv('APP_PORT', '4317');

    await importServerEntrypoint();

    expect(startup.buildServer).toHaveBeenCalledOnce();
    expect(startup.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 4317 });
  });
});
