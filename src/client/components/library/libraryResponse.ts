import type { LibraryPage, LibraryQuery } from '../../../shared/api/library.js';

export type LibraryData = LibraryPage & { scope: string; seenCursors: ReadonlySet<string> };
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const metadata = (page: LibraryPage) => JSON.stringify([
  page.mode, page.path, page.breadcrumbs, page.folders, page.total, page.directTotal, page.unclassifiedCount, page.indexVersion
]);

/** Keep a single directory snapshot across pages; never silently deduplicate corrupt responses. */
export function validLibraryPage(page: LibraryPage, query: LibraryQuery, prior?: LibraryData, cursor?: string): boolean {
  if (!page || page.mode !== query.mode || page.path !== query.path || !Array.isArray(page.items)
    || !Array.isArray(page.folders) || !Array.isArray(page.breadcrumbs)
    || !count(page.total) || !count(page.directTotal) || page.directTotal > page.total
    || !count(page.unclassifiedCount) || !count(page.indexVersion)
    || page.breadcrumbs.length === 0 || page.breadcrumbs[0]?.path !== '' || page.breadcrumbs[0]?.label !== '全部资料'
    || page.breadcrumbs.at(-1)?.path !== page.path) return false;

  const pathParts = page.path ? page.path.split('/') : [];
  if (page.breadcrumbs.length !== pathParts.length + 1
    || page.breadcrumbs.some((crumb, index) => !crumb || typeof crumb.label !== 'string' || !crumb.label.trim()
      || crumb.path !== pathParts.slice(0, index).join('/'))) return false;
  const folderPaths = new Set<string>();
  if (page.folders.some((folder) => {
    if (!folder || typeof folder.path !== 'string' || typeof folder.label !== 'string' || !folder.label.trim()
      || !count(folder.count) || folder.count > page.total || !count(folder.folderCount) || folderPaths.has(folder.path)) return true;
    const prefix = page.path ? `${page.path}/` : '';
    const child = folder.path.slice(prefix.length);
    if (!folder.path.startsWith(prefix) || !child || child.includes('/') || child === '.' || child === '..') return true;
    folderPaths.add(folder.path); return false;
  })) return false;
  if (query.title && (page.folders.length !== 0 || page.total !== page.directTotal)) return false;
  if (prior && metadata(page) !== metadata(prior)) return false;

  const paths = new Set(prior?.items.map((record) => record.path));
  if (page.items.some((record) => {
    if (!record || typeof record.path !== 'string' || typeof record.title !== 'string' || paths.has(record.path)
      || query.status !== undefined && record.knowledgeStatus !== query.status
      || query.title && !record.title.toLocaleLowerCase().includes(query.title.toLocaleLowerCase())) return true;
    paths.add(record.path); return false;
  })) return false;
  if (page.items.length > (query.limit ?? 200) || paths.size > page.directTotal) return false;
  if (page.nextCursor !== undefined) {
    if (typeof page.nextCursor !== 'string' || !page.nextCursor || page.items.length === 0 || paths.size >= page.directTotal
      || page.nextCursor === cursor || prior?.seenCursors.has(page.nextCursor)) return false;
  } else if (paths.size !== page.directTotal) return false;
  return true;
}
