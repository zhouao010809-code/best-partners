import { Link } from 'react-router-dom';
import { BookOpen, X } from 'lucide-react';
import type { LearningSelection } from '../../../shared/api/learning.js';
import '../../styles/learning-selection.css';

export function LearningSelectionCard({ selection, onRemove, disabled = false, historical = false }: {
  selection: LearningSelection;
  onRemove?: () => void;
  disabled?: boolean;
  historical?: boolean;
}) {
  const href = `${selection.path.startsWith('02知识库/') ? '/knowledge' : '/library'}?${new URLSearchParams({ path: selection.path })}`;
  return <section className="learning-selection" aria-label={historical ? '本条提问的选文' : '你选中的文字'}>
    <div className="learning-selection__heading"><span><BookOpen size={14} />{historical ? '本条提问的选文' : '你选中的文字'}</span>
      {onRemove && <button type="button" aria-label="移除待发送选段" title="移除待发送选段" disabled={disabled} onClick={onRemove}><X size={14} /></button>}
    </div>
    <strong>{selection.title}</strong>
    <blockquote>{selection.text}</blockquote>
    <Link to={href}>查看原文</Link>
    {!historical && <p>选中文字与当前资料可用于解释。</p>}
  </section>;
}
