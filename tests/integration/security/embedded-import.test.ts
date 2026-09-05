import { expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ openStateKernel: vi.fn(), loadConfig: vi.fn(), legacyConstructor: vi.fn() }));
vi.mock('../../../src/server/db/database.js', () => ({ openStateKernel: effects.openStateKernel }));
vi.mock('../../../src/server/config.js', () => ({ loadConfig: effects.loadConfig }));
vi.mock('../../../src/server/vault/LocalRest51Gateway.js', () => ({ LocalRest51Gateway: effects.legacyConstructor }));

it('imports the embedded runtime without reading environment config, opening a database, or constructing Local REST', async () => {
  const runtime = await import('../../../src/server/start-server.js');
  expect(runtime.startServer).toBeTypeOf('function');
  expect(effects.openStateKernel).not.toHaveBeenCalled();
  expect(effects.loadConfig).not.toHaveBeenCalled();
  expect(effects.legacyConstructor).not.toHaveBeenCalled();
});
