import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Save, Sparkles, X } from 'lucide-react';
import type { CreativeProfileFields, CreativeProfileSave, ProjectCreativeProfile as SavedCreativeProfile } from '../../../shared/api/creative-profile.js';
import type { CreationDetail, CreationSuggestion, CreationVersion, ProjectCreation } from '../../../shared/api/project-creations.js';
import type { ReadConsoleApi } from '../../api/client.js';
import { creationError } from './useCreationDraft.js';
import './creative-context.css';

export interface ProjectCreativeProfileProps {
  api: ReadConsoleApi;
  projectId: string;
  onSaved?: (profile: SavedCreativeProfile) => void;
  compact?: boolean;
}
type Form = Omit<CreativeProfileSave, 'expectedRevision'>;
const emptyForm = (): Form => ({ audience: '', goal: '', style: '', facts: '', avoid: '', samples: [] });
const formOf = (profile: SavedCreativeProfile): Form => ({ audience: profile.audience, goal: profile.goal, style: profile.style, facts: profile.facts, avoid: profile.avoid, samples: profile.samples.map(sample => ({ ...sample })) });
const fingerprint = (form: Form) => JSON.stringify(form);
const fields: Array<{ name: keyof CreativeProfileFields; label: string; placeholder: string }> = [
  { name: 'audience', label: '受众', placeholder: '这些内容主要写给谁' },
  { name: 'goal', label: '内容目标', placeholder: '希望读者看完知道什么、做什么' },
  { name: 'style', label: '表达风格', placeholder: '例如：口语、直接，保留具体例子' },
  { name: 'facts', label: '已确认事实', placeholder: '已经核实、创作时需要保持准确的信息' },
  { name: 'avoid', label: '避免表达', placeholder: '例如：未经证实的数据、夸大承诺' }
];
export function ProjectCreativeProfile(props: ProjectCreativeProfileProps) {
  return <CreativeProfileSession key={props.projectId} {...props} />;
}
function CreativeProfileSession({ api, projectId, onSaved, compact = false }: ProjectCreativeProfileProps) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<SavedCreativeProfile>();
  const [form, setForm] = useState<Form>(emptyForm);
  const current = useRef(form);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState<{ suggestion: CreationSuggestion; fingerprint: string; revision: number }>();
  const [samplesOpen, setSamplesOpen] = useState(false);
  const [sampleItems, setSampleItems] = useState<ProjectCreation[]>([]);
  const [sampleDetails, setSampleDetails] = useState<Record<string, CreationDetail>>({});
  const [sampleError, setSampleError] = useState('');
  const [sampleBusy, setSampleBusy] = useState(false);
  const alive = useRef(false);
  const candidateController = useRef<AbortController | undefined>(undefined);
  const sampleController = useRef<AbortController | undefined>(undefined);
  const callback = useRef(onSaved); callback.current = onSaved;
  function edit(next: Form) { current.current = next; setForm(next); setNotice(''); }
  useEffect(() => { if (compact) setOpen(false); }, [compact]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; candidateController.current?.abort(); sampleController.current?.abort(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    if (!api.creations?.getProfile) { setLoading(false); setError('当前连接尚不支持项目创作档案，可继续直接创作。'); return; }
    setLoading(true); setError('');
    void api.creations.getProfile(projectId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (!result.ok) { setError(creationError(result)); return; }
      if (result.value.projectId !== projectId) { setError('项目档案不匹配，请重新读取。'); return; }
      setSaved(result.value); edit(formOf(result.value)); callback.current?.(result.value);
    }).catch(() => { if (!controller.signal.aborted) setError('项目档案读取失败，请重试；仍可直接创作。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api.creations, projectId, retry]);
  useEffect(() => {
    if (!open || !samplesOpen || !api.creations || !saved) return;
    const controller = new AbortController();
    setSampleBusy(true); setSampleError('');
    void api.creations.list(projectId, controller.signal).then(async result => {
      if (controller.signal.aborted) return;
      if (!result.ok) { setSampleError(creationError(result)); return; }
      setSampleItems(result.value.items.filter(item => item.projectId === projectId && item.finalVersionId));
      const details = await Promise.all(saved.samples.map(async sample => ({ sample, result: await api.creations!.get(projectId, sample.creationId, controller.signal) })));
      if (controller.signal.aborted) return;
      const resolved: Record<string, CreationDetail> = {};
      let unavailable = false;
      for (const entry of details) {
        if (entry.result.ok && entry.result.value.item.projectId === projectId && entry.result.value.item.id === entry.sample.creationId) resolved[entry.sample.creationId] = entry.result.value;
        else unavailable = true;
      }
      setSampleDetails(previous => ({ ...previous, ...resolved }));
      if (unavailable) setSampleError('部分已选定稿暂时无法读取，原选择仍保留，可重试或移除。');
    }).catch(() => { if (!controller.signal.aborted) setSampleError('定稿列表读取失败，请收起后重新展开。'); })
      .finally(() => { if (!controller.signal.aborted) setSampleBusy(false); });
    return () => controller.abort();
  }, [api.creations, projectId, open, samplesOpen, saved]);
  const dirty = !!saved && fingerprint(form) !== fingerprint(formOf(saved));
  const staleCandidate = !!pending && (pending.fingerprint !== fingerprint(form) || pending.revision !== saved?.revision
    || (pending.suggestion.profileRevision !== undefined && pending.suggestion.profileRevision !== saved?.revision));
  async function save() {
    if (!saved || !api.creations?.saveProfile || saving || conflict) return;
    const sent = current.current; const sentFingerprint = fingerprint(sent);
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await api.creations.saveProfile(projectId, { ...sent, samples: sent.samples.map(sample => ({ ...sample })), expectedRevision: saved.revision });
      if (!alive.current) return;
      if (!result.ok) {
        setError(creationError(result));
        if ('state' in result && (result.state.status === 'conflict' || result.code?.includes('CONFLICT'))) setConflict(true);
        return;
      }
      if (result.value.projectId !== projectId) { setError('保存结果与当前项目不匹配，请重新读取。'); return; }
      setSaved(result.value);
      if (fingerprint(current.current) === sentFingerprint) edit(formOf(result.value));
      setNotice('项目档案已保存，后续创作会使用这一版。'); callback.current?.(result.value);
    } catch { if (alive.current) setError('保存没有完成，你填写的内容仍保留，请重试。'); }
    finally { if (alive.current) setSaving(false); }
  }
  async function readLatest() {
    if (!api.creations?.getProfile || saving) return;
    setSaving(true);
    try {
      const result = await api.creations.getProfile(projectId);
      if (!alive.current) return;
      if (!result.ok) { setError(creationError(result)); return; }
      if (result.value.projectId !== projectId) { setError('项目档案不匹配，请重新读取。'); return; }
      setSaved(result.value); setConflict(false); setError(''); setNotice('已读取最新保存的档案。你的填写仍保留；核对后再保存。'); callback.current?.(result.value);
    } catch { if (alive.current) setError('最新档案读取失败，请重试。'); }
    finally { if (alive.current) setSaving(false); }
  }
  async function generate() {
    if (!api.creations || !saved || generating) return;
    const controller = new AbortController(); candidateController.current = controller;
    const startedFingerprint = fingerprint(current.current); const revision = saved.revision;
    setGenerating(true); setError(''); setPending(undefined); setNotice('');
    try {
      const result = await api.creations.suggest(projectId, { task: 'profile', instruction: '根据项目资料整理创作档案候选：受众、内容目标、表达风格、已确认事实、避免表达。只填写有资料依据的内容，不确定的留空，并提供实际参考来源。' }, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (!result.ok) { setError(creationError(result)); return; }
      if (!result.value.profile) { setError('本次未整理出档案字段，请重试或手动填写。'); return; }
      setPending({ suggestion: result.value, fingerprint: startedFingerprint, revision });
    } catch { if (alive.current && !controller.signal.aborted) setError('本次整理没有完成，填写内容仍保留，请重试。'); }
    finally { if (alive.current && candidateController.current === controller) setGenerating(false); }
  }
  async function chooseSample(item: ProjectCreation) {
    if (!api.creations || sampleBusy || current.current.samples.length >= 3 || current.current.samples.some(sample => sample.creationId === item.id)) return;
    const controller = new AbortController(); sampleController.current = controller;
    setSampleBusy(true); setSampleError('');
    try {
      const result = await api.creations.get(projectId, item.id, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (!result.ok) { setSampleError(creationError(result)); return; }
      const detail = result.value;
      const version = detail.versions.find(entry => entry.id === detail.item.finalVersionId && entry.creationId === item.id);
      if (detail.item.projectId !== projectId || detail.item.id !== item.id || !version) { setSampleError('该条内容没有可用的定稿版本，请重新选择。'); return; }
      setSampleDetails(previous => ({ ...previous, [item.id]: detail }));
      if (current.current.samples.length < 3 && !current.current.samples.some(sample => sample.creationId === item.id)) edit({ ...current.current, samples: [...current.current.samples, { creationId: item.id, versionId: version.id }] });
    } catch { if (alive.current && !controller.signal.aborted) setSampleError('定稿读取失败，请重试。'); }
    finally { if (alive.current && sampleController.current === controller) setSampleBusy(false); }
  }
  function sampleVersion(sample: Form['samples'][number]): CreationVersion | undefined {
    return sampleDetails[sample.creationId]?.versions.find(version => version.id === sample.versionId && version.creationId === sample.creationId);
  }
  return <section className={`creative-context creative-profile${compact ? ' creative-context--compact' : ''}`} aria-label="项目创作档案">
    <button type="button" className="creative-context__toggle" aria-expanded={open} onClick={() => setOpen(current => !current)}><BookOpen size={16} /><span>项目创作档案</span><small>{saved?.revision ? `已保存 · 第 ${saved.revision} 版` : '选填'}</small><span aria-hidden="true">{open ? '−' : '+'}</span></button>
    {open && <div className="creative-context__body">
      <p className="creative-context__hint">为本项目保留常用的创作要求。可稍后补充，保存后用于后续创作。</p>
      {saved && <details className="creative-profile-saved"><summary>{saved.revision ? `当前生效档案 · 第 ${saved.revision} 版` : '尚未保存项目档案'}</summary><dl>{fields.map(field => <div key={field.name}><dt>{field.label}</dt><dd>{saved[field.name] || '未填写'}</dd></div>)}</dl><p className="creative-context__hint">定稿范例：{saved.samples.length} 份</p></details>}
      {loading && <p role="status" className="creative-context__hint">正在读取项目档案…</p>}
      {error && <p role="alert" className="creation-notice">{error}{!saved && api.creations?.getProfile && <button type="button" onClick={() => setRetry(count => count + 1)}>重新读取</button>}</p>}
      <div className="creative-profile-fields">{fields.map(field => <label key={field.name} className="creative-profile-field"><span>{field.label}</span><textarea aria-label={field.label} value={form[field.name]} rows={field.name === 'facts' ? 3 : 2} maxLength={field.name === 'facts' ? 4000 : 2000} placeholder={field.placeholder} disabled={loading || !saved} onChange={event => edit({ ...current.current, [field.name]: event.target.value })} /></label>)}</div>
      <section className="creative-profile-samples"><button type="button" className="creative-profile-samples__toggle" aria-expanded={samplesOpen} disabled={!saved} onClick={() => setSamplesOpen(current => !current)}><span>定稿范例</span><small>{form.samples.length}/3</small><span aria-hidden="true">{samplesOpen ? '−' : '+'}</span></button>
        {samplesOpen && <><p className="creative-context__hint">选择本项目的定稿作为表达范例，最多 3 份。保留所选版本，之后重新定稿不会自动替换。</p>
          {form.samples.map(sample => { const version = sampleVersion(sample); return <div className="creative-reference-selected__item" key={sample.creationId}><span>{version ? `${version.title} · 第 ${version.number} 版` : `已选定稿 · ${sample.versionId}`}{!version && !sampleBusy && <small>该版本暂时无法读取，原选择仍保留。</small>}</span><button type="button" aria-label={`移除定稿范例：${version?.title ?? sample.versionId}`} onClick={() => edit({ ...current.current, samples: current.current.samples.filter(item => item.creationId !== sample.creationId) })}><X size={14} /></button></div>; })}
          {sampleBusy && <p role="status" className="creative-context__hint">正在读取定稿…</p>}{sampleError && <p role="alert" className="creation-notice">{sampleError}</p>}
          {!sampleBusy && !sampleItems.length && <p className="creative-context__hint">本项目还没有定稿，先完成一条内容即可选择。</p>}
          <div className="creative-sample-options">{sampleItems.map(item => <button type="button" className="projects-button" key={item.id} disabled={sampleBusy || form.samples.length >= 3 || form.samples.some(sample => sample.creationId === item.id)} onClick={() => void chooseSample(item)}>{item.title}{form.samples.some(sample => sample.creationId === item.id) ? ' · 已选' : ' · 选择定稿'}</button>)}</div>
        </>}
      </section>
      {dirty && <p className="creative-context__hint" role="status">未保存的填写不会用于创作；离开此页面前请保存。</p>}
      {conflict && <button type="button" className="projects-button" disabled={saving} onClick={() => void readLatest()}>读取最新档案，保留我的填写</button>}
      <div className="creative-context__actions"><button type="button" className="projects-button projects-button--primary" disabled={!saved || !dirty || saving || conflict || !api.creations?.saveProfile} onClick={() => void save()}><Save size={14} />{saving ? '正在保存…' : '保存项目档案'}</button><button type="button" className="projects-button" disabled={!saved || generating || saving} onClick={() => void generate()}><Sparkles size={14} />从资料整理</button></div>
      {generating && <p className="creative-context__hint" role="status">正在根据项目资料整理候选…<button type="button" onClick={() => { candidateController.current?.abort(); setGenerating(false); setNotice('已停止整理，填写内容保留。'); }}>停止</button></p>}
      {notice && <p role="status" className="creative-context__hint">{notice}</p>}
      {pending?.suggestion.profile && <section className="creative-profile-candidate" aria-label="档案候选预览"><h4>档案候选 · 尚未采用</h4><dl>{fields.map(field => <div key={field.name}><dt>{field.label}</dt><dd>{pending.suggestion.profile![field.name] || '暂无资料依据，留空'}</dd></div>)}</dl>
        <strong>本次参考来源 · {pending.suggestion.sources.length}</strong><ul className="creative-profile-source-list">{pending.suggestion.sources.map((source, index) => <li key={`${source.path}:${index}`}><span>{source.title}</span><small>{source.path}</small>{source.evidence?.slice(0, 2).map((part, i) => <blockquote key={i}>{part.excerpt}</blockquote>)}</li>)}</ul>
        {pending.suggestion.sources.length === 0 && <p className="creative-context__hint">本次没有返回参考来源，请核对后再采用。</p>}
        {staleCandidate && <p role="status" className="creation-notice">填写内容或已保存档案已变化，请重新整理，以保留你的最新修改。</p>}
        <button type="button" className="projects-button" disabled={staleCandidate || saving} onClick={() => { if (!pending.suggestion.profile || staleCandidate) return; edit({ ...current.current, ...pending.suggestion.profile }); setPending(undefined); setNotice('已采用到表单；保存项目档案后才会用于创作。'); }}><Check size={14} />采用到表单</button>
      </section>}
    </div>}
  </section>;
}
