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
