// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaterialDeck } from '../../../src/client/components/material-deck/MaterialDeck.js';
import type { MaterialDeckCard } from '../../../src/client/components/material-deck/materialDeckLayout.js';

function makeCard(
  index: number,
  overrides: Partial<MaterialDeckCard> = {}
): MaterialDeckCard {
  return {
    key: `material-${index}`,
    path: `01图书馆/材料-${index}.md`,
    title: `材料 ${index}`,
    sourcePlatform: index % 2 === 0 ? 'YouTube' : 'B站',
    collectedAt: `2026-08-${String(index).padStart(2, '0')}`,
    knowledgeStatus: index % 2 === 0 ? '部分入库' : '未提炼',
    nextAction: index % 2 === 0 ? 'resume' : 'start',
    ...overrides
  };
}

function cardTriggers(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-material-card-trigger]')
  );
}

describe('MaterialDeck interactions', () => {
  let nonceMeta: HTMLMetaElement;

  beforeEach(() => {
    nonceMeta = document.createElement('meta');
    nonceMeta.name = 'csp-nonce';
    nonceMeta.content = 'Task5NonceValue';
    document.head.append(nonceMeta);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    nonceMeta.remove();
    vi.restoreAllMocks();
  });

  it('keeps the showcase caption in sync with hover, selection and removed cards', () => {
    const cards = [makeCard(1), makeCard(2)];
    const { container, rerender } = render(<MaterialDeck appearance="showcase" cards={cards} onPrimaryAction={vi.fn()} />);
    const caption = screen.getByRole('region', { name: '当前资料' });
    expect(caption).toHaveTextContent('材料 1');
    const triggers = cardTriggers(container);
    fireEvent.mouseEnter(triggers[1]!);
    expect(caption).toHaveTextContent('材料 2');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(triggers[0]!);
    fireEvent.mouseEnter(triggers[1]!);
    expect(caption).toHaveTextContent('材料 1');
    rerender(<MaterialDeck appearance="showcase" cards={[cards[1]!]} onPrimaryAction={vi.fn()} />);
    expect(caption).toHaveTextContent('材料 2');
    rerender(<MaterialDeck appearance="showcase" cards={[]} onPrimaryAction={vi.fn()} />);
    expect(caption).toHaveTextContent('暂无待提炼资料');
    expect(caption).not.toHaveTextContent('材料 2');
  });

  it('renders ordered silver-card summaries with persistent textual status badges', () => {
    const cards = [makeCard(1), makeCard(2), makeCard(3)];
    const { container } = render(
      <MaterialDeck cards={cards} onPrimaryAction={vi.fn()} />
    );

    expect(screen.getByRole('region', { name: '待提炼材料牌堆' })).toBeInTheDocument();
    expect(cardTriggers(container).map((trigger) => trigger.textContent)).toEqual([
      expect.stringContaining('材料 1'),
      expect.stringContaining('材料 2'),
      expect.stringContaining('材料 3')
    ]);
    expect(screen.getAllByText('未提炼')).toHaveLength(2);
    expect(screen.getAllByText('部分入库')).toHaveLength(1);
    expect(container.querySelectorAll('[data-card-mode="collapsed"]')).toHaveLength(3);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opts into desk geometry while retaining keyboard selection and the exact primary card', async () => {
    const user = userEvent.setup();
    const cards = [makeCard(1), makeCard(2)];
    const onPrimaryAction = vi.fn();
    const { container, rerender } = render(
      <MaterialDeck cards={cards} onPrimaryAction={onPrimaryAction} />
    );
    const region = screen.getByRole('region', { name: '待提炼材料牌堆' });
    expect(region).toHaveAttribute('data-deck-appearance', 'default');
    const style = document.head.querySelector('style[data-material-deck-style]')!;
    const defaultGeometry = style.textContent;

    rerender(<MaterialDeck appearance="desk" cards={cards} onPrimaryAction={onPrimaryAction} />);

    expect(region).toHaveAttribute('data-deck-appearance', 'desk');
    expect(style.textContent).not.toBe(defaultGeometry);
    const triggers = cardTriggers(container);
    triggers[0]!.focus();
    await user.keyboard('{ArrowRight}{Enter}');
    const detail = screen.getByRole('dialog', { name: '材料 2 详情' });
    expect(onPrimaryAction).not.toHaveBeenCalled();
    await user.click(within(detail).getByRole('button', { name: '继续审阅' }));
    expect(onPrimaryAction).toHaveBeenCalledExactlyOnceWith(cards[1]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(triggers[1]).toHaveFocus();
  });

  it('fails closed before duplicate keys can create two tab stops or dialogs', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cards = [
      makeCard(1),
      makeCard(2, { key: 'material-1' })
    ];
    let thrown: unknown;
    let rendered: ReturnType<typeof render> | undefined;

    try {
      rendered = render(<MaterialDeck cards={cards} onPrimaryAction={vi.fn()} />);
    } catch (error) {
      thrown = error;
    }

    const host = rendered?.container ?? document.body;
    const initialTabStops = host.querySelectorAll(
      '[data-material-card-trigger][tabindex="0"]'
    ).length;
    const firstTrigger = host.querySelector<HTMLButtonElement>('[data-material-card-trigger]');
    if (firstTrigger) fireEvent.click(firstTrigger);

    expect.soft(thrown).toBeInstanceOf(Error);
    expect.soft((thrown as Error | undefined)?.message).toBe(
      'DUPLICATE_MATERIAL_DECK_KEY'
    );
    expect.soft(initialTabStops).toBe(0);
    expect.soft(host.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  });

  it('uses one local roving tab stop and clamps arrow navigation at both edges', async () => {
    const user = userEvent.setup();
    const cards = Array.from({ length: 100 }, (_, index) => makeCard(index + 1));
    const { container } = render(
      <MaterialDeck cards={cards} onPrimaryAction={vi.fn()} />
    );
    const triggers = cardTriggers(container);

    expect(triggers.filter((trigger) => trigger.tabIndex === 0)).toEqual([triggers[0]]);
    triggers[0]!.focus();
    await user.keyboard('{ArrowLeft}');
    expect(triggers[0]).toHaveFocus();

    for (let index = 1; index < triggers.length; index += 1) {
      await user.keyboard('{ArrowRight}');
    }
    expect(triggers[99]).toHaveFocus();
    expect(triggers.filter((trigger) => trigger.tabIndex === 0)).toEqual([triggers[99]]);
    await user.keyboard('{ArrowRight}');
    expect(triggers[99]).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(triggers[98]).toHaveFocus();
  });

  it('lets hover and focus lift a card without opening it or invoking an action', () => {
    const onPrimaryAction = vi.fn();
    const { container } = render(
      <MaterialDeck cards={[makeCard(1), makeCard(2)]} onPrimaryAction={onPrimaryAction} />
    );
    const first = cardTriggers(container)[0]!;
    const wrapper = first.closest('[data-card-index]');

    fireEvent.mouseEnter(first);
    expect(wrapper).toHaveAttribute('data-card-lifted', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onPrimaryAction).not.toHaveBeenCalled();
    fireEvent.mouseLeave(first);
    expect(wrapper).not.toHaveAttribute('data-card-lifted');

    fireEvent.focus(first);
    expect(wrapper).toHaveAttribute('data-card-lifted', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onPrimaryAction).not.toHaveBeenCalled();
  });

  it.each([
    ['click', 'start', '开始提炼'],
    ['click', 'resume', '继续审阅'],
    ['click', 'progress', '查看进度'],
    ['click', 'recover', '恢复提炼']
  ] as const)('opens by %s and exposes the %s action as %s', async (_, nextAction, label) => {
    const user = userEvent.setup();
    const card = makeCard(1, { nextAction });
    const onPrimaryAction = vi.fn();
    render(<MaterialDeck cards={[card]} onPrimaryAction={onPrimaryAction} />);

    await user.click(screen.getByRole('button', { name: /材料 1/u }));
    const detail = screen.getByRole('dialog', { name: '材料 1 详情' });
    expect(detail).toHaveAttribute('data-material-detail-mode', 'selected');
    expect(within(detail).getByRole('heading', { name: '材料 1' })).toHaveFocus();
    expect(onPrimaryAction).not.toHaveBeenCalled();

    await user.click(within(detail).getByRole('button', { name: label }));
    expect(onPrimaryAction).toHaveBeenCalledTimes(1);
    expect(onPrimaryAction).toHaveBeenCalledWith(card);
  });

  it('uses a neutral div as the dialog role host', async () => {
    const user = userEvent.setup();
    render(<MaterialDeck cards={[makeCard(1)]} onPrimaryAction={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /材料 1/u }));

    expect(screen.getByRole('dialog', { name: '材料 1 详情' }).tagName).toBe('DIV');
  });

  it('keeps the primary action visibly unavailable when the host supplies a reason', async () => {
    const user = userEvent.setup();
    const onPrimaryAction = vi.fn();
    render(
      <MaterialDeck
        cards={[makeCard(1)]}
        primaryActionDisabledReason="提炼工作流将在 Phase 2 启用"
        onPrimaryAction={onPrimaryAction}
      />
    );

    await user.click(screen.getByRole('button', { name: /材料 1/u }));
    expect(screen.getByRole('button', { name: '开始提炼' })).toBeDisabled();
    expect(screen.getByText('提炼工作流将在 Phase 2 启用')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '开始提炼' }));
    expect(onPrimaryAction).not.toHaveBeenCalled();
  });

  it.each([
    ['Enter', '{Enter}'],
    ['Space', '[Space]']
  ])('opens with %s and closes with Escape while restoring focus and local scroll', async (_, key) => {
    const user = userEvent.setup();
    const { container } = render(
      <MaterialDeck cards={[makeCard(1), makeCard(2)]} onPrimaryAction={vi.fn()} />
    );
    const viewport = container.querySelector<HTMLElement>('[data-material-deck-viewport]')!;
    const first = cardTriggers(container)[0]!;
    viewport.scrollLeft = 137;
    first.focus();

    await user.keyboard(key);
    expect(screen.getByRole('dialog', { name: '材料 1 详情' })).toBeInTheDocument();
    expect(viewport.scrollLeft).toBe(0);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(first).toHaveFocus();
    expect(viewport.scrollLeft).toBe(137);
  });

  it('offers a visible close control with the same focus and scroll restoration', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MaterialDeck cards={[makeCard(1)]} onPrimaryAction={vi.fn()} />
    );
    const viewport = container.querySelector<HTMLElement>('[data-material-deck-viewport]')!;
    const first = cardTriggers(container)[0]!;
    viewport.scrollLeft = 71;
    await user.click(first);

    await user.click(screen.getByRole('button', { name: '关闭材料详情' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(first).toHaveFocus();
    expect(viewport.scrollLeft).toBe(71);
  });

  it('focuses the first surviving card when the selected card is removed', async () => {
    const user = userEvent.setup();
    const first = makeCard(1);
    const selected = makeCard(2);
    const third = makeCard(3);
    const { container, rerender } = render(
      <MaterialDeck cards={[first, selected, third]} onPrimaryAction={vi.fn()} />
    );
    await user.click(cardTriggers(container)[1]!);
    expect(screen.getByRole('dialog', { name: '材料 2 详情' })).toBeInTheDocument();

    rerender(<MaterialDeck cards={[first, third]} onPrimaryAction={vi.fn()} />);

    const survivors = cardTriggers(container);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(survivors.filter((trigger) => trigger.tabIndex === 0)).toEqual([survivors[0]]);
    expect(survivors[0]).toHaveFocus();
  });

  it('focuses the programmable deck region when the selected card removal empties it', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(
      <MaterialDeck cards={[makeCard(1)]} onPrimaryAction={vi.fn()} />
    );
    await user.click(cardTriggers(container)[0]!);
    expect(screen.getByRole('dialog', { name: '材料 1 详情' })).toBeInTheDocument();

    rerender(<MaterialDeck cards={[]} onPrimaryAction={vi.fn()} />);

    const region = screen.getByRole('region', { name: '待提炼材料牌堆' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(cardTriggers(container)).toHaveLength(0);
    expect(region).toHaveAttribute('tabindex', '-1');
    expect(region).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('previews at 220ms without controls, focus movement, or business action', () => {
    vi.useFakeTimers();
    const onPrimaryAction = vi.fn();
    const { container } = render(
      <MaterialDeck cards={[makeCard(1)]} onPrimaryAction={onPrimaryAction} />
    );
    const first = cardTriggers(container)[0]!;
    first.focus();

    fireEvent.pointerDown(first, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10
    });
    act(() => vi.advanceTimersByTime(219));
    expect(container.querySelector('[data-material-detail-mode="preview"]')).toBeNull();
    act(() => vi.advanceTimersByTime(1));

    const preview = container.querySelector<HTMLElement>(
      '[data-material-detail-mode="preview"]'
    )!;
    expect(preview).toBeInTheDocument();
    expect(within(preview).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(first).toHaveFocus();
    expect(onPrimaryAction).not.toHaveBeenCalled();

    fireEvent.pointerUp(first, { pointerId: 1 });
    expect(container.querySelector('[data-material-detail-mode="preview"]')).toBeNull();
    fireEvent.click(first);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(first);
    expect(screen.getByRole('dialog', { name: '材料 1 详情' })).toBeInTheDocument();
  });

  it.each(['pointerCancel', 'lostPointerCapture'] as const)(
    'clears a long-press preview on %s',
    (eventName) => {
      vi.useFakeTimers();
      const { container } = render(
        <MaterialDeck cards={[makeCard(1)]} onPrimaryAction={vi.fn()} />
      );
      const first = cardTriggers(container)[0]!;

      fireEvent.pointerDown(first, {
        pointerId: 2,
        isPrimary: true,
        button: 0,
        clientX: 10,
        clientY: 10
      });
      act(() => vi.advanceTimersByTime(220));
      expect(container.querySelector('[data-material-detail-mode="preview"]')).toBeInTheDocument();
      fireEvent[eventName](first, { pointerId: 2 });
      expect(container.querySelector('[data-material-detail-mode="preview"]')).toBeNull();
    }
  );

  it('cancels before preview and suppresses its immediate synthetic click after moving more than 12px', () => {
    vi.useFakeTimers();
    const { container } = render(
      <MaterialDeck cards={[makeCard(1)]} onPrimaryAction={vi.fn()} />
    );
    const first = cardTriggers(container)[0]!;
    fireEvent.pointerDown(first, {
      pointerId: 3,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10
    });
    fireEvent.pointerMove(first, { pointerId: 3, clientX: 23, clientY: 10 });
    act(() => vi.advanceTimersByTime(220));
    expect(container.querySelector('[data-material-detail-mode="preview"]')).toBeNull();
    fireEvent.pointerUp(first, { pointerId: 3 });
    fireEvent.click(first);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('expires cancelled-gesture click suppression before the next intentional click', () => {
    vi.useFakeTimers();
    const { container } = render(
      <MaterialDeck cards={[makeCard(1)]} onPrimaryAction={vi.fn()} />
    );
    const first = cardTriggers(container)[0]!;
    fireEvent.pointerDown(first, {
      pointerId: 9,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10
    });
    fireEvent.pointerMove(first, { pointerId: 9, clientX: 23, clientY: 10 });
    fireEvent.pointerUp(first, { pointerId: 9 });

    act(() => vi.advanceTimersByTime(0));
    fireEvent.click(first);
    expect(screen.getByRole('dialog', { name: '材料 1 详情' })).toBeInTheDocument();
  });

  it('still enters preview at 220ms after moving exactly 12px', () => {
    vi.useFakeTimers();
    const { container } = render(
      <MaterialDeck cards={[makeCard(1)]} onPrimaryAction={vi.fn()} />
    );
    const first = cardTriggers(container)[0]!;
    fireEvent.pointerDown(first, {
      pointerId: 8,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10
    });
    fireEvent.pointerMove(first, { pointerId: 8, clientX: 22, clientY: 10 });
    act(() => vi.advanceTimersByTime(220));

    expect(container.querySelector('[data-material-detail-mode="preview"]')).toBeInTheDocument();
    fireEvent.pointerUp(first, { pointerId: 8 });
    expect(container.querySelector('[data-material-detail-mode="preview"]')).toBeNull();
  });

  it('cancels an active preview after movement and still suppresses its synthetic click', () => {
    vi.useFakeTimers();
    const { container } = render(
      <MaterialDeck cards={[makeCard(1)]} onPrimaryAction={vi.fn()} />
    );
    const first = cardTriggers(container)[0]!;
    fireEvent.pointerDown(first, {
      pointerId: 7,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10
    });
    act(() => vi.advanceTimersByTime(220));
    expect(container.querySelector('[data-material-detail-mode="preview"]')).toBeInTheDocument();

    fireEvent.pointerMove(first, { pointerId: 7, clientX: 23, clientY: 10 });
    expect(container.querySelector('[data-material-detail-mode="preview"]')).toBeNull();
    fireEvent.pointerUp(first, { pointerId: 7 });
    fireEvent.click(first);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cleans pending and active previews when a card disappears and does not revive them', () => {
    vi.useFakeTimers();
    const card = makeCard(1);
    const { container, rerender } = render(
      <MaterialDeck cards={[card]} onPrimaryAction={vi.fn()} />
    );
    const first = cardTriggers(container)[0]!;
    fireEvent.pointerDown(first, {
      pointerId: 4,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10
    });
    rerender(<MaterialDeck cards={[]} onPrimaryAction={vi.fn()} />);
    act(() => vi.advanceTimersByTime(220));
    rerender(<MaterialDeck cards={[card]} onPrimaryAction={vi.fn()} />);
    expect(container.querySelector('[data-material-detail-mode="preview"]')).toBeNull();

    const restored = cardTriggers(container)[0]!;
    fireEvent.pointerDown(restored, {
      pointerId: 5,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10
    });
    act(() => vi.advanceTimersByTime(220));
    expect(container.querySelector('[data-material-detail-mode="preview"]')).toBeInTheDocument();
    rerender(<MaterialDeck cards={[]} onPrimaryAction={vi.fn()} />);
    rerender(<MaterialDeck cards={[card]} onPrimaryAction={vi.fn()} />);
    expect(container.querySelector('[data-material-detail-mode="preview"]')).toBeNull();
  });

  it('clears a pending long-press timer on unmount', () => {
    vi.useFakeTimers();
    const { container, unmount } = render(
      <MaterialDeck cards={[makeCard(1)]} onPrimaryAction={vi.fn()} />
    );
    const first = cardTriggers(container)[0]!;

    fireEvent.pointerDown(first, {
      pointerId: 6,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10
    });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
