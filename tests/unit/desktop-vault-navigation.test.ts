import { describe, expect, it, vi } from 'vitest';
import { createDesktopVaultNavigation } from '../../src/electron/vault-navigation.js';
import type { NativeVaultReader } from '../../src/server/vault/NativeReadVaultPort.js';

function fixture() {
  const reader: NativeVaultReader = {
    root: '/brains/我的大脑', rootIdentity: { dev: '1', ino: '2' },
    assertFile: vi.fn(async () => {}), assertDirectory: vi.fn(async () => {}),
    listDirectory: vi.fn(async () => []), readFile: vi.fn(async () => ({ bytes: new Uint8Array() }))
  };
  const shell = { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn((_path: string) => {}) };
  return { reader, shell, navigation: createDesktopVaultNavigation({ reader, shell }) };
}

describe('desktop navigation within the active vault', () => {
  it('exposes the startup reader location and only opens that same folder', async () => {
    const { navigation, shell, reader } = fixture();
    expect(navigation.getVaultInfo()).toEqual({ displayName: '我的大脑', path: '/brains/我的大脑' });
    await navigation.openVaultDirectory();
    expect(reader.assertDirectory).toHaveBeenCalledExactlyOnceWith('00大脑规则');
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith('/brains/我的大脑');
  });

  it('reports a native open failure instead of treating Electron error text as success', async () => {
    const { navigation, shell } = fixture();
    shell.openPath.mockResolvedValueOnce('No application is available');
    await expect(navigation.openVaultDirectory()).rejects.toThrow('未能打开当前大脑文件夹');
    shell.openPath.mockRejectedValueOnce(new Error('sensitive operating system detail'));
    await expect(navigation.openVaultDirectory()).rejects.toThrow('未能打开当前大脑文件夹');
  });

  it('does not open a replaced or unavailable startup root', async () => {
    const { navigation, shell, reader } = fixture();
    vi.mocked(reader.assertDirectory).mockRejectedValueOnce(new Error('ROOT_IDENTITY_CHANGED'));
    await expect(navigation.openVaultDirectory()).rejects.toThrow('未能打开当前大脑文件夹');
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it.each([
    '../secret.md', '/tmp/secret.md', '01图书馆/../secret.md', '01图书馆//note.md',
    '01图书馆\\note.md', '01图书馆/.hidden.md', '01图书馆/note.pdf', '01图书馆/note.md\0',
    'https://example.com/file.md', 'obsidian://open?file=note.md', '03大讲堂/note.md',
    null, 1, { path: '01图书馆/note.md' }
  ])('rejects an invalid document argument before asking the OS to reveal it: %j', async (path) => {
    const { navigation, shell, reader } = fixture();
    await expect(navigation.revealDocument(path)).rejects.toThrow('无法定位这份资料');
    expect(reader.assertFile).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('checks file authority before revealing an existing Markdown document', async () => {
    const { navigation, shell, reader } = fixture();
    await navigation.revealDocument('01图书馆/资料/我的笔记.md');
    expect(reader.assertFile).toHaveBeenCalledExactlyOnceWith('01图书馆/资料/我的笔记.md');
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith('/brains/我的大脑/01图书馆/资料/我的笔记.md');
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('does not reveal an absent file or a path rejected by the native reader', async () => {
    const { navigation, shell, reader } = fixture();
    vi.mocked(reader.assertFile).mockRejectedValueOnce(new Error('PATH_NOT_ALLOWED'));
    await expect(navigation.revealDocument('01图书馆/link.md')).rejects.toThrow('无法定位这份资料');
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('reports a Finder invocation error without leaking OS details', async () => {
    const { navigation, shell } = fixture();
    shell.showItemInFolder.mockImplementationOnce(() => { throw new Error('native detail'); });
    await expect(navigation.revealDocument('01图书馆/note.md')).rejects.toThrow('未能在 Finder 中显示这份资料');
  });
});
