import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createModelKeyStore } from '../../src/electron/model-key-store.js';

const roots: string[] = [];
const key = 'sk-sensitive-test-value';
function root() { const directory = mkdtempSync(join(tmpdir(), 'xiaozhao-model-key-')); roots.push(directory); return directory; }
function encryptedStorage() {
  const secret = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', secret, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    decryptString(value: Buffer) { const decipher = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'); }
  };
}
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('encrypted private model credentials', () => {
  it('has no files before saving and returns only redacted status', () => {
    const directory = join(root(), 'credentials');
    const store = createModelKeyStore({ directory, safeStorage: encryptedStorage() });
    expect(store.status()).toMatchObject({ available: true, configured: false, revision: expect.any(String) });
    expect(existsSync(directory)).toBe(false);
    expect(() => store.getKey()).toThrow('尚未配置 DeepSeek API Key。');
  });

  it('atomically round-trips encrypted credentials with private permissions and stable loaded revision', () => {
    const directory = join(root(), 'credentials'); const safeStorage = encryptedStorage();
    const store = createModelKeyStore({ directory, safeStorage }); const before = store.status().revision;
    store.setKey(`  ${key}  `);
    expect(store.getKey()).toBe(key);
    expect(store.status()).toMatchObject({ available: true, configured: true });
    expect(store.status().revision).not.toBe(before);
    const files = readdirSync(directory); expect(files).toHaveLength(1);
    expect(readFileSync(join(directory, files[0]!)).includes(Buffer.from(key))).toBe(false);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, files[0]!)).mode & 0o777).toBe(0o600);
    const reloaded = createModelKeyStore({ directory, safeStorage });
    expect(reloaded.getKey()).toBe(key);
    expect(reloaded.status().revision).toBe(store.status().revision);
    expect(JSON.stringify(store.status())).not.toContain(key);
  });

  it('replacing the key invalidates previous revision without temporary leftovers', () => {
    const directory = join(root(), 'credentials'); const store = createModelKeyStore({ directory, safeStorage: encryptedStorage() });
    store.setKey(key); const revision = store.status().revision;
    store.setKey('sk-replacement');
    expect(store.getKey()).toBe('sk-replacement');
    expect(store.status().revision).not.toBe(revision);
    expect(readdirSync(directory)).toHaveLength(1);
  });

  it('sets exactly private file permissions even when the process mask is restrictive', () => {
    const directory = join(root(), 'credentials'); mkdirSync(directory, { mode: 0o700 });
    const store = createModelKeyStore({ directory, safeStorage: encryptedStorage() });
    const previousMask = process.umask(0o777);
    try {
      store.setKey(key);
      expect(statSync(join(directory, readdirSync(directory)[0]!)).mode & 0o777).toBe(0o600);
    } finally { process.umask(previousMask); }
  });

  it('clears only its exact credential file and invalidates status', () => {
    const directory = join(root(), 'credentials'); const store = createModelKeyStore({ directory, safeStorage: encryptedStorage() });
    store.setKey(key); const revision = store.status().revision;
    writeFileSync(join(directory, 'unrelated'), 'keep');
    store.clear();
    expect(store.status()).toMatchObject({ configured: false });
    expect(store.status().revision).not.toBe(revision);
    expect(readdirSync(directory)).toEqual(['unrelated']);
    expect(() => store.getKey()).toThrow('尚未配置 DeepSeek API Key。');
    store.clear();
  });

  it('never falls back to plaintext when platform encryption is unavailable', () => {
    const directory = join(root(), 'credentials');
    const store = createModelKeyStore({ directory, safeStorage: { ...encryptedStorage(), isEncryptionAvailable: () => false } });
    expect(store.status()).toMatchObject({ available: false, configured: false, problem: '系统加密不可用，无法保存或读取 API Key。' });
    expect(() => store.setKey(key)).toThrow('系统加密不可用，无法保存或读取 API Key。');
    expect(existsSync(directory)).toBe(false);
  });

  it.each(['', '   ', 'key\nother', 'key\0other', '中文', 'x'.repeat(513)])('rejects malformed keys without storing them: %j', (invalid) => {
    const directory = join(root(), 'credentials'); const store = createModelKeyStore({ directory, safeStorage: encryptedStorage() });
    expect(() => store.setKey(invalid)).toThrow('API Key 格式不正确。');
    expect(existsSync(directory)).toBe(false);
  });

  it('preserves the existing credential when encryption fails without leaking its error', () => {
    const directory = join(root(), 'credentials'); const safeStorage = encryptedStorage();
    const store = createModelKeyStore({ directory, safeStorage }); store.setKey(key);
    const revision = store.status().revision;
    safeStorage.encryptString = () => { throw new Error(`RAW ${key}`); };
    expect(() => store.setKey('sk-new')).toThrow('无法安全保存或读取 API Key，请重新配置。');
    expect(store.getKey()).toBe(key);
    expect(store.status().revision).toBe(revision);
    expect(readdirSync(directory)).toHaveLength(1);
  });

  it('reports corrupted ciphertext as unavailable configuration without returning raw decrypt errors', () => {
    const directory = join(root(), 'credentials'); const safeStorage = encryptedStorage();
    const store = createModelKeyStore({ directory, safeStorage }); store.setKey(key);
    writeFileSync(join(directory, readdirSync(directory)[0]!), 'corrupted ciphertext');
    expect(store.status()).toMatchObject({ configured: false, problem: '无法安全保存或读取 API Key，请重新配置。' });
    expect(() => store.getKey()).toThrow('无法安全保存或读取 API Key，请重新配置。');
  });

  it('rejects symlink directories without changing their target permissions or content', () => {
    const parent = root(); const outside = root(); const directory = join(parent, 'credentials');
    chmodSync(outside, 0o755); symlinkSync(outside, directory);
    const store = createModelKeyStore({ directory, safeStorage: encryptedStorage() });
    expect(() => store.setKey(key)).toThrow('无法安全保存或读取 API Key，请重新配置。');
    expect(readdirSync(outside)).toEqual([]);
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  });

  it.each(['symlink', 'hardlink'])('refuses %s credential files without changing their external targets', (kind) => {
    const parent = root(); const directory = join(parent, 'credentials'); const safeStorage = encryptedStorage();
    const store = createModelKeyStore({ directory, safeStorage }); store.setKey(key);
    const path = join(directory, readdirSync(directory)[0]!); const target = join(parent, 'outside');
    writeFileSync(target, 'untouched', { mode: 0o644 }); rmSync(path);
    if (kind === 'symlink') symlinkSync(target, path); else linkSync(target, path);
    expect(store.status()).toMatchObject({ configured: false, problem: expect.any(String) });
    expect(() => store.setKey('sk-new')).toThrow('无法安全保存或读取 API Key，请重新配置。');
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });
});
