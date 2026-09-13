import { useEffect, useRef } from 'react';
import { ArrowUpRight, BookOpen, Link2, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { KnowledgePage, LiveKnowledgeDetail } from '../api/client.js';
import { PageState } from './PageState.js';
import { MaterialTrashButton } from './MaterialTrash.js';
import { SafeMarkdown } from './SafeMarkdown.js';
import type { PageResource } from '../pages/pageSupport.js';

export interface KnowledgeDetailProps {
  readonly record: Pick<KnowledgePage['items'][number], 'path' | 'title'> & Partial<KnowledgePage['items'][number]>;
  readonly resource: PageResource<LiveKnowledgeDetail>;
  readonly openState: 'idle' | 'opening' | 'opened' | 'failed';
  readonly onClose: () => void;
  readonly onOpen: () => void;
  readonly onRetry?: () => void;
  readonly onUse?: () => void;
  readonly presentation?: 'inline' | 'panel';
}

function markdownBody(markdown: string): string {
  const firstCharacter = markdown.charCodeAt(0) === 0xfeff ? 1 : 0;
  const openingEnd = markdown.indexOf('\n', firstCharacter);
  if (openingEnd === -1) return markdown;
  const opening = markdown.slice(firstCharacter, openingEnd).replace(/\r$/u, '');
  if (!/^---[\t ]*$/u.test(opening)) return markdown;

  let lineStart = openingEnd + 1;
  while (lineStart <= markdown.length) {
    const lineBreak = markdown.indexOf('\n', lineStart);
    const lineEnd = lineBreak === -1 ? markdown.length : lineBreak;
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/u, '');
    if (/^(?:---|\.\.\.)[\t ]*$/u.test(line)) {
      return lineBreak === -1 ? '' : markdown.slice(lineBreak + 1);
    }
    if (lineBreak === -1) break;
    lineStart = lineBreak + 1;
  }

  return markdown;
}

export function KnowledgeDetail({
  record,
  resource,
  openState,
  onClose,
  onOpen,
  onRetry,
  onUse,
  presentation = 'panel'
}: KnowledgeDetailProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [record.path]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const detail = resource.status === 'ready' || resource.status === 'refreshing' || resource.status === 'failed'
    ? resource.data
    : undefined;
  const inline = presentation === 'inline';
  const facts = (
    <dl className="knowledge-detail__facts">
      <div><dt>使用状态</dt><dd>{record.usageStatus ?? '正在读取'}</dd></div>
      <div><dt>知识类型</dt><dd>{record.knowledgeType ?? '正在读取'}</dd></div>
      <div><dt>文件路径</dt><dd>{record.path}</dd></div>
    </dl>
  );
  const provenance = detail === undefined ? null : (
    <>
      <section aria-labelledby="source-materials-title">
        <h3 id="source-materials-title"><BookOpen aria-hidden="true" />来源材料</h3>
        {!record.sourceMaterials ? <p>当前版本未返回来源信息</p> : record.sourceMaterials.length === 0 ? <p>未记录来源材料</p> : (
          <ul>{record.sourceMaterials.map((path) => <li key={path}>{path.startsWith('01图书馆/') ? <><Link to={`/library?${new URLSearchParams({ path: path.endsWith('.md') ? path : `${path}.md` })}`}>查看原文 · {path.split('/').at(-1)?.replace(/\.md$/u, '')}</Link><small>{path}</small></> : path}</li>)}</ul>
        )}
      </section>
      <section aria-labelledby="internal-links-title">
        <h3 id="internal-links-title"><Link2 aria-hidden="true" />内部知识链接</h3>
        {detail.internalKnowledgeLinks.length === 0 ? <p>暂无已解析知识链接</p> : (
          <ul>{detail.internalKnowledgeLinks.map((link) => <li key={link.path}><Link to={`/knowledge?${new URLSearchParams({ path: link.path })}`}><strong>{link.title}</strong></Link><small>{link.path}</small></li>)}</ul>
        )}
      </section>
    </>
  );

  return (
    <aside className={`knowledge-detail${inline ? ' knowledge-detail--inline' : ''}`} role={inline ? 'region' : 'dialog'} aria-label={`${record.title} ${inline ? '阅读' : '详情'}`} aria-modal={inline ? undefined : false}>
      <header className="knowledge-detail__header">
        <div>
          <span>KNOWLEDGE FILE</span><h2 ref={headingRef} tabIndex={-1}>{record.title}</h2>
          {inline && (record.knowledgeType || record.usageStatus) && <p className="knowledge-detail__inline-meta">{[record.knowledgeType, record.usageStatus].filter(Boolean).join(' · ')}</p>}
          {inline && <p className="knowledge-detail__read-state" role="status">{resource.status === 'refreshing' ? '正在核对最新版本，暂保留已读正文…' : '\u00a0'}</p>}
        </div>
        <button type="button" aria-label={inline ? '收回纸页' : '关闭知识详情'} onClick={onClose}><X aria-hidden="true" />{inline && <span>收回纸页</span>}</button>
      </header>

      {!inline && facts}

      {resource.status === 'loading' && <PageState state={{ status: 'loading', message: '正在读取当前版本正文' }} />}
      {resource.status === 'refreshing' && !inline && <PageState state={{ status: 'refreshing', message: '正在核对知识版本' }} />}
      {resource.status === 'failed' && <PageState state={resource.state} />}
      {resource.status === 'failed' && onRetry && <button className="quiet-button" type="button" onClick={onRetry}>重新读取这篇知识</button>}

      {detail !== undefined && (
        <div className="knowledge-detail__body">
          {!inline && provenance}
          <section aria-label="知识正文"><SafeMarkdown>{markdownBody(detail.markdown)}</SafeMarkdown></section>
          {inline && <details className="knowledge-detail__provenance" key={record.path}><summary>来源与关联知识</summary>{facts}{provenance}</details>}
        </div>
      )}

      <footer className="knowledge-detail__footer">
        {onUse && <button type="button" onClick={onUse}>用这篇知识</button>}
        <MaterialTrashButton record={{ path: record.path, title: record.title, origin: 'knowledge' }} text />
        {openState === 'opened' && <span role="status">已在 Obsidian 中打开</span>}
        {openState === 'failed' && <span role="alert">未能在 Obsidian 中打开</span>}
        <button type="button" onClick={onOpen} disabled={openState === 'opening'}>
          <span>{openState === 'opening' ? '正在打开' : '在 Obsidian 中打开'}</span><ArrowUpRight aria-hidden="true" />
        </button>
      </footer>
    </aside>
  );
}
