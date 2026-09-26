import { useCreationInput } from './useCreationInput.js';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { PenLine, Plus, Sparkles, ArrowUpRight, Check, FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ProjectCreation } from '../../../shared/api/project-creations.js';
import type { ReadConsoleApi } from '../../api/client.js';
import { CreationEditor } from './CreationEditor.js';
import { creationError } from './useCreationDraft.js';
import '../../styles/project-workbench.css';

type View = 'desk' | 'topics' | 'files' | 'final';
const tabs: { id: View; label: string }[] = [{ id: 'desk', label: '创作台' }, { id: 'topics', label: '选题库' }, { id: 'files', label: '项目资料' }, { id: 'final', label: '已定稿' }];
export function ProjectWorkbench({ api, projectId, files }: { api: ReadConsoleApi; projectId: string; files: ReactNode }) {
  const [view, setView] = useState<View>('desk');
  const [selected, setSelected] = useState<string>();
  const [items, setItems] = useState<ProjectCreation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [planning, setPlanning] = useState(false);
  const [brief, setBrief] = useCreationInput(`creation-planner-v1:${projectId}`);
  const [planMessage, setPlanMessage] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const alive = useRef(true);
  const creations = api.creations;
  const load = useCallback(async () => {
    if (!creations) return;
    setLoading(true); setError('');
    try { const result = await creations.list(projectId); if (!alive.current) return; if (result.ok) setItems(result.value.items); else setError(creationError(result)); }
    catch { if (alive.current) setError('创作内容读取失败，请重试。'); }
    finally { if (alive.current) setLoading(false); }
  }, [creations, projectId]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; controller.current?.abort(); }; }, [load]);
  const update = (item: ProjectCreation) => setItems(previous => [item, ...previous.filter(value => value.id !== item.id)]);
  async function create(kind: 'topic' | 'script') {
    if (!creations || busy) return;
    setBusy(true); setError('');
    try { const result = await creations.create(projectId, { kind, title: kind === 'topic' ? '未命名选题' : '未命名脚本' });
      if (!alive.current) return;
      if (result.ok) { update(result.value.item); setSelected(result.value.item.id); } else setError(creationError(result));
    } catch { if (alive.current) setError('创建没有完成，请重试。'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function planTopics() {
    if (!creations || busy || !brief.trim()) return;
    setBusy(true); setError(''); setPlanMessage('');
    const request = new AbortController(); controller.current = request;
    try {
      const result = await creations.suggest(projectId, { task: 'topics', instruction: brief.trim() }, request.signal);
      if (!alive.current || request.signal.aborted) return;
      if (!result.ok) { setError(creationError(result)); return; }
      let count = 0;
      for (const topic of result.value.topics) {
        if (request.signal.aborted || !alive.current) break;
        const saved = await creations.create(projectId, { kind: 'topic', ...topic, brief: brief.trim(), sources: result.value.sources });
        if (!alive.current) return;
        if (saved.ok) update(saved.value.item);
        if (request.signal.aborted || controller.current !== request) return;
        if (!saved.ok) { setError(`已保存 ${count} 条选题。${creationError(saved)}其余建议：${result.value.topics.slice(count).map(item => item.title).join('；')}`); break; }
        count++;
      }
      if (request.signal.aborted || controller.current !== request) return;
      setPlanMessage(count ? result.value.reply : `这次还没有可保存的选题。${result.value.reply}`); setView('topics');
      if (count > 0 && count === result.value.topics.length) setPlanning(false);
    } catch { if (alive.current && !request.signal.aborted) setError('策划没有完成，请重试；已经保存的选题仍在。'); }
    finally { if (alive.current && controller.current === request) setBusy(false); }
  }
  // Older read-only connections still expose project files without a misleading editor.
  if (!creations) return <>{files}</>;
  if (selected) return <CreationEditor key={`${projectId}:${selected}`} api={api} projectId={projectId} id={selected} onBack={() => { setSelected(undefined); void load(); }} onSaved={update} onOpen={setSelected} />;
  const visible = items.filter(item => view === 'topics' ? item.kind === 'topic' : view === 'final' ? !!item.finalVersionId : item.kind === 'script');
  return <section className="project-workbench" aria-label="项目创作工作台"><nav className="creation-tabs" role="tablist" aria-label="项目工作台">{tabs.map(tab => <button key={tab.id} type="button" role="tab" aria-selected={view === tab.id} onClick={() => setView(tab.id)}>{tab.label}{tab.id === 'topics' && items.filter(item => item.kind === 'topic').length > 0 && <span>{items.filter(item => item.kind === 'topic').length}</span>}</button>)}</nav>
    {view === 'files' ? files : <><div className="creation-list-heading"><div><h2>{view === 'topics' ? '值得拍的选题' : view === 'final' ? '已经定稿的内容' : '接着写，或开始一条新内容'}</h2><p>{view === 'topics' ? '选中一个角度，把它发展成脚本。' : view === 'final' ? '定稿版本单独保留，后续修改形成新的工作草稿。' : '从项目资料出发，把想法写成可以拍摄的脚本。'}</p></div><div className="creation-actions"><button type="button" className="projects-button" disabled={busy} onClick={() => setPlanning(value => !value)}><Sparkles size={15} />策划选题</button><button type="button" className="projects-button projects-button--primary" disabled={busy} onClick={() => void create(view === 'topics' ? 'topic' : 'script')}><Plus size={15} />{view === 'topics' ? '新建选题' : '新建脚本'}</button></div></div>
    {planning && <section className="creation-planner" aria-label="策划短视频选题"><label className="creation-label">这次想做什么内容？<textarea aria-label="选题要求" value={brief} maxLength={4000} onChange={event => setBrief(event.target.value)} placeholder="例如：面向准备美术集训的家长，从项目资料里找5个适合60秒口播的选题" rows={3} /></label><div className="creation-actions"><button type="button" className="projects-button projects-button--primary" disabled={busy || !brief.trim()} onClick={() => void planTopics()}>根据资料策划</button>{busy && <button type="button" className="projects-button" onClick={() => { controller.current?.abort(); setBusy(false); }}>停止策划</button>}</div><small>点击后，相关项目资料会发送给已配置的 DeepSeek，生成的选题保存在本机。</small></section>}
    {busy && <p className="creation-hint" role="status">正在处理，请稍候…</p>}
    {error && <p className="creation-notice" role="alert">{error} <button type="button" onClick={() => void load()}>重新读取</button> <Link to="/settings">模型设置</Link></p>}
    {planMessage && <p className="creation-hint" role="status">{planMessage}</p>}
    {loading ? <p role="status">正在读取创作内容…</p> : !visible.length ? <div className="creation-empty"><PenLine size={30} /><h3>{view === 'topics' ? '先找到一个值得讲的角度' : view === 'final' ? '定稿后，成稿会留在这里' : '你的第一条脚本，从这里开始'}</h3><p>{view === 'final' ? '在脚本编辑页点击“确认定稿”，保留当时的完整版本。' : '可以直接新建，也可以让问问根据项目资料一起构思。'}</p></div> : <div className="creation-list">{visible.map(item => <button type="button" className="creation-card" aria-label={`打开创作：${item.title}`} key={item.id} onClick={() => setSelected(item.id)}><span className="creation-card-meta">{item.finalVersionId ? <><Check size={13} />有定稿</> : <><FileText size={13} />{item.kind === 'topic' ? '待写脚本' : '正在创作'}</>}<span>{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</span></span><strong>{item.title}</strong><p>{item.angle || item.brief || item.body.slice(0, 90) || '打开后继续创作'}</p><span className="creation-card-open">{item.kind === 'topic' ? '发展成脚本' : '继续编辑'}<ArrowUpRight size={16} /></span></button>)}</div>}
    <p className="creation-hint creation-limit">{items.length} / 200 条创作 · 草稿与版本保存在本机</p></>}
  </section>;
}
