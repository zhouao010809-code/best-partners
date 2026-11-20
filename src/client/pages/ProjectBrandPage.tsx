import { useEffect, useState } from 'react';
import { ChevronRight, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { ProjectBrandProfile } from '../../shared/api/projects.js';
import type { ApiClientResult } from '../api/client.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import '../styles/projects.css';

type BrandView = 'evidence' | 'claims';
const fields = [
  { key: 'category', label: '品类', limit: 200 },
  { key: 'positioning', label: '品牌定位', limit: 4000 },
  { key: 'purchaseReason', label: '购买理由', limit: 4000 }
] as const;

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
  const brandUrl = `${projectUrl}/brand`;

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
      setEditError('请为已填写出处的证据补充依据，或移除该行。');
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
        setEditError('品牌资料已有更新。当前填写仍在表格中，可复制所需内容，再读取最新版。');
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
  const editing = draft !== undefined;
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
      {loaded && <><ChevronRight size={13} aria-hidden="true" /><Link to={projectUrl}>{loaded.name}</Link></>}
      <ChevronRight size={13} aria-hidden="true" /><span aria-current="page">品牌定位</span>
    </nav>
    <header className="projects-page__heading">
      <h1 id="brand-page-title">品牌定位</h1>
      {loaded && <div className="project-brand-actions">
        {draft ? <>
          <button type="button" disabled={saving} className="projects-button" onClick={() => {
            if (conflict) { reload(); return; }
            setDraft(undefined); setEditError('');
          }}>{conflict ? '放弃草稿并读取最新版' : '取消'}</button>
          <button type="button" disabled={saving || conflict} className="projects-button projects-button--primary" onClick={() => void save()}><Save size={15} aria-hidden="true" />{saving ? '正在保存…' : '保存'}</button>
        </> : <button type="button" disabled={!projects?.saveBrand} className="projects-button projects-button--primary" onClick={() => {
          setDraft(loaded.profile); setNotice('');
        }}><Pencil size={15} aria-hidden="true" />编辑品牌资料</button>}
      </div>}
    </header>
    {loadError ? <div className="projects-inline-message" role="alert">{loadError}<button type="button" className="projects-button" onClick={reload}>重新读取</button></div> :
      !loaded && <p role="status">正在读取品牌资料…</p>}
    {editError && <div className="projects-inline-message" role="alert">{editError}</div>}
    {notice && <p className="projects-inline-message" role="status">{notice}</p>}
    {loaded && profile && <>
      <section className="project-brand-section" aria-labelledby="brand-summary-title">
        <header className="project-brand-section__heading"><h2 id="brand-summary-title">项目概览</h2></header>
        <div className="project-brand-table-wrap"><table className="project-brand-table project-brand-table--overview" aria-label="项目概览">
          <thead><tr><th scope="col">项目名</th>{fields.map(field => <th scope="col" key={field.key}>{field.label}</th>)}</tr></thead>
          <tbody><tr><th scope="row">{loaded.name}</th>{fields.map(field => <td key={field.key}>
            {draft ? (field.key === 'category'
              ? <input className="project-brand-input" aria-label={field.label} maxLength={field.limit} disabled={saving} value={draft[field.key]}
                onChange={event => setDraft({ ...draft, [field.key]: event.target.value })} />
              : <textarea className="project-brand-textarea" aria-label={field.label} maxLength={field.limit} rows={3} disabled={saving} value={draft[field.key]}
                onChange={event => setDraft({ ...draft, [field.key]: event.target.value })} />)
              : emptyValue(profile[field.key])}
          </td>)}</tr></tbody>
        </table></div>
      </section>
      <section className="project-brand-section" aria-label="品牌定位明细">
        <header className="project-brand-section__heading">
          <nav className="project-brand-tabs" aria-label="品牌定位明细">
            <Link to={brandUrl} aria-current={evidenceView ? 'page' : undefined}>证据链</Link>
            <Link to={`${brandUrl}?view=claims`} aria-current={evidenceView ? undefined : 'page'}>核心宣传主张</Link>
          </nav>
          {draft && <button type="button" className="projects-button projects-button--quiet" disabled={saving || profile[view].length >= 50} onClick={() => setDraft(evidenceView
            ? { ...draft, evidence: [...draft.evidence, { fact: '', source: '' }] }
            : { ...draft, claims: [...draft.claims, { claim: '' }] })}>
            <Plus size={15} aria-hidden="true" />{evidenceView ? '添加证据' : '添加主张'}
          </button>}
        </header>
        <div className="project-brand-table-wrap"><table className={`project-brand-table project-brand-table--${view}`} aria-label={detailTitle}>
          <thead><tr>{evidenceView ? <><th scope="col">依据</th><th scope="col">出处</th></> : <th scope="col">主张内容</th>}
            {editing && <th scope="col" className="project-brand-row-actions">操作</th>}
          </tr></thead>
          <tbody>
            {profile[view].length === 0 && <tr><td colSpan={(evidenceView ? 2 : 1) + Number(editing)} className="project-brand-empty">{evidenceView ? '尚未填写证据' : '尚未填写核心宣传主张'}</td></tr>}
            {profile[view].map((row, index) => {
              const number = index + 1;
              return <tr key={`${view}-${index}`}>
                {'fact' in row ? (['fact', 'source'] as const).map(key => <td key={key}>{draft
                  ? <textarea className="project-brand-textarea" rows={2} aria-label={`${key === 'fact' ? '依据' : '出处'} ${number}`} maxLength={key === 'fact' ? 2000 : 1000}
                    disabled={saving} value={row[key]} onChange={event => setDraft({ ...draft, evidence: draft.evidence.map((item, i) => i === index ? { ...item, [key]: event.target.value } : item) })} />
                  : emptyValue(row[key])}</td>) : <td>{draft
                    ? <textarea className="project-brand-textarea" rows={2} aria-label={`主张内容 ${number}`} maxLength={2000}
                      disabled={saving} value={row.claim} onChange={event => setDraft({ ...draft, claims: draft.claims.map((item, i) => i === index ? { claim: event.target.value } : item) })} />
                    : row.claim}</td>}
                {editing && <td className="project-brand-row-actions"><button type="button" className="projects-icon-button" disabled={saving}
                  aria-label={`移除${evidenceView ? '证据' : '主张'} ${number}`} onClick={() => removeRow(index)}><Trash2 size={15} aria-hidden="true" /></button></td>}
              </tr>;
            })}
          </tbody>
        </table></div>
      </section>
    </>}
  </section>;
}
