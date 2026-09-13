import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileText, LoaderCircle, Paperclip, X } from 'lucide-react';
import type { ReadConsoleApi } from '../../api/client.js';
import { ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_GROUP_BYTES, type Attachment, type AttachmentSelection } from '../../../shared/api/attachments.js';
import '../../styles/assistant-attachments.css';

export interface AttachmentPickerProps {
  api: ReadConsoleApi; value: AttachmentSelection[]; onChange: (value: AttachmentSelection[]) => void | Promise<void>;
  groupId: string; disabled?: boolean; onAttachmentsChange?: (records: Attachment[]) => void;
  renderActions?: (record: Attachment) => ReactNode; refreshKey?: number | string; children?: ReactNode;
}
export const attachmentContentHref = (id: string) => `/api/v1/assistant/attachments/${encodeURIComponent(id)}/content`;
const statusLabel = (record: Attachment) => ({ processing: '正在读取', ready: '可阅读', 'needs-ocr': '需要文字识别', encrypted: '文件有密码', failed: '读取失败', cancelled: '已取消读取' })[record.status];
const sizeLabel = (size: number) => size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;

export function AttachmentPicker({ api, value, onChange, groupId, disabled = false, onAttachmentsChange, renderActions, refreshKey = 0, children }: AttachmentPickerProps) {
  const service = api.attachments;
  const input = useRef<HTMLInputElement>(null);
  const files = useRef(new Map<string, File>());
  const uploadGroups = useRef(new Map<string, string>());
  const uploading = useRef(new Set<string>());
  const [records, setRecords] = useState<Record<string, Attachment>>({});
  const recordsRef = useRef(records); recordsRef.current = records;
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [uploadRevision, setUploadRevision] = useState(0);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  const valueRef = useRef(value); valueRef.current = value;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const selectionKey = value.map(item => item.id).join(',');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onAttachmentsChange?.(value.flatMap(item => records[item.id] ? [records[item.id]!] : [])); }, [records, selectionKey, onAttachmentsChange]);
  function acceptRecord(record: Attachment) {
    const next = { ...recordsRef.current, [record.id]: record }; recordsRef.current = next; setRecords(next);
    setProblems(items => { const next = { ...items }; delete next[record.id]; return next; });
  }
  useEffect(() => {
    if (!service || !selectionKey) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      await Promise.all(valueRef.current.map(async ({ id }) => {
        if (uploading.current.has(id)) return;
        try {
          const result = await service.get(id, controller.signal); if (controller.signal.aborted) return;
          if (result.ok) acceptRecord(result.value.attachment);
          else setProblems(items => ({ ...items, [id]: 'state' in result ? result.state.message ?? '未能读取文件状态。' : '未能读取文件状态。' }));
        } catch { if (!controller.signal.aborted) setProblems(items => ({ ...items, [id]: '文件状态暂时无法读取，可重试核对。' })); }
      }));
      if (!controller.signal.aborted && valueRef.current.some(({ id }) => uploading.current.has(id) || recordsRef.current[id]?.status === 'processing')) timer = setTimeout(() => void read(), 1000);
    };
    void read(); return () => { controller.abort(); clearTimeout(timer); };
  }, [service, selectionKey, refresh, refreshKey, uploadRevision]);

  async function upload(id: string, file: File) {
    if (!service) return;
    uploading.current.add(id); setUploadRevision(v => v + 1);
    try {
      const result = await service.upload(file, id, uploadGroups.current.get(id) ?? groupId); if (!mounted.current) return;
      if (result.ok) acceptRecord(result.value.attachment);
      else setProblems(items => ({ ...items, [id]: 'state' in result ? result.state.message ?? '上传尚未确认，请重试。' : '上传尚未确认，请重试。' }));
    } catch { if (mounted.current) setProblems(items => ({ ...items, [id]: '上传回应中断，可重试核对同一份文件。' })); }
    finally { uploading.current.delete(id); if (mounted.current) setUploadRevision(v => v + 1); }
  }
  async function choose(list: File[]) {
    if (disabled || !service || !list.length) return;
    setError('');
    const invalid = list.find(file => !/\.(pdf|md|txt)$/iu.test(file.name) || file.size > ATTACHMENT_MAX_FILE_BYTES);
    if (invalid) { setError(`《${invalid.name}》无法添加。支持 PDF、MD、TXT，每个文件不超过 10 MB。`); return; }
    const total = valueRef.current.reduce((sum, item) => sum + (recordsRef.current[item.id]?.size ?? files.current.get(item.id)?.size ?? 0), 0) + list.reduce((sum, file) => sum + file.size, 0);
    if (total > ATTACHMENT_MAX_GROUP_BYTES || valueRef.current.length + list.length > 8) { setError('本次附件总计不能超过 16 MB，最多 8 个文件。请移除部分文件后再添加。'); return; }
    const batchId = crypto.randomUUID();
    const selected = list.map(file => { const id = crypto.randomUUID(); uploadGroups.current.set(id, batchId); files.current.set(id, file); uploading.current.add(id); return { id, file }; });
    const next = [...valueRef.current, ...selected.map(({ id }) => ({ id }))]; valueRef.current = next;
    // The parent can durably record upload IDs before any bytes leave the input.
    try { await onChangeRef.current(next); } catch { selected.forEach(({ id }) => uploading.current.delete(id)); setUploadRevision(v => v + 1); setError('附件编号尚未保存，文件仍保留在此处。请重试草稿保存后再上传。'); return; }
    await Promise.all(selected.map(({ id, file }) => upload(id, file)));
  }
  async function retry(id: string) {
    if (!service || disabled) return;
    const record = records[id]; const file = files.current.get(id);
    if (!record && file) { try { await onChangeRef.current(valueRef.current); } catch { setError('附件编号尚未保存，请先重试草稿保存。'); return; } await upload(id, file); return; }
    if (!record) { setRefresh(v => v + 1); return; }
    try { const result = await service.retry(id); if (result.ok) acceptRecord(result.value.attachment); else setProblems(items => ({ ...items, [id]: 'state' in result ? result.state.message ?? '重试未完成。' : '重试未完成。' })); }
    catch { setProblems(items => ({ ...items, [id]: '重试请求未送达，请再试一次。' })); }
    setRefresh(v => v + 1);
  }
  async function changeSelection(next: AttachmentSelection[]) { valueRef.current = next; try { await onChangeRef.current(next); } catch { setError('附件选择尚未保存，请重试草稿保存。'); } }
  async function cancel(id: string) {
    if (!service) return;
    try { const result = await service.cancel(id); if (result.ok) acceptRecord(result.value.attachment); else setProblems(items => ({ ...items, [id]: 'state' in result ? result.state.message ?? '取消请求未完成。' : '取消请求未完成。' })); }
    catch { setProblems(items => ({ ...items, [id]: '取消请求未送达，请重试。' })); }
  }
  if (!service) return <>{children}</>;
  return <div className={`attachment-picker${dragging ? ' is-dragging' : ''}`} onDragOver={event => { if (!disabled && event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); void choose(Array.from(event.dataTransfer.files)); }}>
    <input ref={input} type="file" className="visually-hidden" aria-label="添加 PDF、MD 或 TXT 文件" accept=".pdf,.md,.txt" multiple disabled={disabled} onChange={event => { const chosen = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void choose(chosen); }} />
    <div className="attachment-picker__toolbar"><button type="button" disabled={disabled} onClick={() => input.current?.click()}><Paperclip size={15} />添加文件</button><span>{dragging ? '松开放入文件' : 'PDF / MD / TXT · 可拖入'}</span></div>
    {error && <p className="attachment-picker__error" role="alert">{error}</p>}
    {value.length > 0 && <ul className="attachment-picker__list" aria-label="本对话附件">{value.map(selection => {
      const record = records[selection.id]; const file = files.current.get(selection.id); const busy = uploading.current.has(selection.id); const problem = problems[selection.id];
      return <li key={selection.id} className="attachment-picker__item"><div className="attachment-picker__title">{busy || record?.status === 'processing' ? <LoaderCircle size={16} className="assistant-spin" /> : <FileText size={16} />}<strong title={record?.name ?? file?.name}>{record?.name ?? file?.name ?? '正在恢复附件…'}</strong><button type="button" aria-label={`移除附件 ${record?.name ?? file?.name ?? selection.id}`} title="从本对话移除，保留原件" disabled={disabled} onClick={() => { const next = valueRef.current.filter(item => item.id !== selection.id); valueRef.current = next; void changeSelection(next); }}><X size={14} /></button></div>
        <div className="attachment-picker__meta"><span>{busy ? '正在上传' : record ? statusLabel(record) : '核对上传结果'}{record ? ` · ${sizeLabel(record.size)}${record.pageCount ? ` · ${record.pageCount} 页` : ''}` : ''}</span>{record?.archive?.state === 'archived' ? <span>已归档{record.archive.indexed === false ? ' · 索引待更新' : ''}</span> : record?.archive?.state === 'needs-review' ? <span>归档待核验</span> : record?.archive?.state === 'preparing' ? <span>归档处理中</span> : <span>临时附件</span>}</div>
        {record?.problem && <p className="attachment-picker__error">{record.problem}</p>}
        {record?.status === 'needs-ocr' && !record.problem && <p className="attachment-picker__help">这份 PDF 尚无可读文字。请先进行文字识别，再上传文字版；原件仍可下载。</p>}
        {record?.status === 'encrypted' && !record.problem && <p className="attachment-picker__help">请先在本机解除文件密码，再重新添加。</p>}
        {record?.status === 'ready' && record.mediaType === 'application/pdf' && Boolean(record.pageCount) && <fieldset className="attachment-picker__pages" disabled={disabled}><legend>发送页码</legend><label>从<input aria-label={`${record.name} 起始页`} type="number" min={1} max={record.pageCount} value={selection.startPage ?? 1} onChange={event => { const page = Math.max(1, Math.min(record.pageCount!, Number(event.target.value) || 1)); void changeSelection(valueRef.current.map(item => item.id === selection.id ? { ...item, startPage: page, endPage: Math.max(page, item.endPage ?? record.pageCount!) } : item)); }} /></label><label>到<input aria-label={`${record.name} 结束页`} type="number" min={selection.startPage ?? 1} max={record.pageCount} value={selection.endPage ?? record.pageCount} onChange={event => { const page = Math.max(selection.startPage ?? 1, Math.min(record.pageCount!, Number(event.target.value) || 1)); void changeSelection(valueRef.current.map(item => item.id === selection.id ? { ...item, endPage: page } : item)); }} /></label><span>原件页码</span></fieldset>}
        {problem && <p className="attachment-picker__error" role="alert">{problem}{!record && !file ? ' 如未收到文件，请移除后重新选择原件。' : ''}</p>}
        <div className="attachment-picker__actions">{record && <a href={attachmentContentHref(record.id)} download={record.name}>下载原件</a>}{record?.status === 'processing' && <button type="button" disabled={disabled} onClick={() => void cancel(record.id)}>取消读取</button>}{!busy && (problem || record && ['failed', 'cancelled'].includes(record.status)) && <button type="button" disabled={disabled} onClick={() => void retry(selection.id)}>{record ? '重新读取' : file ? '重试上传' : '重新核对'}</button>}{record && renderActions?.(record)}</div>
      </li>;
    })}</ul>}
    {children}
  </div>;
}
