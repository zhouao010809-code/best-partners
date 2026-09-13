import { createRoot } from 'react-dom/client';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { QueuePage } from '../../../src/client/pages/QueuePage.js';
import type { ExtractionQueueItem, ExtractionQueueQuery } from '../../../src/shared/api/extraction-queue.js';
import type { ExtractionRun } from '../../../src/shared/api/extraction.js';
import '../../../src/client/styles/tokens.css';
import '../../../src/client/styles/global.css';
import '../../../src/client/styles/shell.css';
import '../../../src/client/styles/extraction.css';
import '../../../src/client/styles/queue-workspace.css';
import '../../../src/client/styles/ingestion.css';

const materialPath = '01图书馆/来自个人/建立自己的阅读与知识系统.md';
const running = new URLSearchParams(window.location.search).has('running');
const run: ExtractionRun = { id: 'e52917bc-a9df-482f-aae8-8c4b6da4301d', materialPath, title: '建立自己的阅读与知识系统', status: 'generating', readingState: '未看', sourceRawSha256: 'a'.repeat(64), ruleFingerprint: 'b'.repeat(64), model: 'deepseek-v4-flash', createdAt: '2026-09-07T00:00:00Z' };
let item: ExtractionQueueItem = { materialPath, title: run.title, sourcePlatform: '个人', collectedAt: '2026-09-07', sourceRawSha256: run.sourceRawSha256,
  view: running ? 'generating' : 'pending', canExtract: !running, ...(running ? { activeRun: run, latestRun: run } : {}) };
const ok = <T,>(value: T) => ({ ok: true as const, value: structuredClone(value) });
const api = {
  extractionQueue: {
    list: async (query: ExtractionQueueQuery) => {
      const visible = query.visibility === 'removed' ? Boolean(item.removedAt) : !item.removedAt;
      return ok({ items: visible && query.view === item.view ? [item] : [], counts: { pending: 0, generating: 0, ready: 0, unfinished: 0, ...(visible ? { [item.view]: 1 } : {}) } });
    },
    get: async () => ok({ item }), history: async () => ok({ items: running ? [run] : [] }),
    setVisibility: async (_path: string, removed: boolean) => {
      if (item.activeRun) return { ok: false as const, state: { status: 'conflict', message: '请先停止本次提炼。' } };
      const { removedAt: _removedAt, ...source } = item;
      item = { ...source, canExtract: !removed, ...(removed ? { removedAt: '2026-09-07T09:30:00Z' } : {}) };
      return ok({ item });
    }
  },
  getDocumentDetail: async () => ok({ path: materialPath, title: item.title, markdown: '# 建立自己的阅读与知识系统\n\n阅读资料时，先记录自己想解决的问题，再判断哪些信息值得长期保留。\n\n## 保留证据，允许重新安排\n\n暂时不处理的资料可以移出队列。原始材料、提炼候选和历史记录会继续保留，需要时再重新加入。\n\n知识的价值来自后续可以重复调用，而不只是收集数量。', versionMarker: { rawSha256: run.sourceRawSha256 } }),
  extraction: { get: async () => ok(run), list: async () => ok({ items: running ? [run] : [] }), cancel: async () => { run.status = 'cancelled'; item = { ...item, view: 'unfinished', activeRun: undefined, latestRun: { ...run }, canExtract: true }; return ok(run); } },
  deepSeek: { get: async () => ok({ configured: true, available: true, providerHost: 'api.deepseek.com', model: 'deepseek-v4-flash' }) }
};
const root = document.getElementById('root'); if (!root) throw new Error('Missing fixture root');
createRoot(root).render(<MemoryRouter initialEntries={[`/queue?view=${item.view}`]}><Routes><Route element={<main style={{ maxWidth: 1400, padding: 16, margin: '0 auto' }}><Outlet context={{ api, health: { status: 'ready', data: { index: { status: 'ready' }, vaultSource: { status: 'ready', adapter: 'filesystem' } } }, dataRevision: 0, refreshHealth: async () => {} }} /></main>}><Route path="/queue" element={<QueuePage />} /></Route></Routes></MemoryRouter>);
