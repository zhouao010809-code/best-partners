import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { AppError } from '../../shared/api/errors.js';
import { validateFilesystemPath, validateFilesystemRoot } from './filesystem-path.js';
import { decodeNativeReadResponse, MAX_FRAME_BYTES, type NativeDirectoryEntry,
  type NativeReadCommand, type NativeReadResponse, type RootIdentity } from './native-read-helper-protocol.js';

export interface NativeVaultReader {
  readonly root: string;
  readonly rootIdentity: RootIdentity;
  listDirectory(relative: string, signal?: AbortSignal): Promise<readonly NativeDirectoryEntry[]>;
  readFile(relative: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array }>;
  assertFile(relative: string, signal?: AbortSignal): Promise<void>;
  assertDirectory(relative: string, signal?: AbortSignal): Promise<void>;
}

export interface NativeReadVaultPortFactory {
  create(root: string): Promise<NativeVaultReader>;
}

export function assertReadNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError('VAULT_REQUEST_ABORTED', 'VAULT_REQUEST_ABORTED', 499);
}

function runHelper(input: {
  helperPath: string; root: string; command: NativeReadCommand;
  identity?: RootIdentity; relative?: string; signal?: AbortSignal;
}): Promise<NativeReadResponse> {
  assertReadNotAborted(input.signal);
  return new Promise((resolve, reject) => {
    const args = [input.command, input.root,
      ...(input.identity ? [input.identity.dev, input.identity.ino, input.relative!] : [])];
    const child = spawn(input.helperPath, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: {} });
    const chunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let settled = false;
    function finish(error?: unknown, response?: NativeReadResponse) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      if (error !== undefined) { child.kill('SIGKILL'); reject(error); }
      else resolve(response!);
    }
    function fail(code: string) { finish(new AppError(code, code, 502)); }
    function abort() { fail('VAULT_REQUEST_ABORTED'); }
    const timer = setTimeout(() => fail('NATIVE_HELPER_TIMEOUT'), 5000);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (stdoutLength > MAX_FRAME_BYTES) { fail('NATIVE_PROTOCOL_INVALID'); return; }
      if (!settled) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrLength += chunk.length;
      if (stderrLength > 64 * 1024) fail('NATIVE_HELPER_FAILED');
    });
    child.once('error', () => fail('NATIVE_HELPER_FAILED'));
    child.once('close', (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal !== null) { fail('NATIVE_HELPER_FAILED'); return; }
      try { finish(undefined, decodeNativeReadResponse(Buffer.concat(chunks), input.command, input.identity)); }
      catch (error) { finish(error); }
    });
  });
}

export class NativeReadVaultPort implements NativeVaultReader {
  private constructor(
    readonly root: string,
    private readonly helperPath: string,
    readonly rootIdentity: RootIdentity
  ) {}

  static async create(input: { root: string; helperPath: string }): Promise<NativeReadVaultPort> {
    const root = validateFilesystemRoot(input.root);
    if (!isAbsolute(input.helperPath) || input.helperPath.includes('\0')) {
      throw new AppError('NATIVE_HELPER_INVALID', 'NATIVE_HELPER_INVALID');
    }
    const response = await runHelper({ root, helperPath: input.helperPath, command: 'probe-root' });
    return new NativeReadVaultPort(root, input.helperPath, Object.freeze(response.root));
  }

  private async request(command: NativeReadCommand, relative: string, signal?: AbortSignal) {
    assertReadNotAborted(signal);
    return runHelper({ root: this.root, helperPath: this.helperPath, command, identity: this.rootIdentity, relative,
      ...(signal === undefined ? {} : { signal }) });
  }

  async listDirectory(relative: string, signal?: AbortSignal): Promise<readonly NativeDirectoryEntry[]> {
    return (await this.request('list-dir', validateFilesystemPath(relative, 'directory'), signal)).entries!;
  }

  async readFile(relative: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array }> {
    return { bytes: (await this.request('read-file', validateFilesystemPath(relative), signal)).payload };
  }

  async assertFile(relative: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request('stat-file', validateFilesystemPath(relative), signal);
    if (response.kind !== 'file') throw new AppError('TYPE_MISMATCH', 'TYPE_MISMATCH');
  }

  async assertDirectory(relative: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request('stat-file', validateFilesystemPath(relative, 'directory-check'), signal);
    if (response.kind !== 'directory') throw new AppError('TYPE_MISMATCH', 'TYPE_MISMATCH');
  }
}

export function createNativeReadVaultPortFactory(helperPath: string): NativeReadVaultPortFactory {
  return { create: (root) => NativeReadVaultPort.create({ root, helperPath }) };
}
