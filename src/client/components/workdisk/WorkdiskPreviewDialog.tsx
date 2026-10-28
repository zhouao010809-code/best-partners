import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FileText, X } from 'lucide-react';
import type { WorkdiskFile, WorkdiskPreview } from '../../../shared/workdisk.js';
import type { XiaozhaoDesktopApi } from '../../../shared/desktop/bridge.js';

export function WorkdiskPreviewDialog({ file, disk, onClose }: { file: WorkdiskFile; disk: NonNullable<XiaozhaoDesktopApi['workdisk']>; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<WorkdiskPreview>();
  const [error, setError] = useState('');
  useEffect(() => {
    const node = dialog.current;
    if (node?.showModal) node.showModal(); else node?.setAttribute('open', '');
    return () => { node?.close?.(); };
  }, []);
  useEffect(() => {
    let live = true; setError(''); setPreview(undefined);
    void disk.preview(file.path).then(value => { if (live) setPreview(value); }, () => { if (live) setError('文件暂时无法读取，请刷新工作盘后再试。'); });
    return () => { live = false; };
  }, [disk, file.path]);
  return <dialog className="workdisk-preview" ref={dialog} aria-labelledby="workdisk-preview-title" onCancel={onClose}>
    <header><div><h3 id="workdisk-preview-title">{file.name}</h3><p>{file.path}</p></div><button aria-label="关闭预览" onClick={onClose}><X size={19} /></button></header>
    {error ? <p role="alert">{error}</p> : !preview ? <p role="status">正在打开文件…</p>
      : preview.kind === 'text' ? <div className="workdisk-text-preview"><pre>{preview.text}</pre>{preview.truncated && <p>这里只显示文件的前一部分，完整内容可用系统应用打开。</p>}</div>
        : preview.kind === 'image' && preview.url ? <img className="workdisk-image-preview" src={preview.url} alt={file.name} />
          : preview.kind === 'media' && preview.url ? <div className="workdisk-media-preview">{file.kind === 'audio' ? <audio controls src={preview.url} aria-label={file.name} /> : <video controls src={preview.url} aria-label={file.name} />}<p>若此格式无法播放，可用系统应用打开。</p></div>
            : <div className="workdisk-empty"><FileText /><h3>这个格式暂不支持内置预览</h3><p>文件已经收好，可以使用电脑上的应用打开。</p></div>}
    <footer><span>{file.date} · 本地文件</span><button onClick={() => { void disk.openFile(file.path).catch(() => setError('无法用系统应用打开此文件。')); }}><ExternalLink size={15} />用系统应用打开</button></footer>
  </dialog>;
}
