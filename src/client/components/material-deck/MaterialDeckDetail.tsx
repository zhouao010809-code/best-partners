import {
  ArrowUpRight,
  CalendarDays,
  CircleDashed,
  FileText,
  RotateCcw,
  X
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { MaterialDeckCard } from './materialDeckLayout.js';

const actionLabels = {
  start: '开始提炼',
  resume: '继续审阅',
  recover: '恢复提炼'
} as const;

export interface MaterialDeckDetailProps {
  card: MaterialDeckCard;
  mode: 'selected' | 'preview';
  primaryActionDisabledReason?: string;
  onClose(): void;
  onPrimaryAction(card: MaterialDeckCard): void;
}

export function MaterialDeckDetail({
  card,
  mode,
  primaryActionDisabledReason,
  onClose,
  onPrimaryAction
}: MaterialDeckDetailProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const selected = mode === 'selected';
  const StatusIcon = card.knowledgeStatus === '未提炼' ? CircleDashed : FileText;
  const ActionIcon = card.nextAction === 'recover' ? RotateCcw : ArrowUpRight;

  useEffect(() => {
    if (selected) headingRef.current?.focus({ preventScroll: true });
  }, [selected]);

  return (
    <article
      className={`material-deck-detail material-deck-detail--${mode}`}
      data-material-detail-mode={mode}
      {...(selected
        ? { role: 'dialog', 'aria-label': `${card.title} 详情`, 'aria-modal': 'false' }
        : { 'aria-hidden': true })}
    >
      <header className="material-deck-detail__header">
        <div>
          <span className="material-deck-detail__eyebrow">MATERIAL SIGNAL</span>
          <h3 ref={selected ? headingRef : undefined} tabIndex={selected ? -1 : undefined}>
            {card.title}
          </h3>
        </div>
        {selected && (
          <button
            type="button"
            className="material-deck-detail__close"
            aria-label="关闭材料详情"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <X aria-hidden="true" />
          </button>
        )}
      </header>

      <div className="material-deck-detail__status">
        <StatusIcon aria-hidden="true" />
        <span>{card.knowledgeStatus}</span>
      </div>

      <dl className="material-deck-detail__facts">
        <div>
          <dt>来源平台</dt>
          <dd>{card.sourcePlatform}</dd>
        </div>
        <div>
          <dt>采集日期</dt>
          <dd><CalendarDays aria-hidden="true" />{card.collectedAt || '未记录'}</dd>
        </div>
      </dl>

      <p className="material-deck-detail__path">{card.path}</p>

      {selected && (
        <div className="material-deck-detail__action">
          {primaryActionDisabledReason !== undefined && (
            <p>{primaryActionDisabledReason}</p>
          )}
          <button
            type="button"
            className="material-deck-detail__primary"
            disabled={primaryActionDisabledReason !== undefined}
            onClick={(event) => {
              event.stopPropagation();
              if (primaryActionDisabledReason === undefined) onPrimaryAction(card);
            }}
          >
            <span>{actionLabels[card.nextAction]}</span>
            <ActionIcon aria-hidden="true" />
          </button>
        </div>
      )}
    </article>
  );
}
