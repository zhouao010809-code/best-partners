import { useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveRestore, Check, FileText, Package, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { MaterialTrashProvider, useMaterialTrash } from '../components/MaterialTrash.js';
import { useTrashInventory, trashOrigins, type TrashPaper } from '../components/useTrashInventory.js';
import { RecycleBinLid } from '../components/RecycleBinArtwork.js';
import { useIntakeTrash } from './intake/useIntakeTrash.js';
import '../styles/unified-trash.css';

const statusText = { moving: '正在移入', trashed: '可恢复', restoring: '正在恢复', restored: '已恢复', 'needs-review': '需要核验', deleting: '删除待核验', deleted: '已彻底删除' };
const dateText = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const paperPath = (paper: TrashPaper) => paper.kind === 'document' ? paper.entry.materialPath : `01图书馆/小兆clipper/${paper.entry.name}`;
const sourceLabel = (paper: TrashPaper) => trashOrigins.find(origin => origin.id === paper.origin)!.label;

export function TrashPage() {
  const { refreshHealth } = useConsoleRuntime();
  const onChanged = useCallback(() => { void refreshHealth?.().catch(() => undefined); }, [refreshHealth]);
  return <MaterialTrashProvider onChanged={onChanged} allowPermanentDelete><TrashWorkspace onChanged={onChanged} /></MaterialTrashProvider>;
}

function TrashWorkspace({ onChanged }: { onChanged: () => void }) {
  const { api, dataRevision } = useConsoleRuntime();
  const material = useMaterialTrash();
  const [autoOpenPacketPending] = useState(() => { try { return !localStorage.getItem('brain-trash-pending-operation'); } catch { return true; } });
  const intake = useIntakeTrash(onChanged, { autoOpenPending: autoOpenPacketPending, allowPermanentDelete: true });
  const inventory = useTrashInventory(api, dataRevision);
  const [params, setParams] = useSearchParams();
  const origin = trashOrigins.find(value => value.id === params.get('origin'))?.id ?? 'all';
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState<string>();
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selectedKey && window.matchMedia?.('(max-width: 820px)').matches) detailRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);
  const needle = search.trim().toLocaleLowerCase();
  const matches = (paper: TrashPaper) => (origin === 'all' || paper.origin === origin)
    && (!needle || `${paper.entry.title} ${paperPath(paper)}`.toLocaleLowerCase().includes(needle));
  const visible = inventory.active.filter(matches);
  const receipts = inventory.papers.filter(paper => ['restored', 'deleted'].includes(paper.entry.status) && matches(paper));
  const selected = visible.find(paper => paper.key === selectedKey);
  const busy = material.busy || intake.busy || intake.visible;
  const relevantSource = origin === 'all' ? undefined : origin === 'intake' ? inventory.packets : inventory.documents;
  const failed = relevantSource?.error || origin === 'all' && (inventory.documents.error || inventory.packets.error);
  const loading = relevantSource ? relevantSource.loading : inventory.loading;
  function selectOrigin(value: string) {
    setSelectedKey(undefined);
    setParams(current => { const next = new URLSearchParams(current); if (value === 'all') next.delete('origin'); else next.set('origin', value); return next; }, { replace: true });
  }
  function restore(paper: TrashPaper) { if (paper.kind === 'document') material.perform(paper.entry, 'restore'); else intake.perform(paper.entry, 'restore'); }
  function retry(paper: TrashPaper) { if (paper.kind === 'document') material.perform(paper.entry, 'retry'); else intake.perform(paper.entry, 'retry'); }
  function remove(paper: TrashPaper) { if (paper.kind === 'document') material.openDelete(paper.entry); else intake.openDelete(paper.entry); }
  return <section className="recycle-workspace" aria-label="统一回收站">
    <div className="recycle-toolbar"><div className="recycle-total"><span className="recycle-live-dot" />{inventory.complete ? `${inventory.active.length} 份暂存` : inventory.loading ? '正在读取' : '部分来源不可用'}<span>手动恢复 · 不自动清空</span></div>
      <div className="recycle-tools"><label className="recycle-search"><Search aria-hidden="true" /><input type="search" aria-label="搜索回收站" placeholder="搜索标题或路径" value={search} onChange={event => setSearch(event.target.value)} /></label><button type="button" className="recycle-icon-button" aria-label="刷新回收站" title="刷新回收站" disabled={busy || inventory.loading} onClick={inventory.refresh}><RefreshCw aria-hidden="true" /></button></div>
    </div>
    <div className="recycle-bin">
      <RecycleBinLid className="recycle-open-lid" />
      <div className="recycle-bin-hinges" aria-hidden="true"><i /><i /></div>
      <div className="recycle-rim" aria-hidden="true"><span /><i /><span /></div>
      <div className="recycle-bin-body">
        <div className="recycle-dividers" role="tablist" aria-label="回收来源">
          {[{ id: 'all', label: '全部' }, ...trashOrigins].map(tab => { const count = tab.id === 'all' ? inventory.complete ? inventory.active.length : undefined : inventory.counts[tab.id as keyof typeof inventory.counts]; return <button key={tab.id} type="button" role="tab" id={`trash-tab-${tab.id}`} aria-label={`${tab.label} ${count ?? '—'}`} aria-controls="trash-papers" aria-selected={origin === tab.id} onClick={() => selectOrigin(tab.id)}><span>{tab.label}</span><span className="recycle-count">{count ?? '—'}</span></button>; })}
        </div>
        <div className={`recycle-interior${selected ? ' recycle-interior--selected' : ''}`}>
          <section className="recycle-paper-surface" role="tabpanel" id="trash-papers" aria-labelledby={`trash-tab-${origin}`} aria-busy={loading}>
            {inventory.packets.error && (origin === 'all' || origin === 'intake') && <p className="recycle-source-error" role="alert">收件箱：{inventory.packets.error}</p>}
            {inventory.documents.error && origin !== 'intake' && <p className="recycle-source-error" role="alert">档案库、提炼队列、知识库：{inventory.documents.error}</p>}
            {loading && <p className="recycle-feedback" role="status">正在读取回收站…</p>}
            {!loading && !failed && visible.length === 0 && <div className="recycle-empty"><Check aria-hidden="true" /><p>{needle ? '没有匹配的资料' : origin === 'all' ? '回收站为空' : '这个分类暂时为空'}</p><small>{needle ? '试试其他标题或路径' : '手动删除的资料会保留在这里'}</small></div>}
            {visible.length > 0 && <ul className="recycle-papers" aria-label="回收站资料">{visible.map(paper => <li key={paper.key}>
              <button type="button" className={`recycle-paper${paper.key === selectedKey ? ' recycle-paper--selected' : ''}`} aria-label={`选择：${paper.entry.title}`} aria-pressed={paper.key === selectedKey} disabled={busy} onClick={() => setSelectedKey(paper.key === selectedKey ? undefined : paper.key)}>
                <span className="recycle-paper-origin">{paper.kind === 'packet' ? <Package aria-hidden="true" /> : <FileText aria-hidden="true" />}{sourceLabel(paper)}</span>
                <strong>{paper.entry.title}</strong><span className="recycle-paper-path">{paperPath(paper)}</span>
                <span className="recycle-paper-bottom"><time dateTime={paper.entry.createdAt}>{dateText(paper.entry.createdAt)}</time><span data-status={paper.entry.status}>{statusText[paper.entry.status]}</span></span>
              </button>
            </li>)}</ul>}
            <div className="recycle-floor-mark" aria-hidden="true">RECYCLE / LOCAL STORAGE</div>
          </section>
          {selected && <aside className="recycle-detail" aria-label="所选资料详情" ref={detailRef}>
            <header><span>{sourceLabel(selected)}</span><button type="button" aria-label="取消选择" className="recycle-icon-button" onClick={() => setSelectedKey(undefined)}><X aria-hidden="true" /></button></header>
            <h2>{selected.entry.title}</h2><p className="recycle-detail-path">{paperPath(selected)}</p>
            <dl><div><dt>状态</dt><dd>{statusText[selected.entry.status]}</dd></div><div><dt>移入时间</dt><dd><time dateTime={selected.entry.createdAt}>{new Date(selected.entry.createdAt).toLocaleString('zh-CN')}</time></dd></div><div><dt>删除范围</dt><dd>{selected.kind === 'packet' ? `整个资料包与自带附件 · ${selected.entry.fileCount} 个文件` : selected.origin === 'knowledge' ? '仅这一篇知识 Markdown' : '仅这一份原始 Markdown'}</dd></div></dl>
            {selected.kind === 'document' && !selected.entry.indexed && <p className="recycle-detail-notice">检索尚未更新，请继续核验。</p>}
            {selected.entry.problem && <p className="recycle-source-error" role="status">{selected.entry.problem}</p>}
            <div className="recycle-detail-actions">
              {selected.entry.status === 'trashed' && <button type="button" className="recycle-restore" disabled={busy} aria-label={`恢复：${selected.entry.title}`} onClick={() => restore(selected)}><ArchiveRestore aria-hidden="true" />{selected.kind === 'packet' ? '恢复到收件箱' : '恢复到原路径'}</button>}
              {!['trashed', 'restored', 'deleted'].includes(selected.entry.status) || selected.kind === 'document' && !selected.entry.indexed ? <button type="button" disabled={busy} aria-label={`继续核验：${selected.entry.title}`} onClick={() => retry(selected)}><RefreshCw aria-hidden="true" />继续核验</button> : null}
              {['trashed', 'deleting'].includes(selected.entry.status) && <button type="button" className="recycle-delete" disabled={busy} aria-label={`${selected.entry.status === 'deleting' ? '重新确认彻底删除' : '彻底删除'}：${selected.entry.title}`} onClick={() => remove(selected)}><Trash2 aria-hidden="true" />{selected.entry.status === 'deleting' ? '重新确认彻底删除' : '彻底删除'}</button>}
            </div><p className="recycle-detail-footnote">恢复保留原路径；彻底删除需单独确认。</p>
          </aside>}
        </div>
      </div>
      <div className="recycle-base" aria-hidden="true" />
    </div>
    {receipts.length > 0 && <details className="recycle-history"><summary>操作记录 · {receipts.length}</summary><ul>{receipts.map(paper => <li key={paper.key}><span>{paper.entry.title}<small>{sourceLabel(paper)} · {paperPath(paper)}</small></span><span>{statusText[paper.entry.status]}<small>{dateText(paper.entry.deletedAt ?? (paper.kind === 'document' ? paper.entry.restoredAt : undefined) ?? paper.entry.createdAt)}</small></span></li>)}</ul></details>}
    {intake.dialog}
  </section>;
}
