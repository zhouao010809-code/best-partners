import { useState } from 'react';
import { ArrowLeft, Save, Check, History, Download } from 'lucide-react';
import type { CreationVersion, ProjectCreation } from '../../../shared/api/project-creations.js';
import type { ReadConsoleApi } from '../../api/client.js';
import { CreationAssistant } from './CreationAssistant.js';
import { CreationSources } from './CreationSources.js';
import { creationError, editable, useCreationDraft } from './useCreationDraft.js';

export function CreationEditor({ api, projectId, id, onBack, onSaved, onOpen }: {
  api: ReadConsoleApi; projectId: string; id: string; onBack(): void; onSaved(item: ProjectCreation): void; onOpen(id: string): void;
}) {
  const creations = api.creations!;
  const state = useCreationDraft(creations, projectId, id, onSaved);
  const { draft, detail } = state;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [exporting, setExporting] = useState<CreationVersion>();
  const [selection, setSelection] = useState<{ text: string; start: number; end: number }>();
  async function back() { await state.flush(); onBack(); }
  async function snapshot(finalize: boolean) {
    setBusy(true); setNotice('');
    try {
      const saved = await state.flush(); if (!saved) return;
      const result = await creations.snapshot(projectId, id, { expectedRevision: saved.revision, finalize });
      if (!result.ok) { setNotice(creationError(result)); return; }
      state.replaceDetail(result.value); setNotice(finalize ? '已确认定稿。继续编辑会保留这份定稿。' : '当前稿已保存为独立版本。');
      setVersionsOpen(true);
    } catch { setNotice('保存版本没有完成，请重试。'); }
    finally { setBusy(false); }
  }
  async function confirmExport() {
    if (!exporting) return;
    setBusy(true); setNotice('');
    try {
      const result = await creations.exportVersion(projectId, id, exporting.id);
      if (!result.ok) { setNotice(creationError(result)); return; }
      setNotice(`已导出 v${exporting.number}：${result.value.path}`); setExporting(undefined);
      window.dispatchEvent(new CustomEvent('xiaozhao:project-workspace-updated', { detail: { projectId } }));
    } catch { setNotice('导出没有完成，请重试。'); }
    finally { setBusy(false); }
  }
  async function saveCopy() {
    if (!draft) return;
    setBusy(true);
    try {
      const result = await creations.create(projectId, { ...editable(draft), kind: 'script', title: `${draft.title.slice(0, 245)}（副本）` });
      if (!result.ok) { setNotice(creationError(result)); return; }
      onSaved(result.value.item); onOpen(result.value.item.id);
    } catch { setNotice('副本保存失败，请重试。'); }
    finally { setBusy(false); }
  }
  if (!draft || !detail) return <div className="creation-empty"><p role="status">{state.error || '正在读取稿件…'}</p><button type="button" className="projects-button" onClick={onBack}>返回创作台</button></div>;
  const final = detail.versions.find(version => version.id === draft.finalVersionId);
  const finalChanged = final && (draft.title !== final.title || draft.brief !== final.brief || draft.body !== final.body);
  return <section className="creation-editor" aria-label="脚本编辑器">
    <div className="creation-editor-toolbar"><button type="button" className="projects-back-link" onClick={() => void back()} disabled={busy}><ArrowLeft size={14} />返回创作台</button><span role="status" className={`creation-save-state creation-save-state--${state.status}`}>{({ loading: '读取中', saved: '已保存到本机', dirty: '等待保存…', saving: '正在保存…', failed: '保存未完成' })[state.status]}</span>
      <div className="creation-actions"><button type="button" className="projects-button" disabled={busy} onClick={() => setVersionsOpen(value => !value)}><History size={14} />版本记录{detail.versions.length ? ` · ${detail.versions.length}` : ''}</button><button type="button" className="projects-button" disabled={busy || state.conflict} onClick={() => void snapshot(false)}><Save size={14} />保存版本</button><button type="button" className="projects-button projects-button--primary" disabled={busy || state.conflict || !draft.body.trim()} onClick={() => void snapshot(true)}><Check size={14} />确认定稿</button></div>
    </div>
    {state.error && <p className="creation-notice" role="alert">{state.error} {state.conflict ? <button type="button" onClick={() => void saveCopy()} disabled={busy}>另存为新脚本</button> : <button type="button" onClick={() => void state.flush()} disabled={busy}>重试保存</button>}</p>}
    {notice && <p className="creation-notice" role="status">{notice}</p>}
    {final && <p className="creation-final-state">已定稿 v{final.number}{finalChanged ? ' · 当前正在编辑新草稿，定稿保持不变' : ' · 与当前正文一致'}</p>}
    {exporting && <section className="creation-export" aria-label="导出版本预览"><header><h3>导出 v{exporting.number} · {exporting.title}</h3><button type="button" className="projects-button" disabled={busy} onClick={() => setExporting(undefined)}>取消导出</button></header><p>将这个版本新建为项目 AI工作区 / 内容草稿 中的 Markdown 文件。</p>{exporting.brief && <p>{exporting.brief}</p>}<pre>{exporting.body}</pre><CreationSources sources={exporting.sources} api={api} /><button type="button" className="projects-button projects-button--primary" disabled={busy} onClick={() => void confirmExport()}><Download size={14} />确认导出</button></section>}
    {versionsOpen && <section className="creation-versions" aria-label="版本记录"><h3>保留的版本</h3>{!detail.versions.length && <p>保存一个版本，之后可以回看、恢复或导出。</p>}{detail.versions.slice().sort((a, b) => b.number - a.number).map(version => <article key={version.id} aria-label={`版本 v${version.number}`}><div><strong>v{version.number} · {version.title}</strong><small>{new Date(version.createdAt).toLocaleString('zh-CN')}{version.id === draft.finalVersionId ? ' · 已定稿' : ''}</small></div><div className="creation-actions"><button type="button" className="projects-button" disabled={busy} onClick={() => { state.update({ title: version.title, brief: version.brief, body: version.body, sources: version.sources }); setNotice(`已将 v${version.number} 载入工作草稿。`); }}>载入此版本</button><button type="button" className="projects-button" disabled={busy} onClick={() => { setExporting(version); setNotice(''); }}>导出此版本</button></div></article>)}</section>}
    <div className="creation-editor-columns"><main className="creation-manuscript"><label className="creation-title-label">内容标题<input aria-label="内容标题" maxLength={255} value={draft.title} disabled={busy} onChange={event => state.update({ title: event.target.value })} /></label>
      <details className="creation-brief" open={!draft.body}><summary>创作要求{draft.brief ? ' · 已填写' : ' · 可选'}</summary><textarea aria-label="创作要求" maxLength={4000} rows={3} disabled={busy} value={draft.brief} onChange={event => state.update({ brief: event.target.value })} placeholder="例如：面向初中生家长，60秒口播，想解释选画室时该关注什么" />
      {(draft.audience || draft.angle || draft.rationale) && <dl>{draft.audience && <><dt>受众</dt><dd>{draft.audience}</dd></>}{draft.angle && <><dt>切入角度</dt><dd>{draft.angle}</dd></>}{draft.rationale && <><dt>选题依据</dt><dd>{draft.rationale}</dd></>}</dl>}</details>
      <label className="creation-label creation-body-label">脚本正文<textarea aria-label="脚本正文" className="creation-body" maxLength={60000} disabled={busy} value={draft.body} onChange={event => { state.update({ body: event.target.value, kind: 'script' }); setSelection(undefined); }} onSelect={event => { const input = event.currentTarget; setSelection(input.selectionEnd > input.selectionStart ? { start: input.selectionStart, end: input.selectionEnd, text: input.value.slice(input.selectionStart, input.selectionEnd) } : undefined); }} placeholder="直接写下你的脚本，或让右侧问问根据项目资料起草。" /></label><footer className="creation-manuscript-footer"><span>{draft.body.length.toLocaleString()} 字</span><span>草稿自动保存在本机 · 导出后进入项目文件夹</span></footer><CreationSources sources={draft.sources} api={api} />
    </main><CreationAssistant locked={busy || state.conflict} api={api} projectId={projectId} draft={draft} persistedDraft={detail.item} messages={detail.messages} selection={selection} flush={state.flush} onAdopt={(body, suggestion) => { const sources = suggestion.replacement ? Array.from(new Map([...draft.sources, ...suggestion.sources].map(source => [source.id, source])).values()) : suggestion.sources; if (sources.length > 100) { setNotice('这次局部修改会超过100条参考来源，请改用整稿修改来整理引用；正文已保留。'); return false; } state.update({ body, kind: 'script', sources }); setSelection(undefined); return true; }} /></div>
  </section>;
}
