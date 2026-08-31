import type { ComponentPropsWithoutRef, ReactNode } from 'react';
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
}

export function SafeMarkdown({ children }: SafeMarkdownProps) {
  return (
    <div className="safe-markdown">
      <ReactMarkdown
        remarkPlugins={SAFE_REMARK_PLUGINS}
        components={SAFE_COMPONENTS}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
