import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AppRouter } from '../../../src/client/app/router.js';
import type { ApiClientResult, KnowledgePage, MaterialPage, ReadConsoleApi } from '../../../src/client/api/client.js';
import type { ExtractionQueueItem, ExtractionQueueQuery } from '../../../src/shared/api/extraction-queue.js';
import '../../../src/client/styles/tokens.css';
import '../../../src/client/styles/global.css';
import '../../../src/client/styles/shell.css';
import '../../../src/client/styles/extraction.css';

// This complete in-memory API has no browser API fallback, filesystem access, or provider calls.
const options = new URLSearchParams(location.search);
const requestedCount = Number(options.get('count') ?? 2);
const count = [0, 1, 2, 9, 25].includes(requestedCount) ? requestedCount : 2;
const sha = 'a'.repeat(64);
const version = 17;
const titles = [
  '让读过的内容在下一次工作中派上用场',
  '从真实问题开始，建立自己的内容选题池',
  '把经验变成方法：保留情境、证据与边界',
  '怎样让团队复盘进入下一轮工作计划',
  '收藏之后，如何判断哪些内容值得提炼',
  '先明确用途，再决定知识的整理方式',
  '用可追溯的来源支持自己的判断',
  '从零散阅读到稳定积累的学习系统',
  '把复杂概念讲清楚需要哪些具体例子'
];
const pending: MaterialPage['items'] = Array.from({ length: count }, (_, index) => ({
  path: `01图书馆/来自个人/总览示例-${String(index + 1).padStart(2, '0')}.md`,
  rawSha256: sha,
  title: index < titles.length ? titles[index]! : `${titles[index % titles.length]} · ${index + 1}`,
  sourcePlatform: ['个人', '公众号', 'B站'][index % 3]!,
  processingStatus: '已归档', knowledgeStatus: '未提炼',
  collectedAt: `2026-09-${String(7 - Math.floor(index / 4)).padStart(2, '0')}`,
  generatedKnowledge: []
}));
const partial: MaterialPage['items'][number] = {
  path: '01图书馆/来自个人/部分入库示例.md', rawSha256: sha,
  title: '已有部分知识产出的访谈记录', sourcePlatform: '个人',
  processingStatus: '已归档', knowledgeStatus: '部分入库', collectedAt: '2026-09-06',
  generatedKnowledge: ['02知识库/09学习/知识管理/知识需要对应具体使用场景.md']
};
const completed: MaterialPage['items'][number] = {
  path: '01图书馆/来自个人/已完成审阅示例.md', rawSha256: sha,
  title: '已完成审阅且原文版本一致的资料', sourcePlatform: '个人',
  processingStatus: '已归档', knowledgeStatus: '未提炼', collectedAt: '2026-09-05', generatedKnowledge: []
};
const materials = [...pending, partial, completed];
const knowledgeTitles = [
  '知识需要对应具体使用场景', '用问题组织内容选题', '一条可复用经验的三个条件',
  '旧版资料整理方法', '建立持续复盘的工作节奏', '判断需要保留证据'
];
const usageStatuses = ['AI总结', '已优化', '定论', '过时', 'AI总结', '定论'] as const;
const knowledge: KnowledgePage['items'] = knowledgeTitles.map((title, index) => ({
  path: `02知识库/09学习/知识管理/${title}.md`, rawSha256: sha, title,
  createdAt: `2026-09-${String(7 - index).padStart(2, '0')}`,
  updatedAt: `2026-09-${String(7 - index).padStart(2, '0')}`,
  sourceType: 'AI提炼', usageStatus: usageStatuses[index]!, knowledgeType: '方法',
  recallFields: { topics: ['知识管理'], keywords: ['复用'], scenarios: ['整理阅读资料'],
    conclusion: '知识需要与下一次使用建立联系。', keyPoints: ['明确使用场景'], boundary: '使用前核对适用情境。' },
  sourceMaterials: [partial.path]
}));
const queueItems: ExtractionQueueItem[] = [
  ...pending.map(record => ({ materialPath: record.path, title: record.title, view: 'pending' as const,
    sourcePlatform: record.sourcePlatform, collectedAt: record.collectedAt, sourceRawSha256: sha, canExtract: true })),
  { materialPath: partial.path, title: partial.title, view: 'ready', canExtract: false, reviewComplete: false, sourceRawSha256: sha },
  { materialPath: completed.path, title: completed.title, view: 'ready', canExtract: false, reviewComplete: true,
    sourceRawSha256: completed.rawSha256, latestReadyRun: {
      id: '11111111-1111-4111-8111-111111111111', status: 'ready', createdAt: '2026-09-07T00:00:00Z',
      sourceRawSha256: sha, currentSourceSha256: completed.rawSha256,
      candidateCount: 2, pendingCandidateCount: 0, reviewComplete: true
    } }
];

const diagnostic = {
  route: '/', healthReads: 0,
  materialQueries: [] as Parameters<ReadConsoleApi['listMaterials']>[0][],
  knowledgeQueries: [] as Parameters<ReadConsoleApi['listKnowledge']>[0][],
  queueQueries: [] as ExtractionQueueQuery[], readCalls: [] as string[], unexpectedActions: [] as string[],
  expected: { count, partial: 1, knowledge: 6, upgradeable: 3, version,
    pendingTitles: pending.map(record => record.title), pendingPaths: pending.map(record => record.path),
    excludedTitles: [partial.title, completed.title], knowledgePaths: knowledge.map(record => record.path) }
};
export type OverviewDeskDiagnostics = typeof diagnostic;
declare global { interface Window { __overviewDeskFixture: OverviewDeskDiagnostics } }
window.__overviewDeskFixture = diagnostic;
const ok = <T,>(value: T) => ({ ok: true as const, value: structuredClone(value) });
const unsupported = async (name: string): Promise<ApiClientResult<never>> => {
  diagnostic.unexpectedActions.push(name);
  return { ok: false, state: { status: 'operation-error', message: '浏览器夹具不执行这项操作。' } };
};
function pageOf<T>(items: readonly T[], query: { cursor?: string | undefined; limit?: number | undefined }) {
  const offset = Number(query.cursor?.split('.')[0] ?? 0);
  const limit = query.limit ?? 40;
  return { items: items.slice(offset, offset + limit),
    ...(offset + limit < items.length ? { nextCursor: `${offset + limit}.${sha}` } : {}) };
}
const api: ReadConsoleApi = {
  getHealth: async () => {
    diagnostic.healthReads += 1;
    return ok({ status: 'ready', vaultSource: { status: 'ready', adapter: 'filesystem', displayName: '示例大脑' },
      index: { status: 'ready', version, refreshedAt: '2026-09-07T00:00:00Z' },
      model: { status: 'configured', providerHost: 'fixture.invalid', name: 'fixture' },
      writeGate: { status: 'blocked', missing: ['WRITE_ENABLED'], fingerprintMatches: true }, schemaIssues: { status: 'available', count: 0 } });
  },
  listMaterials: async query => {
    diagnostic.materialQueries.push(structuredClone(query));
    const filtered = materials.filter(record => (!query.status || record.knowledgeStatus === query.status)
      && (!query.title || record.title.includes(query.title)) && (!query.sourcePlatform || record.sourcePlatform === query.sourcePlatform)
      && (!query.collectedFrom || record.collectedAt! >= query.collectedFrom) && (!query.collectedTo || record.collectedAt! <= query.collectedTo));
    return ok(pageOf(filtered, query));
  },
  listKnowledge: async query => {
    diagnostic.knowledgeQueries.push(structuredClone(query));
    const filtered = knowledge.filter(record => (query.includeObsolete || record.usageStatus !== '过时')
      && (!query.usageStatus || record.usageStatus === query.usageStatus) && (!query.search || record.title.includes(query.search))
      && (!query.knowledgeType || record.knowledgeType === query.knowledgeType) && (!query.topic || record.recallFields.topics.includes(query.topic)));
    return ok(pageOf(filtered, query));
  },
  listOperations: async () => { diagnostic.readCalls.push('listOperations'); return ok({ items: [] }); },
  extractionQueue: {
    list: async query => {
      diagnostic.queueQueries.push(structuredClone(query));
      const visible = queueItems.filter(item => query.visibility === 'removed' ? item.removedAt !== undefined : item.removedAt === undefined)
        .filter(item => (!query.title || item.title.includes(query.title)) && (!query.sourcePlatform || item.sourcePlatform === query.sourcePlatform)
          && (!query.collectedFrom || (item.collectedAt ?? '') >= query.collectedFrom) && (!query.collectedTo || (item.collectedAt ?? '') <= query.collectedTo));
      const selected = visible.filter(item => item.view === (query.view ?? 'pending')
        && (query.reviewState === undefined || (query.reviewState === 'complete' ? item.reviewComplete === true : item.reviewComplete !== true)));
      return ok({ ...pageOf(selected, query), counts: {
        pending: visible.filter(item => item.view === 'pending').length,
        generating: visible.filter(item => item.view === 'generating').length,
        ready: visible.filter(item => item.view === 'ready').length,
        unfinished: visible.filter(item => item.view === 'unfinished').length
      } });
    },
    get: async materialPath => ok({ item: queueItems.find(item => item.materialPath === materialPath) ?? null }),
    history: async () => ok({ items: [] }),
    setVisibility: async () => unsupported('extractionQueue.setVisibility')
  },
  extraction: {
    list: async () => { diagnostic.readCalls.push('extraction.list'); return ok({ items: [] }); },
    get: async () => unsupported('extraction.get'), preview: async () => unsupported('extraction.preview'),
    start: async () => unsupported('extraction.start'), cancel: async () => unsupported('extraction.cancel')
  },
  deepSeek: {
    get: async () => { diagnostic.readCalls.push('deepSeek.get'); return ok({ configured: true, available: true, providerHost: 'api.deepseek.com', model: 'deepseek-v4-flash' }); },
    setKey: async () => unsupported('deepSeek.setKey'), clearKey: async () => unsupported('deepSeek.clearKey')
  },
  getKnowledgeDetail: async path => {
    diagnostic.readCalls.push('getKnowledgeDetail');
    const record = knowledge.find(item => item.path === path);
    if (!record) return unsupported('getKnowledgeDetail:unknown');
    return ok({ record, path, title: record.title, markdown: `# ${record.title}\n\n这是一份只存在于当前浏览器夹具中的示例知识。`,
      internalKnowledgeLinks: [], versionMarker: { rawSha256: sha } });
  },
  getDocumentDetail: async path => {
    const record = materials.find(item => item.path === path);
    if (!record) return unsupported('getDocumentDetail:unknown');
    return ok({ path, title: record.title, markdown: `# ${record.title}\n\n这是一份内存中的示例材料。`, versionMarker: { rawSha256: sha } });
  },
  listDocumentIssues: async () => ok({ items: [] }), listLibrary: async () => unsupported('listLibrary'),
  openKnowledge: async () => unsupported('openKnowledge'), rebuildIndex: async () => unsupported('rebuildIndex'), getIndexJob: async () => unsupported('getIndexJob'),
  trash: {
    list: async () => ok({ items: [] }), get: async () => unsupported('trash.get'),
    preview: async () => unsupported('trash.preview'), commit: async () => unsupported('trash.commit'),
    restore: async () => unsupported('trash.restore'), retry: async () => unsupported('trash.retry'),
    previewDelete: async () => unsupported('trash.previewDelete'), delete: async () => unsupported('trash.delete')
  },
  intakeTrash: {
    list: async () => ok({ items: [] }), get: async () => unsupported('intakeTrash.get'),
    preview: async () => unsupported('intakeTrash.preview'), commit: async () => unsupported('intakeTrash.commit'),
    restore: async () => unsupported('intakeTrash.restore'), retry: async () => unsupported('intakeTrash.retry'),
    previewDelete: async () => unsupported('intakeTrash.previewDelete'), delete: async () => unsupported('intakeTrash.delete')
  }
};
function LocationProbe() {
  const route = useLocation();
  useEffect(() => { diagnostic.route = `${route.pathname}${route.search}`; }, [route]);
  return null;
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/']}><LocationProbe /><AppRouter api={api} /></MemoryRouter>
);
