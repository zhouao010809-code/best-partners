import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { ArrowLeft, FileText, RefreshCw, Search, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useCompanyRuntime } from '../../company/CompanyAppShell.js';
import type { CompanyApiResult } from '../../components/company/company-api.js';
import type { SkillDetail, SkillsPage } from '../../../shared/api/skills.js';
import { SafeMarkdown } from '../../components/SafeMarkdown.js';
import { isCancelled } from '../pageSupport.js';

type Resource<T> = { readonly status: 'loading' | 'refreshing' | 'ready' | 'failed'; readonly data?: T; readonly message?: string };

function resultError(result: CompanyApiResult<unknown>, fallback: string): string {
  return !result.ok && !isCancelled(result) ? (result.state.message || fallback) : fallback;
}

export function CompanySkillLibraryPage(): ReactElement {
  const { api } = useCompanyRuntime();
  const [resource, setResource] = useState<Resource<SkillsPage>>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<Resource<SkillDetail>>({ status: 'loading' });
  const [query, setQuery] = useState('');

  const load = useCallback(async (refresh = false): Promise<void> => {
    setResource(current => ({ status: refresh ? 'refreshing' : 'loading', ...(current.data === undefined ? {} : { data: current.data }) }));
    const result = await api.skills.list();
    if (!result.ok) {
      if (isCancelled(result)) return;
      setResource({ status: 'failed', message: resultError(result, 'Skill 目录暂时无法读取。') });
      return;
    }
    setResource({ status: 'ready', data: result.value });
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const openDetail = useCallback(async (id: string): Promise<void> => {
    setSelectedId(id);
    setDetail({ status: 'loading' });
    const result = await api.skills.get(id);
    if (!result.ok) {
      if (isCancelled(result)) return;
      setDetail({ status: 'failed', message: resultError(result, 'Skill 内容暂时无法读取。') });
      return;
    }
    setDetail({ status: 'ready', data: result.value });
  }, [api]);

  const selected = detail.data;
  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const items = resource.data?.items ?? [];
    return normalized.length === 0 ? items : items.filter(item => `${item.name} ${item.description} ${item.folderName ?? ''}`.toLocaleLowerCase().includes(normalized));
  }, [query, resource.data]);

  if (selectedId !== undefined) {
    return <section className="company-page company-skill-detail" aria-labelledby="company-skill-detail-title">
      <button type="button" className="company-back-link company-skill-back" onClick={() => { setSelectedId(undefined); setDetail({ status: 'loading' }); }}><ArrowLeft size={15} />返回 Skill 库</button>
      {detail.status === 'loading' && <div className="company-empty-state" aria-live="polite"><RefreshCw className="company-spin" size={18} />正在读取 Skill…</div>}
      {detail.status === 'failed' && <div className="company-empty-state"><p role="alert">{detail.message}</p><button type="button" className="company-secondary-button" onClick={() => void openDetail(selectedId)}>重新读取</button></div>}
      {detail.status === 'ready' && selected !== undefined && <>
        <header className="company-page__heading"><div><p className="company-eyebrow">SKILL / COMPANY METHOD</p><h1 id="company-skill-detail-title">{selected.name}</h1><p>{selected.description}</p></div><code className="company-skill-revision">版本 {selected.revision.slice(0, 8)}</code></header>
        <div className="company-skill-readonly"><FileText size={15} />来自公司工作区 <code>skills/</code> 的只读方法说明；内容变更由文件和 Agent 工作流管理。</div>
        <section className="company-skill-markdown" aria-label="Skill 方法正文"><SafeMarkdown>{selected.markdown}</SafeMarkdown></section>
        <section className="company-record-panel"><h2>同目录参考文件</h2>{selected.references.length > 0 ? <ul className="company-skill-references">{selected.references.map(reference => <li key={reference}><code>{reference}</code></li>)}</ul> : <p className="company-muted">这个 Skill 没有额外参考文件。</p>}</section>
      </>}
    </section>;
  }

  return <section className="company-page company-skill-library" aria-labelledby="company-skill-library-title">
    <header className="company-page__heading"><div><p className="company-eyebrow">SKILL LIBRARY / FILE-FIRST METHODS</p><h1 id="company-skill-library-title">Skill 库</h1><p>通用方法和行业方法都保存在公司工作区 <code>skills/</code> 下。当前版本只读浏览，不在网页中直接执行或修改 Skill。</p></div><button type="button" className="company-secondary-button" onClick={() => void load(true)} disabled={resource.status === 'loading' || resource.status === 'refreshing'}><RefreshCw size={15} className={resource.status === 'refreshing' ? 'company-spin' : undefined} />刷新</button></header>
    <div className="company-skill-toolbar"><span className="company-skill-toolbar__icon" aria-hidden="true"><Sparkles size={17} /></span><label className="company-search-field"><Search size={15} aria-hidden="true" /><span className="visually-hidden">搜索 Skill</span><input aria-label="搜索 Skill" placeholder="按名称、描述或分类搜索" value={query} onChange={event => setQuery(event.target.value)} /></label><span className="company-muted">{resource.data?.items.length ?? '…'} 个方法</span></div>
    {resource.status === 'loading' && <div className="company-empty-state" aria-live="polite"><RefreshCw className="company-spin" size={18} />正在读取 Skill 目录…</div>}
    {resource.status === 'refreshing' && <p className="company-muted">正在刷新 Skill 目录…</p>}
    {resource.status === 'failed' && <div className="company-empty-state"><p role="alert">{resource.message}</p><button type="button" className="company-secondary-button" onClick={() => void load()}>重新读取</button></div>}
    {resource.status === 'ready' && visibleItems.length === 0 && (resource.data?.items.length ?? 0) > 0 && <div className="company-empty-state"><Sparkles size={22} aria-hidden="true" /><h3>还没有匹配的 Skill</h3><p>把通用或行业方法文件夹放入公司工作区的 skills/ 后刷新。</p></div>}
    {visibleItems.length > 0 && <section className="company-skill-grid" aria-label="公司 Skill 列表">{visibleItems.map(item => <article className="company-skill-card" key={item.id}><div className="company-skill-card__topline"><span className="company-skill-card__dot" aria-hidden="true" /><code>{item.folderName ?? '通用方法'}</code></div><h2>{item.name}</h2><p>{item.description}</p><div className="company-skill-card__footer"><code>版本 {item.revision.slice(0, 8)}</code><button type="button" className="company-text-link" onClick={() => void openDetail(item.id)}>查看方法 <ArrowLeft size={14} aria-hidden="true" /></button></div></article>)}</section>}
    {resource.status === 'ready' && resource.data?.items.length === 0 && <div className="company-empty-state"><Sparkles size={22} aria-hidden="true" /><h3>公司 Skill 库还没有内容</h3><p>建议按“通用方法 / 教育 / 餐饮”等一层分类目录组织，每个 Skill 文件夹包含一个 SKILL.md。</p><Link className="company-primary-button" to="/company/projects">去项目档案库</Link></div>}
  </section>;
}
