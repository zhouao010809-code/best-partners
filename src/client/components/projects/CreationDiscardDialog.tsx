import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectCreation } from '../../../shared/api/project-creations.js';

export function CreationDiscardDialog({ item, busy, error, onCancel, onConfirm }: { item: ProjectCreation; busy: boolean; error: string; onCancel(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef(onCancel); cancel.current = onCancel;
  const pending = useRef(busy); pending.current = busy;
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!pending.current) cancel.current(); }
      if (event.key !== 'Tab') return;
      const buttons = [...dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []];
      const first = buttons[0]; const last = buttons.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keydown, true);
    return () => { window.removeEventListener('keydown', keydown, true); if (trigger?.isConnected) trigger.focus(); };
  }, []);
  return createPortal(<div className="creation-dialog-backdrop"><section ref={dialog} tabIndex={-1} className="creation-discard-dialog" role="dialog" aria-modal="true" aria-label="移入项目回收站"><h2>移入项目回收站</h2><strong>{item.title}</strong><p>正文、历史版本和讨论会一起保留，可以随时恢复。</p><p>项目原始资料和已经导出的文件仍保留。如果这条内容被选为项目样稿，会同时取消样稿引用；恢复后可重新选择。</p>{error && <p className="creation-notice" role="alert">{error}</p>}<div className="creation-actions"><button type="button" className="projects-button" disabled={busy} onClick={onCancel}>取消</button><button type="button" className="projects-button projects-button--primary" disabled={busy} onClick={onConfirm}>{busy ? '正在移入…' : '确认移入回收站'}</button></div></section></div>, document.body);
}
