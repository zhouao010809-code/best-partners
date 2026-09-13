import type { ArchiveIdentity } from '../archive/sandbox-native.js';

/** Narrow data port; source and knowledge document semantics belong to the service. */
export interface PersonalIngestionPort {
  readonly rootIdentity: ArchiveIdentity;
  read(path: string): Buffer | null;
  writeRecovery(name: string, bytes: Buffer): void;
  readRecovery(name: string): Buffer | null;
  listRecovery(): readonly string[];
  /** Exclusive knowledge creation, or an update retaining the old inode in stageName.
   * INGESTION_NEEDS_REVIEW means rename happened but verification failed: preserve
   * all versions and let recovery inspect them; this is not an atomic hash CAS. */
  apply(path: string, stageName: string, before: Buffer | null, after: Buffer): void;
  close(): void;
}

export interface NativeIngestion {
  openIngestion(archive: unknown, recoveryRoot: string): unknown;
  ingestionRootIdentity(handle: unknown): ArchiveIdentity;
  ingestionRead(handle: unknown, path: string): Buffer | null;
  ingestionWriteRecovery(handle: unknown, name: string, bytes: Buffer): void;
  ingestionReadRecovery(handle: unknown, name: string): Buffer | null;
  ingestionListRecovery(handle: unknown): string[];
  ingestionApply(handle: unknown, path: string, stageName: string, before: Buffer | null, after: Buffer): void;
  ingestionClose(handle: unknown): void;
}

/** Borrows the already locked archive root; closing the archive invalidates this port. */
export function bindPersonalIngestion(native: NativeIngestion, archive: unknown, recoveryRoot: string): PersonalIngestionPort {
  const handle = native.openIngestion(archive, recoveryRoot);
  try {
    return Object.freeze({
      rootIdentity: Object.freeze(native.ingestionRootIdentity(handle)),
      read: (path: string) => native.ingestionRead(handle, path),
      writeRecovery: (name: string, bytes: Buffer) => native.ingestionWriteRecovery(handle, name, bytes),
      readRecovery: (name: string) => native.ingestionReadRecovery(handle, name),
      listRecovery: () => Object.freeze(native.ingestionListRecovery(handle)),
      apply: (path: string, stageName: string, before: Buffer | null, after: Buffer) => native.ingestionApply(handle, path, stageName, before, after),
      close: () => native.ingestionClose(handle)
    });
  } catch (error) {
    native.ingestionClose(handle);
    throw error;
  }
}
