import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  getMaterialDeckLayout,
  numericCss,
  type MaterialDeckCard
} from '../../../../src/client/components/material-deck/materialDeckLayout.js';

const counts = [1, 7, 9, 25, 100] as const;
const viewports = [
  { viewportWidth: 1440, viewportHeight: 610 },
  { viewportWidth: 820, viewportHeight: 590 },
  { viewportWidth: 390, viewportHeight: 590 }
] as const;

describe('MaterialDeck layout', () => {
  it('enlarges showcase cards without changing their side angle or rotating on hover', () => {
    const input = { count: 9, viewportWidth: 1000, viewportHeight: 480 };
    const original = getMaterialDeckLayout(input);
    const showcase = getMaterialDeckLayout({ ...input, appearance: 'showcase', liftedIndex: 4 });
    expect(showcase.cards[4]).toMatchObject({ width: original.cards[4]!.width * 1.25, height: original.cards[4]!.height * 1.25, rotateY: -48, rotateZ: -2 });
    expect(showcase.cards[4]!.y).toBeLessThan(original.cards[4]!.y);
    const narrow = getMaterialDeckLayout({ count: 25, appearance: 'showcase', activeIndex: 24, viewportWidth: 270, viewportHeight: 440 });
    expect(narrow.detailLeft + narrow.detailWidth).toBeLessThanOrEqual(270);
    expect(narrow.cards[24]).toMatchObject({ rotateY: 0, rotateZ: 0 });
    expect(narrow.cards.every(card => Math.abs(card.y) <= 6 && card.z <= 9)).toBe(true);
  });

  it('keeps the default geometry unchanged when the desk appearance is not requested', () => {
    const input = { count: 2, viewportWidth: 700, viewportHeight: 420 };
    const layout = getMaterialDeckLayout(input);

    expect(getMaterialDeckLayout({ ...input, appearance: 'default' })).toEqual(layout);
    expect(layout).toMatchObject({
      trackWidth: 700,
      trackHeight: 420,
      safe: 18,
      detailLeft: 18,
      detailWidth: 280,
      detailHeight: 330,
      cards: [
        { left: 260, top: 103, width: 112, height: 214, rotateY: -48, rotateZ: -2 },
        { left: 328, top: 103, width: 112, height: 214, rotateY: -48, rotateZ: -2 }
      ]
    });
  });

  it('keeps the exact Phase 1 card projection contract', () => {
    expectTypeOf<MaterialDeckCard>().toEqualTypeOf<{
      key: string;
      path: string;
      title: string;
      sourcePlatform: string;
      collectedAt?: string;
      knowledgeStatus: '未提炼' | '部分入库';
      nextAction: 'start' | 'resume' | 'recover';
    }>();
  });

  it.each(counts)('returns finite deterministic geometry for %i cards', (count) => {
    for (const viewport of viewports) {
      const input = { count, ...viewport };
      const first = getMaterialDeckLayout(input);
      const second = getMaterialDeckLayout(input);

      expect(second).toEqual(first);
      expect(first.cards).toHaveLength(count);
      expect(first.cards.map((card) => card.index)).toEqual(
        Array.from({ length: count }, (_, index) => index)
      );
      expect(first.cards.every((card) => card.mode === 'collapsed')).toBe(true);

      const topLevelNumbers = [
        first.trackWidth,
        first.trackHeight,
        first.safe,
        first.detailLeft,
        first.detailWidth,
        first.detailHeight,
        first.railLeft
      ];
      expect(topLevelNumbers.every(Number.isFinite)).toBe(true);
      expect(first.trackWidth).toBeGreaterThanOrEqual(viewport.viewportWidth);
      expect(first.trackHeight).toBe(viewport.viewportHeight);

      for (const card of first.cards) {
        const cardNumbers = [
          card.index,
          card.left,
          card.top,
          card.width,
          card.height,
          card.y,
          card.z,
          card.rotateY,
          card.rotateZ,
          card.scale,
          card.opacity,
          card.zIndex
        ];
        expect(cardNumbers.every(Number.isFinite)).toBe(true);
        expect(card.width).toBeGreaterThan(0);
        expect(card.height).toBeGreaterThan(0);
        expect(card.opacity).toBeGreaterThanOrEqual(0);
        expect(card.opacity).toBeLessThanOrEqual(1);
      }
    }
  });

  it.each(counts)('places one active card and %i - 1 cards in the ordered rail', (count) => {
    const activeIndex = Math.floor(count / 2);
    for (const viewport of viewports) {
      const layout = getMaterialDeckLayout({ count, activeIndex, ...viewport });
      const active = layout.cards[activeIndex];
      const rail = layout.cards.filter((card) => card.mode === 'rail');

      expect(active).toMatchObject({
        index: activeIndex,
        mode: 'active',
        left: layout.safe,
        width: layout.detailWidth,
        rotateY: 0,
        rotateZ: 0
      });
      expect(layout.cards.filter((card) => card.mode === 'active')).toHaveLength(1);
      expect(rail).toHaveLength(count - 1);
      expect(rail.map((card) => card.index)).toEqual(
        Array.from({ length: count }, (_, index) => index).filter(
          (index) => index !== activeIndex
        )
      );
      expect(rail.map((card) => card.railRank)).toEqual(
        Array.from({ length: count - 1 }, (_, index) => index)
      );
      expect(rail.every((card) => card.left >= layout.railLeft)).toBe(true);
    }
  });

  it('ignores invalid active and lifted indexes', () => {
    const base = getMaterialDeckLayout({
      count: 7,
      viewportWidth: 820,
      viewportHeight: 590
    });

    for (const invalidIndex of [-1, 7, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(getMaterialDeckLayout({
        count: 7,
        activeIndex: invalidIndex,
        liftedIndex: invalidIndex,
        viewportWidth: 820,
        viewportHeight: 590
      })).toEqual(base);
    }
  });

  it('lifts one collapsed card and separates its neighbors without opening it', () => {
    const base = getMaterialDeckLayout({
      count: 7,
      viewportWidth: 820,
      viewportHeight: 590
    });
    const lifted = getMaterialDeckLayout({
      count: 7,
      liftedIndex: 3,
      viewportWidth: 820,
      viewportHeight: 590
    });

    expect(lifted.cards[3]).toMatchObject({ mode: 'collapsed', rotateY: -48 });
    expect(lifted.cards[3]!.y).toBeLessThan(base.cards[3]!.y);
    expect(lifted.cards[3]!.scale).toBeGreaterThan(base.cards[3]!.scale);
    expect(lifted.cards[2]!.left).toBeLessThan(base.cards[2]!.left);
    expect(lifted.cards[4]!.left).toBeGreaterThan(base.cards[4]!.left);
  });

  it('expands the collapsed mobile track enough to keep adjacent titles readable', () => {
    const layout = getMaterialDeckLayout({
      count: 9,
      viewportWidth: 390,
      viewportHeight: 590
    });
    const adjacentSteps = layout.cards.slice(1).map(
      (card, index) => card.left - layout.cards[index]!.left
    );
    const last = layout.cards.at(-1)!;

    expect(Math.min(...adjacentSteps)).toBeGreaterThanOrEqual(94);
    expect(layout.trackWidth).toBeGreaterThanOrEqual(850);
    expect(layout.cards[0]!.left).toBeGreaterThanOrEqual(0);
    expect(last.left + last.width).toBeLessThanOrEqual(layout.trackWidth + 1);
  });

  it('rounds safe CSS numbers and rejects non-finite values', () => {
    expect(numericCss(1 / 3)).toBe('0.333');
    expect(numericCss(-0)).toBe('0');
    expect(numericCss(12.3456)).toBe('12.346');
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => numericCss(invalid)).toThrowError('NON_FINITE_DECK_LAYOUT');
    }
  });
});

describe('MaterialDeck desk appearance', () => {
  const deskViewports = [
    { viewportWidth: 270, viewportHeight: 360 },
    { viewportWidth: 390, viewportHeight: 420 },
    { viewportWidth: 700, viewportHeight: 460 },
    { viewportWidth: 1440, viewportHeight: 560 }
  ];

  it.each([1, 2, 3])('presents %i collapsed cards as a side-facing deck with identifiable faces', (count) => {
    for (const viewport of deskViewports) {
      const layout = getMaterialDeckLayout({ count, appearance: 'desk', ...viewport });
      for (const card of layout.cards) {
        expect(card.width).toBeGreaterThanOrEqual(200);
        expect(card.width).toBeLessThanOrEqual(240);
        expect(card.width * Math.cos(card.rotateY * Math.PI / 180)).toBeGreaterThanOrEqual(130);
        expect(Math.abs(card.rotateY)).toBeGreaterThanOrEqual(45);
        expect(Math.abs(card.rotateY)).toBeLessThanOrEqual(50);
      }
      for (const [index, card] of layout.cards.slice(1).entries()) {
        const previous = layout.cards[index]!;
        const visibleStep = card.left - previous.left;
        expect(visibleStep).toBeGreaterThanOrEqual(125);
        expect(visibleStep).toBeLessThan(previous.width);
      }
    }
  });

  it.each([1, 2, 3, 9, 100])('bounds %i cards and their lifted edges inside a finite horizontal track', (count) => {
    for (const viewport of deskViewports) {
      for (const liftedIndex of [undefined, 0, count - 1]) {
        const layout = getMaterialDeckLayout({
          count,
          appearance: 'desk',
          ...viewport,
          ...(liftedIndex === undefined ? {} : { liftedIndex })
        });
        expect(layout.trackHeight).toBe(viewport.viewportHeight);
        expect(layout.trackWidth).toBeGreaterThanOrEqual(viewport.viewportWidth);
        expect(layout.trackWidth).toBeLessThanOrEqual(Math.max(viewport.viewportWidth, count * 240 + 80));
        for (const card of layout.cards) {
          expect(Object.values(card).filter((value) => typeof value === 'number').every(Number.isFinite)).toBe(true);
          expect(Math.abs(card.y)).toBeLessThanOrEqual(24);
          expect(Math.abs(card.z)).toBeLessThanOrEqual(40);
          expect(card.left).toBeGreaterThanOrEqual(0);
          expect(card.left + card.width).toBeLessThanOrEqual(layout.trackWidth);
          const radians = Math.abs(card.rotateZ) * Math.PI / 180;
          const halfWidth = (card.width / 2 * Math.cos(radians) + card.height * 0.58 * Math.sin(radians)) * card.scale;
          const centerX = card.left + card.width / 2;
          const originY = card.top + card.height * 0.58 + card.y;
          const upperHeight = (card.height * 0.58 * Math.cos(radians) + card.width / 2 * Math.sin(radians)) * card.scale;
          const lowerHeight = (card.height * 0.42 * Math.cos(radians) + card.width / 2 * Math.sin(radians)) * card.scale;
          expect(centerX - halfWidth).toBeGreaterThanOrEqual(0);
          expect(centerX + halfWidth).toBeLessThanOrEqual(layout.trackWidth);
          expect(originY - upperHeight).toBeGreaterThanOrEqual(0);
          expect(originY + lowerHeight).toBeLessThanOrEqual(layout.trackHeight);
        }
      }
    }
  });

  it.each([1, 2, 3, 9, 100])('fits the selected detail and preserves all %i card indexes in an ordered rail', (count) => {
    for (const viewport of deskViewports) {
      for (const activeIndex of [0, Math.floor(count / 2), count - 1]) {
        const layout = getMaterialDeckLayout({ count, activeIndex, appearance: 'desk', ...viewport });
        const active = layout.cards[activeIndex]!;
        const rail = layout.cards.filter((card) => card.mode === 'rail');
        expect(layout.cards.filter((card) => card.mode === 'active')).toEqual([active]);
        expect(active.left + active.width).toBeLessThanOrEqual(viewport.viewportWidth);
        expect(active.top).toBeGreaterThanOrEqual(0);
        expect(active.top + active.height).toBeLessThanOrEqual(viewport.viewportHeight);
        expect(active).toMatchObject({ rotateY: 0, rotateZ: 0, scale: 1 });
        expect(rail.map((card) => card.index)).toEqual(
          Array.from({ length: count }, (_, index) => index).filter((index) => index !== activeIndex)
        );
        expect(rail.map((card) => card.railRank)).toEqual(
          Array.from({ length: count - 1 }, (_, index) => index)
        );
        for (const card of rail) {
          expect(card.left).toBeGreaterThanOrEqual(active.left + active.width);
          expect(card.left + card.width).toBeLessThanOrEqual(layout.trackWidth);
          expect(card.top + card.y).toBeGreaterThanOrEqual(0);
          expect(card.top + card.y + card.height).toBeLessThanOrEqual(layout.trackHeight);
          expect(Math.abs(card.y)).toBeLessThanOrEqual(12);
          expect(Math.abs(card.z)).toBeLessThanOrEqual(16);
        }
      }
    }
  });

  it('retains empty and invalid input handling for the optional appearance', () => {
    const empty = getMaterialDeckLayout({ count: 0, appearance: 'desk', viewportWidth: 270, viewportHeight: 360 });
    expect(empty.cards).toEqual([]);
    const input = { count: 3, appearance: 'desk' as const, viewportWidth: 700, viewportHeight: 460 };
    expect(getMaterialDeckLayout({ ...input, activeIndex: 3, liftedIndex: -1 })).toEqual(getMaterialDeckLayout(input));
    const invalidViewport = getMaterialDeckLayout({ count: 1, appearance: 'desk', viewportWidth: Number.NaN, viewportHeight: Number.POSITIVE_INFINITY });
    expect(Object.values(invalidViewport).filter((value) => typeof value === 'number').every(Number.isFinite)).toBe(true);
  });
});
