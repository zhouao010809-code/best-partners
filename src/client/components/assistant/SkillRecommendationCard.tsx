import { Check, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, WandSparkles } from 'lucide-react';
import type { SkillMatchCandidate } from '../../../shared/api/skills.js';

export interface SkillRecommendationCardProps {
  state: 'matching' | 'ready' | 'error' | 'unavailable' | 'invalidated';
  candidates?: SkillMatchCandidate[];
  selectedIndex?: number;
  onSelect?: (index: number) => void;
  onUse?: () => void;
  onSkip?: () => void;
  message?: string;
  onRetry?: () => void;
  onContinue?: () => void;
  canRetry?: boolean;
}

export function SkillRecommendationCard(props: SkillRecommendationCardProps) {
  if (props.state === 'matching') {
    return <section className="assistant-skill-card assistant-skill-card--matching" aria-label="Skill 匹配状态" role="status">
      <LoaderCircle className="assistant-spin" aria-hidden="true" />
      <span>正在匹配适合的 Skill…</span>
    </section>;
  }

  if (props.state === 'invalidated') {
    return <section className="assistant-skill-card assistant-skill-card--invalidated" aria-label="Skill 推荐已失效" role="status">
      <p>{props.message}</p>
      <button type="button" onClick={() => props.onRetry?.()}><RefreshCw />重新匹配</button>
    </section>;
  }

  if (props.state === 'error' || props.state === 'unavailable') {
    return <section className="assistant-skill-card assistant-skill-card--error" aria-label="Skill 匹配不可用" role="alert">
      <p>{props.message}</p>
      <div className="assistant-skill-card__actions">
        <button type="button" onClick={() => props.onRetry?.()} disabled={props.canRetry === false}><RefreshCw />重试匹配</button>
        <button type="button" className="assistant-skill-card__secondary" onClick={() => props.onContinue?.()}>继续普通问问</button>
      </div>
    </section>;
  }

  if (props.state !== 'ready' || !props.candidates || props.selectedIndex === undefined || !props.onSelect || !props.onUse || !props.onSkip) return null;
  const selected = props.candidates[props.selectedIndex]!;
  const hasNext = props.candidates.length > 1;
  return <section className="assistant-skill-card" aria-label="Skill 推荐">
    <div className="assistant-skill-card__heading">
      <div><WandSparkles aria-hidden="true" /><strong>可以使用一个本地 Skill</strong></div>
      <span>{props.selectedIndex + 1} / {props.candidates.length}</span>
    </div>
    <div className="assistant-skill-card__candidate">
      <strong>{selected.name}</strong>
      <p>{selected.description}</p>
      <small>{selected.folderName ? `文件夹：${selected.folderName}` : '未分类'} · {selected.reason}</small>
    </div>
    <p className="assistant-skill-card__disclosure">确认后才会把这个 Skill 的方法说明交给问问。</p>
    <div className="assistant-skill-card__actions">
      <button type="button" className="assistant-skill-card__primary" onClick={() => props.onUse?.()}><Check />使用此 Skill</button>
      <button type="button" className="assistant-skill-card__secondary" onClick={() => props.onSkip?.()}>不用</button>
      {hasNext && <button type="button" className="assistant-skill-card__secondary" onClick={() => props.onSelect?.((props.selectedIndex! + 1) % props.candidates!.length)}><ChevronRight />换一个</button>}
      {hasNext && props.selectedIndex > 0 && <button type="button" className="assistant-skill-card__secondary" aria-label="换回上一个 Skill" onClick={() => props.onSelect?.((props.selectedIndex! - 1 + props.candidates!.length) % props.candidates!.length)}><ChevronLeft />上一个</button>}
    </div>
  </section>;
}
