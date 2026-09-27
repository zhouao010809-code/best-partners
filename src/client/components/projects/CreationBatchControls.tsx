import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ArchiveRestore, Trash2 } from 'lucide-react';
import type { CreationBatch } from './useCreationBatch.js';

export function CreationBatchToolbar({ batch, trash, disabled }: { batch: CreationBatch; trash: boolean; disabled: boolean }) {
  return <div className="creation-batch-toolbar" role="group" aria-label="批量管理当前列表">
    <div className="creation-actions"><button type="button" className="creation-text-action" disabled={disabled} onClick={batch.selectAll}>{batch.allSelected ? '取消全选' : '全选当前列表'}</button><span>已选 {batch.selectedCount} 条</span></div>
    <button type="button" className="projects-button" disabled={disabled || !batch.selectedCount} onClick={trash ? () => void batch.restore() : batch.requestDiscard}>{trash ? <ArchiveRestore size={15} /> : <Trash2 size={15} />}{trash ? `批量恢复（${batch.selectedCount}）` : `批量移入回收站（${batch.selectedCount}）`}</button>
  </div>;
}

export function CreationBatchResult({ batch, disabled, onRefresh }: { batch: CreationBatch; disabled: boolean; onRefresh(): void }) {
  if (!batch.report && !batch.progress && !batch.undoItems.length) return null;
  return <section className="creation-batch-result" aria-label="批量处理结果">
    {batch.progress ? <p role="status">正在{batch.progress.action === 'discard' ? '移入回收站' : '恢复'} · {batch.progress.completed} / {batch.progress.total} 条</p> : batch.report && <>
      <p role="status">{batch.report.action === 'discard' ? '已移入回收站' : '已恢复'} {batch.report.count} 条，{batch.report.failures.length} 条未完成。</p>
      {batch.report.failures.length > 0 && <><ul className="creation-batch-failures">{batch.report.failures.map(({ item, reason }) => <li key={item.id}>{item.title}：{reason}</li>)}</ul><p className="creation-hint">{batch.report.undo ? '未完成项仍在回收站，请重新读取后核对。此次撤销不会覆盖后来发生的修改。' : '仍在当前列表的未完成项保留选择。核对后可继续处理，已成功项不会重复提交。'}</p><button type="button" className="creation-text-action" disabled={disabled} onClick={onRefresh}>重新读取列表</button></>}
    </>}
    {batch.undoItems.length > 0 && <button type="button" className="creation-text-action" disabled={disabled} onClick={() => void batch.undo()}>撤销本批回收</button>}
  </section>;
}

export function CreationBatchDialog({ batch }: { batch: CreationBatch }) {
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef(batch.cancel); cancel.current = batch.cancel;
  const busy = useRef(batch.busy); busy.current = batch.busy;
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!busy.current) cancel.current(); }
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
  const items = batch.confirmation ?? [];
  return createPortal(<div className="creation-dialog-backdrop"><section ref={dialog} tabIndex={-1} className="creation-discard-dialog" role="dialog" aria-modal="true" aria-label="批量移入项目回收站">
    <h2>将这 {items.length} 条内容移入回收站？</h2>
    <ul className="creation-batch-confirm-list">{items.map(item => <li key={item.id}>{item.title}</li>)}</ul>
    <p>正文、历史版本和讨论会一起保留，可以整批撤销，也可以在回收站多选恢复。</p>
    <p>项目原始资料和已导出文件仍保留。被选为项目样稿的内容会取消样稿引用，恢复后可重新选择。</p>
    {batch.progress && <p role="status">正在移入回收站 · {batch.progress.completed} / {batch.progress.total} 条</p>}
    <div className="creation-actions"><button type="button" className="projects-button" disabled={batch.busy} onClick={batch.cancel}>取消</button><button type="button" className="projects-button projects-button--primary" disabled={batch.busy} onClick={() => void batch.discard()}>{batch.busy ? '正在移入…' : `确认移入回收站（${items.length}）`}</button></div>
  </section></div>, document.body);
}
