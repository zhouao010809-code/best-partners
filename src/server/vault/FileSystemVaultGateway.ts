import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from '../../shared/api/errors.js';
import { validateFilesystemPath, validateFilesystemRoot } from './filesystem-path.js';
import { assertReadNotAborted, type NativeReadVaultPortFactory, type NativeVaultReader } from './NativeReadVaultPort.js';
import { MAX_FILE_BYTES } from './native-read-helper-protocol.js';
import { sha256Bytes } from './raw-bytes.js';
import type { OpenableVaultGateway, VaultReadiness, VersionedBytes } from './VaultGateway.js';
import type { VaultLayout } from '../../shared/domain/vault-layout.js';
import { identifyVaultLayout } from './vault-layout.js';

export class FileSystemVaultGateway implements OpenableVaultGateway {
  readonly cacheKey: string;

  private constructor(
    readonly layout: VaultLayout,
    private readonly vaultRoot: string,
    private readonly reader: NativeVaultReader,
    private readonly openExternal: ((url: string) => Promise<void>) | undefined
  ) {
    this.cacheKey = createHash('sha256')
      .update(JSON.stringify([vaultRoot, reader.rootIdentity.dev, reader.rootIdentity.ino]), 'utf8')
      .digest('hex');
  }

  static async create(input: {
    vaultRoot: string; nativeReader: NativeReadVaultPortFactory; openExternal?: (url: string) => Promise<void>;
  }): Promise<FileSystemVaultGateway> {
    const root = validateFilesystemRoot(input.vaultRoot);
    const reader = await input.nativeReader.create(root);
    return new FileSystemVaultGateway(await identifyVaultLayout(reader), root, reader, input.openExternal);
  }

  private validateReadPath(path: string, kind: 'file' | 'directory' = 'file'): string {
    const value = validateFilesystemPath(path, kind);
    const root = value.split('/')[0];
    if (root !== '00大脑规则' && root !== '01图书馆' && root !== this.layout.knowledgeRoot) {
      throw new AppError('PATH_NOT_ALLOWED', 'PATH_NOT_ALLOWED');
    }
    return value;
  }

  async listDirectory(path: string, signal?: AbortSignal): Promise<readonly string[]> {
    assertReadNotAborted(signal);
    const entries = await this.reader.listDirectory(this.validateReadPath(path, 'directory'), signal);
    return entries.map((entry) => entry.kind === 'directory' ? `${entry.name}/` : entry.name);
  }

  async probeReadiness(signal?: AbortSignal): Promise<VaultReadiness> {
    try {
      for (const directory of ['01图书馆', this.layout.knowledgeRoot, this.layout.outputRoot, ...(this.layout.id === 'current' ? ['02日记本'] : [])]) {
        await this.reader.assertDirectory(directory, signal);
      }
    } catch { return { status: 'unavailable', reason: 'VAULT_UNAVAILABLE' }; }
    try {
      await this.reader.assertDirectory('00大脑规则', signal);
      for (const path of this.layout.rulePaths) await this.reader.assertFile(path, signal);
      return { status: 'ready' };
    } catch {
      try { await this.reader.assertDirectory('01图书馆', signal); }
      catch { return { status: 'unavailable', reason: 'VAULT_UNAVAILABLE' }; }
      return { status: 'unavailable', reason: 'VAULT_RULES_MISSING' };
    }
  }

  async readRaw(requestedPath: string, signal?: AbortSignal): Promise<VersionedBytes> {
    assertReadNotAborted(signal);
    const path = this.validateReadPath(requestedPath);
    const { bytes } = await this.reader.readFile(path, signal);
    assertReadNotAborted(signal);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new AppError('FILE_TOO_LARGE', 'FILE_TOO_LARGE');
    return { path, bytes, rawSha256: sha256Bytes(bytes) };
  }

  async openInObsidian(requestedPath: string, signal?: AbortSignal): Promise<void> {
    assertReadNotAborted(signal);
    const path = this.validateReadPath(requestedPath);
    await this.reader.assertFile(path, signal);
    assertReadNotAborted(signal);
    if (!this.openExternal) throw new AppError('OBSIDIAN_OPEN_UNAVAILABLE', 'OBSIDIAN_OPEN_UNAVAILABLE', 503);
    const query = new URLSearchParams({ vault: basename(this.vaultRoot), file: path });
    await this.openExternal(`obsidian://open?${query.toString()}`);
  }
}
