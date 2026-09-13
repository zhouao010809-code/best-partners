import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ModelCredentialsError, normalizeModelApiKey, type ModelCredentialsPort } from '../server/ai/model-credentials.js';
import { ensurePrivateDirectory, secureExistingPrivateFile } from '../server/db/permissions.js';

interface SafeStoragePort {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (value: string) => Buffer;
  readonly decryptString: (value: Buffer) => string;
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export function createModelKeyStore(input: {
  readonly directory: string;
  readonly safeStorage: SafeStoragePort;
}): ModelCredentialsPort {
  const directory = resolve(input.directory);
  const path = join(directory, 'deepseek-key.enc');
  const available = () => {
    try { return input.safeStorage.isEncryptionAvailable(); } catch { return false; }
  };
  const assertAvailable = () => { if (!available()) throw new ModelCredentialsError('UNAVAILABLE'); };
  const assertDirectory = () => {
    const status = lstatSync(directory);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error();
  };
  const read = () => {
    try {
      assertDirectory();
      if (!secureExistingPrivateFile(path)) return undefined;
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const status = fstatSync(descriptor);
        if (!status.isFile() || status.nlink !== 1 || status.size === 0 || status.size > 16_384) throw new Error();
        const encrypted = readFileSync(descriptor);
        const key = normalizeModelApiKey(input.safeStorage.decryptString(encrypted));
        return { key, revision: createHash('sha256').update(encrypted).digest('hex') };
      } finally { closeSync(descriptor); }
    } catch (error) {
      if (missing(error)) return undefined;
      throw new ModelCredentialsError('STORAGE_FAILED');
    }
  };
  const syncDirectory = () => {
    const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  };
  return {
    status() {
      if (!available()) return { available: false, configured: false, revision: 'unavailable', problem: new ModelCredentialsError('UNAVAILABLE').message };
      try {
        const saved = read();
        return { available: true, configured: saved !== undefined, revision: saved?.revision ?? 'unconfigured' };
      } catch {
        return { available: true, configured: false, revision: 'unreadable', problem: new ModelCredentialsError('STORAGE_FAILED').message };
      }
    },
    getKey() {
      assertAvailable();
      const saved = read();
      if (!saved) throw new ModelCredentialsError('NOT_CONFIGURED');
      return saved.key;
    },
    setKey(apiKey) {
      assertAvailable();
      const key = normalizeModelApiKey(apiKey);
      let temporary: string | undefined;
      try {
        const encrypted = input.safeStorage.encryptString(key);
        if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > 16_384) throw new Error();
        ensurePrivateDirectory(directory);
        secureExistingPrivateFile(path);
        const candidate = join(directory, `.deepseek-key-${randomUUID()}.tmp`);
        const descriptor = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        temporary = candidate;
        try { fchmodSync(descriptor, 0o600); writeFileSync(descriptor, encrypted); fsyncSync(descriptor); }
        finally { closeSync(descriptor); }
        renameSync(candidate, path);
        temporary = undefined;
        syncDirectory();
      } catch { throw new ModelCredentialsError('STORAGE_FAILED'); }
      finally {
        if (temporary) {
          try { unlinkSync(temporary); } catch { /* A failed cleanup must never expose filesystem details. */ }
        }
      }
    },
    clear() {
      try {
        assertDirectory();
        if (!secureExistingPrivateFile(path)) return;
        unlinkSync(path);
        syncDirectory();
      } catch (error) {
        if (!missing(error)) throw new ModelCredentialsError('STORAGE_FAILED');
      }
    }
  };
}
