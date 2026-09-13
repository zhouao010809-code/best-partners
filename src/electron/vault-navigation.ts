import { basename, join } from 'node:path';
import type { NativeVaultReader } from '../server/vault/NativeReadVaultPort.js';
import { validateFilesystemPath } from '../server/vault/filesystem-path.js';

interface DesktopShell {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

/** Bound once to the reader for the vault accepted at application startup. */
export function createDesktopVaultNavigation(input: {
  readonly reader: NativeVaultReader;
  readonly shell: DesktopShell;
}) {
  const path = input.reader.root;
  return {
    getVaultInfo: () => ({ displayName: basename(path), path }),
    async openVaultDirectory(): Promise<void> {
      try {
        // The native reader rejects a moved/replaced root and symlink ancestors.
        await input.reader.assertDirectory('00大脑规则');
        if (await input.shell.openPath(path)) throw new Error('OPEN_FAILED');
      } catch { throw new Error('未能打开当前大脑文件夹，请确认文件夹仍在原位置后重试。'); }
    },
    async revealDocument(requestedPath: unknown): Promise<void> {
      let relativePath: string;
      try {
        if (typeof requestedPath !== 'string' || !/\.md$/i.test(requestedPath)) throw new Error('INVALID_DOCUMENT');
        relativePath = validateFilesystemPath(requestedPath);
        // Existing descriptor-anchored validation rejects missing files, symlinks
        // and root replacement before a local Finder selection can be requested.
        await input.reader.assertFile(relativePath);
      } catch { throw new Error('无法定位这份资料：文件不存在，或不在当前大脑的可用 Markdown 目录中。'); }
      try { input.shell.showItemInFolder(join(path, relativePath)); }
      catch { throw new Error('未能在 Finder 中显示这份资料，请重试。'); }
    }
  };
}
