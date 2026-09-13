import { Children, cloneElement, createContext, isValidElement, useContext, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

function absoluteHttpUrl(href: string | undefined): string | undefined {
  if (href === undefined || !/^https?:\/\//iu.test(href)) {
    return undefined;
  }

  try {
    const parsed = new URL(href);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname.length === 0) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

function SafeLink({
  href,
  children
}: {
  readonly href?: string | undefined;
  readonly children?: ReactNode | undefined;
}) {
  const safeHref = absoluteHttpUrl(href);
  if (safeHref === undefined) {
    return <span className="safe-markdown__rejected-link">{children}</span>;
  }
  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
    >
      {children}
    </a>
  );
}

function SafeImage({ alt }: ComponentPropsWithoutRef<'img'>) {
  return <span className="safe-markdown__image-alt">{alt || '图片'}</span>;
}

function SafeTableHeader({ children }: ComponentPropsWithoutRef<'th'>) {
  return <th>{children}</th>;
}

function SafeTableCell({ children }: ComponentPropsWithoutRef<'td'>) {
  return <td>{children}</td>;
}

const SAFE_COMPONENTS: Components = {
  a: SafeLink,
  img: SafeImage,
  th: SafeTableHeader,
  td: SafeTableCell
};

const SAFE_REMARK_PLUGINS = [remarkGfm];

export interface SafeMarkdownProps {
  readonly children: string;
  readonly renderCitation?: ((id: string) => ReactNode) | undefined;
}

type CitationRenderer = ((id: string) => ReactNode) | undefined;
const CitationContext = createContext<CitationRenderer>(undefined);
function withCitations(nodes: ReactNode, renderCitation: CitationRenderer): ReactNode {
  return Children.map(nodes, (node) => {
    if (typeof node === 'string') return node.split(/(\[S\d+\])/gu).map((part, i) => /^\[S\d+\]$/u.test(part) ? <span key={i}>{renderCitation?.(part.slice(1, -1)) ?? part}</span> : part);
    if (isValidElement<{ children?: ReactNode }>(node) && typeof node.type === 'string' && !['code', 'pre', 'a', 'button'].includes(String(node.type))) return cloneElement(node, {}, withCitations(node.props.children, renderCitation));
    return node;
  });
}
const CITATION_COMPONENTS: Components = {
  ...SAFE_COMPONENTS,
  p: function CitationParagraph({ children }) { return <p>{withCitations(children, useContext(CitationContext))}</p>; },
  li: function CitationListItem({ children }) { return <li>{withCitations(children, useContext(CitationContext))}</li>; },
  td: function CitationCell({ children }) { return <td>{withCitations(children, useContext(CitationContext))}</td>; }
};

export function SafeMarkdown({ children, renderCitation }: SafeMarkdownProps) {
  return (
    <CitationContext.Provider value={renderCitation}><div className="safe-markdown">
      <ReactMarkdown
        remarkPlugins={SAFE_REMARK_PLUGINS}
        components={renderCitation ? CITATION_COMPONENTS : SAFE_COMPONENTS}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div></CitationContext.Provider>
  );
}
