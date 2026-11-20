import { useEffect, useState } from 'react';
import { ArrowUpRight, ChevronRight, Link2, Megaphone, Pencil, PenLine, Plus, Save, Trash2 } from 'lucide-react';
import { Link, useMatch, useParams, useSearchParams } from 'react-router-dom';
import type { ProjectBrandProfile } from '../../shared/api/projects.js';
import type { ApiClientResult } from '../api/client.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import '../styles/projects.css';

type BrandView = 'evidence' | 'claims';

function readResult<T>(result: ApiClientResult<T>, fallback: string): T {
  if (result.ok) return result.value;
  throw new Error('state' in result ? result.state.message || fallback : fallback);
}

function emptyValue(value: string) {
  return value || <span className="project-brand-muted">待填写</span>;
}

export function ProjectBrandPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <ProjectBrandWorkspace key={id} id={id} /> : <p role="alert">请从「我的项目」打开品牌定位。</p>;
}

function ProjectBrandWorkspace({ id }: { id: string }) {
  const { api } = useConsoleRuntime();
  const projects = api.projects;
  const [params, setParams] = useSearchParams();
  const view: BrandView = params.get('view') === 'claims' ? 'claims' : 'evidence';
  const [loaded, setLoaded] = useState<{ name: string; profile: ProjectBrandProfile }>();
  const [draft, setDraft] = useState<ProjectBrandProfile>();
  const [loadError, setLoadError] = useState('');
  const [editError, setEditError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const projectUrl = `/projects/${encodeURIComponent(id)}`;
  const inBrandDetail = Boolean(useMatch('/projects/:id/brand'));
  const tabUrl = inBrandDetail ? `${projectUrl}/brand` : projectUrl;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      if (!projects?.getBrand) throw new Error('当前连接暂时无法读取品牌资料。');
      const [projectResult, profileResult] = await Promise.all([
        projects.get(id, controller.signal), projects.getBrand(id, controller.signal)
      ]);
      if (controller.signal.aborted) return;
      const project = readResult(projectResult, '项目读取失败，请重试。');
      const profile = readResult(profileResult, '品牌资料读取失败，请重试。');
      setLoaded({ name: project.displayName, profile });
    }
    void load().catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : '品牌资料读取失败，请重试。');
    });
    return () => controller.abort();
  }, [id, projects, attempt]);

  function reload() {
    setDraft(undefined);
    setLoaded(undefined);
    setConflict(false);
    setEditError('');
    setLoadError('');
    setNotice('');
    setAttempt(value => value + 1);
  }

  async function save() {
    if (!draft || !loaded || !projects?.saveBrand || saving || conflict) return;
    const evidence = draft.evidence.map(row => ({ fact: row.fact.trim(), source: row.source.trim() }))
      .filter(row => row.fact || row.source);
    if (evidence.some(row => !row.fact)) {
      setParams({});
      setEditError('请为已填写出处的证据补充依据，或移除这条证据。');
      return;
    }
    const claims = draft.claims.map(row => ({ claim: row.claim.trim() })).filter(row => row.claim);
    setSaving(true);
    setEditError('');
    try {
      const result = await projects.saveBrand(id, {
        category: draft.category.trim(), positioning: draft.positioning.trim(), purchaseReason: draft.purchaseReason.trim(),
        evidence, claims, expectedRevision: draft.revision
      });
      if (!result.ok && 'state' in result && (result.code === 'PROJECT_BRAND_REVISION_CONFLICT' || result.state.status === 'conflict')) {
        setConflict(true);
        setEditError('品牌资料已有更新。当前填写内容已保留，可复制所需内容，再读取最新版。');
        return;
      }
      const profile = readResult(result, '保存失败，当前填写已保留。');
      setLoaded({ name: loaded.name, profile });
      setDraft(undefined);
      setNotice('品牌资料已保存。');
    } catch (error) {
      setEditError(error instanceof Error ? error.message : '保存失败，当前填写已保留。');
    } finally {
      setSaving(false);
    }
  }

  const profile = draft ?? loaded?.profile;
  const evidenceView = view === 'evidence';
  const detailTitle = evidenceView ? '证据链' : '核心宣传主张';

  function removeRow(index: number) {
    if (!draft) return;
    setDraft(evidenceView
      ? { ...draft, evidence: draft.evidence.filter((_, i) => i !== index) }
      : { ...draft, claims: draft.claims.filter((_, i) => i !== index) });
  }

  return <section className="projects-page project-brand-page" aria-labelledby="brand-page-title">
    <nav className="project-brand-breadcrumbs" aria-label="项目导航">
      <Link to="/projects">我的项目</Link>
      <ChevronRight size={13} aria-hidden="true" />
      {inBrandDetail ? <>
        {loaded && <><Link to={projectUrl}>{loaded.name}</Link><ChevronRight size={13} aria-hidden="true" /></>}
        <span aria-current="page">品牌定位</span>
      </> : <span aria-current="page">项目概览</span>}
    </nav>
    <header className="projects-page__heading">
      <h1 id="brand-page-title">{inBrandDetail ? '品牌定位' : loaded?.name ?? '项目概览'}</h1>
      <div className="project-brand-actions">
        {!draft && <Link className="projects-button projects-button--quiet" to={`${projectUrl}/workbench`}><PenLine size={15} aria-hidden="true" />进入创作台</Link>}
        {draft ? <>
          <button type="button" disabled={saving} className="projects-button" onClick={() => {
            if (conflict) { reload(); return; }
            setDraft(undefined); setEditError('');
          }}>{conflict ? '放弃草稿并读取最新版' : '取消'}</button>
          <button type="button" disabled={saving || conflict} className="projects-button projects-button--primary" onClick={() => void save()}><Save size={15} aria-hidden="true" />{saving ? '正在保存…' : '保存'}</button>
        </> : loaded && <button type="button" disabled={!projects?.saveBrand} className="projects-button projects-button--primary" onClick={() => {
          setDraft(loaded.profile); setNotice('');
        }}><Pencil size={15} aria-hidden="true" />编辑品牌资料</button>}
      </div>
    </header>
    {loadError ? <div className="projects-inline-message" role="alert">{loadError}<button type="button" className="projects-button" onClick={reload}>重新读取</button></div> :
      !loaded && <p role="status">正在读取品牌资料…</p>}
    {editError && <div className="projects-inline-message" role="alert">{editError}</div>}
    {notice && <p className="projects-inline-message" role="status">{notice}</p>}
    {loaded && profile && <>
      <section className="brand-overview" aria-label="项目概览">
        <div className="brand-overview__identity">
          {inBrandDetail && <strong>{loaded.name}</strong>}
          <div>
            <span>品类</span>
            {draft ? <input className="project-brand-input" aria-label="品类" maxLength={200} disabled={saving} value={draft.category}
              onChange={event => setDraft({ ...draft, category: event.target.value })} /> : emptyValue(profile.category)}
          </div>
        </div>
        <div className="brand-overview__position">
          {draft ? <>
            <label htmlFor="brand-positioning">品牌定位</label>
            <textarea id="brand-positioning" className="project-brand-textarea" maxLength={4000} rows={3} disabled={saving} value={draft.positioning}
              onChange={event => setDraft({ ...draft, positioning: event.target.value })} />
          </> : <><h2>品牌定位</h2><p>{emptyValue(profile.positioning)}</p></>}
        </div>
        <div className="brand-overview__reason">
          {draft ? <>
            <label htmlFor="brand-purchase-reason">购买理由</label>
            <textarea id="brand-purchase-reason" className="project-brand-textarea" maxLength={4000} rows={3} disabled={saving} value={draft.purchaseReason}
              onChange={event => setDraft({ ...draft, purchaseReason: event.target.value })} />
          </> : <><h2>购买理由</h2><p>{emptyValue(profile.purchaseReason)}</p></>}
        </div>
      </section>
      <nav className="brand-portals" aria-label="品牌定位明细">
        <Link className="brand-portal brand-portal--evidence" to={tabUrl} aria-label="证据链" aria-current={evidenceView ? 'page' : undefined}>
          <span className="brand-portal__icon"><Link2 size={21} aria-hidden="true" /></span>
          <div><strong>证据链</strong><span className="brand-portal__count">{profile.evidence.length} 条依据</span></div>
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
        <Link className="brand-portal brand-portal--claims" to={`${tabUrl}?view=claims`} aria-label="核心宣传主张" aria-current={evidenceView ? undefined : 'page'}>
          <span className="brand-portal__icon"><Megaphone size={21} aria-hidden="true" /></span>
          <div><strong>核心宣传主张</strong><span className="brand-portal__count">{profile.claims.length} 条主张</span></div>
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </nav>
      <section className="brand-details" aria-label={detailTitle}>
        <header className="brand-details__heading">
          <h2>{detailTitle}</h2>
          {draft && <button type="button" className="projects-button projects-button--quiet" disabled={saving || profile[view].length >= 50} onClick={() => setDraft(evidenceView
            ? { ...draft, evidence: [...draft.evidence, { fact: '', source: '' }] }
            : { ...draft, claims: [...draft.claims, { claim: '' }] })}>
            <Plus size={15} aria-hidden="true" />{evidenceView ? '添加证据' : '添加主张'}
          </button>}
        </header>
        {profile[view].length === 0 && <div className="brand-details__empty">
          {evidenceView ? <Link2 aria-hidden="true" /> : <Megaphone aria-hidden="true" />}
          <p>{evidenceView ? '尚未填写证据。记录支持品牌定位的事实与出处。' : '尚未填写核心宣传主张。留下品牌希望传达的一句话。'}</p>
        </div>}
        <div className="brand-entry-list">
          {profile[view].map((row, index) => {
            const number = index + 1;
            return <article className="brand-entry" key={`${view}-${index}`} aria-label={`${evidenceView ? '证据' : '主张'} ${number}`}>
              {'fact' in row ? (['fact', 'source'] as const).map(key => {
                const label = key === 'fact' ? '依据' : '出处';
                const fieldId = `brand-evidence-${index}-${key}`;
                return <div className="brand-entry__field" key={key}>
                  {draft ? <>
                    <label className="brand-entry__label" htmlFor={fieldId}>{label}</label>
                    <textarea id={fieldId} className="project-brand-textarea" rows={2} aria-label={`${label} ${number}`} maxLength={key === 'fact' ? 2000 : 1000}
                      disabled={saving} value={row[key]} onChange={event => setDraft({ ...draft, evidence: draft.evidence.map((item, i) => i === index ? { ...item, [key]: event.target.value } : item) })} />
                  </> : <><span className="brand-entry__label">{label}</span><p>{emptyValue(row[key])}</p></>}
                </div>;
              }) : <div className="brand-entry__field">
                {draft ? <>
                  <label className="brand-entry__label" htmlFor={`brand-claim-${index}`}>主张内容</label>
                  <textarea id={`brand-claim-${index}`} className="project-brand-textarea" rows={2} aria-label={`主张内容 ${number}`} maxLength={2000}
                    disabled={saving} value={row.claim} onChange={event => setDraft({ ...draft, claims: draft.claims.map((item, i) => i === index ? { claim: event.target.value } : item) })} />
                </> : <><span className="brand-entry__label">主张内容</span><p>{row.claim}</p></>}
              </div>}
              {draft && <button type="button" className="projects-icon-button brand-entry__remove" disabled={saving}
                aria-label={`移除${evidenceView ? '证据' : '主张'} ${number}`} onClick={() => removeRow(index)}><Trash2 size={15} aria-hidden="true" /></button>}
            </article>;
          })}
        </div>
      </section>
    </>}
  </section>;
}
