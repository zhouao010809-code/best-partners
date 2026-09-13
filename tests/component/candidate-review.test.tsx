import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ExtractionWorkbench } from '../../src/client/pages/ExtractionPage.js';
import type { ExtractionRun } from '../../src/shared/api/extraction.js';
import type { IngestionReview, ReviewCandidate, SaveCandidateRequest } from '../../src/shared/api/ingestion.js';
const ok = <T,>(value: T) => ({ ok: true as const, value });
const id = 'e52917bc-a9df-482f-aae8-8c4b6da4301d'; const batchId = '62b6b258-8469-45ac-ae2e-a3c6a46af160';
const candidate: ReviewCandidate = { id: 'c1', version: 1, state: 'pending', decision: 'later', target: { mode: 'new' }, draft: {
  title: '候选知识', knowledgeType: '方法', suggestedPath: '02知识库/09学习', topics: [], coreContent: '先明确问题，再选择工具。', value: '减少重复试错',
  draft: { keywords: ['问题', '工具', '选择'], scenarios: ['选择工具时', '复盘工作时'], conclusion: '先明确问题', keyPoints: ['明确问题', '再选工具'], boundary: '目标明确的任务', quotes: [], summaries: ['先有问题，再有工具。'] }
} };
const run: ExtractionRun = { id, title: '资料', materialPath: '01图书馆/资料.md', readingState: '已看', status: 'ready', sourceRawSha256: 'a'.repeat(64), ruleFingerprint: 'b'.repeat(64), model: 'deepseek-v4-flash', createdAt: '2026-09-07T00:00:00Z', result: { briefing: { sentences: ['一', '二', '三'], keyPoints: [], usefulness: '学习' }, candidates: [candidate.draft] } };
let review: IngestionReview;
const ingestion = { review: vi.fn(), save: vi.fn(), matches: vi.fn(), preview: vi.fn(), commit: vi.fn(), batch: vi.fn(), resume: vi.fn(), recoveryPreview: vi.fn(), resolve: vi.fn() };
const getDocumentDetail = vi.fn(); const getKnowledgeDetail = vi.fn();
const extraction = { get: vi.fn() }; const deepSeek = { get: vi.fn() };
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => ({ api: { extraction, deepSeek, ingestion, getDocumentDetail, getKnowledgeDetail }, health: { status: 'loading' } }) }));
function LocationProbe() { const navigate = useNavigate(); return <><output aria-label="当前审阅路由">{useLocation().pathname}</output><button onClick={() => navigate('/away')}>切换资料</button></>; }
function open(onNextMaterial?: () => void) { return render(<MemoryRouter><Link to="/away">离开审阅</Link><LocationProbe /><ExtractionWorkbench id={id} materialPath={run.materialPath} embedded {...(onNextMaterial ? { onNextMaterial } : {})} /></MemoryRouter>); }
async function editTitle(container?: HTMLElement) {
  const queries = container ? within(container) : screen;
  const existing = queries.queryByRole('textbox', { name: '知识标题' });
  if (existing) return existing;
  fireEvent.click(await queries.findByRole('button', { name: '编辑候选' }));
  return queries.findByRole('textbox', { name: '知识标题' });
}
it('starts with readable content and lets the candidate directory preserve edits while comparing', async () => {
  review.candidates = Array.from({ length: 4 }, (_, index) => ({ ...structuredClone(candidate), id: `c${index + 1}`, draft: { ...structuredClone(candidate.draft), title: `候选 ${index + 1}`, coreContent: `第 ${index + 1} 条原有正文` } }));
  const original = structuredClone(review.candidates);
  ingestion.save.mockImplementation(async (_run, request) => ok({ ...original.find(value => value.id === request.candidateId)!, ...request, id: request.candidateId, version: request.version + 1 }));
  const user = userEvent.setup(); open();
  expect(await screen.findByRole('navigation', { name: '候选目录' })).toBeVisible();
  expect(screen.getByText('第 1 条原有正文', { selector: '.ingestion-reading p' })).toBeVisible();
  expect(screen.getAllByText(/原文依据：暂无直接摘录/u)).not.toHaveLength(0);
  expect(screen.queryByRole('textbox', { name: '知识标题' })).not.toBeInTheDocument();
  expect(screen.getByText('第 2 条原有正文', { selector: '.ingestion-reading p' })).not.toBeVisible();
  await user.click(screen.getByRole('button', { name: '编辑候选' }));
  const title = screen.getByRole('textbox', { name: '知识标题' });
  fireEvent.change(title, { target: { value: '本机正在修改的候选' } });
  await user.click(screen.getByRole('button', { name: '查看候选 2：候选 2' }));
  expect(screen.getByText('第 2 条原有正文', { selector: '.ingestion-reading p' })).toBeVisible();
  await user.click(screen.getByRole('checkbox', { name: '同时展开候选 1' }));
  expect(screen.getByRole('textbox', { name: '知识标题' })).toBe(title);
  expect(title).toHaveValue('本机正在修改的候选');
  await user.click(screen.getByRole('button', { name: '下一条候选' }));
  expect(screen.getByRole('button', { name: '查看候选 3：候选 3' })).toHaveAttribute('aria-current', 'true');
  expect(review.candidates).toEqual(original);
  expect(ingestion.commit).not.toHaveBeenCalled();
});
it('opens the exact missing field from the batch summary without changing the candidate', async () => {
  review.candidates[0]!.decision = 'keep';
  review.candidates[0]!.draft.draft.keywords = [];
  const original = structuredClone(review.candidates[0]);
  const user = userEvent.setup(); open();
  await screen.findByRole('navigation', { name: '候选目录' });
  await user.click(screen.getByRole('button', { name: '补齐本批缺项' }));
  const keywords = await screen.findByRole('textbox', { name: /关键词/u });
  await waitFor(() => expect(keywords).toHaveFocus());
  expect(keywords.closest('details')).toHaveAttribute('open');
  expect(review.candidates[0]).toEqual(original);
  expect(ingestion.save).not.toHaveBeenCalled();
  expect(ingestion.preview).not.toHaveBeenCalled();
});
it('opens the exact batch linked from operations without resuming it automatically', async () => {
  ingestion.batch.mockResolvedValue(ok({ id: batchId, runId: id, status: 'needs-review', indexed: false, createdAt: '2026-09-07T00:00:00Z', knowledgePaths: [], pendingCount: 1, sourceStatus: '未提炼' }));
  render(<MemoryRouter initialEntries={[`/extractions/${id}?batch=${batchId}`]}><ExtractionWorkbench id={id} materialPath={run.materialPath} embedded /></MemoryRouter>);
  expect(await screen.findByRole('heading', {name:'本批需要核对变化'})).toBeVisible();
  expect(ingestion.batch).toHaveBeenCalledWith(batchId, expect.any(AbortSignal));
  expect(ingestion.resume).not.toHaveBeenCalled(); expect(ingestion.resolve).not.toHaveBeenCalled();
});
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); review = { runId: id, materialPath: run.materialPath, title: '资料', candidates: [structuredClone(candidate)], directories: ['02知识库/09学习'], sourceStatus: '未提炼', sourceChanged: false, complete: false, relatedRuns: [], batches: [] };
  extraction.get.mockResolvedValue(ok(run)); ingestion.review.mockImplementation(async () => ok(structuredClone(review)));
  ingestion.matches.mockResolvedValue(ok({ items: [] }));
  ingestion.save.mockImplementation(async (_id: string, request: SaveCandidateRequest) => { const { candidateId, ...fields } = request; const value = { ...review.candidates[0]!, ...fields, id: candidateId, version: request.version + 1 }; review.candidates[0] = value; return ok(value); });
  ingestion.preview.mockResolvedValue(ok({ id: batchId, runId: id, expiresAt: '2099-01-01T00:00:00Z', files: [{ path: '02知识库/09学习/候选知识.md', kind: 'new', before: null, after: '# 正式预览\n\n<script>bad()</script>\n\n先明确问题' }], selectedCount: 1, discardedCount: 0, pendingCount: 0, sourceStatus: '已入库' }));
  ingestion.commit.mockImplementation(async () => { review.candidates[0] = { ...review.candidates[0]!, state: 'committed', committedPath: '02知识库/09学习/候选知识.md' }; return ok({ id: batchId, runId: id, status: 'committed', indexed: true, createdAt: '2026-09-07T00:00:00Z', knowledgePaths: ['02知识库/09学习/候选知识.md'], pendingCount: 0, sourceStatus: '已入库' }); });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
it('reports unsaved review work to the queue and clears the guard after saving', async () => {
  const onReviewBusy = vi.fn();
  render(<MemoryRouter><ExtractionWorkbench id={id} materialPath={run.materialPath} embedded onReviewBusy={onReviewBusy} /></MemoryRouter>);
  const title = await editTitle();
  fireEvent.change(title, { target: { value: '草稿不能被下一份丢弃' } });
  await waitFor(() => expect(onReviewBusy).toHaveBeenCalledWith(true, true));
  await waitFor(() => expect(onReviewBusy.mock.calls.at(-1)?.[0]).toBe(false));
  expect(ingestion.save).toHaveBeenCalledWith(id, expect.objectContaining({ draft: expect.objectContaining({ title: '草稿不能被下一份丢弃' }) }));
  expect(ingestion.commit).not.toHaveBeenCalled();
});
it('edits the real candidate form and keeps unsaved input across remount after a save failure', async () => {
  ingestion.save.mockResolvedValue({ ok: false, state: { status: 'disconnected', message: '保存暂不可用' } });
  const view = open(); const title = await editTitle();
  fireEvent.change(title, { target: { value: '我修改后的标题' } });
  await screen.findByText(/保存暂不可用/u); view.unmount(); open();
  expect(await editTitle()).toHaveValue('我修改后的标题');
  expect(ingestion.commit).not.toHaveBeenCalled();
});
it('requires an explicit keep decision and visible preview before a single commit, then offers the next step', async () => {
  const onNextMaterial = vi.fn();
  const user = userEvent.setup(); open(onNextMaterial);
  await editTitle();
  expect(screen.getByRole('radio', { name: '稍后处理' })).toBeChecked();
  expect(screen.queryByRole('button', { name: '确认入库' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('radio', { name: '选入本批' }));
  await user.click(screen.getByRole('button', { name: '预览本批变化' }));
  expect(await screen.findByRole('heading', { name: '正式预览' })).toBeVisible();
  expect(document.querySelector('script')).toBeNull(); expect(ingestion.commit).not.toHaveBeenCalled();
  await user.dblClick(screen.getByRole('button', { name: '确认入库' }));
  expect(await screen.findByRole('link', { name: '打开知识：候选知识' })).toHaveAttribute('href', `/knowledge?path=${encodeURIComponent('02知识库/09学习/候选知识.md')}`);
  expect(ingestion.commit).toHaveBeenCalledExactlyOnceWith(batchId);
  expect(screen.getByRole('link', { name: '使用这篇知识' })).toHaveAttribute('href', `/knowledge?path=${encodeURIComponent('02知识库/09学习/候选知识.md')}`);
  expect(onNextMaterial).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '处理下一份' }));
  expect(onNextMaterial).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '知识标题' })).not.toBeInTheDocument());
});
it('keeps local edits on a version conflict and does not send a preview', async () => {
  ingestion.save.mockResolvedValue({ ok: false, state: { status: 'conflict', message: '另一窗口已修改草稿' } });
  open(); fireEvent.change(await editTitle(), { target: { value: '不要丢的编辑' } });
  expect(await screen.findByText(/另一窗口已修改草稿/u)).toBeVisible();
  expect(screen.getByRole('textbox', { name: '知识标题' })).toHaveValue('不要丢的编辑');
  expect(ingestion.preview).not.toHaveBeenCalled();
});
it('requires reading and acknowledging the current source before previewing changed evidence', async () => {
  review.sourceChanged = true; review.sourceCurrentSha = 'c'.repeat(64);
  getDocumentDetail.mockResolvedValue(ok({ path: run.materialPath, title: '当前资料', markdown: '当前原文的新证据', versionMarker: { rawSha256: 'c'.repeat(64) } }));
  const user = userEvent.setup(); open(); await editTitle();
  await user.click(screen.getByRole('radio', { name: '选入本批' }));
  expect(screen.getByRole('button', { name: '预览本批变化' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '读取当前原资料' }));
  expect(await screen.findByText('当前原文的新证据')).toBeVisible();
  await user.click(screen.getByRole('checkbox', { name: '我已核对当前原资料，候选仍有依据' }));
  await user.click(screen.getByRole('button', { name: '预览本批变化' }));
  await waitFor(() => expect(ingestion.preview).toHaveBeenCalledWith(expect.objectContaining({ acknowledgedSourceSha: 'c'.repeat(64) })));
});
it('shows match evidence and protects settled or obsolete knowledge from merging', async () => {
  ingestion.matches.mockResolvedValue(ok({ items: [
    { path: '02知识库/定论.md', title: '定论笔记', usageStatus: '定论', reason: '核心结论相关', conclusion: '已确认判断' },
    { path: '02知识库/过时.md', title: '过时笔记', usageStatus: '过时', reason: '标题相近', conclusion: '历史判断' }
  ] }));
  const user = userEvent.setup(); open();
  await user.click(await screen.findByText('查重与存放方式'));
  expect(await screen.findByText('核心结论相关')).toBeVisible();
  expect(screen.queryByRole('button', { name: '合并到 定论笔记' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '合并到 过时笔记' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '只补充来源到 定论笔记' }));
  expect(await screen.findByText(/不会把这条候选的新判断写入已有正文/u)).toBeVisible();
});
it('keeps a failed confirmation id and queries that same batch without automatically repeating writes', async () => {
  ingestion.commit.mockResolvedValue({ ok: false, state: { status: 'disconnected', message: '连接中断' } });
  ingestion.batch.mockResolvedValue(ok({ id: batchId, runId: id, status: 'committed', indexed: false, createdAt: '2026-09-07T00:00:00Z', knowledgePaths: ['02知识库/笔记.md'], pendingCount: 0, sourceStatus: '已入库' }));
  const user = userEvent.setup(); open(); await user.click(await screen.findByRole('radio', { name: '选入本批' }));
  await user.click(screen.getByRole('button', { name: '预览本批变化' }));
  await user.click(await screen.findByRole('button', { name: '确认入库' }));
  expect(await screen.findByText(/连接中断/u)).toBeVisible();
  await user.click(screen.getByRole('button', { name: '查询本批结果' }));
  expect(await screen.findByText(/已写入，检索尚未更新/u)).toBeVisible();
  expect(ingestion.batch).toHaveBeenCalledWith(batchId, expect.any(AbortSignal));
  expect(ingestion.commit).toHaveBeenCalledTimes(1); expect(ingestion.resume).not.toHaveBeenCalled();
});
it('retains temporarily invalid metadata after a failed save and reopening the workbench', async () => {
  ingestion.save.mockResolvedValue({ ok: false, state: { status: 'validation-error', message: '关键词最多 6 个' } });
  const user = userEvent.setup(); const view = open(); await editTitle();
  await user.click(screen.getByText('召回字段与可复用表达'));
  const value = '一\n二\n三\n四\n五\n六\n七';
  fireEvent.change(screen.getByRole('textbox', { name: /关键词/u }), { target: { value } });
  await screen.findByText('关键词最多 6 个'); view.unmount(); open();
  await editTitle(); await user.click(screen.getByText('召回字段与可复用表达'));
  expect(screen.getByRole('textbox', { name: /关键词/u })).toHaveValue(value);
});
it('queries a persisted submitted batch after remount and permits only an explicit retry of the same id', async () => {
  ingestion.commit.mockResolvedValue({ ok: false, state: { status: 'disconnected', message: '连接中断' } });
  ingestion.batch.mockResolvedValue({ ok: false, state: { status: 'operation-error', message: '暂未找到批次' } });
  const user = userEvent.setup(); const view = open(); await user.click(await screen.findByRole('radio', { name: '选入本批' }));
  await user.click(screen.getByRole('button', { name: '预览本批变化' })); await user.click(await screen.findByRole('button', { name: '确认入库' }));
  await screen.findByText('连接中断'); view.unmount(); open();
  await screen.findByRole('button', { name: '查询本批结果' });
  expect(ingestion.commit).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '使用同一批次重试确认' }));
  await waitFor(() => expect(ingestion.commit).toHaveBeenLastCalledWith(batchId));
  expect(ingestion.commit).toHaveBeenCalledTimes(2);
});
it('distinguishes a discard-only batch from saving a knowledge note', async () => {
  ingestion.preview.mockResolvedValue(ok({ id: batchId, runId: id, expiresAt: '2099-01-01T00:00:00Z', files: [], selectedCount: 0, discardedCount: 1, pendingCount: 0, sourceStatus: '未提炼' }));
  ingestion.commit.mockImplementation(async () => { review.candidates[0]!.state = 'discarded'; review.complete = true; return ok({ id: batchId, runId: id, status: 'committed', indexed: true, createdAt: '2026-09-07T00:00:00Z', knowledgePaths: [], pendingCount: 0, sourceStatus: '未提炼' }); });
  const user = userEvent.setup(); open(); await user.click(await screen.findByRole('radio', { name: '明确放弃' }));
  await user.click(screen.getByRole('button', { name: '预览本批变化' })); await user.click(await screen.findByRole('button', { name: '确认本批取舍' }));
  expect(await screen.findByText('本批取舍已确认，没有新建或更新知识笔记。')).toBeVisible();
  expect(screen.queryByText('知识已保存，可在知识库查看。')).not.toBeInTheDocument();
});
it('shows recovery before and after content and requires a fresh explicit resolve click', async () => {
  review.batches = [{ id: batchId, runId: id, status: 'needs-review', indexed: false, createdAt: '2026-09-07T00:00:00Z', knowledgePaths: ['02知识库/笔记.md'], pendingCount: 1, sourceStatus: '未提炼', problem: '笔记被其他应用修改' }];
  ingestion.batch.mockResolvedValue(ok(review.batches[0]));
  ingestion.recoveryPreview.mockResolvedValue(ok({ id, batchId, expiresAt: '2099-01-01T00:00:00Z', sourceChoice: 'current', hasPreservedSource: false, files: [{ path: '02知识库/笔记.md', kind: 'update', before: '外部修改内容', after: '拟恢复内容' }] }));
  ingestion.resolve.mockResolvedValue(ok({ ...review.batches[0]!, status: 'committed', indexed: true }));
  const user = userEvent.setup(); open(); await user.click(await screen.findByRole('button', { name: '查看这批结果' }));
  await user.click(await screen.findByRole('button', { name: '查看并核对恢复变化' }));
  expect(await screen.findByText('外部修改内容', { selector: 'p' })).toBeVisible(); expect(screen.getByText('拟恢复内容', { selector: 'p' })).toBeVisible();
  expect(ingestion.resolve).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '确认解决这些变化' }));
  expect(ingestion.resolve).toHaveBeenCalledExactlyOnceWith(id);
});
it('preserves a conflicted note by explicitly selecting a new title and invalidates the old recovery preview on edits', async () => {
  const oldPath = '02知识库/09学习/定论笔记.md'; const secondPath = '02知识库/09学习/另一篇笔记.md';
  review.batches = [{ id: batchId, runId: id, status: 'needs-review', indexed: false, createdAt: '2026-09-07T00:00:00Z', knowledgePaths: [oldPath, secondPath], pendingCount: 1, sourceStatus: '未提炼' }];
  ingestion.batch.mockResolvedValue(ok(review.batches[0]));
  ingestion.recoveryPreview.mockResolvedValue(ok({ id, batchId, expiresAt: '2099-01-01T00:00:00Z', sourceChoice: 'current', hasPreservedSource: false, files: [] }));
  const user = userEvent.setup(); open(); await user.click(await screen.findByRole('button', { name: '查看这批结果' }));
  await user.click(screen.getByText('冲突笔记改为新建'));
  const title = screen.getByRole('textbox', { name: '为“定论笔记”填写新标题' });
  expect(title).toHaveValue(''); expect(screen.getByRole('textbox', { name: '为“另一篇笔记”填写新标题' })).toHaveValue('');
  expect(screen.getByText(/候选另存，保留旧笔记/u)).toBeVisible();
  await user.click(screen.getByRole('button', { name: '查看并核对恢复变化' }));
  expect(await screen.findByRole('button', { name: '确认解决这些变化' })).toBeEnabled();
  fireEvent.change(title, { target: { value: '我的新判断' } });
  expect(screen.queryByRole('button', { name: '确认解决这些变化' })).not.toBeInTheDocument();
  expect(ingestion.recoveryPreview).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '查看并核对恢复变化' }));
  await waitFor(() => expect(ingestion.recoveryPreview).toHaveBeenLastCalledWith(batchId, 'current', { [oldPath]: '02知识库/09学习/我的新判断.md' }));
  expect(ingestion.resolve).not.toHaveBeenCalled();
  fireEvent.change(title, { target: { value: '../换目录' } });
  await user.click(screen.getByRole('button', { name: '查看并核对恢复变化' }));
  expect(await screen.findByText('新标题不能包含路径分隔符或控制字符。')).toBeVisible();
  expect(ingestion.recoveryPreview).toHaveBeenCalledTimes(2);
});
it('does not let a late save replace newer edits', async () => {
  let resolve!: (value: unknown) => void;
  ingestion.save.mockImplementationOnce((_id: string, request: SaveCandidateRequest) => new Promise((accept) => { resolve = (value: unknown) => { review.candidates[0] = { ...review.candidates[0]!, draft: request.draft, version: 2 }; accept(value); }; }));
  review.candidates.push({ ...structuredClone(candidate), id: 'c2', decision: 'later' });
  const view = open(); const title = await editTitle();
  fireEvent.change(title, { target: { value: '第一个编辑' } });
  await waitFor(() => expect(ingestion.save).toHaveBeenCalledTimes(1));
  fireEvent.change(title, { target: { value: '新编辑不能被覆盖' } });
  await act(async () => resolve(ok({ ...candidate, version: 2, draft: { ...candidate.draft, title: '第一个编辑' } })));
  await waitFor(() => expect(title).toHaveValue('新编辑不能被覆盖'));
  view.unmount();
});
it('binds the preview to all displayed versions, including deferred and settled candidates', async () => {
  review.candidates.push({ ...structuredClone(candidate), id: 'c2', version: 3, decision: 'later' }, { ...structuredClone(candidate), id: 'c3', version: 4, state: 'discarded', decision: 'discard' });
  const user = userEvent.setup(); open();
  await user.click((await screen.findAllByRole('radio', { name: '选入本批' }))[0]!);
  await user.click(screen.getByRole('button', { name: '预览本批变化' }));
  await waitFor(() => expect(ingestion.preview).toHaveBeenCalledWith({ runId: id, versions: [{ id: 'c1', version: 2 }, { id: 'c2', version: 3 }, { id: 'c3', version: 4 }] }));
});
it('keeps source YAML visibly separate from the readable body in a preview', async () => {
  ingestion.preview.mockResolvedValue(ok({ id: batchId, runId: id, expiresAt: '2099-01-01T00:00:00Z', files: [{ path: run.materialPath, kind: 'source', before: '原正文', after: '---\n知识入库状态: 已入库\n---\n\n原正文' }], selectedCount: 1, discardedCount: 0, pendingCount: 0, sourceStatus: '已入库' }));
  const user = userEvent.setup(); open(); await user.click(await screen.findByRole('radio', { name: '选入本批' }));
  await user.click(screen.getByRole('button', { name: '预览本批变化' }));
  expect(await screen.findByText('知识入库状态: 已入库', { selector: 'pre' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '知识入库状态: 已入库' })).not.toBeInTheDocument();
});
it('only unlocks stale confirmation for a fresh preview after verifying that its batch never started', async () => {
  ingestion.commit.mockResolvedValue({ ok: false, code: 'PLAN_STALE', state: { status: 'operation-error', message: '原文变化，请重新预览' } });
  ingestion.batch.mockResolvedValue({ ok: false, code: 'BATCH_NOT_FOUND', state: { status: 'operation-error', message: '本批尚未开始写入' } });
  const user = userEvent.setup(); open(); await user.click(await screen.findByRole('radio', { name: '选入本批' }));
  await user.click(screen.getByRole('button', { name: '预览本批变化' })); await user.click(await screen.findByRole('button', { name: '确认入库' }));
  await screen.findByText('原文变化，请重新预览'); expect(await editTitle()).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '重新核对候选与预览' }));
  expect(await screen.findByRole('button', { name: '预览本批变化' })).toBeEnabled();
  expect(screen.getByRole('textbox', { name: '知识标题' })).toBeEnabled();
  expect(ingestion.batch).toHaveBeenCalledWith(batchId, expect.any(AbortSignal)); expect(ingestion.commit).toHaveBeenCalledTimes(1);
});
it('shows the preserved concurrent edit and regenerates a recovery preview when the source version choice changes', async () => {
  review.batches = [{ id: batchId, runId: id, status: 'needs-review', indexed: false, createdAt: '2026-09-07T00:00:00Z', knowledgePaths: ['02知识库/笔记.md'], pendingCount: 1, sourceStatus: '未提炼' }];
  ingestion.batch.mockResolvedValue(ok(review.batches[0]));
  ingestion.recoveryPreview.mockImplementation(async (_id: string, sourceChoice = 'preserved') => ok({ id, batchId, expiresAt: '2099-01-01T00:00:00Z', sourceChoice, hasPreservedSource: true,
    files: [{ path: run.materialPath, kind: 'source', before: '当前磁盘原文', after: sourceChoice === 'current' ? '当前磁盘原文并补回链' : '外部修改原文并补回链', preserved: '竞争时保留的原文证据' }] }));
  const user = userEvent.setup(); open(); await user.click(await screen.findByRole('button', { name: '查看这批结果' }));
  await user.click(await screen.findByRole('button', { name: '查看并核对恢复变化' }));
  expect(await screen.findByRole('radio', { name: '保留的外部修改版本' })).toBeChecked();
  await user.click(screen.getByText('竞争时保留的外部修改版本'));
  expect(await screen.findByText('竞争时保留的原文证据')).toBeVisible();
  await user.click(screen.getByRole('radio', { name: '当前磁盘版本' }));
  await waitFor(() => expect(ingestion.recoveryPreview).toHaveBeenLastCalledWith(batchId, 'current'));
  expect(await screen.findByText('当前磁盘原文并补回链', { selector: 'p' })).toBeVisible();
  expect(ingestion.resolve).not.toHaveBeenCalled();
});
it('prevents route changes and unload while an edit cannot be retained anywhere', async () => {
  const store = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  ingestion.save.mockResolvedValue({ ok: false, state: { status: 'disconnected', message: '保存不可用' } });
  try {
    const user = userEvent.setup(); open(); fireEvent.change(await editTitle(), { target: { value: '尚未落盘的编辑' } });
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    await user.click(screen.getByRole('link', { name: '离开审阅' }));
    expect(screen.getByLabelText('当前审阅路由')).toHaveTextContent(/^\/$/u);
    await user.click(screen.getByRole('button', { name: '切换资料' }));
    expect(screen.getByLabelText('当前审阅路由')).toHaveTextContent(/^\/$/u);
    expect(screen.getByRole('textbox', { name: '知识标题' })).toHaveValue('尚未落盘的编辑');
  } finally { store.mockRestore(); }
});
it('keeps the saved candidate readable when ingestion service is unavailable', async () => {
  ingestion.review.mockResolvedValue({ ok: false, state: { status: 'recovery-required', message: '当前桌面版尚未启用入库' } });
  open(); expect(await screen.findByText('当前桌面版尚未启用入库')).toBeVisible();
  expect(screen.getByRole('heading', { name: /候选知识/u })).toBeVisible();
  expect(screen.queryByRole('button', { name: '确认入库' })).not.toBeInTheDocument();
});
it('locks candidates attached to an unfinished batch when reopening and exposes recovery first', async () => {
  review.candidates[0]!.batchId = batchId;
  review.batches = [{ id: batchId, runId: id, status: 'needs-review', indexed: false, createdAt: '2026-09-07T00:00:00Z', knowledgePaths: ['02知识库/笔记.md'], pendingCount: 1, sourceStatus: '未提炼' }];
  open(); expect(await editTitle()).toBeDisabled();
  expect(screen.getByRole('button', { name: '查看这批结果' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '预览本批变化' })).not.toBeInTheDocument();
  expect(ingestion.save).not.toHaveBeenCalled();
});

function copyTabStorage(source: Storage): Storage {
  const values = new Map(Array.from({ length: source.length }, (_, index) => { const key = source.key(index)!; return [key, source.getItem(key)!] as const; }));
  return { get length() { return values.size; }, clear: () => values.clear(), key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
it('preserves another tab draft when a copied tab reference saves the same candidate', async () => {
  ingestion.save.mockImplementation(async (_id: string, request: SaveCandidateRequest) => {
    if (request.draft.title !== 'A 已保存') return { ok: false, state: { status: 'disconnected', message: '保存暂不可用' } };
    const { candidateId, ...fields } = request;
    const value = { ...review.candidates[0]!, ...fields, id: candidateId, version: request.version + 1 };
    review.candidates[0] = value; return ok(value);
  });
  const originalSession = sessionStorage;
  const a = open();
  fireEvent.change(await editTitle(a.container), { target: { value: 'A 临时草稿' } });
  await within(a.container).findByText('保存暂不可用');
  const copiedSession = copyTabStorage(originalSession);
  vi.stubGlobal('sessionStorage', copiedSession);
  const b = open();
  fireEvent.change(await editTitle(b.container), { target: { value: 'B 不能丢的编辑' } });
  await within(b.container).findByText('保存暂不可用');
  fireEvent.change(within(a.container).getByRole('textbox', { name: '知识标题' }), { target: { value: 'A 已保存' } });
  await waitFor(() => expect(review.candidates[0]!.draft.title).toBe('A 已保存'));
  expect(within(b.container).getByRole('textbox', { name: '知识标题' })).toHaveValue('B 不能丢的编辑');
  b.unmount(); a.unmount();
  const reopened = open();
  expect(await editTitle(reopened.container)).toHaveValue('B 不能丢的编辑');
});
it('recovers legacy and multiple persistent drafts after tab storage is lost', async () => {
  ingestion.save.mockResolvedValue({ ok: false, state: { status: 'disconnected', message: '保存暂不可用' } });
  localStorage.setItem(`brain-ingestion-draft:${id}:c1`, JSON.stringify({ ...candidate, draft: { ...candidate.draft, title: '旧版临时草稿' } }));
  const first = open();
  expect(await editTitle(first.container)).toHaveValue('旧版临时草稿');
  fireEvent.change(within(first.container).getByRole('textbox', { name: '知识标题' }), { target: { value: '第一窗口的编辑' } });
  await within(first.container).findByText('保存暂不可用');
  const second = open();
  fireEvent.change(await editTitle(second.container), { target: { value: '第二窗口的编辑' } });
  await within(second.container).findByText('保存暂不可用');
  first.unmount(); second.unmount(); sessionStorage.clear();
  open();
  await editTitle();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '恢复本机草稿：第一窗口的编辑' }));
  expect(screen.getByRole('textbox', { name: '知识标题' })).toHaveValue('第一窗口的编辑');
  await user.click(screen.getByRole('button', { name: '恢复本机草稿：第二窗口的编辑' }));
  expect(screen.getByRole('textbox', { name: '知识标题' })).toHaveValue('第二窗口的编辑');
});
it('does not hide a valid independent draft behind malformed legacy storage', async () => {
  ingestion.save.mockResolvedValue({ ok: false, state: { status: 'disconnected', message: '保存暂不可用' } });
  const view = open();
  fireEvent.change(await editTitle(), { target: { value: '独立草稿仍可恢复' } });
  await screen.findByText('保存暂不可用'); view.unmount(); sessionStorage.clear();
  localStorage.setItem(`brain-ingestion-draft:${id}:c1`, '{broken');
  open(); await editTitle();
  expect(screen.getByRole('button', { name: '恢复本机草稿：独立草稿仍可恢复' })).toBeInTheDocument();
});
it('does not offer an already synchronized remount copy as an unsaved draft after reopening', async () => {
  ingestion.save.mockResolvedValueOnce({ ok: false, state: { status: 'disconnected', message: '保存暂不可用' } });
  const view = open();
  fireEvent.change(await editTitle(), { target: { value: '恢复后完成保存' } });
  await screen.findByText('保存暂不可用'); view.unmount();
  const restored = open();
  expect(await editTitle()).toHaveValue('恢复后完成保存');
  await waitFor(() => expect(review.candidates[0]!.draft.title).toBe('恢复后完成保存'));
  await waitFor(() => expect(screen.queryByRole('region', { name: '本机临时草稿恢复' })).not.toBeInTheDocument());
  restored.unmount(); sessionStorage.clear(); open();
  expect(await editTitle()).toHaveValue('恢复后完成保存');
  expect(screen.queryByRole('region', { name: '本机临时草稿恢复' })).not.toBeInTheDocument();
});
it('clears storage failures per candidate without releasing another unretained edit', async () => {
  review.candidates.push({ ...structuredClone(candidate), id: 'c2', draft: { ...structuredClone(candidate.draft), title: '第二条候选' } });
  ingestion.save.mockResolvedValue({ ok: false, state: { status: 'disconnected', message: '保存暂不可用' } });
  const onReviewBusy = vi.fn();
  const originalWrite = Storage.prototype.setItem;
  const store = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (value.includes('第一条未保留')) throw new Error('quota');
    return originalWrite.call(this, key, value);
  });
  try {
    render(<MemoryRouter><ExtractionWorkbench id={id} materialPath={run.materialPath} embedded onReviewBusy={onReviewBusy} /></MemoryRouter>);
    await editTitle();
    fireEvent.click(screen.getByRole('checkbox', { name: '同时展开候选 2' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑候选' }));
    const titles = screen.getAllByRole('textbox', { name: '知识标题' });
    fireEvent.change(titles[0]!, { target: { value: '第一条未保留' } });
    fireEvent.change(titles[1]!, { target: { value: '第二条已保留' } });
    await waitFor(() => expect(onReviewBusy.mock.calls.at(-1)).toEqual([true, false]));
    expect(screen.getByText('本机临时草稿空间不可用，请保持页面打开并重试保存。')).toBeVisible();
    fireEvent.change(titles[0]!, { target: { value: '第一条已恢复持久保存' } });
    await waitFor(() => expect(onReviewBusy.mock.calls.at(-1)).toEqual([true, true]));
    expect(screen.queryByText('本机临时草稿空间不可用，请保持页面打开并重试保存。')).not.toBeInTheDocument();
  } finally { store.mockRestore(); }
});
it('clears a storage warning once its candidate is confirmed saved by the server', async () => {
  const originalWrite = Storage.prototype.setItem;
  const store = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith('brain-ingestion-draft:')) throw new Error('quota');
    return originalWrite.call(this, key, value);
  });
  try {
    open();
    fireEvent.change(await editTitle(), { target: { value: '由服务完成保存' } });
    expect(screen.getByText('本机临时草稿空间不可用，请保持页面打开并重试保存。')).toBeVisible();
    await waitFor(() => expect(review.candidates[0]!.draft.title).toBe('由服务完成保存'));
    await waitFor(() => expect(screen.queryByText('本机临时草稿空间不可用，请保持页面打开并重试保存。')).not.toBeInTheDocument());
  } finally { store.mockRestore(); }
});
