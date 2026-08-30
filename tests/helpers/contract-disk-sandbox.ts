import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { assertSandboxVaultPath } from './contract-runtime.js';

function containedBy(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent === ''
    || (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function assertRegularSingleLink(path: string): void {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) throw new Error('unsafe');
}

export type ContractDiskSandbox = {
  createFile(vaultPath: string, bytes: Uint8Array): Promise<void>;
  overwriteFile(vaultPath: string, bytes: Uint8Array): Promise<void>;
  renameFile(sourceVaultPath: string, destinationVaultPath: string): Promise<void>;
  deleteFile(vaultPath: string): Promise<void>;
};

export function createContractDiskSandbox(input: {
  readonly canonicalTestVaultRoot: string;
  readonly runId: string;
}): ContractDiskSandbox {
  if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
    throw new Error('CONTRACT_DISK_NOFOLLOW_UNAVAILABLE');
  }
  const root = input.canonicalTestVaultRoot;

  function navigateParent(vaultPath: string): { parentSegments: string[]; fileName: string } {
    const logical = assertSandboxVaultPath(vaultPath, input.runId);
    const segments = logical.split('/');
    const fileName = segments.pop();
    if (fileName === undefined || realpathSync('.') !== root) throw new Error('unsafe');

    for (const segment of segments) {
      try {
        const status = lstatSync(segment);
        if (status.isSymbolicLink() || !status.isDirectory()) throw new Error('unsafe');
      } catch (error) {
        if (!missing(error)) throw error;
        mkdirSync(segment, { mode: 0o700 });
        const created = lstatSync(segment);
        if (created.isSymbolicLink() || !created.isDirectory()) throw new Error('unsafe');
      }
      process.chdir(segment);
      if (!containedBy(root, realpathSync('.'))) throw new Error('unsafe');
    }
    return { parentSegments: segments, fileName };
  }

  function guarded(operation: () => void): void {
    const previous = process.cwd();
    let failed = false;
    try {
      process.chdir(root);
      if (realpathSync('.') !== root) throw new Error('unsafe');
      operation();
    } catch {
      failed = true;
    } finally {
      try {
        process.chdir(previous);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error('CONTRACT_DISK_PATH_UNSAFE');
  }

  function writeFinal(fileName: string, bytes: Uint8Array, create: boolean): void {
    const flags = create
      ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
      : constants.O_WRONLY | constants.O_NOFOLLOW;
    const descriptor = openSync(fileName, flags, 0o600);
    try {
      const status = fstatSync(descriptor);
      if (!status.isFile() || status.nlink !== 1) throw new Error('unsafe');
      if (!create) ftruncateSync(descriptor, 0);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  return {
    async createFile(vaultPath, bytes) {
      guarded(() => {
        const { fileName } = navigateParent(vaultPath);
        try {
          lstatSync(fileName);
          throw new Error('unsafe');
        } catch (error) {
          if (!missing(error)) throw error;
        }
        writeFinal(fileName, bytes, true);
      });
    },

    async overwriteFile(vaultPath, bytes) {
      guarded(() => {
        const { fileName } = navigateParent(vaultPath);
        assertRegularSingleLink(fileName);
        writeFinal(fileName, bytes, false);
      });
    },

    async renameFile(sourceVaultPath, destinationVaultPath) {
      guarded(() => {
        const source = assertSandboxVaultPath(sourceVaultPath, input.runId).split('/');
        const destination = assertSandboxVaultPath(destinationVaultPath, input.runId).split('/');
        const sourceName = source.pop();
        const destinationName = destination.pop();
        if (
          sourceName === undefined
          || destinationName === undefined
          || source.join('/') !== destination.join('/')
        ) {
          throw new Error('unsafe');
        }
        navigateParent(sourceVaultPath);
        assertRegularSingleLink(sourceName);
        try {
          lstatSync(destinationName);
          throw new Error('unsafe');
        } catch (error) {
          if (!missing(error)) throw error;
        }
        renameSync(sourceName, destinationName);
        assertRegularSingleLink(destinationName);
      });
    },

    async deleteFile(vaultPath) {
      guarded(() => {
        const { fileName } = navigateParent(vaultPath);
        assertRegularSingleLink(fileName);
        unlinkSync(fileName);
      });
    }
  };
}
