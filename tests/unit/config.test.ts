import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/server/config.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function validEnvironment(overrides: Record<string, string | undefined> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'xiaozhao-brain-console-'));
  temporaryRoots.push(root);
  const vault = join(root, 'vault');
  const appData = join(root, 'app-data');
  mkdirSync(vault);
  mkdirSync(appData);

  return {
    APP_HOST: '127.0.0.1',
    APP_PORT: '4317',
    APP_DATA_DIR: appData,
    VAULT_REAL_ROOT: vault,
    OBSIDIAN_API_URL: 'https://127.0.0.1:27124',
    OBSIDIAN_API_KEY: 'obsidian-test-secret',
    MODEL_BASE_URL: 'https://api.deepseek.com',
    MODEL_NAME: '',
    MODEL_API_KEY: '',
    ...overrides
  };
}

describe('loadConfig', () => {
  it('defaults WRITE_ENABLED to false when it is omitted', () => {
    const environment = validEnvironment();
    delete environment.WRITE_ENABLED;

    expect(loadConfig(environment).writeEnabled).toBe(false);
  });

  it('requires the exact loopback host', () => {
    expect(() => loadConfig(validEnvironment({ APP_HOST: 'localhost' })))
      .toThrowError('APP_HOST');
  });

  it('requires a non-empty Obsidian API key', () => {
    expect(() => loadConfig(validEnvironment({ OBSIDIAN_API_KEY: '' })))
      .toThrowError('OBSIDIAN_API_KEY');
  });

  it('requires a model key when a model name is configured', () => {
    expect(() => loadConfig(validEnvironment({ MODEL_NAME: 'deepseek-chat', MODEL_API_KEY: '' })))
      .toThrowError('MODEL_API_KEY');
  });

  it('allows an omitted model name and key', () => {
    const environment = validEnvironment();
    delete environment.MODEL_NAME;
    delete environment.MODEL_API_KEY;

    expect(() => loadConfig(environment)).not.toThrow();
  });

  it('rejects an app data directory inside the vault', () => {
    const environment = validEnvironment();
    const appData = join(environment.VAULT_REAL_ROOT, 'app-data');
    mkdirSync(appData);

    expect(() => loadConfig({ ...environment, APP_DATA_DIR: appData }))
      .toThrowError('APP_DATA_DIR');
  });

  it('rejects a vault root inside the app data directory', () => {
    const environment = validEnvironment();
    const vault = join(environment.APP_DATA_DIR, 'vault');
    mkdirSync(vault);

    expect(() => loadConfig({ ...environment, VAULT_REAL_ROOT: vault }))
      .toThrowError('VAULT_REAL_ROOT');
  });

  it('does not disclose supplied secret values in validation errors', () => {
    const secret = 'do-not-disclose-this-secret';
    let thrown: unknown;
    try {
      loadConfig(validEnvironment({ APP_HOST: 'localhost', OBSIDIAN_API_KEY: secret }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(secret);
  });
});
