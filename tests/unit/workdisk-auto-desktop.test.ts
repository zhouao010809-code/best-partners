import { describe, expect, it, vi } from 'vitest';
import { createDesktopWorkdiskAuto } from '../../src/electron/workdisk-auto-controller.js';
import type { WorkdiskAutoState } from '../../src/shared/workdisk-auto.js';

function fixture() {
  const state: WorkdiskAutoState = { source: { rootPath: '/selected/downloads', displayName: '下载' }, enabled: true, nameFromContent: true, phase: 'watching', pendingCount: 0, receipts: [] };
  const service = {
    status: vi.fn(async () => state),
    configure: vi.fn(async (_path: string, _options: { nameFromContent: boolean }) => state),
    setEnabled: vi.fn(async (_enabled: boolean) => state),
    setNaming: vi.fn(async (_enabled: boolean) => state),
    renameReceipt: vi.fn(async (_id: string, _title: string) => state),
    resolveSource: vi.fn(async () => '/verified/downloads')
  };
  const chooseDirectory = vi.fn(async (_options: { nameFromContent: boolean }): Promise<string | undefined> => '/selected/downloads');
  const openPath = vi.fn(async (_path: string) => '');
  return { service, state, chooseDirectory, openPath, controller: createDesktopWorkdiskAuto({ service, chooseDirectory, openPath }) };
}

describe('desktop automatic workdisk collection', () => {
  it('reads state without configuring or starting collection', async () => {
    const f = fixture();
    await expect(f.controller.status()).resolves.toEqual(f.state);
    expect(f.service.configure).not.toHaveBeenCalled(); expect(f.service.setEnabled).not.toHaveBeenCalled();
  });
  it.each([true, false])('configures only the native directory selection and explicit naming choice %s', async nameFromContent => {
    const f = fixture();
    await expect(f.controller.chooseSource({ nameFromContent })).resolves.toEqual(f.state);
    expect(f.chooseDirectory).toHaveBeenCalledWith({ nameFromContent });
    expect(f.service.configure).toHaveBeenCalledWith('/selected/downloads', { nameFromContent });
  });
  it('does not change configuration when the native selection is cancelled', async () => {
    const f = fixture(); f.chooseDirectory.mockResolvedValueOnce(undefined);
    await expect(f.controller.chooseSource({ nameFromContent: true })).resolves.toBeNull();
    expect(f.service.configure).not.toHaveBeenCalled();
  });
  it('rejects renderer paths and malformed options before opening a picker or mutating settings', async () => {
    const f = fixture();
    for (const value of [undefined, null, true, '/private', {}, { nameFromContent: 'true' }, { nameFromContent: true, path: '/private' }]) {
      await expect(f.controller.chooseSource(value)).rejects.toThrow('输入');
    }
    for (const value of [undefined, null, 'true', 1, { enabled: true }]) {
      await expect(f.controller.setEnabled(value)).rejects.toThrow('输入');
      await expect(f.controller.setNaming(value)).rejects.toThrow('输入');
    }
    expect(f.chooseDirectory).not.toHaveBeenCalled(); expect(f.service.configure).not.toHaveBeenCalled();
    expect(f.service.setEnabled).not.toHaveBeenCalled(); expect(f.service.setNaming).not.toHaveBeenCalled();
  });
  it('propagates boolean enable and naming changes', async () => {
    const f = fixture();
    for (const value of [true, false]) {
      await expect(f.controller.setEnabled(value)).resolves.toEqual(f.state);
      await expect(f.controller.setNaming(value)).resolves.toEqual(f.state);
      expect(f.service.setEnabled).toHaveBeenLastCalledWith(value); expect(f.service.setNaming).toHaveBeenLastCalledWith(value);
    }
  });
  it('prevents overlapping directory selections and releases the picker after cancellation', async () => {
    const f = fixture(); let finish!: (value: undefined) => void;
    f.chooseDirectory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const selecting = f.controller.chooseSource({ nameFromContent: true });
    void selecting.catch(() => undefined);
    await expect(f.controller.chooseSource({ nameFromContent: false })).rejects.toThrow('文件选择窗口');
    finish(undefined); await selecting;
    await expect(f.controller.chooseSource({ nameFromContent: false })).resolves.toEqual(f.state);
  });
  it('opens only the source verified by the service and does not open a stale source', async () => {
    const f = fixture(); await f.controller.openSource();
    expect(f.openPath).toHaveBeenCalledWith('/verified/downloads'); expect(f.service.status).not.toHaveBeenCalled();
    f.openPath.mockClear(); f.service.resolveSource.mockRejectedValueOnce(new Error('/private/replaced'));
    await expect(f.controller.openSource()).rejects.toThrow('无法打开'); expect(f.openPath).not.toHaveBeenCalled();
    f.openPath.mockResolvedValueOnce('/private/system error');
    await expect(f.controller.openSource()).rejects.toThrow('无法打开');
  });
  it('allows receipt renaming with a text title but rejects renderer paths and invalid IDs', async () => {
    const f = fixture(); const id = '299d1d7d-bf8c-40aa-af8e-73c3e3b42b4b';
    await expect(f.controller.renameReceipt(id, '  招生视频拍摄计划  ')).resolves.toEqual(f.state);
    expect(f.service.renameReceipt).toHaveBeenCalledWith(id, '招生视频拍摄计划');
    f.service.renameReceipt.mockClear();
    for (const title of ['', ' ', '../private', '/private', 'a\\b', 'a:b', '.hidden', 'a\u0000b', 'a'.repeat(61), '名'.repeat(61), 'title.pdf', 'con', 'a?b', 'a\u202eb']) {
      await expect(f.controller.renameReceipt(id, title)).rejects.toThrow('输入');
    }
    for (const invalid of [undefined, null, '', '/private', 'unknown']) await expect(f.controller.renameReceipt(invalid, '正常标题')).rejects.toThrow('输入');
    expect(f.service.renameReceipt).not.toHaveBeenCalled();
  });
  it('sanitizes native and service errors without exposing internal paths', async () => {
    const f = fixture(); f.service.status.mockRejectedValueOnce(new Error('/private/state'));
    await expect(f.controller.status()).rejects.toThrow('无法读取');
    f.chooseDirectory.mockRejectedValueOnce(new Error('/private/picker'));
    await expect(f.controller.chooseSource({ nameFromContent: true })).rejects.toThrow('无法打开文件选择窗口');
    f.service.configure.mockRejectedValueOnce(new Error('/private/source'));
    await expect(f.controller.chooseSource({ nameFromContent: false })).rejects.toThrow('无法连接');
  });
});
