import type { KnowledgeCatalogPage, KnowledgeCatalogQuery } from '../../../shared/api/knowledge-catalog.js';
import type { KnowledgeRecord } from '../../../shared/domain/records.js';

export type KnowledgeCatalogData = Omit<KnowledgeCatalogPage, 'items'> & { items: KnowledgeRecord[]; scope: string; seenCursors: ReadonlySet<string> };
export function catalogRecord(record: KnowledgeCatalogPage['items'][number]): KnowledgeRecord {
  const {upstreamVersion, createdAt, updatedAt, ...core} = record;
  return {...core, ...(upstreamVersion === undefined ? {} : {upstreamVersion}), ...(createdAt === undefined ? {} : {createdAt}), ...(updatedAt === undefined ? {} : {updatedAt})};
}
export const directoryLabel = (name: string): string => name.replace(/^\d+[\s._、-]*/u, '') || name;
export function noteDirectory(path: string): string {
  return path.startsWith('02知识库/') ? path.slice('02知识库/'.length).split('/').slice(0, -1).join('/') : '';
}
export function directoryCrumbs(path: string) {
  return [{path: '', label: '知识书柜'}, ...path.split('/').filter(Boolean).map((name, i, parts) => ({
    path: parts.slice(0, i + 1).join('/'), label: directoryLabel(name)
  }))];
}
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const metadata = (page: KnowledgeCatalogPage) => JSON.stringify([page.path, page.breadcrumbs, page.folders, page.total, page.directTotal, page.indexVersion]);

export function validKnowledgeCatalog(page: KnowledgeCatalogPage, query: KnowledgeCatalogQuery, prior?: KnowledgeCatalogData, cursor?: string): boolean {
  if (!page || page.path !== (query.path ?? '') || !Array.isArray(page.items) || !Array.isArray(page.folders)
    || !Array.isArray(page.breadcrumbs) || !count(page.total) || !count(page.directTotal) || page.directTotal > page.total || !count(page.indexVersion)) return false;
  const expected = directoryCrumbs(page.path);
  if (page.breadcrumbs.length !== expected.length || page.breadcrumbs.some((crumb, i) => !crumb || crumb.path !== expected[i]?.path
    || crumb.label !== expected[i]?.label)) return false;
  const folders = new Set<string>();
  const prefix = page.path ? `${page.path}/` : '';
  if (page.folders.some(folder => {
    if (!folder || typeof folder.path !== 'string' || !folder.path.startsWith(prefix) || folders.has(folder.path)
      || folder.label !== directoryLabel(folder.path.split('/').at(-1) ?? '') || !count(folder.count) || folder.count > page.total) return true;
    const child = folder.path.slice(prefix.length);
    if (!child || child.startsWith('.') || /[/\\\u0000-\u001f]/u.test(child)) return true;
    folders.add(folder.path); return false;
  })) return false;
  if (query.search && (page.folders.length !== 0 || page.directTotal !== page.total)) return false;
  if (prior && metadata(prior) !== metadata(page)) return false;
  const paths = new Set(prior?.items.map(item => item.path));
  if (page.items.some(item => {
    if (!item || typeof item.path !== 'string' || paths.has(item.path) || !item.path.startsWith(`02知识库/${prefix}`)
      || !query.search && noteDirectory(item.path) !== page.path
      || !query.includeObsolete && item.usageStatus === '过时'
      || query.usageStatus && item.usageStatus !== query.usageStatus
      || query.knowledgeType && item.knowledgeType !== query.knowledgeType
      || query.topic && !item.recallFields.topics.includes(query.topic)) return true;
    paths.add(item.path); return false;
  })) return false;
  if (page.items.length > (query.limit ?? 200) || paths.size > page.directTotal) return false;
  if (page.nextCursor !== undefined) {
    if (!page.nextCursor || page.items.length === 0 || page.nextCursor === cursor || prior?.seenCursors.has(page.nextCursor) || paths.size >= page.directTotal) return false;
  } else if (paths.size !== page.directTotal) return false;
  return true;
}
