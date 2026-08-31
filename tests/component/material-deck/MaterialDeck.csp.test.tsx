// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { cleanup, render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaterialDeck } from '../../../src/client/components/material-deck/MaterialDeck.js';
import {
  getMaterialDeckLayout,
  type MaterialDeckCard
} from '../../../src/client/components/material-deck/materialDeckLayout.js';
import { buildScopedDeckCss } from '../../../src/client/components/material-deck/useDeckStyleSheet.js';

const nonce = 'Task5_Nonce-Value';

function makeCard(index: number, marker = ''): MaterialDeckCard {
  return {
    key: `key-${index}${marker}`,
    path: `01图书馆/${marker}材料-${index}.md`,
    title: `${marker}材料 ${index}`,
    sourcePlatform: `${marker}B站`,
    collectedAt: '2026-08-31',
    knowledgeStatus: index % 2 === 0 ? '部分入库' : '未提炼',
    nextAction: index % 2 === 0 ? 'resume' : 'start'
  };
}

function dynamicStyles(): HTMLStyleElement[] {
  return Array.from(
    document.head.querySelectorAll<HTMLStyleElement>('style[data-material-deck-style]')
  );
}

describe('MaterialDeck CSP isolation', () => {
  let nonceMeta: HTMLMetaElement;

  beforeEach(() => {
    nonceMeta = document.createElement('meta');
    nonceMeta.name = 'csp-nonce';
    nonceMeta.content = nonce;
    document.head.append(nonceMeta);
  });

  afterEach(() => {
    cleanup();
    nonceMeta.remove();
    for (const element of dynamicStyles()) element.remove();
    vi.restoreAllMocks();
  });

  it('fails explicitly instead of falling back to inline geometry when the nonce is absent', () => {
    nonceMeta.remove();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(
      <MaterialDeck cards={[makeCard(1)]} onPrimaryAction={vi.fn()} />
    )).toThrowError('MISSING_CSP_NONCE');
    expect(dynamicStyles()).toHaveLength(0);
  });

  it('gives two instances distinct alphanumeric selectors and completely local state', async () => {
    const user = userEvent.setup();
    const cards = [makeCard(1), makeCard(2), makeCard(3)];
    const { container } = render(
      <StrictMode>
        <div data-testid="first-deck">
          <MaterialDeck cards={cards} onPrimaryAction={vi.fn()} />
        </div>
        <div data-testid="second-deck">
          <MaterialDeck cards={cards} onPrimaryAction={vi.fn()} />
        </div>
      </StrictMode>
    );
    const hosts = Array.from(container.querySelectorAll<HTMLElement>('[data-testid$="-deck"]'));
    const roots = hosts.map((host) => host.querySelector<HTMLElement>('[data-deck-instance]')!);
    const instanceIds = roots.map((root) => root.dataset.deckInstance!);

    expect(instanceIds).toHaveLength(2);
    expect(instanceIds[0]).toMatch(/^[A-Za-z0-9]+$/u);
    expect(instanceIds[1]).toMatch(/^[A-Za-z0-9]+$/u);
    expect(instanceIds[0]).not.toBe(instanceIds[1]);

    const styles = dynamicStyles();
    expect(styles).toHaveLength(2);
    for (const [index, element] of styles.entries()) {
      const instanceId = instanceIds[index]!;
      expect(element.nonce).toBe(nonce);
      expect(element.dataset.materialDeckStyle).toBe(instanceId);
      expect(element.textContent).toContain(`[data-deck-instance="${instanceId}"]`);
      expect(element.textContent).not.toContain(
        `[data-deck-instance="${instanceIds[index === 0 ? 1 : 0]}"]`
      );
    }

    const firstTriggers = within(hosts[0]!).getAllByRole('button', { name: /材料 \d/u });
    const secondTriggers = within(hosts[1]!).getAllByRole('button', { name: /材料 \d/u });
    expect(firstTriggers.filter((element) => element.tabIndex === 0)).toEqual([firstTriggers[0]]);
    expect(secondTriggers.filter((element) => element.tabIndex === 0)).toEqual([secondTriggers[0]]);

    firstTriggers[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(firstTriggers[1]).toHaveFocus();
    expect(firstTriggers.filter((element) => element.tabIndex === 0)).toEqual([firstTriggers[1]]);
    expect(secondTriggers.filter((element) => element.tabIndex === 0)).toEqual([secondTriggers[0]]);

    await user.keyboard('{Enter}');
    expect(within(hosts[0]!).getByRole('dialog', { name: '材料 2 详情' })).toBeInTheDocument();
    expect(within(hosts[1]!).queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps user-controlled card strings out of generated CSS', () => {
    const marker = 'CssBreakoutBodyDisplayNone';
    render(
      <MaterialDeck
        cards={[makeCard(1, `${marker}\"}body{display:none}/*`)]}
        onPrimaryAction={vi.fn()}
      />
    );

    expect(dynamicStyles()).toHaveLength(1);
    expect(dynamicStyles()[0]!.textContent).not.toContain(marker);
    expect(dynamicStyles()[0]!.textContent).toMatch(/\[data-card-index="0"\]/u);
  });

  it('rejects unsafe instance ids, non-finite geometry, and non-numeric indexes', () => {
    const layout = getMaterialDeckLayout({
      count: 1,
      viewportWidth: 820,
      viewportHeight: 590
    });

    expect(() => buildScopedDeckCss('Unsafe-id', layout)).toThrowError(
      'INVALID_DECK_INSTANCE'
    );
    expect(() => buildScopedDeckCss('Safe123', {
      ...layout,
      trackWidth: Number.NaN
    })).toThrowError('NON_FINITE_DECK_LAYOUT');
    expect(() => buildScopedDeckCss('Safe123', {
      ...layout,
      cards: [{ ...layout.cards[0]!, index: 0.5 }]
    })).toThrowError('INVALID_DECK_CARD_INDEX');
  });

  it('uses no style attribute or DOM id in either instance', () => {
    const { container } = render(
      <>
        <MaterialDeck cards={[makeCard(1)]} onPrimaryAction={vi.fn()} />
        <MaterialDeck cards={[makeCard(1)]} onPrimaryAction={vi.fn()} />
      </>
    );

    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    expect(container.querySelectorAll('[id]')).toHaveLength(0);
    expect(container.querySelectorAll('#production-deck-title')).toHaveLength(0);
    expect(container.querySelectorAll('#production-card-detail')).toHaveLength(0);
  });

  it('updates one stable style element and removes it on unmount', () => {
    const { rerender, unmount } = render(
      <MaterialDeck cards={[makeCard(1)]} onPrimaryAction={vi.fn()} />
    );
    expect(dynamicStyles()).toHaveLength(1);
    const before = dynamicStyles()[0]!;
    const beforeText = before.textContent;

    rerender(
      <MaterialDeck
        cards={[makeCard(1), makeCard(2), makeCard(3)]}
        onPrimaryAction={vi.fn()}
      />
    );
    expect(dynamicStyles()).toHaveLength(1);
    expect(dynamicStyles()[0]).toBe(before);
    expect(dynamicStyles()[0]!.textContent).not.toBe(beforeText);

    unmount();
    expect(dynamicStyles()).toHaveLength(0);
  });
});
