import { useEffect, useRef, useState } from 'react';
import type { DocumentIssuePage, LiveDocumentDetail } from '../api/client.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { dataFromResource, indexCanServe } from '../pages/pageSupport.js';

function reason(issue: DocumentIssuePage['items'][number]): string {
  if (issue.message === 'FRONTMATTER_OPENING_DELIMITER_MISSING') return '缺少资料信息，原文仍可查看';
  if (issue.code === 'UNEXPECTED_TYPE') return '旧资料分类需要确认，未自动更改';
  if (issue.code === 'INVALID_FIELD') return `资料信息需要确认${issue.field === undefined ? '' : `：${issue.field.split('.')[0]}`}`;
  return '资料信息的写法暂未识别，原文仍可查看';
}

function guidance(issue: DocumentIssuePage['items'][number]): string {
  if (issue.message === 'FRONTMATTER_OPENING_DELIMITER_MISSING') {
    return '文件开头缺少可识别的属性区块。请对照当前大脑规则中的对应模板，核对这份文件需要的属性。';
  }
  if (issue.code === 'UNEXPECTED_TYPE') {
    return '「类型」与所在目录的规则不一致。请先确认它是原始资料还是知识笔记，再按当前大脑规则核对类型和存放目录。';
  }
  if (issue.code === 'INVALID_FIELD') {
    const field = issue.field?.split('.')[0];
    return `${field ? `「${field}」` : '部分属性'}缺失或格式不符合当前规则。请核对对应属性的填写方式和实际内容，不要仅为通过检查而猜填。`;
  }
  return '属性区块格式无法读取。请检查文件开头属性的分隔线、缩进与写法，并对照当前大脑规则核对。';
}

function title(path: string): string { return path.split('/').at(-1)!.replace(/\.md$/u, ''); }

export function DocumentIssuesPanel() {
  const runtime = useConsoleRuntime();
  const health = dataFromResource(runtime.health);
  const available = runtime.health.status !== 'failed' && indexCanServe(health);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<DocumentIssuePage>({ items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<LiveDocumentDetail>();
  const [detailError, setDetailError] = useState('');
  const [revealStates, setRevealStates] = useState<Record<string, 'pending' | 'error' | 'done'>>({});
  const revealRequests = useRef(new Set<string>());
  const revealRevision = useRef(0);
  const canReveal = typeof window.xiaozhaoDesktop?.revealDocument === 'function';
  const listController = useRef<AbortController | undefined>(undefined);
  const detailController = useRef<AbortController | undefined>(undefined);
  const seenCursors = useRef(new Set<string>());
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement | undefined>(undefined);

  const loadPage = async (cursor?: string): Promise<void> => {
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await runtime.api.listDocumentIssues({ limit: 50, ...(cursor === undefined ? {} : { cursor }) }, controller.signal);
      if (controller.signal.aborted || ('cancelled' in result && result.cancelled)) return;
      if (!result.ok) { setError('读取资料列表未完成，请重试。'); return; }
      const previous = cursor === undefined ? [] : page.items;
      const incoming = result.value;
      const paths = [...previous, ...incoming.items].map((issue) => issue.path);
      if (new Set(paths).size !== paths.length || (incoming.nextCursor !== undefined && (incoming.items.length === 0 || seenCursors.current.has(incoming.nextCursor)))) {
        setError('资料列表已变化，请重新读取。');
        return;
      }
      if (incoming.nextCursor !== undefined) seenCursors.current.add(incoming.nextCursor);
      setPage({ ...incoming, items: [...previous, ...incoming.items] });
    } catch {
      if (!controller.signal.aborted) setError('读取资料列表未完成，请重试。');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    listController.current?.abort();
    detailController.current?.abort();
    setSelected(undefined);
    setDetail(undefined);
    setPage({ items: [] });
    setRevealStates({});
    revealRequests.current.clear();
    seenCursors.current.clear();
    if (available) void loadPage();
    return () => {
      listController.current?.abort();
      detailController.current?.abort();
      revealRevision.current += 1;
    };
  }, [available, runtime.api, runtime.dataRevision, revision]);

  const openOriginal = async (path: string): Promise<void> => {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setSelected(path);
    setDetail(undefined);
    setDetailError('');
    try {
      const result = await runtime.api.getDocumentDetail(path, controller.signal);
      if (controller.signal.aborted || ('cancelled' in result && result.cancelled)) return;
      if (!result.ok || result.value.path !== path) { setDetailError('原文暂时无法读取，请刷新列表后重试。'); return; }
      setDetail(result.value);
    } catch {
      if (!controller.signal.aborted) setDetailError('原文暂时无法读取，请重试。');
    }
  };

  const revealDocument = async (path: string): Promise<void> => {
    const reveal = window.xiaozhaoDesktop?.revealDocument;
    if (!reveal || revealRequests.current.has(path)) return;
    const revision = revealRevision.current;
    revealRequests.current.add(path);
    setRevealStates((states) => ({ ...states, [path]: 'pending' }));
    try {
      await reveal(path);
      if (revision === revealRevision.current) setRevealStates((states) => ({ ...states, [path]: 'done' }));
    } catch {
      if (revision === revealRevision.current) setRevealStates((states) => ({ ...states, [path]: 'error' }));
    } finally {
      if (revision === revealRevision.current) revealRequests.current.delete(path);
    }
  };

  useEffect(() => { if (selected !== undefined) detailHeading.current?.focus(); }, [selected]);

  return (
    <section className="document-issues" aria-label="待确认资料">
      <header className="document-issues__header">
        <div><h2>待确认资料</h2><p>这些文件仍保存在大脑中。缺少或不明确的信息不会被自动猜测，也不会计入未提炼牌堆。</p></div>
        <button type="button" className="quiet-button" disabled={!available || loading} onClick={() => setRevision((value) => value + 1)}>重新读取资料列表</button>
      </header>
      {!available ? <p role="status">连接大脑并完成扫描后，即可查看具体资料。</p> : <>
        {page.items.length > 0 && <div className="document-issues__guidance">
          <p>在编辑器中核对文件开头的属性，以当前大脑规则和对应模板为准；只修改能确认的信息。</p>
          <p>保存后等待扫描再重新读取列表。扫描可能有延迟，重新读取列表不会立即重新扫描文件。</p>
          {!canReveal && <p>可按下方相对路径在当前大脑文件夹中找到文件，再用 Obsidian 或编辑器打开。</p>}
        </div>}
        {selected !== undefined && <section className="document-original" aria-label="资料原文">
          <header><h3 ref={detailHeading} tabIndex={-1}>{title(selected)}</h3><button type="button" className="quiet-button" onClick={() => {
            detailController.current?.abort(); setSelected(undefined); setDetail(undefined); trigger.current?.focus();
          }}>关闭原文</button></header>
          <p>只读查看 · 原文和附件未改动</p>
          {detailError !== '' ? <><p role="alert">{detailError}</p><button type="button" className="quiet-button" onClick={() => void openOriginal(selected)}>重新读取原文</button></> : detail === undefined ? <p role="status">正在读取原文…</p> : <pre data-testid="document-original">{detail.markdown}</pre>}
        </section>}
        {error !== '' && <p role="alert">{error}</p>}
        {loading && <p role="status">正在读取资料列表…</p>}
        {!loading && error === '' && page.items.length === 0 && <p>没有待确认的资料格式</p>}
        {page.items.length > 0 && <ul className="document-issues__list">{page.items.map((issue) => <li key={issue.path}>
          <div className="document-issues__item-content"><strong>{title(issue.path)}</strong><span>{reason(issue)}</span><p className="document-issues__item-guidance">{guidance(issue)}</p><small>{issue.path}</small>
            {revealStates[issue.path] === 'error' && <p className="document-issues__feedback" role="alert">未能在 Finder 中定位，请重试；也可按上方路径手动找到文件。</p>}
            {revealStates[issue.path] === 'done' && <p className="document-issues__feedback" role="status">已请求在 Finder 中定位，请用编辑器打开并核对属性。</p>}
          </div>
          <div className="document-issues__actions">
            {canReveal && <button className="quiet-button" type="button" disabled={revealStates[issue.path] === 'pending'}
              aria-label={`${revealStates[issue.path] === 'error' ? '重新在 Finder 中定位' : '在 Finder 中定位'}：${issue.path}`}
              onClick={() => void revealDocument(issue.path)}>{revealStates[issue.path] === 'pending' ? '正在定位…' : revealStates[issue.path] === 'error' ? '重新定位' : '在 Finder 中定位'}</button>}
            <button className="quiet-button" type="button" aria-label={`查看原文：${title(issue.path)}`} onClick={(event) => { trigger.current = event.currentTarget; void openOriginal(issue.path); }}>查看原文</button>
          </div>
        </li>)}</ul>}
        {page.nextCursor !== undefined && <button className="quiet-button" type="button" disabled={loading || error !== ''} onClick={() => void loadPage(page.nextCursor)}>加载更多资料</button>}
      </>}
    </section>
  );
}
