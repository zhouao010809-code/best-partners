import type { ArchiveIdentity, ArchiveStat } from '../archive/sandbox-native.js';

/** Moves one archived original or knowledge Markdown; attachments and parent folders stay put. */
export interface PersonalTrashPort {
  readonly rootIdentity: ArchiveIdentity;
  stat(path: string): ArchiveStat | null;
  read(path: string): Buffer | null;
  statItem(id: string): ArchiveStat | null;
  readItem(id: string): Buffer | null;
  /** TRASH_NEEDS_REVIEW means movement occurred but postflight failed. Preserve
   * every version and journal for recovery; never retry or delete blindly. */
  move(path: string, id: string, expected: ArchiveIdentity): void;
  restore(id: string, path: string, expected: ArchiveIdentity): void;
  /** Permanently unlinks one confirmed item. TRASH_DELETE_NEEDS_REVIEW means
   * unlink occurred but verification or durability failed; do not retry blindly.
   * macOS offers no atomic inode compare-and-unlink against an external writer. */
  purge(id: string, expected: ArchiveIdentity, expectedBytes: Buffer): void;
  writeRecovery(name: string, bytes: Buffer): void;
  readRecovery(name: string): Buffer | null;
  listRecovery(): readonly string[];
  close(): void;
}

export interface NativeTrash {
  openTrash(archive: unknown, recoveryRoot: string): unknown;
  trashRootIdentity(handle: unknown): ArchiveIdentity;
  trashStat(handle: unknown, path: string): ArchiveStat | null;
  trashRead(handle: unknown, path: string): Buffer | null;
  trashStatItem(handle: unknown, id: string): ArchiveStat | null;
  trashReadItem(handle: unknown, id: string): Buffer | null;
  trashMove(handle: unknown, path: string, id: string, expected: ArchiveIdentity): void;
  trashRestore(handle: unknown, id: string, path: string, expected: ArchiveIdentity): void;
  trashPurge(handle: unknown, id: string, expected: ArchiveIdentity, expectedBytes: Buffer): void;
  trashWriteRecovery(handle: unknown, name: string, bytes: Buffer): void;
  trashReadRecovery(handle: unknown, name: string): Buffer | null;
  trashListRecovery(handle: unknown): string[];
  trashClose(handle: unknown): void;
}

/** Borrows the archive root lock. Close this port before closing its archive. */
export function bindPersonalTrash(native: NativeTrash, archive: unknown, recoveryRoot: string): PersonalTrashPort {
  const handle = native.openTrash(archive, recoveryRoot);
  try {
    return Object.freeze({
      rootIdentity: Object.freeze(native.trashRootIdentity(handle)),
      stat: (path: string) => native.trashStat(handle, path),
      read: (path: string) => native.trashRead(handle, path),
      statItem: (id: string) => native.trashStatItem(handle, id),
      readItem: (id: string) => native.trashReadItem(handle, id),
      move: (path: string, id: string, expected: ArchiveIdentity) => native.trashMove(handle, path, id, expected),
      restore: (id: string, path: string, expected: ArchiveIdentity) => native.trashRestore(handle, id, path, expected),
      purge: (id: string, expected: ArchiveIdentity, expectedBytes: Buffer) => native.trashPurge(handle, id, expected, expectedBytes),
      writeRecovery: (name: string, bytes: Buffer) => native.trashWriteRecovery(handle, name, bytes),
      readRecovery: (name: string) => native.trashReadRecovery(handle, name),
      listRecovery: () => Object.freeze(native.trashListRecovery(handle)),
      close: () => native.trashClose(handle)
    });
  } catch (error) {
    native.trashClose(handle);
    throw error;
  }
}
