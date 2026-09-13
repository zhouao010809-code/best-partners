import { useId, useState } from 'react';
import { ChevronDown, ChevronRight, Inbox, Trash2 } from 'lucide-react';
import type { IntakeList } from '../../../shared/api/intake.js';
import '../../styles/intake-tray.css';

type IntakeItem = IntakeList['items'][number];

function itemIssues(item: IntakeItem): string[] {
  const missing = [
    !item.fields.title && '标题',
    !item.fields.platform && '平台',
    !item.fields.collectedAt && '采集日期',
  ].filter(Boolean);
  const issues = missing.length ? [`缺${missing.join('、')}`] : [];
  if (item.mainCandidates.length > 1) issues.push('需选择主文件');
  if (!item.mainCandidates.length) issues.push('未找到主文件');
  if (item.problem) issues.push(item.problem);
  return issues;
}

function EnvelopeArtwork() {
  return (
    <span className="intake-envelope__art" aria-hidden="true">
      <svg className="intake-envelope__lid" viewBox="0 0 300 58" preserveAspectRatio="none" focusable="false">
        <path d="M1 57 8 14Q10 3 23 3H277Q290 3 292 14L299 57Z" />
        <path className="intake-envelope__lid-glint" d="M12 13Q14 6 24 6H274" />
      </svg>
      <span className="intake-envelope__back" />
      <span className="intake-envelope__paper intake-envelope__paper--rear" />
      <span className="intake-envelope__paper" />
      <span className="intake-envelope__front" />
      <span className="intake-envelope__flap" />
      <svg className="intake-envelope__seams" viewBox="0 0 300 178" preserveAspectRatio="none" focusable="false">
        <path className="intake-envelope__fold-shadow" d="M1 3 150 57 299 3" />
        <path className="intake-envelope__fold" d="M1 1 150 55 299 1" />
        <path className="intake-envelope__side-fold" d="M2 175 79 84M298 175 221 84" />
        <path className="intake-envelope__edge" d="M1 1V176H299V1Z" />
        <path className="intake-envelope__edge-inner" d="M4 6V172H296V6" />
        <path className="intake-envelope__edge-glint" d="M2 1H298M2 175H298" />
      </svg>
    </span>
  );
}

export function IntakeTray({ items, selectedName, busy, supportsDirectImport = false, onSelect, onTrash }: {
  items: IntakeList['items'];
  selectedName?: string;
  busy: boolean;
  supportsDirectImport?: boolean;
  onSelect: (item: IntakeItem) => void;
  onTrash?: (item: IntakeItem) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'needs-info'>('all');
  const [showAll, setShowAll] = useState(false);
  const [lastSelectedName, setLastSelectedName] = useState<string>();
  const listId = useId();
  const needsInfo = items.filter((item) => itemIssues(item).length > 0);
  const filtered = filter === 'needs-info' ? needsInfo : items;
  const pinnedName = selectedName || lastSelectedName;
  const selectedBeyondPreview = filtered.slice(4).find((item) => item.name === pinnedName);
  // Keep the originating envelope mounted when its editor closes and returns focus.
  const visible = showAll ? filtered : selectedBeyondPreview
    ? [...filtered.slice(0, 3), selectedBeyondPreview]
    : filtered.slice(0, 4);

  return (
    <section className="intake-tray" aria-label="待整理资料" aria-busy={busy}>
      <div className="intake-tray__well">
        <header className="intake-tray__header">
          <h2 className="intake-tray__heading">待整理 <span>{items.length}</span></h2>
          <div className="intake-tray__filters" role="group" aria-label="资料筛选">
            <button type="button" aria-pressed={filter === 'all'} onClick={() => { setFilter('all'); setShowAll(false); }}>
              全部
            </button>
            <span className="intake-tray__filter-divider" aria-hidden="true">/</span>
            <button type="button" aria-pressed={filter === 'needs-info'} onClick={() => { setFilter('needs-info'); setShowAll(false); }}>
              信息不完整
              {needsInfo.length > 0 && <span className="intake-tray__filter-count" aria-hidden="true">{needsInfo.length}</span>}
            </button>
          </div>
        </header>

        {visible.length ? (
          <ul className="intake-tray__grid" id={listId}>
            {visible.map((item) => {
              const title = item.fields.title || item.name;
              const issues = itemIssues(item);
              const metadata = [item.fields.platform, item.fields.collectedAt].filter(Boolean).join(' · ');
              return (
                <li className="intake-tray__slot" key={item.name}>
                  <button
                    className="intake-envelope"
                    type="button"
                    aria-label={`整理 ${item.name}`}
                    aria-pressed={selectedName === item.name}
                    disabled={busy || item.kind !== 'directory' || !item.mainCandidates.length}
                    onClick={() => { setLastSelectedName(item.name); onSelect(item); }}
                    title={[title, ...issues].join('；')}
                  >
                    <EnvelopeArtwork />
                    <span className="intake-envelope__content">
                      <strong className="intake-envelope__title" title={title}>{title}</strong>
                      {metadata && <span className="intake-envelope__metadata" title={metadata}>{metadata}</span>}
                      <span className="intake-envelope__details">
                        <span className="intake-envelope__kind">{item.kind === 'directory' ? '资料包' : '文件'}</span>
                        {issues.length > 0 && <span className="intake-envelope__issue" title={issues.join('；')}>{issues.join('；')}</span>}
                      </span>
                    </span>
                  </button>
                  {onTrash && <button type="button" className="intake-envelope-trash" aria-label={`移入回收站：${item.name}`} title="移入回收站" disabled={busy} onClick={() => onTrash(item)}><Trash2 aria-hidden="true" /></button>}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="intake-tray__empty" id={listId}>
            <Inbox aria-hidden="true" />
            <h3>{items.length ? '资料信息都完整' : '收件箱是空的'}</h3>
            {!items.length && <p>{supportsDirectImport
              ? '这里接收浏览器剪辑插件保存的收藏；也可以在上方选择文件或粘贴文本。'
              : '这里接收浏览器剪辑插件保存的收藏。还没有资料时，先在浏览器里剪辑，保存后会自动出现在这里。'}</p>}
          </div>
        )}

        {filtered.length > 4 && (
          <div className="intake-tray__footer">
            <button className="intake-tray__more" type="button" aria-expanded={showAll} aria-controls={listId} onClick={() => setShowAll(!showAll)}>
              {showAll ? '收起资料' : `查看全部 ${filtered.length} 份`}
              {showAll ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            </button>
          </div>
        )}
      </div>
      <span className="intake-tray__handle" aria-hidden="true" />
    </section>
  );
}
