import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { DashboardPage } from '../../src/client/pages/DashboardPage.js';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { ConsoleRuntime } from '../../src/client/app/ConsoleRuntime.js';
import type { ExtractionQueueItem, ExtractionQueueQuery } from '../../src/shared/api/extraction-queue.js';
import type { MaterialDeckCard } from '../../src/client/components/material-deck/materialDeckLayout.js';

let runtime: ConsoleRuntime;
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));
vi.mock('../../src/client/components/material-deck/MaterialDeck.js', () => ({ MaterialDeck: ({ cards, onPrimaryAction }: { cards: MaterialDeckCard[]; onPrimaryAction(card: MaterialDeckCard): void }) => <div>{cards.length ? cards.map(card => <button key={card.path} onClick={() => onPrimaryAction(card)}>{card.title}:{card.nextAction}</button>) : <p>暂无待提炼材料</p>}</div> }));
afterEach(cleanup);
const ok = <T,>(value: T) => ({ ok: true as const, value });
const sha = 'a'.repeat(64);
function fixture(options: { modern?: boolean; modelConfigured?: boolean; empty?: boolean } = {}) {
  const modern = options.modern ?? true;
  const items: ExtractionQueueItem[] = options.empty ? [] : (['pending', 'generating', 'ready', 'unfinished'] as const).map((view, i) => ({
    materialPath: `01图书馆/${view}.md`, title: view, view, canExtract: view !== 'generating', sourceRawSha256: sha,
    ...(view === 'generating' ? { activeRun: { id: `run-${i}`, status: 'generating' as const, sourceRawSha256: sha, createdAt: '2026-09-10T00:00:00Z' } } : {}),
    ...(view === 'ready' ? { reviewComplete: false, latestReadyRun: { id: `run-${i}`, status: 'ready' as const, sourceRawSha256: sha, createdAt: '2026-09-10T00:00:00Z', candidateCount: 2 } } : {}),
    ...(view === 'unfinished' ? { latestRun: { id: `run-${i}`, status: 'failed' as const, sourceRawSha256: sha, createdAt: '2026-09-10T00:00:00Z' } } : {})
  }));
  const counts = options.empty
    ? { pending: 0, generating: 0, ready: 0, unfinished: 0 }
    : { pending: 1, generating: 1, ready: 3, unfinished: 1 };
  const list = vi.fn(async (query: ExtractionQueueQuery) => ok({ counts, items: query.visibility === 'removed' || query.reviewState === 'complete' ? [] : items.filter(item => item.view === query.view) }));
  const health = { status: 'ready' as const, vaultSource: { status: 'ready' as const, adapter: 'filesystem' as const, displayName: 'Test' }, index: { status: 'ready' as const, version: 1, refreshedAt: '2026-09-10T00:00:00Z' }, model: options.modelConfigured ? { status: 'configured' as const, providerHost: 'test.invalid', name: 'test-model' } : { status: 'unconfigured' as const, providerHost: 'test.invalid' }, writeGate: { status: 'blocked' as const, missing: [], fingerprintMatches: true }, schemaIssues: { status: 'available' as const, count: 0 } };
  const api = { getHealth: vi.fn(async () => ok(health)), listMaterials: vi.fn(async () => ok({ items: items.map(item => ({ path: item.materialPath, title: item.title, rawSha256: sha, knowledgeStatus: '未提炼', processingStatus: '已归档', sourcePlatform: '个人', generatedKnowledge: [] })) })), listKnowledge: vi.fn(async () => ok({ items: [] })), listOperations: vi.fn(async () => ok({ items: [] })), extraction: {}, intake: {},
    ...(modern ? { extractionQueue: { list } } : {}) } as unknown as ReadConsoleApi;
  runtime = { api, health: { status: 'ready', data: health }, refreshHealth: vi.fn(), dataRevision: 0 };
  return { api, list, items, counts, health };
}
function Location() { const location = useLocation(); return <output aria-label="location">{location.pathname}{location.search}</output>; }
function show() { render(<MemoryRouter><DashboardPage /><Location /></MemoryRouter>); }

it('keeps material actions available without a duplicate continue-work section', async () => {
  const f = fixture(); const user = userEvent.setup(); show();
  expect(await screen.findByTestId('metric-materials')).toHaveTextContent('4');
  expect(screen.queryByRole('navigation', { name: '继续工作' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: '提炼队列' })).toHaveAttribute('href', '/queue');
  expect(screen.getByRole('link', { name: /开始提炼前需要配置 DeepSeek 密钥/u })).toHaveAttribute('href', '/settings');
  expect(screen.getByRole('heading', { name: /待处理资料/u })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'ready:resume' }));
  expect(screen.getByLabelText('location')).toHaveTextContent('/queue?view=ready&materialPath=01');
  expect(screen.getByLabelText('location')).toHaveTextContent('run=run-2');
  await user.click(screen.getByRole('button', { name: 'generating:progress' }));
  expect(screen.getByLabelText('location')).toHaveTextContent('view=generating');
  expect(screen.getByLabelText('location')).toHaveTextContent('run=run-1');
  await user.click(screen.getByRole('button', { name: 'unfinished:recover' }));
  expect(screen.getByLabelText('location')).toHaveTextContent('view=unfinished');
  expect(screen.getByLabelText('location')).toHaveTextContent('run=run-3');
  expect(f.list).toHaveBeenCalledWith(expect.objectContaining({ view: 'ready', reviewState: 'pending' }), expect.any(AbortSignal));
});

it('only surfaces the model setup prompt when pending work still needs it', async () => {
  fixture({ modelConfigured: true }); show();
  await screen.findByTestId('metric-materials');
  expect(screen.queryByRole('link', { name: /开始提炼前需要配置 DeepSeek 密钥/u })).not.toBeInTheDocument();

  cleanup();
  fixture({ empty: true }); show();
  await screen.findByTestId('metric-materials');
  expect(screen.queryByRole('link', { name: /开始提炼前需要配置 DeepSeek 密钥/u })).not.toBeInTheDocument();
});

it('gives an empty first-run desk a direct route to bring in new material', async () => {
  fixture({ empty: true }); show();
  await screen.findByText('暂无待提炼材料');
  expect(screen.getByRole('link', { name: '去收件箱整理新收件' })).toHaveAttribute('href', '/intake');
});

it('retains the material-list dashboard on adapters without queue capabilities', async () => {
  fixture({ modern: false }); show();
  expect(await screen.findByTestId('metric-materials')).toHaveTextContent('4');
  expect(screen.getByRole('button', { name: 'ready:start' })).toBeVisible();
  expect(screen.queryByRole('navigation', { name: '继续工作' })).not.toBeInTheDocument();
});

it('does not publish material actions assembled from changing queue snapshots', async () => {
  const f = fixture();
  f.list.mockImplementation(async query => ok({ items: [], counts: { ...f.counts, pending: query.view === 'generating' ? 2 : 1 } }));
  show();
  await waitFor(() => expect(f.list.mock.calls.filter(([query]) => query.view === 'generating' && query.visibility !== 'removed')).toHaveLength(2));
  expect(screen.queryByTestId('metric-materials')).not.toBeInTheDocument();
  expect(await screen.findByText('任务阶段仍在变化，等待稳定快照')).toBeVisible();
});
