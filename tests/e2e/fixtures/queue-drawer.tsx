import { createRoot } from 'react-dom/client';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import type { ExtractionQueueItem, ExtractionQueueQuery, ExtractionRunSummary } from '../../../src/shared/api/extraction-queue.js';
import type { ExtractionRun } from '../../../src/shared/api/extraction.js';
import type { IngestionReview, ReviewCandidate, SaveCandidateRequest } from '../../../src/shared/api/ingestion.js';
import '../../../src/client/styles/tokens.css';
import '../../../src/client/styles/global.css';
import '../../../src/client/styles/shell.css';
import '../../../src/client/styles/extraction.css';
import '../../../src/client/styles/queue-workspace.css';
import '../../../src/client/styles/ingestion.css';
import { QueuePage } from '../../../src/client/pages/QueuePage.js';

// Every record and operation in this fixture exists only in this browser tab.
const pendingTitles = [
  '把 AI 工具接进日常工作：从整理会议记录到复用团队知识',
  '选题不是凭感觉：从真实问题建立稳定的内容选题池',
  '如何建立自己的学习系统，让读过的内容能够再次被调用',
  '一场产品复盘的完整记录：用户反馈如何变成下一轮改进',
  '从零散收藏到长期积累：个人知识管理的三个关键环节',
  '拍摄之前先想清楚什么：短视频脚本与现场执行的衔接',
  '怎样判断一条经验能否复用：情境、证据与使用边界',
  '一次课程设计讨论：把复杂概念讲清楚而不丢掉关键细节'
];
const readyTitles = ['整理知识之前，先明确下一次会在什么场景使用', '从观察到判断：为内容选题建立可以反复核对的标准'];
const sha = 'a'.repeat(64);
const pending: ExtractionQueueItem[] = pendingTitles.map((title, index) => ({ materialPath: `01图书馆/来自个人/抽屉示例-${index + 1}.md`, title,
  view: 'pending', canExtract: true, sourcePlatform: index % 2 ? '公众号' : '个人', collectedAt: `2026-09-${String(7 - Math.floor(index / 2)).padStart(2, '0')}`, sourceRawSha256: sha }));

const candidate = (index: number): ReviewCandidate => ({ id: `candidate-${index}`, version: 1, state: 'pending', decision: 'later', target: { mode: 'new' }, draft: {
  title: index === 0 ? '用未来的使用场景筛选值得保留的知识' : '从真实问题出发建立选题判断标准', knowledgeType: '方法', suggestedPath: '02知识库/09学习/知识管理', topics: [],
  coreContent: '保留一条知识之前，先写下自己会在什么情况下再次使用它。能对应到具体判断、行动或表达的内容，才值得继续提炼。\n\n复用时应同时保留来源与适用边界，避免把特定情境中的经验当作通用结论。',
  value: '让资料整理与真实使用建立联系，减少只收藏、不调用的积累。',
  draft: { keywords: ['知识管理', '使用场景', '复用'], scenarios: ['整理阅读资料时', '为下一次工作准备知识时'], conclusion: '先识别未来使用场景，再决定知识的保留方式。',
    keyPoints: ['写清知识解决的具体问题', '保留证据和使用边界'], boundary: '适用于需要反复调用的知识，不代替原始资料的保真归档。', quotes: [], summaries: ['知识需要能在下一次行动中找到位置。'] }
} });
const readyRuns: ExtractionRun[] = readyTitles.map((title, index) => ({
  id: `e52917bc-a9df-482f-aae8-8c4b6da430${index + 1}d`, materialPath: `01图书馆/来自个人/待确认示例-${index + 1}.md`, title,
  status: 'ready', readingState: '已看', model: 'deepseek-v4-flash', createdAt: '2026-09-07T08:30:00Z', sourceRawSha256: sha, ruleFingerprint: 'b'.repeat(64),
  result: { briefing: { sentences: ['这份资料讨论知识如何服务后续行动。', '整理时先说明用途，再筛选值得保留的内容。', '复用前仍需检查情境与证据。'], keyPoints: ['明确用途', '保留依据'], usefulness: '为资料整理提供可执行的判断标准。' }, candidates: [candidate(index).draft] }
}));
const summary = (run: ExtractionRun): ExtractionRunSummary => ({ id: run.id, status: run.status, createdAt: run.createdAt, sourceRawSha256: run.sourceRawSha256,
  ...(run.status === 'ready' ? { candidateCount: run.result!.candidates.length, pendingCandidateCount: run.result!.candidates.length, reviewComplete: false } : {}) });
const ready: ExtractionQueueItem[] = readyRuns.map(run => ({ materialPath: run.materialPath, title: run.title, view: 'ready', canExtract: false,
  sourcePlatform: '个人', collectedAt: '2026-09-06', sourceRawSha256: sha, pendingCandidateCount: 1, reviewComplete: false, latestRun: summary(run), latestReadyRun: summary(run) }));
const activeRun: ExtractionRun = { id: 'e52917bc-a9df-482f-aae8-8c4b6da4303d', title: '一次团队产品复盘：让用户反馈进入下一轮工作计划',
  materialPath: '01图书馆/来自个人/提炼中示例.md', status: 'generating', readingState: '已看', model: 'deepseek-v4-flash', createdAt: '2026-09-07T09:00:00Z', sourceRawSha256: sha, ruleFingerprint: 'b'.repeat(64) };
const running: ExtractionQueueItem = { materialPath: activeRun.materialPath, title: activeRun.title, view: 'generating', canExtract: false,
  sourcePlatform: '个人', collectedAt: '2026-09-07', sourceRawSha256: sha, activeRun: summary(activeRun), latestRun: summary(activeRun) };
const materials = [...pending, running, ...ready];
const runs = [...readyRuns, activeRun];
const reviews = new Map<string, IngestionReview>(readyRuns.map((run, index) => [run.id, { runId: run.id, materialPath: run.materialPath, title: run.title,
  candidates: [candidate(index)], directories: ['02知识库/09学习/知识管理', '02知识库/02触达/公域/02编导/选题'], sourceStatus: '未提炼',
  sourceChanged: false, complete: false, relatedRuns: [], batches: [] }]));
const diagnostic = { listCalls: [] as ExtractionQueueQuery[], bodyReads: [] as string[], saves: [] as SaveCandidateRequest[], unexpectedActions: [] as string[] };
declare global { interface Window { __queueDrawerFixture: typeof diagnostic } }
window.__queueDrawerFixture = diagnostic;
const ok = <T,>(value: T) => ({ ok: true as const, value: structuredClone(value) });
const unsupported = async (name: string) => { diagnostic.unexpectedActions.push(name); return { ok: false as const, state: { status: 'unavailable' as const, message: '浏览器夹具不执行这项操作。' } }; };
const api = {
  extractionQueue: {
    list: async (query: ExtractionQueueQuery) => {
      diagnostic.listCalls.push(structuredClone(query));
      const visible = materials.filter(item => query.visibility === 'removed' ? Boolean(item.removedAt) : !item.removedAt)
        .filter(item => (!query.title || item.title.includes(query.title)) && (!query.sourcePlatform || item.sourcePlatform === query.sourcePlatform))
        .filter(item => (!query.collectedFrom || item.collectedAt! >= query.collectedFrom) && (!query.collectedTo || item.collectedAt! <= query.collectedTo));
      const selected = visible.filter(item => item.view === (query.view ?? 'pending') && (query.reviewState !== 'complete' || item.reviewComplete));
      const start = Number(query.cursor ?? 0); const limit = query.limit ?? 40;
      return ok({ items: selected.slice(start, start + limit), counts: { pending: visible.filter(item => item.view === 'pending').length,
        generating: visible.filter(item => item.view === 'generating').length, ready: visible.filter(item => item.view === 'ready').length, unfinished: 0 },
        ...(start + limit < selected.length ? { nextCursor: String(start + limit) } : {}) });
    },
    get: async (path: string) => ok({ item: materials.find(item => item.materialPath === path) ?? null }),
    history: async ({ materialPath }: { materialPath: string }) => ok({ items: runs.filter(run => run.materialPath === materialPath).map(summary) }),
    setVisibility: async () => unsupported('extractionQueue.setVisibility')
  },
  getDocumentDetail: async (path: string) => {
    diagnostic.bodyReads.push(path); const material = materials.find(item => item.materialPath === path);
    return ok({ path, title: material?.title ?? '示例资料', markdown: `# ${material?.title ?? '示例资料'}\n\n整理资料时，先写出希望解决的具体问题，再决定阅读和提炼的顺序。\n\n## 从资料走向使用\n\n知识的价值来自下次可以重复调用，而不只是收集数量。保留原始资料，能让判断始终有证据可查。\n\n## 保留适用边界\n\n任何方法都对应特定的使用情境。提炼时应说明它适合解决什么问题，以及什么时候需要重新核对。`, versionMarker: { rawSha256: sha } });
  },
  extraction: { get: async (id: string) => { const run = runs.find(run => run.id === id); return run ? ok(run) : unsupported('extraction.get:unknown'); },
    list: async (path?: string) => ok({ items: runs.filter(run => !path || run.materialPath === path) }),
    preview: async () => unsupported('extraction.preview'), start: async () => unsupported('extraction.start'), cancel: async () => unsupported('extraction.cancel') },
  ingestion: {
    review: async (id: string) => { const review = reviews.get(id); return review ? ok(review) : unsupported('ingestion.review:unknown'); },
    save: async (id: string, request: SaveCandidateRequest) => {
      const review = reviews.get(id); const index = review?.candidates.findIndex(candidate => candidate.id === request.candidateId) ?? -1;
      if (!review || index < 0) return unsupported('ingestion.save:unknown');
      diagnostic.saves.push(structuredClone(request));
      const value: ReviewCandidate = { ...review.candidates[index]!, draft: structuredClone(request.draft), target: structuredClone(request.target), decision: request.decision, version: request.version + 1 };
      review.candidates[index] = value; return ok(value);
    },
    matches: async () => ok({ items: [] }), preview: async () => unsupported('ingestion.preview'), commit: async () => unsupported('ingestion.commit'),
    batch: async () => unsupported('ingestion.batch'), resume: async () => unsupported('ingestion.resume'), recoveryPreview: async () => unsupported('ingestion.recoveryPreview'), resolve: async () => unsupported('ingestion.resolve')
  },
  deepSeek: { get: async () => ok({ configured: true, available: true, providerHost: 'api.deepseek.com', model: 'deepseek-v4-flash' }) },
  getKnowledgeDetail: async () => unsupported('getKnowledgeDetail')
};
const root = document.getElementById('root'); if (!root) throw new Error('Missing fixture root');
createRoot(root).render(<MemoryRouter initialEntries={['/queue']}><Routes><Route element={
  <main style={{ maxWidth: 1400, padding: 16, margin: '0 auto' }}>
    <header style={{ padding: '12px 2px 20px', display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}><h1 style={{ margin: 0, fontSize: 25, fontWeight: 500 }}>提炼队列</h1><span style={{ color: '#949494', fontSize: 11 }}>浏览器验证 · 全部为示例资料</span></header>
    <Outlet context={{ api, health: { status: 'ready', data: { index: { status: 'ready' }, vaultSource: { status: 'ready', adapter: 'filesystem' } } }, dataRevision: 0, refreshHealth: async () => {} }} />
  </main>}><Route path="/queue" element={<QueuePage />} /></Route></Routes></MemoryRouter>);
