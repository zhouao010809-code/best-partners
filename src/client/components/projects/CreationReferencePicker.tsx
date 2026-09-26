import { useEffect, useId, useRef, useState } from 'react';
import { Check, Files, Search, X } from 'lucide-react';
import type { CreationReferenceSelection } from '../../../shared/api/project-creations.js';
import type { ProjectFile } from '../../../shared/api/projects.js';
import type { ReadConsoleApi } from '../../api/client.js';
import { creationError } from './useCreationDraft.js';
import './creative-context.css';

export interface CreationReferencePickerProps {
  api: ReadConsoleApi;
  projectId: string;
  value?: CreationReferenceSelection | undefined;
  onChange(value: CreationReferenceSelection): void;
  disabled?: boolean;
  compact?: boolean;
}
const automatic: CreationReferenceSelection = { mode: 'auto', paths: [] };
const usable = (file: ProjectFile) => file.kind === 'file' && file.parseStatus === 'readable' && file.origin === 'source' && !file.problem;
const reason = (file: ProjectFile) => usable(file) ? '' : file.origin !== 'source' ? '不是项目原始资料' : file.parseStatus === 'unsupported' ? '暂不支持读取' : file.parseStatus === 'too-large' ? '文件较大，暂不支持读取' : file.parseStatus === 'failed' ? '文件解析失败，请检查文件' : '资料已变化或无法读取，请更新资料后重新选择';
const copySelection = (value: CreationReferenceSelection): CreationReferenceSelection => ({ mode: value.mode, paths: [...value.paths] });

/** A project-keyed instance owns its pending selection and cancels obsolete lookups. */
export function CreationReferencePicker(props: CreationReferencePickerProps) {
  return <ReferencePickerSession key={props.projectId} {...props} />;
}
function ReferencePickerSession({ api, projectId, value = automatic, onChange, disabled = false, compact = false }: CreationReferencePickerProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(() => copySelection(value));
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<ProjectFile[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [validation, setValidation] = useState<Record<string, string>>({});
  const validated = useRef<Record<string, string>>({});
  const group = useId();
  const valueKey = JSON.stringify(value);
  const pathsKey = JSON.stringify(pending.paths);
  useEffect(() => { setPending(copySelection(value)); }, [valueKey]);
  useEffect(() => {
    if (!open || pending.mode !== 'selected') return;
    const controller = new AbortController();
    setBusy(true); setError('');
    if (!api.projects) { setError('当前连接无法读取项目资料。'); setBusy(false); return; }
    void api.projects.files(projectId, { origin: 'source', search: search.trim(), limit: 200 }, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (!result.ok) { setError(creationError(result)); setItems([]); return; }
      setItems(result.value.items.filter(item => item.kind === 'file' && item.origin === 'source'));
      setTotal(result.value.total);
    }).catch(() => { if (!controller.signal.aborted) setError('项目资料读取失败，请重试。'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api.projects, projectId, open, pending.mode, search, refresh]);
  useEffect(() => {
    if (!open || pending.mode !== 'selected' || !api.projects) return;
    const controller = new AbortController();
    for (const path of pending.paths) {
      if (validated.current[path] !== undefined) continue;
      void api.projects.file(projectId, path, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        const problem = result.ok ? reason(result.value) : creationError(result, '资料已移走或当前无法读取。');
        validated.current[path] = problem;
        setValidation(current => ({ ...current, [path]: problem }));
      }).catch(() => {
        if (controller.signal.aborted) return;
        const problem = '资料暂时无法核对，请重试。';
        validated.current[path] = problem; setValidation(current => ({ ...current, [path]: problem }));
      });
    }
    return () => controller.abort();
  }, [api.projects, projectId, open, pending.mode, pathsKey, refresh]);
  const invalid = pending.paths.some(path => !!validation[path]);
  const dirty = JSON.stringify(pending) !== valueKey;
  function toggle(file: ProjectFile) {
    if (disabled || !usable(file)) return;
    validated.current[file.relativePath] = ''; setValidation(current => ({ ...current, [file.relativePath]: '' }));
    setPending(current => ({ mode: 'selected', paths: current.paths.includes(file.relativePath)
      ? current.paths.filter(path => path !== file.relativePath)
      : current.paths.length < 20 ? [...current.paths, file.relativePath] : current.paths }));
  }
  function retry() { validated.current = {}; setValidation({}); setRefresh(count => count + 1); }
  return <section className={`creative-context creative-references${compact ? ' creative-context--compact' : ''}`} aria-label="本条参考资料设置">
    <button className="creative-context__toggle" type="button" aria-expanded={open} onClick={() => setOpen(current => !current)}>
      <Files size={15} /><span>本条参考资料</span><small>{value.mode === 'selected' ? `已选 ${value.paths.length} 份` : '自动找资料'}</small><span aria-hidden="true">{open ? '−' : '+'}</span>
    </button>
    {open && <div className="creative-context__body">
      <fieldset className="creative-reference-modes" disabled={disabled}><legend className="sr-only">资料查找方式</legend>
        <label><input name={group} type="radio" checked={pending.mode === 'auto'} onChange={() => setPending({ mode: 'auto', paths: [] })} />自动找资料</label>
        <label><input name={group} type="radio" checked={pending.mode === 'selected'} onChange={() => setPending({ mode: 'selected', paths: [...pending.paths] })} />只用所选资料</label>
      </fieldset>
      <p className="creative-context__hint">{pending.mode === 'auto' ? '根据本条创作要求查找相关资料。' : '只查找所选项目文件，仍沿用项目档案、当前稿件和定稿范例。最多选择 20 份。'}</p>
      {pending.mode === 'selected' && <>
        <div className="creative-reference-selected" aria-label="已选参考资料"><strong>已选资料 · {pending.paths.length}/20</strong>
          {pending.paths.length === 0 && <p className="creative-context__hint">选择至少一份资料后再应用。</p>}
          {pending.paths.map(path => <div key={path} className="creative-reference-selected__item"><span>{path}{validation[path] && <small role="status">{validation[path]}</small>}</span><button type="button" disabled={disabled} aria-label={`移除参考资料：${path}`} onClick={() => setPending(current => ({ ...current, paths: current.paths.filter(item => item !== path) }))}><X size={14} /></button></div>)}
        </div>
        <label className="creative-reference-search"><Search size={14} /><input aria-label="搜索参考资料" placeholder="搜索项目资料" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} disabled={disabled} /></label>
        {busy && <p className="creative-context__hint" role="status">正在查找项目资料…</p>}
        {error && <p role="alert" className="creation-notice">{error} <button type="button" onClick={retry}>重试</button></p>}
        {!busy && !error && items.length === 0 && <p className="creative-context__hint">{search ? '没有匹配的项目资料，试试其他关键词。' : '项目还没有可选择的文件，可先在项目资料中添加。'}</p>}
        <div className="creative-reference-results">{items.map(item => <label key={item.relativePath} className="creative-reference-option"><input type="checkbox" aria-label={item.relativePath} checked={pending.paths.includes(item.relativePath)} disabled={disabled || !usable(item) || (pending.paths.length >= 20 && !pending.paths.includes(item.relativePath))} onChange={() => toggle(item)} /><span>{item.relativePath}{!usable(item) && <small>{reason(item)}</small>}</span></label>)}</div>
        {total > 200 && <p className="creative-context__hint">仅显示前 200 项，可搜索缩小范围；已选资料会继续保留。</p>}
        {invalid && <p className="creation-notice">部分已选资料无法读取，请移除或重新核对。<button type="button" onClick={retry}>重新核对</button></p>}
      </>}
      {dirty && <p className="creative-context__hint" role="status">资料选择尚未应用。</p>}
      <button type="button" className="projects-button" disabled={disabled || !dirty || (pending.mode === 'selected' && (pending.paths.length === 0 || pending.paths.length > 20 || invalid))} onClick={() => onChange(copySelection(pending))}><Check size={14} />应用资料选择</button>
    </div>}
  </section>;
}
