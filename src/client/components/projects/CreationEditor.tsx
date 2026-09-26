import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Save, Check, History, Download, Undo2, Trash2 } from 'lucide-react';
import type { CreationVersion, ProjectCreation } from '../../../shared/api/project-creations.js';
import type { ReadConsoleApi } from '../../api/client.js';
import { CreationAssistant } from './CreationAssistant.js';
import { CreationSources } from './CreationSources.js';
import { CreationReferencePicker } from './CreationReferencePicker.js';
import { creationError, editable, useCreationDraft } from './useCreationDraft.js';

export function CreationEditor({ api, projectId, id, onBack, onSaved, onOpen, onDiscard, profileRevision }: {
  api: ReadConsoleApi; projectId: string; id: string; onBack(): void; onSaved(item: ProjectCreation): void; onOpen(id: string): void;
  profileRevision?: number | undefined;
  onDiscard?(item: ProjectCreation): void;
}) {
  const creations = api.creations!;
  const state = useCreationDraft(creations, projectId, id, onSaved);
  const { draft, detail } = state;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [exporting, setExporting] = useState<CreationVersion>();
  const [selection, setSelection] = useState<{ text: string; start: number; end: number }>();
  const [undo, setUndo] = useState<ReturnType<typeof editable>>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const discarded = !!draft?.discardedAt;
  const locked = busy || state.conflict || discarded;
  async function back() {
    if (busy) return;
    if (discarded) { onBack(); return; }
    setBusy(true);
    try { if (await state.flush() && alive.current) onBack(); }
    finally { if (alive.current) setBusy(false); }
  }
  async function requestDiscard() {
    if (busy || discarded || !onDiscard || !detail) return;
    setBusy(true);
    try { const saved = await state.flush(); if (alive.current) onDiscard(saved ?? detail.item); }
    finally { if (alive.current) setBusy(false); }
  }
  async function replaceDraft(patch: Partial<ReturnType<typeof editable>>, message: string, remember = true): Promise<boolean> {
    if (locked) return false;
    setBusy(true); setNotice('正在保留当前稿件，保存成功后再替换…');
    try {
      const saved = await state.flush();
      if (!alive.current) return false;
      if (!saved) { setNotice('当前稿件还没有保存成功，正文未变。'); return false; }
      const result = await creations.snapshot(projectId, id, { expectedRevision: saved.revision, finalize: false });
      if (!alive.current) return false;
      if (!result.ok) { setNotice(creationError(result)); return false; }
      state.replaceDetail(result.value);
      if (remember) setUndo(editable(saved));
      else setUndo(undefined);
      state.update(patch); setSelection(undefined);
      setNotice(`${message}替换前的稿件已保存在版本记录。`);
      return true;
    } catch { if (alive.current) setNotice('未能保留替换前的稿件，正文未变，请重试。'); return false; }
    finally { if (alive.current) setBusy(false); }
  }
  async function snapshot(finalize: boolean) {
    if (locked) return;
    setBusy(true); setNotice('');
    try {
      const saved = await state.flush(); if (!saved) return;
      const result = await creations.snapshot(projectId, id, { expectedRevision: saved.revision, finalize });
      if (!result.ok) { setNotice(creationError(result)); return; }
      state.replaceDetail(result.value); setNotice(finalize ? '已确认定稿。继续编辑会保留这份定稿。' : '当前稿已保存为独立版本。');
    } catch { setNotice('保存版本没有完成，请重试。'); }
    finally { setBusy(false); }
  }
  async function confirmExport() {
    if (!exporting || locked) return;
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
    if (!draft || discarded) return;
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
      <div className="creation-actions"><button type="button" className="projects-button" disabled={busy} onClick={() => setVersionsOpen(value => !value)}><History size={14} />版本记录{detail.versions.length ? ` · ${detail.versions.length}` : ''}</button><button type="button" className="projects-button" disabled={locked} onClick={() => void snapshot(false)}><Save size={14} />保存版本</button><button type="button" className="projects-button projects-button--primary" disabled={locked || !draft.body.trim()} onClick={() => void snapshot(true)}><Check size={14} />确认定稿</button>{onDiscard && <button type="button" className="projects-button" disabled={busy || discarded} onClick={() => void requestDiscard()}><Trash2 size={14} />移入回收站</button>}</div>
    </div>
    {state.error && <p className="creation-notice" role="alert">{state.error} {state.conflict ? <button type="button" onClick={() => void saveCopy()} disabled={busy || discarded}>另存为新脚本</button> : <button type="button" onClick={() => void state.flush()} disabled={busy || discarded}>重试保存</button>}</p>}
    {notice && <p className="creation-notice" role="status">{notice}</p>}
    {discarded && <p className="creation-notice">这条内容已移入回收站，恢复后才能继续编辑。</p>}
    {undo && <div className="creation-actions"><button type="button" className="projects-button" disabled={locked} onClick={() => void replaceDraft(undo, '已恢复这次替换前的工作草稿。', false)}><Undo2 size={14} />撤销这次替换</button><small>撤销前也会保留当前稿，之后仍可从版本记录找回。</small></div>}
    {final && <div className="creation-final-state"><span>已定稿 v{final.number}{finalChanged ? ' · 当前正在编辑新草稿，定稿保持不变' : ' · 与当前正文一致'}</span><button type="button" className="creation-text-action" disabled={locked} onClick={() => setExporting(final)}><Download size={13} />查看并导出定稿</button></div>}
    {exporting && <section className="creation-export" aria-label="导出版本预览"><header><h3>导出 v{exporting.number} · {exporting.title}</h3><button type="button" className="projects-button" disabled={busy} onClick={() => setExporting(undefined)}>取消导出</button></header><p>将这个版本新建为项目 AI工作区 / 内容草稿 中的 Markdown 文件。</p>{exporting.brief && <p>{exporting.brief}</p>}<pre>{exporting.body}</pre><CreationSources sources={exporting.sources} api={api} /><button type="button" className="projects-button projects-button--primary" disabled={locked} onClick={() => void confirmExport()}><Download size={14} />确认导出</button></section>}
    {versionsOpen && <section className="creation-versions" aria-label="版本记录"><h3>保留的版本</h3>{!detail.versions.length && <p>保存一个版本，之后可以回看、恢复或导出。</p>}{detail.versions.slice().sort((a, b) => b.number - a.number).map(version => <article key={version.id} aria-label={`版本 v${version.number}`}><div><strong>v{version.number} · {version.title}</strong><small>{new Date(version.createdAt).toLocaleString('zh-CN')}{version.id === draft.finalVersionId ? ' · 已定稿' : ''}</small></div><div className="creation-actions"><button type="button" className="projects-button" disabled={locked} onClick={() => void replaceDraft({ title: version.title, brief: version.brief, body: version.body, sources: version.sources, referenceSelection: version.referenceSelection ?? { mode: 'auto', paths: [] } }, `已将 v${version.number} 及其资料范围载入工作草稿。`)}>载入此版本</button><button type="button" className="projects-button" disabled={locked} onClick={() => { setExporting(version); setNotice(''); }}>导出此版本</button></div></article>)}</section>}
    <div className="creation-editor-columns"><main className="creation-manuscript"><label className="creation-title-label">内容标题<input aria-label="内容标题" maxLength={255} value={draft.title} disabled={busy || discarded} onChange={event => state.update({ title: event.target.value })} /></label>
      <details className="creation-brief" open={!draft.body}><summary>创作要求{draft.brief ? ' · 已填写' : ' · 可选'}</summary><textarea aria-label="创作要求" maxLength={4000} rows={3} disabled={busy || discarded} value={draft.brief} onChange={event => state.update({ brief: event.target.value })} placeholder="例如：面向初中生家长，60秒口播，想解释选画室时该关注什么" />
      {(draft.audience || draft.angle || draft.rationale) && <dl>{draft.audience && <><dt>受众</dt><dd>{draft.audience}</dd></>}{draft.angle && <><dt>切入角度</dt><dd>{draft.angle}</dd></>}{draft.rationale && <><dt>选题依据</dt><dd>{draft.rationale}</dd></>}</dl>}</details>
      <CreationReferencePicker api={api} projectId={projectId} value={draft.referenceSelection} onChange={referenceSelection => state.update({ referenceSelection })} disabled={locked} compact />
      <label className="creation-label creation-body-label">脚本正文<textarea aria-label="脚本正文" className="creation-body" maxLength={60000} disabled={busy || discarded} value={draft.body} onChange={event => { state.update({ body: event.target.value, kind: 'script' }); setSelection(undefined); }} onSelect={event => { const input = event.currentTarget; setSelection(input.selectionEnd > input.selectionStart ? { start: input.selectionStart, end: input.selectionEnd, text: input.value.slice(input.selectionStart, input.selectionEnd) } : undefined); }} placeholder="直接写下你的脚本，或让右侧问问根据项目资料起草。" /></label><footer className="creation-manuscript-footer"><span>{draft.body.length.toLocaleString()} 字</span><span>草稿自动保存在本机 · 导出后进入项目文件夹</span></footer><CreationSources sources={draft.sources} api={api} />
    </main><CreationAssistant locked={locked} api={api} projectId={projectId} draft={draft} persistedDraft={detail.item} messages={detail.messages} profileRevision={profileRevision} selection={selection} flush={state.flush} onAdopt={async (body, suggestion) => { const sources = suggestion.replacement ? Array.from(new Map([...draft.sources, ...suggestion.sources].map(source => [source.id, source])).values()) : suggestion.sources; if (sources.length > 100) { setNotice('这次局部修改会超过100条参考来源，请改用整稿修改来整理引用；正文已保留。'); return false; } return replaceDraft({ body, kind: 'script', sources }, '已采用到正文。'); }} /></div>
  </section>;
}
