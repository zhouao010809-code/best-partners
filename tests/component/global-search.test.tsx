import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import { GlobalSearch, readRecent, rememberRecent } from '../../src/client/components/GlobalSearch.js';
import { ASSISTANT_INTENT_EVENT } from '../../src/client/components/assistant/assistantIntent.js';
const library = vi.fn(); const knowledge = vi.fn(); const close = vi.fn();
const api = { listLibrary: library, listKnowledge: knowledge } as unknown as ReadConsoleApi;
const ok = (items: {path: string; title: string}[]) => ({ok: true, value: {items}});
function setup() { render(<MemoryRouter><GlobalSearch api={api} vault="fixture" onClose={close} /></MemoryRouter>); return userEvent.setup(); }
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  library.mockResolvedValue(ok([{path: '01图书馆/创作.md', title: '创作原文'}]));
  knowledge.mockResolvedValue(ok([{path: '02知识库/创作.md', title: '创作方法'}])); sessionStorage.clear();
});
afterEach(() => { cleanup(); Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); vi.restoreAllMocks(); vi.clearAllMocks(); });
it('searches both collections immediately on Enter and lets selected knowledge become an editable AI prompt', async () => {
  const listener = vi.fn(); window.addEventListener(ASSISTANT_INTENT_EVENT, listener);
  try {
    const user = setup(); await user.type(screen.getByLabelText('搜索全部资料与知识'), '创作{Enter}');
    expect(await screen.findByText('创作原文')).toBeVisible(); expect(screen.getByText('创作方法')).toBeVisible();
    expect(library.mock.calls[0]![0]).toMatchObject({ title: '创作' }); expect(knowledge.mock.calls[0]![0]).toMatchObject({ search: '创作' });
    await user.click(screen.getByLabelText('选用知识：创作方法')); await user.click(screen.getByRole('button', {name: /用已选知识拟提纲/u}));
    expect(listener).toHaveBeenCalledTimes(1); expect(listener.mock.calls[0]![0].detail).toMatchObject({scope: 'brain', prompt: expect.stringContaining('02知识库/创作.md')}); expect(close).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener(ASSISTANT_INTENT_EVENT, listener); }
});
it('keeps successful results when one collection fails', async () => {
  library.mockRejectedValue(new Error('offline')); const user = setup();
  await user.type(screen.getByLabelText('搜索全部资料与知识'), '创作{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent('部分资料'); expect(screen.getByText('创作方法')).toBeVisible();
});
it('does not replace a newer query with a late earlier response', async () => {
  let resolveOld!: (result: ReturnType<typeof ok>) => void;
  library.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const user = setup(); const input = screen.getByLabelText('搜索全部资料与知识');
  await user.type(input, '旧{Enter}'); await waitFor(() => expect(library).toHaveBeenCalledTimes(1));
  await user.clear(input); await user.type(input, '新{Enter}'); expect(await screen.findByText('创作原文')).toBeVisible();
  await act(async () => resolveOld(ok([{path:'01图书馆/旧.md',title:'迟到的旧结果'}])));
  expect(screen.queryByText('迟到的旧结果')).not.toBeInTheDocument();
});
it('clears recent metadata without changing documents or sending a request', async () => {
  rememberRecent('fixture', {href:'/knowledge?path=02知识库%2F文章.md', title:'文章'}); const user = setup();
  expect(screen.getByRole('button', {name:'文章'})).toBeVisible(); await user.click(screen.getByRole('button', {name:'清除记录'}));
  expect(readRecent('fixture')).toEqual([]); expect(library).not.toHaveBeenCalled(); expect(knowledge).not.toHaveBeenCalled();
});
it('offers the full collection when quick results have another page, keeping the search term', async () => {
  knowledge.mockResolvedValue({ ok: true, value: { items: [{path:'02知识库/创作.md',title:'创作方法'}], nextCursor:'more' } });
  function Location() { const location = useLocation(); return <output aria-label="目标位置">{location.pathname}{location.search}</output>; }
  render(<MemoryRouter><GlobalSearch api={api} vault="fixture" onClose={close} /><Location /></MemoryRouter>);
  const user = userEvent.setup(); await user.type(screen.getByLabelText('搜索全部资料与知识'), '创作{Enter}');
  await user.click(await screen.findByRole('button', {name:'查看全部知识结果'}));
  const destination = new URL(screen.getByLabelText('目标位置').textContent!, 'http://local');
  expect(destination.pathname).toBe('/knowledge'); expect(destination.searchParams.get('search')).toBe('创作'); expect(destination.searchParams.get('scope')).toBe('all'); expect(destination.searchParams.get('layout')).toBe('compact'); expect(close).toHaveBeenCalledTimes(1);
});
