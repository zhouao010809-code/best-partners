import { useCreationInput } from './useCreationInput.js';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { PenLine, Plus, Sparkles, ArrowUpRight, Check, FileText, Trash2, ArchiveRestore } from 'lucide-react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { creationReferenceSelectionSchema, creationSuggestionSchema, type CreationReferenceSelection, type ProjectCreation } from '../../../shared/api/project-creations.js';
import type { ProjectCreativeProfile } from '../../../shared/api/creative-profile.js';
import type { ReadConsoleApi } from '../../api/client.js';
import { CreationEditor } from './CreationEditor.js';
import { ProjectCreativeProfile as ProjectCreativeProfilePanel } from './ProjectCreativeProfile.js';
import { CreationReferencePicker } from './CreationReferencePicker.js';
import { CreationDiscardDialog } from './CreationDiscardDialog.js';
import { creationError } from './useCreationDraft.js';
import '../../styles/project-workbench.css';

type View = 'desk' | 'topics' | 'files' | 'final' | 'trash';
const tabs: { id: View; label: string }[] = [{ id: 'desk', label: '创作台' }, { id: 'topics', label: '选题库' }, { id: 'files', label: '项目资料' }, { id: 'final', label: '已定稿' }, { id: 'trash', label: '回收站' }];
const candidateSchema = z.strictObject({ suggestion: creationSuggestionSchema, brief: z.string().max(4000), references: creationReferenceSelectionSchema, remaining: z.array(z.number().int().min(0).max(19)).max(20), picked: z.array(z.number().int().min(0).max(19)).max(20), requestIds: z.array(z.uuid()).max(20).default([]) });
type Candidates = z.infer<typeof candidateSchema>;
const savingCandidateProjects = new Set<string>();
const candidateChangedEvent = 'project-topic-candidates-changed';
function readCandidates(key: string): Candidates | undefined {
  try { const parsed = candidateSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? 'null')); if (parsed.success) return { ...parsed.data, requestIds: parsed.data.suggestion.topics.map((_, index) => parsed.data.requestIds[index] ?? crypto.randomUUID()) }; } catch { /* Only recover validated local candidates. */ }
  return undefined;
}
export function ProjectWorkbench({ api, projectId, files, onEditingChange }: { api: ReadConsoleApi; projectId: string; files: ReactNode; onEditingChange?(editing: boolean): void }) {
  const [view, setView] = useState<View>('desk');
  const [selected, setSelected] = useState<string>();
  const [items, setItems] = useState<ProjectCreation[]>([]);
  const [discarded, setDiscarded] = useState<ProjectCreation[]>([]);
  const [discardTarget, setDiscardTarget] = useState<ProjectCreation>();
  const [undoItem, setUndoItem] = useState<ProjectCreation>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'create' | 'plan' | 'save-topics' | 'discard' | 'restore'>();
  const mutation = useRef(false);
  const [error, setError] = useState('');
  const [planning, setPlanning] = useState(false);
  const [brief, setBrief] = useCreationInput(`creation-planner-v1:${projectId}`);
  const [referenceJson, setReferenceJson] = useCreationInput(`creation-planner-references-v1:${projectId}`, 100000);
  const candidateKey = `creation-candidates-v1:${projectId}`;
  const [candidates, setCandidates] = useState<Candidates | undefined>(() => readCandidates(candidateKey));
  const [profileRevision, setProfileRevision] = useState<number>();
  const profileRevisionRef = useRef<number | undefined>(undefined);
  const profileSaved = useCallback((profile: ProjectCreativeProfile) => { profileRevisionRef.current = profile.revision; setProfileRevision(profile.revision); }, []);
  let references: CreationReferenceSelection = { mode: 'auto', paths: [] };
  try { const parsed = creationReferenceSelectionSchema.safeParse(JSON.parse(referenceJson)); if (parsed.success) references = parsed.data; } catch { /* Preserve automatic discovery for an empty recovery store. */ }
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const alive = useRef(true);
  const loadEpoch = useRef(0);
  const creations = api.creations;
  const load = useCallback(async () => {
    if (!creations) return;
    const epoch = ++loadEpoch.current;
    setLoading(true); setError('');
    try {
      const results = await Promise.all([creations.list(projectId), creations.listDiscarded?.(projectId)]);
      if (!alive.current || epoch !== loadEpoch.current) return;
      const [active, trash] = results;
      if (active.ok) setItems(active.value.items); else setError(creationError(active));
      if (trash?.ok) setDiscarded(trash.value.items); else if (trash) setError(creationError(trash));
    } catch { if (alive.current && epoch === loadEpoch.current) setError('创作内容读取失败，请重试。'); }
    finally { if (alive.current && epoch === loadEpoch.current) setLoading(false); }
  }, [creations, projectId]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; controller.current?.abort(); }; }, [load]);
  const editing = selected !== undefined;
  useEffect(() => { onEditingChange?.(editing); return () => onEditingChange?.(false); }, [editing, onEditingChange]);
  const update = (item: ProjectCreation) => {
    // Prevent a list request started before this mutation from reintroducing an old row.
    loadEpoch.current += 1; setLoading(false);
    setItems(previous => item.discardedAt ? previous.filter(value => value.id !== item.id) : [item, ...previous.filter(value => value.id !== item.id)]);
    setDiscarded(previous => item.discardedAt ? [item, ...previous.filter(value => value.id !== item.id)] : previous.filter(value => value.id !== item.id));
  };
  function rememberCandidates(next?: Candidates) {
    if (alive.current) setCandidates(next);
    // Persist each successful selection before another create can start, including on navigation.
    try { if (next) localStorage.setItem(candidateKey, JSON.stringify(next)); else localStorage.removeItem(candidateKey); } catch { if (alive.current) setError('本机暂时无法保留未保存建议，请在当前页面完成选择。'); }
    window.dispatchEvent(new CustomEvent(candidateChangedEvent, { detail: { key: candidateKey } }));
  }
  useEffect(() => {
    const refresh = (event?: Event) => {
      if (event instanceof StorageEvent && event.key !== candidateKey) return;
      if (event instanceof CustomEvent && event.detail?.key !== candidateKey) return;
      setCandidates(readCandidates(candidateKey));
      setBusy(value => savingCandidateProjects.has(candidateKey) ? 'save-topics' : value === 'save-topics' ? undefined : value);
    };
    refresh();
    window.addEventListener(candidateChangedEvent, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(candidateChangedEvent, refresh); window.removeEventListener('storage', refresh); };
  }, [candidateKey]);
  function outdated(value: Candidates) {
    return value.suggestion.profileRevision !== undefined && profileRevisionRef.current !== undefined && value.suggestion.profileRevision !== profileRevisionRef.current;
  }
  async function create(kind: 'topic' | 'script') {
    if (!creations || mutation.current || busy) return;
    mutation.current = true; setBusy('create'); setError('');
    try { const result = await creations.create(projectId, { kind, title: kind === 'topic' ? '未命名选题' : '未命名脚本' });
      if (!alive.current) return;
      if (result.ok) { update(result.value.item); setSelected(result.value.item.id); } else setError(creationError(result));
    } catch { if (alive.current) setError('创建没有完成，请重新读取列表后重试。'); }
    finally { mutation.current = false; if (alive.current) setBusy(undefined); }
  }
  async function planTopics() {
    if (!creations || busy || mutation.current || !brief.trim()) return;
    setBusy('plan'); setError(''); setMessage('');
    const request = new AbortController(); controller.current = request;
    const submittedBrief = brief.trim(); const submittedReferences = structuredClone(references);
    try {
      const result = await creations.suggest(projectId, { task: 'topics', instruction: submittedBrief, referenceSelection: submittedReferences }, request.signal);
      if (!alive.current || request.signal.aborted || controller.current !== request) return;
      if (!result.ok) { setError(creationError(result)); return; }
      const next: Candidates = { suggestion: result.value, brief: submittedBrief, references: submittedReferences, remaining: result.value.topics.map((_, index) => index), picked: [], requestIds: result.value.topics.map(() => crypto.randomUUID()) };
      if (outdated(next)) { setError('项目创作档案已变化，请按最新档案重新策划。'); return; }
      if (!next.remaining.length) { setMessage(`这次还没有可保存的选题。${result.value.reply}`); return; }
      rememberCandidates(next); setView('topics'); setPlanning(false); setMessage(result.value.reply);
    } catch { if (alive.current && !request.signal.aborted) setError('策划没有完成，请重试。'); }
    finally { if (alive.current && controller.current === request) setBusy(undefined); }
  }
  async function saveTopics() {
    if (!creations || !candidates || !candidates.picked.length || busy || mutation.current || savingCandidateProjects.has(candidateKey)) return;
    if (creations.getProfile && candidates.suggestion.profileRevision !== undefined && profileRevisionRef.current === undefined) { setError('正在核对项目创作档案，请稍候再保存。'); return; }
    if (outdated(candidates)) { setError('项目创作档案已变化，请放弃这批建议，按最新档案重新策划。'); return; }
    mutation.current = true; savingCandidateProjects.add(candidateKey); setBusy('save-topics'); setError('');
    rememberCandidates(candidates);
    window.dispatchEvent(new CustomEvent(candidateChangedEvent, { detail: { key: candidateKey } }));
    let remaining = structuredClone(candidates); let count = 0;
    try {
      for (const index of candidates.picked) {
        if (!alive.current) break;
        if (outdated(remaining)) { setError(`已保存 ${count} 条选题。项目创作档案已变化，剩余选题未保存，请按最新档案重新策划。`); return; }
        const topic = remaining.suggestion.topics[index]; if (!topic || !remaining.remaining.includes(index)) continue;
        const result = await creations.create(projectId, { kind: 'topic', ...topic, brief: remaining.brief, sources: remaining.suggestion.sources, referenceSelection: remaining.references, requestId: remaining.requestIds[index], ...(remaining.suggestion.profileRevision !== undefined ? { expectedProfileRevision: remaining.suggestion.profileRevision } : {}) });
        if (!result.ok) { if (alive.current) setError(`已保存 ${count} 条选题。${creationError(result)}剩余建议仍保留，请核对后重试。`); return; }
        count += 1;
        remaining = { ...remaining, remaining: remaining.remaining.filter(value => value !== index), picked: remaining.picked.filter(value => value !== index) };
        rememberCandidates(remaining.remaining.length ? remaining : undefined);
        if (alive.current) update(result.value.item);
      }
      if (alive.current) { setView('topics'); setMessage(`已保存 ${count} 条选题，未选择的建议可以继续挑选或放弃。`); }
    } catch { if (alive.current) setError(`已收到 ${count} 条保存成功结果。请重新读取列表，核对本次结果后再保存剩余建议。`); }
    finally { mutation.current = false; savingCandidateProjects.delete(candidateKey); if (alive.current) setBusy(undefined); window.dispatchEvent(new CustomEvent(candidateChangedEvent, { detail: { key: candidateKey } })); }
  }
  async function discard() {
    if (!creations?.discard || !discardTarget || mutation.current) return;
    mutation.current = true; setBusy('discard'); setError('');
    try {
      const result = await creations.discard(projectId, discardTarget.id, { expectedRevision: discardTarget.revision });
      if (!alive.current) return;
      if (!result.ok) { setError(creationError(result)); return; }
      update(result.value.item); setUndoItem(result.value.item); setSelected(undefined); setDiscardTarget(undefined);
      setMessage(`“${result.value.item.title}”已移入项目回收站。`);
      window.dispatchEvent(new CustomEvent('project-creation-lifecycle', { detail: { projectId } }));
    } catch { if (alive.current) setError('未收到明确结果，请取消此窗口后重新读取，核对回收站再操作。'); }
    finally { mutation.current = false; if (alive.current) setBusy(undefined); }
  }
  async function restore(item: ProjectCreation) {
    if (!creations?.restore || busy || mutation.current) return;
    mutation.current = true; setBusy('restore'); setError('');
    try {
      const result = await creations.restore(projectId, item.id, { expectedRevision: item.revision });
      if (!alive.current) return;
      if (!result.ok) { setError(creationError(result)); return; }
      update(result.value.item); setUndoItem(undefined); setMessage(`“${item.title}”已恢复，可以继续创作。`);
      if (view !== 'trash') setView(item.kind === 'topic' ? 'topics' : 'desk');
      window.dispatchEvent(new CustomEvent('project-creation-lifecycle', { detail: { projectId } }));
    } catch { if (alive.current) setError('恢复结果暂未确认，请重新读取列表后核对。'); }
    finally { mutation.current = false; if (alive.current) setBusy(undefined); }
  }
  if (!creations) return <>{files}</>;
  const visible = view === 'trash' ? discarded : items.filter(item => view === 'topics' ? item.kind === 'topic' : view === 'final' ? !!item.finalVersionId : item.kind === 'script');
  const pendingTopics = candidates?.remaining.filter(index => candidates.suggestion.topics[index]) ?? [];
  const canRecycle = Boolean(creations.discard && creations.restore && creations.listDiscarded);
  const checkingCandidateProfile = Boolean(creations.getProfile && candidates?.suggestion.profileRevision !== undefined && profileRevision === undefined);
  return <section className="project-workbench" aria-label="项目创作工作台">
    <div inert={Boolean(discardTarget)}>
      <ProjectCreativeProfilePanel api={api} projectId={projectId} onSaved={profileSaved} compact={editing} />
      {selected ? <CreationEditor key={`${projectId}:${selected}`} api={api} projectId={projectId} id={selected} profileRevision={profileRevision} onBack={() => { setSelected(undefined); void load(); }} onSaved={update} onOpen={setSelected} {...(canRecycle ? { onDiscard: (item: ProjectCreation) => { setError(''); setDiscardTarget(item); } } : {})} /> : <>
        <nav className="creation-tabs" role="tablist" aria-label="项目工作台">{tabs.filter(tab => tab.id !== 'trash' || canRecycle).map(tab => <button key={tab.id} type="button" role="tab" aria-selected={view === tab.id} onClick={() => setView(tab.id)}>{tab.label}{tab.id === 'topics' && items.filter(item => item.kind === 'topic').length > 0 && <span>{items.filter(item => item.kind === 'topic').length}</span>}</button>)}</nav>
        {view === 'files' ? files : <>
          <div className="creation-list-heading"><div><h2>{view === 'topics' ? '值得拍的选题' : view === 'final' ? '已经定稿的内容' : view === 'trash' ? '暂时放下的内容' : '接着写，或开始一条新内容'}</h2><p>{view === 'topics' ? '先挑选喜欢的角度，保存后再发展成脚本。' : view === 'final' ? '定稿版本单独保留，后续修改形成新的工作草稿。' : view === 'trash' ? '正文、历史版本和讨论都保留，随时可以恢复。' : '从项目资料出发，把想法写成可以拍摄的脚本。'}</p></div>{view !== 'trash' && <div className="creation-actions"><button type="button" className="projects-button" disabled={Boolean(busy)} onClick={() => setPlanning(value => !value)}><Sparkles size={15} />策划选题</button><button type="button" className="projects-button projects-button--primary" disabled={Boolean(busy)} onClick={() => void create(view === 'topics' ? 'topic' : 'script')}><Plus size={15} />{view === 'topics' ? '新建选题' : '新建脚本'}</button></div>}</div>
          {planning && view !== 'trash' && <section className="creation-planner" aria-label="策划短视频选题"><label className="creation-label">这次想做什么内容？<textarea aria-label="选题要求" value={brief} maxLength={4000} onChange={event => setBrief(event.target.value)} placeholder="例如：面向准备美术集训的家长，从项目资料里找5个适合60秒口播的选题" rows={3} /></label><CreationReferencePicker api={api} projectId={projectId} value={references} onChange={value => setReferenceJson(JSON.stringify(value))} disabled={Boolean(busy)} /><div className="creation-actions"><button type="button" className="projects-button projects-button--primary" disabled={Boolean(busy) || !brief.trim() || pendingTopics.length > 0} onClick={() => void planTopics()}>根据资料策划</button>{busy === 'plan' ? <button type="button" className="projects-button" onClick={() => { controller.current?.abort(); setBusy(undefined); setMessage('已停止策划，填写的要求仍保留。'); }}>停止策划</button> : <button type="button" className="projects-button" disabled={Boolean(busy)} onClick={() => setPlanning(false)}>收起策划</button>}</div><small>{pendingTopics.length ? '请先保存或放弃下方这批建议，再策划下一批。' : '相关资料会发送给已配置的 DeepSeek。生成后先预览，只有你选中的内容才会进入选题库。'}</small></section>}
          {candidates && pendingTopics.length > 0 && view !== 'trash' && <section className="creation-candidates" aria-label="待选择的选题"><div className="creation-list-heading"><div><h3>挑选这次想留下的角度</h3><p>还没有加入选题库 · 只保存你选中的内容</p></div><button type="button" className="creation-text-action" disabled={Boolean(busy)} onClick={() => rememberCandidates({ ...candidates, picked: candidates.picked.length === pendingTopics.length ? [] : pendingTopics })}>{candidates.picked.length === pendingTopics.length ? '取消全选' : '全选'}</button></div><div className="creation-candidate-list">{pendingTopics.map(index => { const topic = candidates.suggestion.topics[index]!; return <label key={`${candidates.suggestion.id}:${index}`} className="creation-candidate"><input type="checkbox" aria-label={`保留选题：${topic.title}`} checked={candidates.picked.includes(index)} disabled={Boolean(busy)} onChange={event => rememberCandidates({ ...candidates, picked: event.target.checked ? [...candidates.picked, index] : candidates.picked.filter(value => value !== index) })} /><span><strong>{topic.title}</strong><p>{topic.angle}</p><small>{[topic.audience, topic.rationale].filter(Boolean).join(' · ')}</small></span></label>; })}</div>{checkingCandidateProfile && <p role="status" className="creation-hint">正在核对项目创作档案…</p>}{outdated(candidates) && <p role="status" className="creation-notice">项目创作档案已变化，请放弃这批建议后重新策划。</p>}<div className="creation-actions"><button type="button" className="projects-button projects-button--primary" disabled={Boolean(busy) || checkingCandidateProfile || !candidates.picked.length || outdated(candidates)} onClick={() => void saveTopics()}>保存所选（{candidates.picked.length}）</button><button type="button" className="projects-button" disabled={Boolean(busy)} onClick={() => { rememberCandidates(); setMessage('未保存的建议已放弃，已保存的选题仍保留。'); }}>放弃剩余建议</button></div></section>}
          {busy && <p className="creation-hint" role="status">{busy === 'plan' ? '正在根据资料策划选题…' : busy === 'save-topics' ? '正在保存选中的选题…' : '正在处理，请稍候…'}</p>}
          {error && <p className="creation-notice" role="alert">{error} <button type="button" disabled={Boolean(busy)} onClick={() => void load()}>重新读取</button> <Link to="/settings">模型设置</Link></p>}
          {message && <p className="creation-hint" role="status">{message} {undoItem && <button type="button" className="creation-text-action" disabled={Boolean(busy)} onClick={() => void restore(undoItem)}>撤销移入</button>}</p>}
          {loading ? <p role="status">正在读取创作内容…</p> : !visible.length ? (pendingTopics.length > 0 && view !== 'trash' ? null : <div className="creation-empty"><PenLine size={30} /><h3>{view === 'topics' ? '先找到一个值得讲的角度' : view === 'final' ? '定稿后，成稿会留在这里' : view === 'trash' ? '回收站是空的' : '你的第一条脚本，从这里开始'}</h3><p>{view === 'final' ? '在脚本编辑页点击“确认定稿”，保留当时的完整版本。' : view === 'trash' ? '移入回收站的选题和脚本会在这里保留，恢复后可继续编辑。' : '可以直接新建，也可以让问问根据项目资料一起构思。'}</p></div>) : <div className="creation-list">{visible.map(item => <article className="creation-card" key={item.id}><button type="button" className="creation-card-main" disabled={view === 'trash' || Boolean(busy)} aria-label={`${view === 'trash' ? '已回收创作' : '打开创作'}：${item.title}`} onClick={() => setSelected(item.id)}><span className="creation-card-meta">{item.discardedAt ? <><Trash2 size={13} />已回收</> : item.finalVersionId ? <><Check size={13} />有定稿</> : <><FileText size={13} />{item.kind === 'topic' ? '待写脚本' : '正在创作'}</>}<span>{new Date(item.discardedAt ?? item.updatedAt).toLocaleDateString('zh-CN')}</span></span><strong>{item.title}</strong><p>{item.angle || item.brief || item.body.slice(0, 90) || '打开后继续创作'}</p>{view !== 'trash' && <span className="creation-card-open">{item.kind === 'topic' ? '发展成脚本' : '继续编辑'}<ArrowUpRight size={16} /></span>}</button>{canRecycle && <div className="creation-card-tools">{view === 'trash' ? <button type="button" className="creation-text-action" disabled={Boolean(busy)} aria-label={`恢复创作：${item.title}`} onClick={() => void restore(item)}><ArchiveRestore size={14} />恢复到{item.kind === 'topic' ? '选题库' : '创作台'}</button> : <button type="button" className="creation-text-action creation-remove" disabled={Boolean(busy)} aria-label={`移入回收站：${item.title}`} onClick={() => { setError(''); setDiscardTarget(item); }}><Trash2 size={14} />移入回收站</button>}</div>}</article>)}</div>}
          <p className="creation-hint creation-limit">{view === 'trash' ? `${discarded.length} 条已回收内容 · 不占创作条目数量` : `${items.length} / 200 条创作 · 草稿与版本保存在本机`}</p>
        </>}
      </>}
    </div>
    {discardTarget && <CreationDiscardDialog item={discardTarget} busy={busy === 'discard'} error={error} onCancel={() => { setDiscardTarget(undefined); setError(''); }} onConfirm={() => void discard()} />}
  </section>;
}
