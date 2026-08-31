import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type {
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent
} from 'react';
import { MaterialDeckDetail } from './MaterialDeckDetail.js';
import {
  getMaterialDeckLayout,
  type MaterialDeckCard
} from './materialDeckLayout.js';
import { useDeckStyleSheet } from './useDeckStyleSheet.js';
import './material-deck.css';

export const PRESS_PREVIEW_MS = 220;
export const PRESS_MOVE_TOLERANCE_PX = 12;

export interface MaterialDeckProps {
  cards: readonly MaterialDeckCard[];
  primaryActionDisabledReason?: string;
  onPrimaryAction(card: MaterialDeckCard): void;
}

type PendingPointer = {
  key: string;
  pointerId: number;
  clientX: number;
  clientY: number;
  previewStarted: boolean;
};

export function MaterialDeck({
  cards,
  primaryActionDisabledReason,
  onPrimaryAction
}: MaterialDeckProps) {
  const [selectedKey, setSelectedKey] = useState<string>();
  const [previewKey, setPreviewKey] = useState<string>();
  const [hoveredKey, setHoveredKey] = useState<string>();
  const [focusLiftKey, setFocusLiftKey] = useState<string>();
  const [focusedKey, setFocusedKey] = useState<string | undefined>(() => cards[0]?.key);
  const [viewportSize, setViewportSize] = useState({ width: 960, height: 560 });
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const viewportRef = useRef<HTMLDivElement>(null);
  const priorActiveKeyRef = useRef<string | undefined>(undefined);
  const priorScrollLeftRef = useRef<number | undefined>(undefined);
  const restoreFocusKeyRef = useRef<string | undefined>(undefined);
  const pointerTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerRef = useRef<PendingPointer | undefined>(undefined);
  const suppressNextClickRef = useRef<string | undefined>(undefined);

  const indexByKey = useMemo(
    () => new Map(cards.map((card, index) => [card.key, index])),
    [cards]
  );
  const effectiveSelectedKey = selectedKey !== undefined && indexByKey.has(selectedKey)
    ? selectedKey
    : undefined;
  const effectivePreviewKey = effectiveSelectedKey === undefined
    && previewKey !== undefined
    && indexByKey.has(previewKey)
    ? previewKey
    : undefined;
  const activeKey = effectiveSelectedKey ?? effectivePreviewKey;
  const activeIndex = activeKey === undefined ? undefined : indexByKey.get(activeKey);
  const liftedKey = hoveredKey !== undefined && indexByKey.has(hoveredKey)
    ? hoveredKey
    : focusLiftKey !== undefined && indexByKey.has(focusLiftKey)
      ? focusLiftKey
      : undefined;
  const liftedIndex = liftedKey === undefined ? undefined : indexByKey.get(liftedKey);
  const effectiveFocusedKey = focusedKey !== undefined && indexByKey.has(focusedKey)
    ? focusedKey
    : cards[0]?.key;
  const layout = useMemo(() => getMaterialDeckLayout({
    count: cards.length,
    ...(activeIndex === undefined ? {} : { activeIndex }),
    ...(liftedIndex === undefined ? {} : { liftedIndex }),
    viewportWidth: viewportSize.width,
    viewportHeight: viewportSize.height
  }), [activeIndex, cards.length, liftedIndex, viewportSize.height, viewportSize.width]);
  const instanceId = useDeckStyleSheet(layout);

  const clearPointerPreview = useCallback((key?: string) => {
    if (pointerTimerRef.current !== undefined) clearTimeout(pointerTimerRef.current);
    pointerTimerRef.current = undefined;
    pointerRef.current = undefined;
    setPreviewKey((current) => (key === undefined || current === key ? undefined : current));
  }, []);

  useEffect(() => () => {
    if (pointerTimerRef.current !== undefined) clearTimeout(pointerTimerRef.current);
    pointerTimerRef.current = undefined;
    pointerRef.current = undefined;
  }, []);

  useEffect(() => {
    const pending = pointerRef.current;
    if (pending && !indexByKey.has(pending.key)) clearPointerPreview(pending.key);
    if (selectedKey !== undefined && !indexByKey.has(selectedKey)) setSelectedKey(undefined);
    if (previewKey !== undefined && !indexByKey.has(previewKey)) setPreviewKey(undefined);
    if (hoveredKey !== undefined && !indexByKey.has(hoveredKey)) setHoveredKey(undefined);
    if (focusLiftKey !== undefined && !indexByKey.has(focusLiftKey)) setFocusLiftKey(undefined);
    if (focusedKey !== undefined && !indexByKey.has(focusedKey)) {
      setFocusedKey(cards[0]?.key);
    }
    if (suppressNextClickRef.current !== undefined
      && !indexByKey.has(suppressNextClickRef.current)) {
      suppressNextClickRef.current = undefined;
    }
  }, [
    cards,
    clearPointerPreview,
    focusLiftKey,
    focusedKey,
    hoveredKey,
    indexByKey,
    previewKey,
    selectedKey
  ]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const updateSize = () => {
      const bounds = viewport.getBoundingClientRect();
      const width = viewport.clientWidth || bounds.width || 960;
      const height = viewport.clientHeight || bounds.height || 560;
      setViewportSize((current) => (
        current.width === width && current.height === height
          ? current
          : { width, height }
      ));
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const priorActiveKey = priorActiveKeyRef.current;
    if (activeKey !== undefined && priorActiveKey === undefined) {
      priorScrollLeftRef.current = viewport.scrollLeft;
      viewport.scrollLeft = 0;
    } else if (activeKey === undefined && priorActiveKey !== undefined) {
      const scrollLeft = priorScrollLeftRef.current ?? 0;
      const restoreKey = restoreFocusKeyRef.current;
      if (restoreKey !== undefined) {
        cardRefs.current.get(restoreKey)?.focus({ preventScroll: true });
      }
      viewport.scrollLeft = scrollLeft;
      priorScrollLeftRef.current = undefined;
      restoreFocusKeyRef.current = undefined;
    }
    priorActiveKeyRef.current = activeKey;
  }, [activeKey]);

  const openSelection = useCallback((key: string) => {
    clearPointerPreview();
    restoreFocusKeyRef.current = key;
    setSelectedKey((current) => (current === key ? undefined : key));
  }, [clearPointerPreview]);

  const closeSelection = useCallback(() => {
    if (effectiveSelectedKey === undefined) return;
    restoreFocusKeyRef.current = effectiveSelectedKey;
    setSelectedKey(undefined);
  }, [effectiveSelectedKey]);

  const handleCardKeyDown = useCallback((
    event: KeyboardEvent<HTMLButtonElement>,
    cardIndex: number,
    key: string
  ) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const nextIndex = event.key === 'ArrowLeft'
        ? Math.max(0, cardIndex - 1)
        : Math.min(cards.length - 1, cardIndex + 1);
      const nextCard = cards[nextIndex];
      if (!nextCard) return;
      setFocusedKey(nextCard.key);
      const nextTrigger = cardRefs.current.get(nextCard.key);
      nextTrigger?.focus();
      nextTrigger?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setFocusedKey(key);
      openSelection(key);
    }
  }, [cards, openSelection]);

  const handlePointerDown = useCallback((
    event: PointerEvent<HTMLButtonElement>,
    key: string
  ) => {
    if (effectiveSelectedKey !== undefined || event.isPrimary === false || event.button !== 0) {
      return;
    }
    clearPointerPreview();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointerRef.current = {
      key,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      previewStarted: false
    };
    pointerTimerRef.current = setTimeout(() => {
      const pending = pointerRef.current;
      if (!pending || pending.pointerId !== event.pointerId || pending.key !== key) return;
      pending.previewStarted = true;
      setPreviewKey(key);
    }, PRESS_PREVIEW_MS);
  }, [clearPointerPreview, effectiveSelectedKey]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const pending = pointerRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      event.clientX - pending.clientX,
      event.clientY - pending.clientY
    );
    if (distance > PRESS_MOVE_TOLERANCE_PX) {
      if (pending.previewStarted) suppressNextClickRef.current = pending.key;
      clearPointerPreview(pending.key);
    }
  }, [clearPointerPreview]);

  const finishPointer = useCallback((
    event: PointerEvent<HTMLButtonElement>,
    suppressClick: boolean
  ) => {
    const pending = pointerRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (suppressClick && pending.previewStarted) suppressNextClickRef.current = pending.key;
    clearPointerPreview(pending.key);
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }, [clearPointerPreview]);

  const handleCardBlur = useCallback((
    event: FocusEvent<HTMLButtonElement>,
    key: string
  ) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setFocusLiftKey((current) => (current === key ? undefined : current));
  }, []);

  const handleRootKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || effectiveSelectedKey === undefined) return;
    event.preventDefault();
    closeSelection();
  }, [closeSelection, effectiveSelectedKey]);

  const handleStageClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    closeSelection();
  }, [closeSelection]);

  return (
    <section
      className="material-deck"
      aria-label="待提炼材料牌堆"
      data-deck-instance={instanceId}
      onKeyDown={handleRootKeyDown}
    >
      <header className="material-deck__header">
        <div>
          <span>MATERIAL DECK</span>
          <h2>待提炼材料</h2>
        </div>
        <strong>{String(cards.length).padStart(2, '0')} 张</strong>
      </header>

      <div className="material-deck__stage" onClick={handleStageClick}>
        <div
          ref={viewportRef}
          className="material-deck__viewport"
          data-material-deck-viewport
        >
          <div className="material-deck__track">
            {cards.map((card, cardIndex) => {
              const cardLayout = layout.cards[cardIndex];
              if (!cardLayout) return null;
              const selected = effectiveSelectedKey === card.key;
              const preview = effectivePreviewKey === card.key;
              const revealed = selected || preview;
              const lifted = activeKey === undefined && liftedKey === card.key;
              return (
                <div
                  key={card.key}
                  className={`material-deck-card${selected ? ' is-selected' : ''}${preview ? ' is-preview' : ''}${lifted ? ' is-lifted' : ''}`}
                  data-card-index={cardIndex}
                  data-card-mode={cardLayout.mode}
                  {...(lifted ? { 'data-card-lifted': 'true' } : {})}
                >
                  <button
                    ref={(node) => {
                      if (node) cardRefs.current.set(card.key, node);
                      else cardRefs.current.delete(card.key);
                    }}
                    type="button"
                    className="material-deck-card__trigger"
                    data-material-card-trigger
                    aria-label={`${card.title}，${card.sourcePlatform}，${card.knowledgeStatus}`}
                    aria-expanded={selected}
                    tabIndex={!selected && effectiveFocusedKey === card.key ? 0 : -1}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (suppressNextClickRef.current === card.key) {
                        suppressNextClickRef.current = undefined;
                        return;
                      }
                      setFocusedKey(card.key);
                      openSelection(card.key);
                    }}
                    onKeyDown={(event) => handleCardKeyDown(event, cardIndex, card.key)}
                    onMouseEnter={() => setHoveredKey(card.key)}
                    onMouseLeave={() => setHoveredKey((current) => (
                      current === card.key ? undefined : current
                    ))}
                    onFocus={() => {
                      setFocusedKey(card.key);
                      setFocusLiftKey(card.key);
                    }}
                    onBlur={(event) => handleCardBlur(event, card.key)}
                    onPointerDown={(event) => handlePointerDown(event, card.key)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={(event) => finishPointer(event, true)}
                    onPointerCancel={(event) => finishPointer(event, false)}
                    onLostPointerCapture={(event) => finishPointer(event, false)}
                  >
                    <span className={`material-deck-card__badge material-deck-card__badge--${card.knowledgeStatus === '未提炼' ? 'pending' : 'partial'}`}>
                      {card.knowledgeStatus}
                    </span>
                    <small>{card.sourcePlatform}</small>
                    <strong>{card.title}</strong>
                    <span className="material-deck-card__date">{card.collectedAt || '日期未记录'}</span>
                  </button>

                  {revealed && (
                    <MaterialDeckDetail
                      card={card}
                      mode={selected ? 'selected' : 'preview'}
                      onClose={closeSelection}
                      onPrimaryAction={onPrimaryAction}
                      {...(primaryActionDisabledReason === undefined
                        ? {}
                        : { primaryActionDisabledReason })}
                    />
                  )}
                </div>
              );
            })}
            {cards.length === 0 && (
              <p className="material-deck__empty">暂无待提炼材料</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
