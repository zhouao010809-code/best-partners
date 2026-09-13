import { AppError, PublicApiError } from '../../shared/api/errors.js';
import type { KnowledgeCatalogPage } from '../../shared/api/knowledge-catalog.js';
import type { KnowledgeRecord } from '../../shared/domain/records.js';
import type { ReadVaultGateway } from '../vault/VaultGateway.js';
import { validateFilesystemPath } from '../vault/filesystem-path.js';

const ROOT = '02知识库';
const ordered = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export function knowledgeDirectoryPath(path: string): string {
  try {
    return validateFilesystemPath(path ? `${ROOT}/${path}` : ROOT, 'directory');
  } catch {
    throw new PublicApiError('VALIDATION_ERROR', '知识目录路径无效。', 400, { path: 'Invalid knowledge directory' });
  }
}

/** One live directory listing, with literal filesystem identities preserved. */
export async function readKnowledgeDirectory(gateway: ReadVaultGateway, path: string): Promise<readonly string[]> {
  const directory = knowledgeDirectoryPath(path);
  let entries: readonly string[];
  try {
    entries = await gateway.listDirectory(directory);
  } catch (error) {
    if (error instanceof AppError && (error.statusCode === 404 || error.code === 'NOT_FOUND' || error.code === 'TYPE_MISMATCH')) {
      throw new PublicApiError('KNOWLEDGE_FOLDER_NOT_FOUND', '这个知识目录已不存在，请返回知识书柜或刷新。', 404);
    }
    throw new PublicApiError('KNOWLEDGE_DIRECTORY_UNAVAILABLE', '暂时无法读取知识目录，请重试。', 503);
  }
  const seen = new Set<string>();
  const visible: string[] = [];
  for (const entry of entries) {
    const name = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    if (!name || name === '.' || name === '..' || /[/\\\u0000-\u001f\u007f]/u.test(name) || seen.has(name)) {
      throw new PublicApiError('KNOWLEDGE_DIRECTORY_INVALID', '知识目录响应无效，请刷新后重试。', 502);
    }
    seen.add(name);
    if (name.startsWith('.')) continue;
    try { validateFilesystemPath(`${directory}/${name}`, entry.endsWith('/') ? 'directory' : 'file'); }
    catch { throw new PublicApiError('KNOWLEDGE_DIRECTORY_INVALID', '知识目录响应无效，请刷新后重试。', 502); }
    visible.push(entry);
  }
  return visible.sort(ordered);
}

function label(path: string): string {
  if (!path) return '知识书柜';
  const name = path.split('/').at(-1)!;
  return name.replace(/^\d+[\s._、-]*/u, '') || name;
}

/** Records have already passed the shared knowledge filters, before pagination. */
export function buildKnowledgeCatalog(input: {
  path: string;
  entries: readonly string[];
  records: readonly KnowledgeRecord[];
  search?: string;
}): Omit<KnowledgeCatalogPage, 'indexVersion' | 'nextCursor'> {
  const prefix = `${knowledgeDirectoryPath(input.path)}/`;
  const records = input.records.filter((record) => record.path.startsWith(prefix))
    .sort((left, right) => ordered(left.path, right.path));
  const searching = Boolean(input.search?.trim());
  const direct = searching ? records : records.filter((record) => !record.path.slice(prefix.length).includes('/'));
  const counts = new Map<string, number>();
  for (const record of records) {
    const relative = record.path.slice(prefix.length);
    const separator = relative.indexOf('/');
    if (separator >= 0) {
      const name = relative.slice(0, separator);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const paths = [''];
  const parts = input.path ? input.path.split('/') : [];
  for (let length = 1; length <= parts.length; length += 1) paths.push(parts.slice(0, length).join('/'));
  return {
    path: input.path,
    breadcrumbs: paths.map((path) => ({ path, label: label(path) })),
    folders: searching ? [] : input.entries.filter((entry) => entry.endsWith('/')).map((entry) => {
      const name = entry.slice(0, -1);
      const path = input.path ? `${input.path}/${name}` : name;
      return { path, label: label(path), count: counts.get(name) ?? 0 };
    }),
    items: direct,
    total: records.length,
    directTotal: direct.length
  };
}
