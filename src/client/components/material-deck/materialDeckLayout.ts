export type MaterialDeckCard = {
  key: string;
  path: string;
  title: string;
  sourcePlatform: string;
  collectedAt?: string;
  knowledgeStatus: '未提炼' | '部分入库';
  nextAction: 'start' | 'resume' | 'recover';
};

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
  const center = (count - 1) / 2;
  const cardWidth = clamp(viewportWidth * 0.16, 104, 142);
  const cardHeight = clamp(viewportHeight * 0.49, 214, 276);
  const visualWidth = cardWidth * 0.69;
  const step = count <= 1
    ? 0
    : clamp((viewportWidth - visualWidth - 38) / Math.max(1, count - 1), 38, 68);
  const safe = clamp(Math.min(viewportWidth, viewportHeight) * 0.035, 18, 30);
  const gap = clamp(viewportWidth * 0.028, 18, 34);
  const detailWidth = clamp(viewportWidth * 0.39, 280, 420);
  const detailHeight = clamp(
    viewportHeight * 0.78,
    330,
    Math.max(330, viewportHeight - safe * 2)
  );
  const detailLeft = safe;
  const railLeft = detailLeft + detailWidth + gap;
  const railWidth = Math.max(180, viewportWidth - safe - railLeft);
  const miniWidth = clamp(railWidth * 0.22, 72, 118);
  const miniHeight = clamp(viewportHeight * 0.47, 160, 236);
  const miniVisual = miniWidth * 0.66;
  const miniStep = clamp(
    (railWidth - miniVisual) / Math.max(1, count - 2),
    20,
    48
  );
  const trackWidth = activeIndex === undefined
    ? Math.max(viewportWidth, visualWidth + Math.max(0, count - 1) * step + safe * 2)
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
        y: (railRank - (count - 2) / 2) * 1.25,
        z: railRank,
        rotateY: -53,
        rotateZ: -2.4,
        scale: 0.92,
        opacity: 0.58,
        zIndex: railRank + 2
      };
    }

    let left = trackWidth / 2 + (index - center) * step - cardWidth / 2;
    let y = (index - center) * 1.25;
    let z = index * 1.5;
    let scale = 1;
    if (liftedIndex !== undefined) {
      const distance = index - liftedIndex;
      if (distance === 0) {
        y -= 11;
        z += 70;
        scale = 1.06;
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
      rotateZ: -2,
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
