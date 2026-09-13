import { createRequire } from 'node:module';
import { bindPersonalIngestion, type NativeIngestion, type PersonalIngestionPort } from '../ingestion/ingestion-native.js';
import { bindPersonalTrash, type NativeTrash, type PersonalTrashPort } from '../trash/trash-native.js';
import { bindPersonalIntakeTrash, type NativeIntakeTrash, type PersonalIntakeTrashPort } from '../trash/intake-trash-native.js';

export type ArchiveIdentity = { dev: string; ino: string };
export type ArchiveStat = ArchiveIdentity & { kind: 'file' | 'directory'; size: number };
export interface SandboxArchivePort {
  readonly root: string;
  readonly rootIdentity: ArchiveIdentity;
  stat(relative: string): ArchiveStat | null;
  list(relative: string): readonly { name: string; kind: 'file' | 'directory' }[];
  read(relative: string): Buffer;
  move(source: string, target: string, expected: ArchiveIdentity): void;
  syncParents(source: string, target: string): void;
  readRecovery(name: string): Buffer | null;
  writeRecovery(name: string, bytes: Buffer): void;
  listRecovery(): readonly string[];
  close(): void;
}

export interface PersonalArchivePort extends SandboxArchivePort {
  publishAttachmentPackage?(stagingRoot: string, name: string, mainName: string, main: Buffer, originalName: string, original: Buffer): void;
  openIngestion(recoveryRoot: string): PersonalIngestionPort;
  openTrash(recoveryRoot: string): PersonalTrashPort;
  openIntakeTrash(recoveryRoot: string): PersonalIntakeTrashPort;
  listIntake(): readonly { name: string; kind: 'file' | 'directory' }[];
  ensureMonth(platform: string, month: string): void;
  statRecovery(name: string): ArchiveStat | null;
  swapMain(relativeMain: string, stageName: string, expectedMain: ArchiveIdentity, expectedStage: ArchiveIdentity): void;
  renameMain(from: string, to: string, expected: ArchiveIdentity): void;
}

type NativeArchive = {
  open(root: string): unknown;
  rootIdentity(handle: unknown): ArchiveIdentity;
  stat(handle: unknown, relative: string): ArchiveStat | null;
  list(handle: unknown, relative: string): { name: string; kind: 'file' | 'directory' }[];
  read(handle: unknown, relative: string): Buffer;
  move(handle: unknown, source: string, target: string, expected: ArchiveIdentity): void;
  syncParents(handle: unknown, source: string, target: string): void;
  readRecovery(handle: unknown, name: string): Buffer | null;
  writeRecovery(handle: unknown, name: string, bytes: Buffer): void;
  listRecovery(handle: unknown): string[];
  close(handle: unknown): void;
};

type NativePersonalArchive = NativeArchive & NativeIngestion & NativeTrash & NativeIntakeTrash & {
  publishAttachmentPackage(handle: unknown, stagingRoot: string, name: string, mainName: string, main: Buffer, originalName: string, original: Buffer): void;
  openPersonal(root: string, recoveryRoot: string): unknown;
  listIntake(handle: unknown): { name: string; kind: 'file' | 'directory' }[];
  ensureMonth(handle: unknown, platform: string, month: string): void;
  statRecovery(handle: unknown, name: string): ArchiveStat | null;
  swapMain(handle: unknown, relativeMain: string, stageName: string, expectedMain: ArchiveIdentity, expectedStage: ArchiveIdentity): void;
  renameMain(handle: unknown, from: string, to: string, expected: ArchiveIdentity): void;
};

function bindArchive(root: string, native: NativeArchive, handle: unknown): SandboxArchivePort {
  return {
    root,
    rootIdentity: Object.freeze(native.rootIdentity(handle)),
    stat: (relative: string) => native.stat(handle, relative),
    list: (relative: string) => native.list(handle, relative),
    read: (relative: string) => native.read(handle, relative),
    move: (source: string, target: string, expected: ArchiveIdentity) => native.move(handle, source, target, expected),
    syncParents: (source: string, target: string) => native.syncParents(handle, source, target),
    readRecovery: (name: string) => native.readRecovery(handle, name),
    writeRecovery: (name: string, bytes: Buffer) => native.writeRecovery(handle, name, bytes),
    listRecovery: () => native.listRecovery(handle),
    close: () => native.close(handle)
  };
}

// Sandbox-only. Loading this module trusts addon code at launch; it does not
// reproduce the retired helper's held-executable-descriptor trust contract.
export function openSandboxArchive(root: string, addonPath: string): SandboxArchivePort {
  const native = createRequire(import.meta.url)(addonPath) as NativeArchive;
  const handle = native.open(root);
  try {
    return Object.freeze(bindArchive(root, native, handle));
  } catch (error) {
    native.close(handle);
    throw error;
  }
}

// This entry point is for the user's trusted personal App bootstrap. The native
// module separately confines data mutations to clipper intake and its recovery root.
export function openPersonalArchive(root: string, recoveryRoot: string, addonPath: string): PersonalArchivePort {
  const native = createRequire(import.meta.url)(addonPath) as NativePersonalArchive;
  const handle = native.openPersonal(root, recoveryRoot);
  try {
    return Object.freeze({
      ...bindArchive(root, native, handle),
      publishAttachmentPackage: (stagingRoot: string, name: string, mainName: string, main: Buffer, originalName: string, original: Buffer) => native.publishAttachmentPackage(handle, stagingRoot, name, mainName, main, originalName, original),
      openIngestion: (ingestionRecoveryRoot: string) => bindPersonalIngestion(native, handle, ingestionRecoveryRoot),
      openTrash: (trashRecoveryRoot: string) => bindPersonalTrash(native, handle, trashRecoveryRoot),
      openIntakeTrash: (intakeTrashRecoveryRoot: string) => bindPersonalIntakeTrash(native, handle, intakeTrashRecoveryRoot),
      listIntake: () => native.listIntake(handle),
      ensureMonth: (platform: string, month: string) => native.ensureMonth(handle, platform, month),
      statRecovery: (name: string) => native.statRecovery(handle, name),
      swapMain: (relativeMain: string, stageName: string, expectedMain: ArchiveIdentity, expectedStage: ArchiveIdentity) =>
        native.swapMain(handle, relativeMain, stageName, expectedMain, expectedStage),
      renameMain: (from: string, to: string, expected: ArchiveIdentity) => native.renameMain(handle, from, to, expected)
    });
  } catch (error) {
    native.close(handle);
    throw error;
  }
}
