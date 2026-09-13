export type MaterialDeckCard = {
  key: string;
  path: string;
  title: string;
  sourcePlatform: string;
  collectedAt?: string;
  knowledgeStatus: '未提炼' | '部分入库';
  nextAction: 'start' | 'resume' | 'recover' | 'progress';
  primaryActionDisabledReason?: string;
};

export type MaterialDeckAppearance = 'default' | 'desk' | 'showcase';

export type MaterialDeckCardLayout = {
  index: number;
  mode: 'collapsed' | 'active' | 'rail';
  railRank?: number;
  left: number;
  top: number;
  width: number;
  height: number;
  y: number;
  z: number;
  rotateY: number;
  rotateZ: number;
  scale: number;
  opacity: number;
  zIndex: number;
};

export type MaterialDeckLayout = {
  trackWidth: number;
  trackHeight: number;
  safe: number;
  detailLeft: number;
  detailWidth: number;
  detailHeight: number;
  railLeft: number;
  cards: MaterialDeckCardLayout[];
};

export function numericCss(value: number): string {
  if (!Number.isFinite(value)) throw new Error('NON_FINITE_DECK_LAYOUT');
  return String(Math.round(value * 1000) / 1000);
}

export function getMaterialDeckLayout(input: {
  count: number;
  appearance?: MaterialDeckAppearance;
  activeIndex?: number;
  liftedIndex?: number;
  viewportWidth: number;
  viewportHeight: number;
}): MaterialDeckLayout {
  const count = Math.max(0, Math.floor(finiteOr(input.count, 0)));
  const viewportWidth = Math.max(1, finiteOr(input.viewportWidth, 1));
  const viewportHeight = Math.max(1, finiteOr(input.viewportHeight, 1));
  const activeIndex = validIndex(input.activeIndex, count);
  const liftedIndex = activeIndex === undefined
    ? validIndex(input.liftedIndex, count)
    : undefined;
  const desk = input.appearance === 'desk';
  const showcase = input.appearance === 'showcase';
  const magnification = showcase ? 1.25 : 1;
  const fewCards = count <= 3;
  const center = (count - 1) / 2;
  const cardWidth = desk
    ? fewCards ? clamp(viewportWidth * 0.34, 200, 240) : clamp(viewportWidth * 0.28, 180, 216)
    : clamp(viewportWidth * 0.16, 104, 142) * magnification;
  const cardHeight = desk
    ? clamp(viewportHeight * 0.65, 240, 300)
    : clamp(viewportHeight * 0.49, 214, 276) * magnification;
  const visualWidth = desk || showcase ? cardWidth : cardWidth * 0.69;
  const step = count <= 1
    ? 0
    : desk
      ? cardWidth * (fewCards ? 0.66 : 0.52)
      : viewportWidth <= 480
        ? clamp(cardWidth * 0.94, 94 * magnification, 100 * magnification)
        : clamp((viewportWidth - visualWidth - 38) / Math.max(1, count - 1), 38 * magnification, 68 * magnification);
  // The desk reserves the complete card width plus lift/rotation clearance at both ends.
  const safe = desk
    ? clamp(viewportWidth * 0.035, 24, 32)
    : clamp(Math.min(viewportWidth, viewportHeight) * 0.035, 18, 30);
  const gap = clamp(viewportWidth * 0.028, 18, 34);
  const detailWidth = desk || showcase
    ? Math.min(Math.max(1, viewportWidth - safe * 2), clamp(viewportWidth * 0.49, 280, 420))
    : clamp(viewportWidth * 0.39, 280, 420);
  const detailHeight = desk || showcase
    ? Math.max(1, Math.min(480, viewportHeight - safe * 2))
    : clamp(
        viewportHeight * 0.78,
        330,
        Math.max(330, viewportHeight - safe * 2)
      );
  const detailLeft = safe;
  const railLeft = detailLeft + detailWidth + gap;
  const railWidth = Math.max(180, viewportWidth - safe - railLeft);
  const miniWidth = desk ? clamp(railWidth * 0.28, 100, 144) : clamp(railWidth * 0.22, 72, 118);
  const miniHeight = desk ? clamp(viewportHeight * 0.52, 180, 240) : clamp(viewportHeight * 0.47, 160, 236);
  const miniVisual = desk ? miniWidth : miniWidth * 0.66;
  const miniStep = desk
    ? clamp(miniWidth * 0.7, 72, 96)
    : clamp(
        (railWidth - miniVisual) / Math.max(1, count - 2),
        20,
        48
      );
  const trackWidth = activeIndex === undefined
    ? Math.max(viewportWidth, visualWidth + Math.max(0, count - 1) * step + (desk ? safe + 12 : safe) * 2)
    : desk && count <= 1
      ? viewportWidth
      : Math.max(
          viewportWidth,
          railLeft + miniVisual + Math.max(0, count - 2) * miniStep + safe
        );
  const trackHeight = viewportHeight;
  const cards = Array.from({ length: count }, (_, index): MaterialDeckCardLayout => {
    if (index === activeIndex) {
      return {
        index,
        mode: 'active',
        left: detailLeft,
        top: (trackHeight - detailHeight) / 2,
        width: detailWidth,
        height: detailHeight,
        y: 0,
        z: 0,
        rotateY: 0,
        rotateZ: 0,
        scale: 1,
        opacity: 1,
        zIndex: 999
      };
    }

    if (activeIndex !== undefined) {
      const railRank = index < activeIndex ? index : index - 1;
      return {
        index,
        mode: 'rail',
        railRank,
        left: railLeft + railRank * miniStep,
        top: (trackHeight - miniHeight) / 2,
        width: miniWidth,
        height: miniHeight,
        y: desk || showcase
          ? clamp((railRank - (count - 2) / 2) * 1.25, -6, 6)
          : (railRank - (count - 2) / 2) * 1.25,
        z: desk || showcase ? Math.min(railRank, 8) : railRank,
        rotateY: desk ? -44 : -53,
        rotateZ: desk ? -5 : -2.4,
        scale: 0.92,
        opacity: 0.58,
        zIndex: railRank + 2
      };
    }

    let left = trackWidth / 2 + (index - center) * step - cardWidth / 2;
    let y = desk || showcase ? clamp((index - center) * 1.25, -6, 6) : (index - center) * 1.25;
    let z = desk || showcase ? Math.min(index * 1.5, 9) : index * 1.5;
    let scale = 1;
    if (liftedIndex !== undefined) {
      const distance = index - liftedIndex;
      if (distance === 0) {
        y -= showcase ? 22 : 11;
        z += desk ? 24 : showcase ? 50 : 70;
        scale = desk ? 1.04 : 1.06;
      } else if (Math.abs(distance) <= 2) {
        left += Math.sign(distance) * 8 * (3 - Math.abs(distance));
      }
    }

    return {
      index,
      mode: 'collapsed',
      left,
      top: (trackHeight - cardHeight) / 2,
      width: cardWidth,
      height: cardHeight,
      y,
      z,
      rotateY: -48,
      rotateZ: desk ? -6 : -2,
      scale,
      opacity: 1,
      zIndex: index + 2
    };
  });

  return {
    trackWidth,
    trackHeight,
    safe,
    detailLeft,
    detailWidth,
    detailHeight,
    railLeft,
    cards
  };
}

function validIndex(value: number | undefined, count: number): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) < count
    ? Number(value)
    : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(Math.max(minimum, maximum), value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
