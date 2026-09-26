import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AssistantSource } from '../../../shared/api/assistant.js';
import type { ReadConsoleApi } from '../../api/client.js';
import { assistantSourceHref } from '../assistant/AssistantMessageView.js';
import { creationError } from './useCreationDraft.js';

export function CreationSources({ sources, api }: { sources: AssistantSource[]; api: ReadConsoleApi }) {
  const [preview, setPreview] = useState<{ title: string; content: string }>();
  const [busy, setBusy] = useState(false);
  async function read(source: AssistantSource) {
    const match = /^project:([^/]+)\/(.+)$/u.exec(source.path);
    if (!match || !api.projects) return;
    setBusy(true);
    try {
      const result = await api.projects.file(match[1]!, match[2]!);
      setPreview({ title: source.title, content: result.ok ? result.value.content ?? '该文件暂不支持正文预览。' : creationError(result) });
    } catch { setPreview({ title: source.title, content: '资料读取失败，请重试。' }); }
    finally { setBusy(false); }
  }
  if (!sources.length) return null;
  return <details className="creation-sources"><summary>参考资料 · {sources.length}</summary>{sources.map((source, index) => <div key={`${source.path}:${index}`}>
    {source.path.startsWith('project:') ? <button type="button" onClick={() => void read(source)} disabled={busy}>{source.id} · {source.title}</button> : <Link to={assistantSourceHref(source.path)}>{source.id} · {source.title}</Link>}
    {source.evidence?.slice(0, 2).map((part, i) => <blockquote key={i}>{part.excerpt}</blockquote>)}
  </div>)}{preview && <section aria-label="资料正文预览"><button type="button" onClick={() => setPreview(undefined)}>收起正文</button><h4>{preview.title}</h4><pre>{preview.content}</pre></section>}</details>;
}
