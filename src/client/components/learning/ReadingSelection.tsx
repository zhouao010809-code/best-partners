import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MessageCircle } from 'lucide-react';
import type { LearningSelection } from '../../../shared/api/learning.js';
import { askAssistant } from '../assistant/assistantIntent.js';
import '../../styles/reading-selection.css';

type ReadingSource = Omit<LearningSelection, 'text'>;

/** Only the loaded Markdown body belongs here; metadata and saved notes stay outside. */
export function ReadingSelection({ source, children }: { source: ReadingSource | undefined; children: ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [passage, setPassage] = useState<LearningSelection>();
  const [tooLong, setTooLong] = useState(false);
  const path = source?.path;
  const title = source?.title;
  const revision = source?.revision;

  useLayoutEffect(() => {
    const body = bodyRef.current;
    setPassage(undefined);
    setTooLong(false);
    if (!body) return;
    const clearOwnedSelection = () => {
      const selection = window.getSelection();
      if (selection?.anchorNode && body.contains(selection.anchorNode)) selection.removeAllRanges();
    };
    clearOwnedSelection();
    if (!path || !title || !revision) return clearOwnedSelection;

    const capture = () => {
      const selected = window.getSelection();
      const range = selected?.rangeCount === 1 ? selected.getRangeAt(0) : undefined;
      if (!range || selected!.isCollapsed || body.closest('[hidden], [inert], [aria-hidden="true"]')
        || !body.contains(range.startContainer) || !body.contains(range.endContainer)) {
        setPassage(undefined); setTooLong(false); return;
      }
      const text = selected!.toString().trim();
      const exceedsLimit = Array.from(text).length > 6000;
      setTooLong(exceedsLimit);
      setPassage(text && !exceedsLimit ? { path, title, revision, text } : undefined);
    };
    document.addEventListener('selectionchange', capture);
    return () => { document.removeEventListener('selectionchange', capture); clearOwnedSelection(); };
  }, [path, title, revision]);

  const active = passage && passage.path === path && passage.title === title && passage.revision === revision ? passage : undefined;
  return <>
    <div ref={bodyRef} className="reading-selection-body">{children}</div>
    {source && (active || tooLong) && createPortal(tooLong
      ? <p className="selection-ask reading-selection-limit" role="status">选中文字超过 6000 字，请缩小选择范围。</p>
      : <button type="button" className="selection-ask" onMouseDown={event => event.preventDefault()} onClick={() => {
        if (!active) return;
        askAssistant({ purpose: 'learning', scope: 'current', contextPath: active.path, selection: active, prompt: '请用容易理解的话解释这段内容' });
        setPassage(undefined);
        window.getSelection()?.removeAllRanges();
      }}><MessageCircle size={16} aria-hidden="true" />问问这段内容</button>, document.body)}
  </>;
}
