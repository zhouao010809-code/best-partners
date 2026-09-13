import type { ArchiveTreeReader } from '../archive/archive-snapshot.js';
import type { ArchiveIdentity, ArchiveStat } from '../archive/sandbox-native.js';

export type IntakeTrashPurgeMember = ArchiveIdentity & { path: string } & (
  { kind: 'directory' } | { kind: 'file'; bytes: Buffer }
);

/** Recycles one top-level intake entry, including only its own descendants. */
export interface PersonalIntakeTrashPort {
  readonly rootIdentity: ArchiveIdentity;
  readonly source: ArchiveTreeReader;
  readonly items: ArchiveTreeReader;
  /** INTAKE_TRASH_NEEDS_REVIEW means movement happened but postflight failed.
   * Preserve every version and journal; never retry or roll back blindly. */
  move(name: string, id: string, expected: ArchiveIdentity): void;
  restore(id: string, name: string, expected: ArchiveIdentity): void;
  /** Exact remaining tree in UTF-8 byte order, including root/empty directories. Never resumes itself. */
  purge(id: string, tree: readonly IntakeTrashPurgeMember[]): void;
  /** Immutable UUID intent, restore, restored, delete, confirm and deleted journals. */
  writeRecovery(name: string, bytes: Buffer): void;
  readRecovery(name: string): Buffer | null;
  listRecovery(): readonly string[];
  close(): void;
}

export interface NativeIntakeTrash {
  openIntakeTrash(archive: unknown, recoveryRoot: string): unknown;
  intakeTrashRootIdentity(handle: unknown): ArchiveIdentity;
  intakeTrashSourceStat(handle: unknown, path: string): ArchiveStat | null;
  intakeTrashSourceList(handle: unknown, path: string): { name: string; kind: 'file' | 'directory' }[];
  intakeTrashSourceRead(handle: unknown, path: string): Buffer;
  intakeTrashItemStat(handle: unknown, path: string): ArchiveStat | null;
  intakeTrashItemList(handle: unknown, path: string): { name: string; kind: 'file' | 'directory' }[];
  intakeTrashItemRead(handle: unknown, path: string): Buffer;
  intakeTrashMove(handle: unknown, name: string, id: string, expected: ArchiveIdentity): void;
  intakeTrashRestore(handle: unknown, id: string, name: string, expected: ArchiveIdentity): void;
  intakeTrashPurge(handle: unknown, id: string, tree: readonly IntakeTrashPurgeMember[]): void;
  intakeTrashWriteRecovery(handle: unknown, name: string, bytes: Buffer): void;
  intakeTrashReadRecovery(handle: unknown, name: string): Buffer | null;
  intakeTrashListRecovery(handle: unknown): string[];
  intakeTrashClose(handle: unknown): void;
}

/** Borrows the archive root lock and lifetime; close this port first. */
export function bindPersonalIntakeTrash(native: NativeIntakeTrash, archive: unknown, recoveryRoot: string): PersonalIntakeTrashPort {
  const handle = native.openIntakeTrash(archive, recoveryRoot);
  try {
    return Object.freeze({
      rootIdentity: Object.freeze(native.intakeTrashRootIdentity(handle)),
      source: Object.freeze({
        stat: (path: string) => native.intakeTrashSourceStat(handle, path),
        list: (path: string) => native.intakeTrashSourceList(handle, path),
        read: (path: string) => native.intakeTrashSourceRead(handle, path)
      }),
      items: Object.freeze({
        stat: (path: string) => native.intakeTrashItemStat(handle, path),
        list: (path: string) => native.intakeTrashItemList(handle, path),
        read: (path: string) => native.intakeTrashItemRead(handle, path)
      }),
      move: (name: string, id: string, expected: ArchiveIdentity) => native.intakeTrashMove(handle, name, id, expected),
      restore: (id: string, name: string, expected: ArchiveIdentity) => native.intakeTrashRestore(handle, id, name, expected),
      purge: (id: string, tree: readonly IntakeTrashPurgeMember[]) => native.intakeTrashPurge(handle, id, tree),
      writeRecovery: (name: string, bytes: Buffer) => native.intakeTrashWriteRecovery(handle, name, bytes),
      readRecovery: (name: string) => native.intakeTrashReadRecovery(handle, name),
      listRecovery: () => Object.freeze(native.intakeTrashListRecovery(handle)),
      close: () => native.intakeTrashClose(handle)
    });
  } catch (error) {
    native.intakeTrashClose(handle);
    throw error;
  }
}
