import { createRoot } from 'react-dom/client';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { CandidateReview } from '../../../src/client/pages/queue/CandidateReview.js';
import type { ReadConsoleApi } from '../../../src/client/api/client.js';
import type { ExtractionRun } from '../../../src/shared/api/extraction.js';
import type { IngestionReview, ReviewCandidate } from '../../../src/shared/api/ingestion.js';
import '../../../src/client/styles/tokens.css';
import '../../../src/client/styles/global.css';
import '../../../src/client/styles/shell.css';
import '../../../src/client/styles/extraction.css';
import '../../../src/client/styles/ingestion.css';

const id = 'e52917bc-a9df-482f-aae8-8c4b6da4301d'; const batchId = '62b6b258-8469-45ac-ae2e-a3c6a46af160';
const candidate: ReviewCandidate = { id: 'c1', version: 1, state: 'pending', decision: 'later', target: { mode: 'new' }, draft: {
  title: '先明确问题，再选择工具', knowledgeType: '方法', suggestedPath: '02知识库/09学习/学习方法', topics: [],
  coreContent: '## 先把要解决的问题写下来\n\n选择工具前，先明确具体任务、预期结果和约束。工具应服务于问题。\n\n1. 用一句话描述问题。\n2. 写下可检查的结果。\n3. 根据约束选择工具。', value: '把比较工具的时间转化为解决具体问题的行动。',
  draft: { keywords: ['问题', '工具', '行动'], scenarios: ['开始新项目', '选择工作工具'], conclusion: '从具体问题出发选择工具。', keyPoints: ['先明确目标', '再匹配工具'], boundary: '适用于目标可描述的任务。', quotes: [], summaries: ['先有问题，再选工具。'] }
} };
const run: ExtractionRun = { id, title: '建立自己的工作方法', materialPath: '01图书馆/资料.md', readingState: '已看', status: 'ready', sourceRawSha256: 'a'.repeat(64), ruleFingerprint: 'b'.repeat(64), model: 'deepseek-v4-flash', createdAt: '2026-09-07T00:00:00Z', result: { briefing: { sentences: ['一', '二', '三'], keyPoints: [], usefulness: '帮助思考' }, candidates: [candidate.draft] } };
const review: IngestionReview = { runId: id, title: run.title, materialPath: run.materialPath, candidates: [candidate], directories: [candidate.draft.suggestedPath], sourceChanged: false, sourceStatus: '未提炼', complete: false, relatedRuns: [], batches: [] };
const knowledgePath = () => `${review.candidates[0]!.draft.suggestedPath}/${review.candidates[0]!.draft.title}.md`;
const ok = <T,>(value: T) => ({ ok: true as const, value });
const fixtureApi = {
  ingestion: {
    review: async () => ok(structuredClone(review)),
    save: async (_run, request) => { const { candidateId, ...fields } = request; const value = { ...review.candidates[0]!, ...fields, id: candidateId, version: request.version + 1 }; review.candidates[0] = value; return ok(structuredClone(value)); },
    matches: async () => ok({ items: [{ path: '02知识库/09学习/目标拆解.md', title: '把目标拆成可执行任务', usageStatus: '已优化' as const, conclusion: '明确结果之后，再拆分执行步骤。', reason: '核心结论与关键词相关' }] }),
    preview: async () => ok({ id: batchId, runId: id, expiresAt: '2099-01-01T00:00:00Z', files: [{ path: knowledgePath(), kind: 'new' as const, before: null, after: `# ${review.candidates[0]!.draft.title}\n\n${review.candidates[0]!.draft.coreContent}` }, { path: run.materialPath, kind: 'source' as const, before: '---\n知识入库状态: 未提炼\n生成知识: []\n---\n\n原始资料正文保持不变。', after: `---\n知识入库状态: 已入库\n生成知识:\n  - "[[${knowledgePath().replace(/\.md$/u, '')}]]"\n---\n\n原始资料正文保持不变。` }], selectedCount: 1, discardedCount: 0, pendingCount: 0, sourceStatus: '已入库' as const }),
    commit: async () => { review.candidates[0]!.state = 'committed'; review.candidates[0]!.committedPath = knowledgePath(); review.complete = true; review.sourceStatus = '已入库'; return ok({ id: batchId, runId: id, status: 'committed' as const, indexed: true, createdAt: '2026-09-07T00:00:00Z', knowledgePaths: [review.candidates[0]!.committedPath], pendingCount: 0, sourceStatus: '已入库' as const }); }
  },
  getKnowledgeDetail: async (path: string) => ok({ path, title: '把目标拆成可执行任务', markdown: '# 把目标拆成可执行任务\n\n先确定预期结果，再安排具体步骤。', internalKnowledgeLinks: [], versionMarker: { rawSha256: 'a'.repeat(64) } })
} satisfies Pick<ReadConsoleApi, 'getKnowledgeDetail'> & { ingestion: Pick<NonNullable<ReadConsoleApi['ingestion']>, 'review' | 'save' | 'matches' | 'preview' | 'commit'> };
const root = document.getElementById('root'); if (!root) throw new Error('Missing fixture root');
createRoot(root).render(<MemoryRouter><Routes><Route element={<main style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 18px' }}><Outlet context={{ api: fixtureApi }} /></main>}><Route index element={<CandidateReview run={run} />} /></Route></Routes></MemoryRouter>);
