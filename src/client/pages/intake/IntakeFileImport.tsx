import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ArrowRight, FileText, MessageCircle, Plus, RefreshCw } from 'lucide-react';
import type { Attachment, AttachmentSelection } from '../../../shared/api/attachments.js';
import type { ReadConsoleApi } from '../../api/client.js';
import { AttachmentPicker } from '../../components/assistant/AttachmentPicker.js';
import { askAssistant } from '../../components/assistant/assistantIntent.js';
import '../../styles/intake-file-import.css';

export function IntakeFileImport({ api, onArchived }: { api: ReadConsoleApi; onArchived: () => void }) {
  const service = api.attachments;
  const [selection, setSelection] = useState<AttachmentSelection[]>([]);
  const [groupId] = useState(() => crypto.randomUUID());
  const [records, setRecords] = useState<Attachment[]>([]);
  const [error, setError] = useState(''); const [busy, setBusy] = useState('');
  const [revision, setRevision] = useState(0); const [shown, setShown] = useState(8);
  const [pasteOpen, setPasteOpen] = useState(false); const [title, setTitle] = useState(''); const [text, setText] = useState('');
  const pendingPaste = useRef<{ id: string; groupId: string; file: File; text: string; title: string } | undefined>(undefined);
  const mounted = useRef(true); const sequence = useRef(0); const busyRef = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!service) return;
    const current = ++sequence.current;
    try {
      const result = await service.list(signal);
      if (!mounted.current || signal?.aborted || current !== sequence.current) return;
      if (result.ok) { setRecords(result.value.attachments); setError(''); }
      else setError('state' in result ? result.state.message ?? '暂存文件暂不可用，可重新读取。' : '暂存文件暂不可用。');
    } catch { if (mounted.current && !signal?.aborted && current === sequence.current) setError('暂存文件连接中断，可重新读取。'); }
  }, [service]);
  useEffect(() => { mounted.current = true; const controller = new AbortController(); void load(controller.signal); return () => { mounted.current = false; sequence.current += 1; controller.abort(); }; }, [load]);
  useEffect(() => {
    if (!records.some(record => record.status === 'processing')) return;
    const timer = setTimeout(() => void load(), 1500); return () => clearTimeout(timer);
  }, [records, load]);
  const updateRecords = useCallback((next: Attachment[]) => {
    setRecords(current => [...next, ...current.filter(record => !next.some(item => item.id === record.id))]);
  }, []);
  async function archive(record: Attachment) {
    if (!service || busyRef.current) return;
    busyRef.current = true; setBusy(record.id); setError('');
    try {
      const result = await service.archive(record.id);
      if (!mounted.current) return;
      if (!result.ok) { setError('state' in result ? result.state.message ?? '归档尚未确认，可再次核验。' : '归档尚未确认。'); return; }
      if (result.value.result.state !== 'archived') setError('归档需要继续核验，原件与恢复记录均已保留。');
      setRevision(value => value + 1); await load(); onArchived();
    } catch { if (mounted.current) setError('归档回应中断，请再次点击核验；相同文件会查找已有结果。'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(''); }
  }
  async function addText() {
    if (!service || busyRef.current || !title.trim() || !text.trim()) return;
    const name = `${title.trim().replace(/[/\\\p{Cc}:]/gu, '_').slice(0, 70)}.txt`;
    if (!pendingPaste.current || pendingPaste.current.text !== text || pendingPaste.current.title !== title) pendingPaste.current = { id: crypto.randomUUID(), groupId: crypto.randomUUID(), file: new File([text], name, { type: 'text/plain' }), text, title };
    const pending = pendingPaste.current;
    busyRef.current = true; setBusy('paste'); setError('');
    try {
      const result = await service.upload(pending.file, pending.id, pending.groupId);
      if (!mounted.current) return;
      if (!result.ok) { setError('state' in result ? result.state.message ?? '文字尚未保存，请重试。' : '文字尚未保存。'); return; }
      updateRecords([result.value.attachment]); setSelection([{ id: result.value.attachment.id }]); setText(''); setTitle(''); setPasteOpen(false); pendingPaste.current = undefined;
    } catch { if (mounted.current) setError('文字保存回应中断，可以重试核验同一份资料。'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(''); }
  }
  if (!service) return null;
  const selectedFile = (id: string): AttachmentSelection => selection.find(item => item.id === id) ?? { id };
  function inspect(id: string) {
    setSelection(current => {
      if (current.some(item => item.id === id)) return current;
      if (current.length >= 8) { setError('已选 8 份文件，请先移除一份再查看其他文件。'); return current; }
      return [...current, { id }];
    });
  }
  const actions = (record: Attachment) => <>
    {record.status === 'ready' && <button type="button" disabled={Boolean(busy)} onClick={() => askAssistant({ prompt: '请帮我理解这份文件的核心内容。', scope: 'brain', attachments: [selectedFile(record.id)] })}><MessageCircle />问问这份</button>}
    {record.archive?.state === 'archived' && record.archive.materialPath ? <><Link to={`/library?${new URLSearchParams({ path: record.archive.materialPath })}`}>打开归档<ArrowRight /></Link>{record.status === 'ready' && <button type="button" disabled={Boolean(busy)} onClick={() => askAssistant({ prompt: '请提炼这份文件所选范围的知识候选，保留原文引用。', scope: 'brain', attachments: [selectedFile(record.id)] })}>提炼这份<ArrowRight /></button>}</>
      : <button type="button" disabled={Boolean(busy) || record.status === 'processing'} onClick={() => void archive(record)}><Archive />{busy === record.id ? '正在归档…' : record.archive?.state === 'needs-review' ? '继续核验归档' : '归档原件'}</button>}
  </>;
  const history = records.filter(record => !selection.some(item => item.id === record.id));
  return <section className="intake-file-import" aria-label="导入本地资料">
    <header><div><h2>把资料带进来</h2><p>先暂存并阅读，归档后进入你的大脑。</p></div><button type="button" onClick={() => setPasteOpen(value => !value)} aria-expanded={pasteOpen}><Plus />粘贴文本</button></header>
    <AttachmentPicker api={api} value={selection} onChange={setSelection} groupId={groupId} disabled={Boolean(busy)} onAttachmentsChange={updateRecords} renderActions={actions} refreshKey={revision} />
    {pasteOpen && <form className="intake-file-import__paste" onSubmit={event => { event.preventDefault(); void addText(); }}><label>资料标题<input value={title} maxLength={70} required disabled={Boolean(busy)} onChange={event => setTitle(event.target.value)} /></label><label>粘贴正文<textarea value={text} maxLength={300_000} rows={6} required disabled={Boolean(busy)} onChange={event => setText(event.target.value)} /></label><button type="submit" disabled={Boolean(busy) || !title.trim() || !text.trim()}>{busy === 'paste' ? '正在保存…' : '添加为临时资料'}</button></form>}
    {error && <p role="alert" className="intake-file-import__error">{error}<button type="button" disabled={Boolean(busy)} onClick={() => void load()}><RefreshCw />重新读取</button></p>}
    {history.length > 0 && <details className="intake-file-import__history"><summary>本机文件 · {history.length} 份</summary><ul>{history.slice(0, shown).map(record => <li key={record.id}><div><FileText /><strong>{record.name}</strong><span>{record.archive?.state === 'archived' ? '已归档' : record.status === 'ready' ? '临时资料' : record.problem ?? '等待读取'}</span></div><div className="intake-file-import__actions">{actions(record)}<button type="button" disabled={Boolean(busy)} onClick={() => inspect(record.id)}>查看文件</button></div></li>)}</ul>{history.length > shown && <button type="button" onClick={() => setShown(count => count + 20)}>显示更多</button>}</details>}
  </section>;
}
