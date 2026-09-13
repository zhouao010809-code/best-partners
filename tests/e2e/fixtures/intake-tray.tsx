import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { intakePreviewRequestSchema, type IntakeList, type IntakeOutcome, type IntakePreview, type IntakePreviewRequest } from '../../../src/shared/api/intake.js';
import type { ApiClientResult, ReadConsoleApi } from '../../../src/client/api/client.js';
import type { IntakeTrashEntry, IntakeTrashPreview } from '../../../src/shared/api/intake-trash.js';
import { IntakePage } from '../../../src/client/pages/IntakePage.js';
import { useIntakeTrash } from '../../../src/client/pages/intake/useIntakeTrash.js';
import '../../../src/client/styles/tokens.css';
import '../../../src/client/styles/global.css';
import '../../../src/client/styles/shell.css';
import '../../../src/client/styles/intake.css';

// Deliberately no production API client: every record and mutation lives in this tab.
const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'six';
const examples: IntakeList['items'] = [
  { name: '示例-把收藏变成可复用的知识', kind: 'directory', mainCandidates: ['文章.md'], fields: {
    title: '把收藏变成可复用的知识：从下一次使用的场景开始', platform: '公众号', collectedAt: '2026-09-07',
    author: '示例作者', url: 'https://example.invalid/articles/knowledge-reuse'
  } },
  { name: '示例-一次产品复盘的完整记录', kind: 'directory', mainCandidates: ['复盘.md'], fields: {
    title: '一次产品复盘的完整记录：用户反馈如何进入下一轮工作', platform: '飞书'
  } },
  { name: '示例-访谈原稿与整理稿', kind: 'directory', mainCandidates: ['访谈原稿.md', '整理稿.md'], fields: {
    title: '访谈原稿与整理稿：保留不同版本的使用边界', platform: '个人', collectedAt: '2026-09-06'
  } },
  { name: '示例-让选题回到真实问题', kind: 'directory', mainCandidates: ['笔记.md'], fields: {
    title: '让选题回到真实问题：观察、判断与行动之间的联系', platform: '小红书', collectedAt: '2026-09-06'
  } },
  { name: '示例-尚未整理的录音.mp3', kind: 'file', mainCandidates: [], fields: {}, problem: '当前只支持包含 Markdown 的资料文件夹。' },
  { name: '示例-一份较长路径的学习资料', kind: 'directory', mainCandidates: ['学习资料.md'], fields: {
    title: '一份较长路径的学习资料：为持续积累建立可以重新找到证据的入口', platform: '独立站', collectedAt: '2026-09-05'
  } }
];
const recoveryId = 'b3d97342-7ba7-45a4-9b31-3dc30ea4a186';
const completedId = 'd11b2ab6-26c5-4b79-a38e-b144bd32e4f3';
let items = scenario === 'empty' ? [] : structuredClone(examples);
let operations: IntakeList['operations'] = scenario === 'recovery'
  ? [{ id: recoveryId, state: 'pending', target: '01图书馆/来自个人/示例-待恢复资料' }]
  : scenario === 'empty' ? [] : [{ id: completedId, state: 'archived', target: '01图书馆/来自公众号/示例-已归档资料' }];
const previews = new Map<string, { request: IntakePreviewRequest; preview: IntakePreview }>();
const diagnostic = {
  scenario,
  listCalls: 0,
  previewCalls: [] as IntakePreviewRequest[],
  commitTokens: [] as string[],
  resumeIds: [] as string[],
  healthRefreshes: 0,
  trashCommits: [] as string[],
  trashRestores: [] as string[],
  unexpectedActions: [] as string[]
};
declare global { interface Window { __intakeTrayFixture: typeof diagnostic } }
window.__intakeTrayFixture = diagnostic;

const ok = <T,>(value: T): ApiClientResult<T> => ({ ok: true, value: structuredClone(value) });
const failure = (message: string): ApiClientResult<never> => ({ ok: false, state: { status: 'operation-error', message } });
const intake: NonNullable<ReadConsoleApi['intake']> = {
  list: async () => {
    diagnostic.listCalls += 1;
    if (scenario === 'retry' && diagnostic.listCalls === 1) {
      return { ok: false, state: { status: 'disconnected', message: '示例连接暂时中断，请重试读取收件箱。' } };
    }
    return ok({ available: true, automaticArchive: false, items, operations });
  },
  preview: async request => {
    diagnostic.previewCalls.push(structuredClone(request));
    const parsed = intakePreviewRequestSchema.safeParse(request);
    const item = items.find(candidate => candidate.name === request.name);
    if (!parsed.success || !item || !item.mainCandidates.includes(request.mainName)) return failure('示例资料信息不完整，请检查后重试。');
    const token = crypto.randomUUID();
    const preview: IntakePreview = {
      token, target: `01图书馆/来自${request.fields.platform}/${request.fields.collectedAt}-${request.fields.title}`,
      mainName: request.mainName, truncated: false, expiresAt: new Date(Date.now() + 600_000).toISOString(),
      markdown: `---\n原始标题: ${request.fields.title}\n来源平台: ${request.fields.platform}\n采集日期: ${request.fields.collectedAt}\n---\n\n# ${request.fields.title}\n\n这是一段仅用于浏览器验证的示例原文。预览与确认都不会读取或修改真实资料。\n\n原始素材和附件应当在归档后保持完整，知识仍需另外提炼与确认。`
    };
    previews.set(token, { request: structuredClone(request), preview });
    return ok(preview);
  },
  commit: async token => {
    diagnostic.commitTokens.push(token);
    const saved = previews.get(token);
    if (!saved) return failure('示例预览已失效，请重新预览。');
    const outcome: IntakeOutcome = { id: token, state: 'archived', indexed: true, target: saved.preview.target };
    items = items.filter(item => item.name !== saved.request.name);
    operations = [{ id: outcome.id, state: outcome.state, target: outcome.target }, ...operations];
    previews.delete(token);
    return ok(outcome);
  },
  resume: async id => {
    diagnostic.resumeIds.push(id);
    const operation = operations.find(candidate => candidate.id === id);
    if (!operation) return failure('没有找到示例恢复记录。');
    operation.state = 'archived';
    return ok({ ...operation, indexed: true });
  }
};
const trashPreviews = new Map<string, IntakeTrashPreview>();
const trashEntries = new Map<string, { entry: IntakeTrashEntry; item: IntakeList['items'][number] }>();
const intakeTrash: NonNullable<ReadConsoleApi['intakeTrash']> = {
  list: async () => ok({ items: [...trashEntries.values()].map(value => value.entry) }),
  preview: async name => {
    const item = items.find(item => item.name === name); if (!item) return failure('示例资料不存在');
    const preview: IntakeTrashPreview = { id: crypto.randomUUID(), name, title: name, kind: item.kind, bytes: 1024, fileCount: item.kind === 'file' ? 1 : 3, expiresAt: new Date(Date.now() + 600000).toISOString() };
    trashPreviews.set(preview.id, preview); return ok(preview);
  },
  commit: async id => {
    diagnostic.trashCommits.push(id); const preview = trashPreviews.get(id);
    const item = items.find(item => item.name === preview?.name); if (!preview || !item) return failure('示例预览失效');
    const { expiresAt: _expires, ...scope } = preview;
    const entry: IntakeTrashEntry = { ...scope, status: 'trashed', createdAt: new Date().toISOString() };
    trashEntries.set(id, { entry, item }); items = items.filter(item => item.name !== entry.name); return ok(entry);
  },
  get: async id => trashEntries.has(id) ? ok(trashEntries.get(id)!.entry) : failure('示例操作不存在'),
  restore: async id => {
    diagnostic.trashRestores.push(id); const saved = trashEntries.get(id); if (!saved) return failure('示例操作不存在');
    if (saved.entry.status !== 'restored') { items.push(saved.item); saved.entry.status = 'restored'; }
    return ok(saved.entry);
  },
  retry: async id => trashEntries.has(id) ? ok(trashEntries.get(id)!.entry) : failure('示例操作不存在')
};
const api = new Proxy({ intake, intakeTrash }, {
  get(target, property) {
    if (property === 'intake') return target.intake;
    if (property === 'intakeTrash') return target.intakeTrash;
    return async () => {
      diagnostic.unexpectedActions.push(String(property));
      return failure('浏览器验证只提供内存中的收件接口。');
    };
  }
});

// Supply the surrounding navigation that the production AppShell now owns.
// The recycle view and dialog still use the real packet-trash implementation.
function IntakeFixture() {
  const [showTrash, setShowTrash] = useState(false);
  const trash = useIntakeTrash(() => {}, { autoOpenPending: false });
  return <>
    <nav aria-label="示例页面导航" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
      <button type="button" onClick={() => setShowTrash(!showTrash)}>{showTrash ? '返回收件箱' : '回收站'}</button>
    </nav>
    {showTrash ? <>{trash.view}{trash.dialog}</> : <IntakePage />}
  </>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing intake fixture root');
createRoot(root).render(<MemoryRouter initialEntries={['/intake']}><Routes><Route element={
  <main style={{ maxWidth: 1400, minWidth: 0, padding: 16, margin: '0 auto' }}>
    <header style={{ padding: '12px 2px 20px', display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
      <h1 style={{ margin: 0, fontSize: 25, fontWeight: 500 }}>收件箱</h1>
      <span style={{ color: '#949494', fontSize: 11 }}>浏览器验证 · 全部为示例资料 · 仅保存在当前页面</span>
    </header>
    <Outlet context={{ api, health: { status: 'ready', data: { index: { status: 'ready' }, vaultSource: { status: 'ready', adapter: 'filesystem' } } },
      dataRevision: 0, refreshHealth: async () => { diagnostic.healthRefreshes += 1; } }} />
  </main>
}><Route path="/intake" element={<IntakeFixture />} /></Route></Routes></MemoryRouter>);
