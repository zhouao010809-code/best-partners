import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkdiskThumbnail } from '../../src/client/components/workdisk/WorkdiskThumbnail.js';
import type { DesktopWorkdiskApi } from '../../src/shared/desktop/bridge.js';
import type { WorkdiskFile } from '../../src/shared/workdisk.js';

const file: WorkdiskFile = { path: 'image.png', name: 'image.png', kind: 'image', size: 1, date: '2026-11-03', modifiedAt: '2026-11-03T00:00:00Z' };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('loads only near the viewport and retries a transient miss without repeatedly decoding a bad file', async () => {
  vi.useFakeTimers();
  let observe!: IntersectionObserverCallback;
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) { observe = callback; } observe() {} disconnect() {} });
  const thumbnail = vi.fn().mockResolvedValue(null);
  const disk = { thumbnail } as unknown as DesktopWorkdiskApi;
  render(<WorkdiskThumbnail file={file} bindingId="one" disk={disk}><span>PNG</span></WorkdiskThumbnail>);
  expect(thumbnail).not.toHaveBeenCalled();
  await act(async () => observe([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver));
  expect(thumbnail).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  expect(thumbnail).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(thumbnail).toHaveBeenCalledTimes(2);
  await act(async () => observe([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver));
  thumbnail.mockResolvedValueOnce('data:image/jpeg;base64,/9j/2Q==');
  await act(async () => observe([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver));
  expect(document.querySelector('.workdisk-card-art img')).not.toBeNull();
});

it('does not show a thumbnail that arrives after switching disks', async () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  let finish!: (value: string) => void;
  const thumbnail = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(null);
  const disk = { thumbnail } as unknown as DesktopWorkdiskApi;
  const view = render(<WorkdiskThumbnail file={file} bindingId="one" disk={disk}><span>PNG</span></WorkdiskThumbnail>);
  view.rerender(<WorkdiskThumbnail file={file} bindingId="two" disk={disk}><span>PNG</span></WorkdiskThumbnail>);
  await act(async () => finish('data:image/jpeg;base64,/9j/2Q=='));
  expect(document.querySelector('.workdisk-card-art img')).toBeNull();
});
