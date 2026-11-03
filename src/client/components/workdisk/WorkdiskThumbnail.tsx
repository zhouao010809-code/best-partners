import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkdiskFile } from '../../../shared/workdisk.js';
import type { DesktopWorkdiskApi } from '../../../shared/desktop/bridge.js';
import './workdisk-thumbnail.css';

export function WorkdiskThumbnail({ file, disk, bindingId, children }: {
  file: WorkdiskFile; disk: DesktopWorkdiskApi; bindingId: string; children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<{ key: string; url: string }>();
  const key = `${bindingId}/${file.path}/${file.modifiedAt}/${file.size}`;
  const url = image?.key === key ? image.url : undefined;
  useEffect(() => {
    if (!disk.thumbnail || !['image', 'video'].includes(file.kind)) return;
    let live = true;
    let visible = !globalThis.IntersectionObserver;
    let inFlight = false;
    let loaded = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      if (!live || !visible || inFlight || loaded || attempts >= 2) return;
      inFlight = true; attempts++;
      void disk.thumbnail!(file.path, bindingId).then(value => {
        if (live && value) { loaded = true; setImage({ key, url: value }); }
      }).catch(() => undefined).finally(() => {
        inFlight = false;
        if (live && visible && !loaded && attempts < 2) retry = setTimeout(load, 1200);
      });
    };
    if (!globalThis.IntersectionObserver) load();
    const observer = globalThis.IntersectionObserver ? new IntersectionObserver(entries => {
      const next = entries.some(entry => entry.isIntersecting);
      if (next && !visible) attempts = 0;
      visible = next;
      if (visible) load(); else clearTimeout(retry);
    }, { rootMargin: '160px' }) : undefined;
    if (container.current) observer?.observe(container.current);
    return () => { live = false; clearTimeout(retry); observer?.disconnect(); };
  }, [bindingId, disk, file.path, file.kind, key]);
  return <div ref={container} className={`workdisk-card-art${url ? ' workdisk-card-art--thumbnail' : ''}`}>
    {url ? <img src={url} alt="" aria-hidden="true" draggable={false} onError={() => setImage(undefined)} /> : children}
    {url && <span>{file.kind === 'video' ? '视频' : file.name.split('.').pop()?.slice(0, 8).toUpperCase()}</span>}
  </div>;
}
