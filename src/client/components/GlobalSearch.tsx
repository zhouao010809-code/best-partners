import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, FileText, Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ReadConsoleApi } from '../api/client.js';
import { askAssistant } from './assistant/assistantIntent.js';
import '../styles/global-search.css';

type SearchItem = { path: string; title: string; kind: 'material' | 'knowledge' };
type RecentItem = { title: string; href: string };
const recentKey = (vault: string) => `brain-recent:${vault}`;
export function readRecent(vault: string): RecentItem[] {
  try { const value: unknown = JSON.parse(sessionStorage.getItem(recentKey(vault)) || '[]'); return Array.isArray(value) ? value.filter((item): item is RecentItem => typeof item?.title === 'string' && typeof item?.href === 'string' && /^\/(library|knowledge|queue)\?/u.test(item.href)).slice(0, 10) : []; } catch { return []; }
}
export function rememberRecent(vault: string, item: RecentItem) {
  try { sessionStorage.setItem(recentKey(vault), JSON.stringify([item, ...readRecent(vault).filter(value => value.href !== item.href)].slice(0, 10))); } catch { /* Navigation remains available without storage. */ }
}
const targetFor = (item: SearchItem) => `${item.kind === 'knowledge' ? '/knowledge' : '/library'}?${new URLSearchParams({ path: item.path })}`;

export function GlobalSearch({ api, vault, onClose }: { api: ReadConsoleApi; vault: string; onClose: () => void }) {
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [retry, setRetry] = useState(0);
  const [items, setItems] = useState<SearchItem[]>([]);
  const [more, setMore] = useState<Array<'material' | 'knowledge'>>([]);
  const [selected, setSelected] = useState<SearchItem[]>([]);
  const [recent, setRecent] = useState(() => readRecent(vault));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.showModal(); input.current?.focus(); return () => previous?.focus(); }, []);
  useEffect(() => { const timer = setTimeout(() => setTerm(query.trim()), 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    if (!term) { setItems([]); setMore([]); setLoading(false); setError(''); return; }
    const controller = new AbortController(); setLoading(true); setError(''); setItems([]); setMore([]);
    void Promise.allSettled([Promise.resolve().then(() => api.listLibrary({ mode: 'source', title: term, limit: 12 }, controller.signal)), Promise.resolve().then(() => api.listKnowledge({ search: term, limit: 12 }, controller.signal))]).then(results => {
      if (controller.signal.aborted) return;
      const found: SearchItem[] = []; const remaining: Array<'material' | 'knowledge'> = []; let failed = 0;
      results.forEach((result, index) => { if (result.status !== 'fulfilled' || !result.value.ok) { failed += 1; return; } const kind: SearchItem['kind'] = index === 0 ? 'material' : 'knowledge'; if (result.value.value.nextCursor !== undefined) remaining.push(kind); found.push(...result.value.value.items.map(item => ({ path: item.path, title: item.title, kind }))); });
      setItems(found); setMore(remaining); setLoading(false); if (failed) setError(failed === 2 ? '暂时无法搜索，请检查连接后重试。' : '部分资料暂未读取，先显示可用结果。');
    });
    return () => controller.abort();
  }, [api, term, retry]);
  function open(href: string, title: string) { rememberRecent(vault, { href, title }); navigate(href); onClose(); }
  function reuse() {
    if (!selected.length) return;
    askAssistant({ scope: 'brain', prompt: `请只使用以下 ${selected.length} 篇已选知识，拟一份可编辑的文章提纲。先核对原文，列出观点对应的来源；不要保存或入库。\n\n${selected.map((item, index) => `${index + 1}. 《${item.title}》\n${item.path}`).join('\n\n')}` }); onClose();
  }
  return <dialog ref={dialog} className="global-search" aria-label="搜索大脑" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="global-search__body">
    <form onSubmit={event => { event.preventDefault(); setTerm(query.trim()); }} className="global-search__input"><Search size={21} /><input ref={input} aria-label="搜索全部资料与知识" placeholder="搜索资料标题、知识或主题…" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /><button type="button" aria-label="关闭搜索" onClick={onClose}><X size={19} /></button></form>
    <div className="global-search__results">
      {loading && <p role="status">正在搜索大脑…</p>}{error && <p role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>重新搜索</button></p>}
      {term && !loading && items.length === 0 && !error && <p>没有找到“{term}”。试试更短的关键词。</p>}
      {items.map(item => <div className="global-search__row" key={item.path}>{item.kind === 'knowledge' ? <label title="选入知识复用"><input type="checkbox" aria-label={`选用知识：${item.title}`} checked={selected.some(value => value.path === item.path)} disabled={selected.length >= 6 && !selected.some(value => value.path === item.path)} onChange={event => setSelected(values => event.target.checked ? [...values, item] : values.filter(value => value.path !== item.path))} /></label> : <FileText size={17} />}<button type="button" onClick={() => open(targetFor(item), item.title)}><strong>{item.title}</strong><small>{item.kind === 'knowledge' ? '知识' : '原始资料'} · {item.path.split('/').slice(0, -1).join(' / ')}</small></button><ArrowRight size={15} /></div>)}
      {!term && <><div className="global-search__heading"><span>最近访问</span>{recent.length > 0 && <button type="button" onClick={() => { try { sessionStorage.removeItem(recentKey(vault)); } catch { /* In-memory clearing still works. */ } setRecent([]); }}>清除记录</button>}</div>{recent.length ? recent.map(item => <button type="button" className="global-search__recent" key={item.href} onClick={() => open(item.href, item.title)}><FileText size={16} />{item.title}<ArrowRight size={14} /></button>) : <p className="global-search__muted">打开过的资料会出现在这里。</p>}<div className="global-search__heading">快速前往</div><div className="global-search__shortcuts">{[['/queue', '提炼工作台'], ['/intake', '整理收件'], ['/knowledge', '浏览知识'], ['/operations', '操作与恢复']].map(([href, title]) => <button type="button" key={href} onClick={() => { navigate(href!); onClose(); }}>{title}<ArrowRight size={14} /></button>)}</div></>}
      {more.length > 0 && <div className="global-search__shortcuts">{more.map(kind => <button type="button" key={kind} onClick={() => { navigate(kind === 'knowledge' ? `/knowledge?${new URLSearchParams({ search: term, scope: 'all', layout: 'compact' })}` : `/library?${new URLSearchParams({ title: term, scope: 'all', mode: 'source' })}`); onClose(); }}>查看全部{kind === 'knowledge' ? '知识' : '资料'}结果<ArrowRight size={14} /></button>)}</div>}
    </div>
    {selected.length > 0 && <div className="global-search__reuse"><div><BookOpen size={16} />已选 {selected.length} 篇知识<button type="button" onClick={() => setSelected([])}>清空选择</button></div><button type="button" onClick={reuse}>用已选知识拟提纲 <ArrowRight size={15} /></button></div>}
    <footer>资料按标题检索 · 知识按关键词检索 · Enter 立即搜索</footer>
  </div></dialog>;
}
