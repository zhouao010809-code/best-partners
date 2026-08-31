import { useEffect, useRef } from 'react';
import { ArrowUpRight, BookOpen, Link2, X } from 'lucide-react';
import type { KnowledgePage, LiveKnowledgeDetail } from '../api/client.js';
import { PageState } from './PageState.js';
import { SafeMarkdown } from './SafeMarkdown.js';
import type { PageResource } from '../pages/pageSupport.js';

export interface KnowledgeDetailProps {
  readonly record: KnowledgePage['items'][number];
  readonly resource: PageResource<LiveKnowledgeDetail>;
  readonly openState: 'idle' | 'opening' | 'opened' | 'failed';
  readonly onClose: () => void;
  readonly onOpen: () => void;
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
  onOpen
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

  return (
    <aside className="knowledge-detail" role="dialog" aria-label={`${record.title} 详情`} aria-modal="false">
      <header className="knowledge-detail__header">
        <div><span>KNOWLEDGE FILE</span><h2 ref={headingRef} tabIndex={-1}>{record.title}</h2></div>
        <button type="button" aria-label="关闭知识详情" onClick={onClose}><X aria-hidden="true" /></button>
      </header>

      <dl className="knowledge-detail__facts">
        <div><dt>使用状态</dt><dd>{record.usageStatus}</dd></div>
        <div><dt>知识类型</dt><dd>{record.knowledgeType}</dd></div>
        <div><dt>文件路径</dt><dd>{record.path}</dd></div>
      </dl>

      {resource.status === 'loading' && <PageState state={{ status: 'loading', message: '正在读取当前版本正文' }} />}
      {resource.status === 'refreshing' && <PageState state={{ status: 'refreshing', message: '正在核对知识版本' }} />}
      {resource.status === 'failed' && <PageState state={resource.state} />}

      {detail !== undefined && (
        <div className="knowledge-detail__body">
          <section aria-labelledby="source-materials-title">
            <h3 id="source-materials-title"><BookOpen aria-hidden="true" />来源材料</h3>
            {record.sourceMaterials.length === 0 ? <p>未记录来源材料</p> : (
              <ul>{record.sourceMaterials.map((path) => <li key={path}>{path}</li>)}</ul>
            )}
          </section>
          <section aria-labelledby="internal-links-title">
            <h3 id="internal-links-title"><Link2 aria-hidden="true" />内部知识链接</h3>
            {detail.internalKnowledgeLinks.length === 0 ? <p>暂无已解析知识链接</p> : (
              <ul>{detail.internalKnowledgeLinks.map((link) => <li key={link.path}><strong>{link.title}</strong><small>{link.path}</small></li>)}</ul>
            )}
          </section>
          <section aria-label="知识正文"><SafeMarkdown>{markdownBody(detail.markdown)}</SafeMarkdown></section>
        </div>
      )}

      <footer className="knowledge-detail__footer">
        {openState === 'opened' && <span role="status">已在 Obsidian 中打开</span>}
        {openState === 'failed' && <span role="alert">未能在 Obsidian 中打开</span>}
        <button type="button" onClick={onOpen} disabled={openState === 'opening'}>
          <span>{openState === 'opening' ? '正在打开' : '在 Obsidian 中打开'}</span><ArrowUpRight aria-hidden="true" />
        </button>
      </footer>
    </aside>
  );
}
