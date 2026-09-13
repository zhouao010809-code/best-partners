import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';
import { createExtractionService } from '../../src/server/services/extraction-service.js';
import { ModelCredentialsError } from '../../src/server/ai/model-credentials.js';
import { DeepSeekConnectionError } from '../../src/server/ai/deepseek-connection.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture() {
  const database = new Database(':memory:'); applyMigrations(database);
  const gateway = new FakeVaultGateway({ '01图书馆/private.md': 'must never read or send' });
  let revision = 1; let key = 'test-only-key'; let problem: string | undefined;
  const credentials = { status: () => ({ available: true, configured: !!key && !problem, revision: String(revision), ...(problem ? { problem } : {}) }),
    getKey: vi.fn(() => key), setKey: vi.fn((next: string) => { key = next; revision++; problem = undefined; }), clear: vi.fn(() => { key = ''; revision++; problem = undefined; }) };
  const verify = vi.fn(async (_key: string, _signal: AbortSignal) => {});
  const generate = vi.fn(async () => ({}));
  const create = () => createExtractionService({ database, repository: createIndexRepository(database), gateway, credentials,
    provider: { generate }, connectionVerifier: { verify }, now: () => new Date('2026-09-09T03:00:00.000Z') });
  const service = create(); cleanup.push(async () => { await service.close(); database.close(); });
  return { service, create, database, gateway, credentials, verify, generate, corrupt: () => { problem = new ModelCredentialsError('STORAGE_FAILED').message; } };
}

it('preserves a damaged credential store as an actionable problem, not a never-configured state', () => {
  const f = fixture(); f.corrupt();
  expect(f.service.settings()).toMatchObject({ available: true, configured: false, problem: '无法安全保存或读取 API Key，请重新配置。' });
});

it('verifies only on explicit invocation without vault reads, extraction runs or key mutations', async () => {
  const f = fixture(); expect(f.service.settings().verification).toBeUndefined(); expect(f.verify).not.toHaveBeenCalled();
  const settings = await f.service.verifyConnection();
  expect(settings.verification).toEqual({ status: 'verified', checkedAt: '2026-09-09T03:00:00.000Z', message: '连接验证成功，当前密钥和模型可以使用。' });
  expect(f.verify).toHaveBeenCalledExactlyOnceWith('test-only-key', expect.any(AbortSignal));
  expect(f.gateway.rawReadPaths).toEqual([]); expect(f.generate).not.toHaveBeenCalled();
  expect(f.service.list().items).toEqual([]); expect(f.credentials.setKey).not.toHaveBeenCalled(); expect(f.credentials.clear).not.toHaveBeenCalled();
  expect(f.service.settings()).toEqual(settings);
  await f.service.close(); const restarted = f.create(); expect(restarted.settings().verification).toBeUndefined(); await restarted.close();
});

it('deduplicates concurrent checks and clears prior results after either key mutation', async () => {
  const f = fixture(); let release!: () => void;
  f.verify.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  const a = f.service.verifyConnection(); const b = f.service.verifyConnection();
  await Promise.resolve(); expect(f.verify).toHaveBeenCalledTimes(1); release();
  expect(await a).toEqual(await b);
  expect(f.service.setKey('next-key').verification).toBeUndefined();
  f.verify.mockResolvedValue(); await f.service.verifyConnection();
  expect(f.service.clearKey()).toMatchObject({ configured: false }); expect(f.service.settings().verification).toBeUndefined();
});

it.each(['set', 'clear', 'external'] as const)('never publishes a stale result after %s key changes', async (action) => {
  const f = fixture(); let release!: () => void;
  f.verify.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  const pending = expect(f.service.verifyConnection()).rejects.toMatchObject({ code: 'MODEL_VERIFICATION_STALE' });
  await Promise.resolve();
  if (action === 'set') f.service.setKey('new-key');
  else if (action === 'clear') f.service.clearKey();
  else f.credentials.setKey('outside-change');
  release(); await pending; expect(f.service.settings().verification).toBeUndefined();
});

it('stores sanitized failure feedback and requires a saved readable key before trying', async () => {
  const f = fixture(); f.verify.mockRejectedValue(new Error('never return test-only-key or provider details'));
  const result = await f.service.verifyConnection();
  expect(result.verification).toMatchObject({ status: 'failed', message: '无法连接 DeepSeek，请检查网络连接或代理设置后重试。' });
  expect(JSON.stringify(result)).not.toContain('test-only-key');
  f.service.clearKey(); await expect(f.service.verifyConnection()).rejects.toMatchObject({ code: 'MODEL_KEY_REQUIRED' });
  f.corrupt(); await expect(f.service.verifyConnection()).rejects.toMatchObject({ code: 'MODEL_KEY_STORAGE_FAILED' });
  expect(f.verify).toHaveBeenCalledTimes(1);
});

it('cancels an in-flight verification when the service closes without preserving the result', async () => {
  const f = fixture(); f.verify.mockImplementation(() => new Promise<void>(() => {}));
  const pending = expect(f.service.verifyConnection()).rejects.toMatchObject({ code: 'MODEL_VERIFICATION_STALE' });
  await Promise.resolve(); await f.service.close(); await pending;
  expect(f.verify.mock.calls[0]?.[1].aborted).toBe(true); expect(f.service.settings().verification).toBeUndefined();
});

it('keeps a newer verification when an old transport finishes after the key changes', async () => {
  const f = fixture(); let release!: () => void;
  f.verify.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const old = expect(f.service.verifyConnection()).rejects.toMatchObject({ code: 'MODEL_VERIFICATION_STALE' });
  await Promise.resolve(); f.service.setKey('current-key');
  f.verify.mockRejectedValueOnce(new DeepSeekConnectionError('INSUFFICIENT_BALANCE'));
  const current = await f.service.verifyConnection();
  expect(current.verification).toMatchObject({ status: 'failed', message: 'DeepSeek 账户余额不足，请在 DeepSeek 平台补充余额后重新验证。' });
  release(); await old;
  expect(f.service.settings()).toEqual(current); expect(f.verify).toHaveBeenCalledTimes(2);
});

it('keeps the still-current verification when saving a replacement key fails before mutation', async () => {
  const f = fixture(); const saved = await f.service.verifyConnection();
  f.credentials.setKey.mockImplementationOnce(() => { throw new ModelCredentialsError('STORAGE_FAILED'); });
  expect(() => f.service.setKey('replacement')).toThrow('密钥未能安全保存');
  expect(f.service.settings()).toEqual(saved);
});

it('hides the previous successful result while a fresh verification is pending', async () => {
  const f = fixture(); await f.service.verifyConnection();
  expect(f.service.settings().verification?.status).toBe('verified');
  let reject!: (error: Error) => void;
  f.verify.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const pending = f.service.verifyConnection();
  await Promise.resolve();
  const whilePending = f.service.settings();
  reject(new DeepSeekConnectionError('INSUFFICIENT_BALANCE'));
  const result = await pending;
  expect(whilePending.verification).toBeUndefined();
  expect(result.verification?.status).toBe('failed');
  expect(f.service.settings()).toEqual(result);
});
