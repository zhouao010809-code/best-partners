import type { LibraryPage, LibraryQuery } from '../../shared/api/library.js';
import type { KnowledgeRecord, MaterialRecord } from '../../shared/domain/records.js';
import { PublicApiError } from '../../shared/api/errors.js';
import { normalizeVaultPath } from '../security/vault-path.js';
import { normalizeWikiLinkList } from '../rules/wikilinks.js';

type Identity = { kind: 'material' | 'knowledge'; path: string; title: string };
type Candidates<T> = Map<string, Map<string, T>>;
type Folder = { path: string; children: Set<string>; all: Set<string>; direct: Set<string> };
type Catalog = Omit<LibraryPage, 'indexVersion' | 'nextCursor'>;

function ordered(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? '' : path.slice(0, separator);
}

function unsafeText(path: string): boolean {
  return /[\\\u0000-\u001f\u007f]/u.test(path)
    || /%(?:2e|2f|5c|00)/iu.test(path)
    || /^[a-z][a-z0-9+.-]*:/iu.test(path)
    || path.split('/').some((part) => !part || part.startsWith('.'));
}

export function validateLibraryPath(path: string, mode: LibraryPage['mode']): void {
  if (path === '' || (mode === 'topic' && path === '@unclassified')) return;
  try {
    // Query text has already been decoded once by HTTP. These are literal
    // filesystem names, including any percent tokens; never decode them again.
    normalizeVaultPath(`${mode === 'source' ? '01图书馆' : '02知识库'}/${path}/_directory.md`, 'read');
  } catch {
    throw new PublicApiError('VALIDATION_ERROR', '资料目录路径无效。', 400, { path: 'Invalid library directory' });
  }
}

function identityFor(kind: Identity['kind'], record: MaterialRecord | KnowledgeRecord): Identity | undefined {
  try {
    const path = normalizeVaultPath(record.path, 'read');
    const root = kind === 'material' ? '01图书馆/' : '02知识库/';
    if (!path.startsWith(root) || !path.endsWith('.md')) return;
    return { kind, path, title: record.title };
  } catch { return; }
}

function addCandidate<T>(candidates: Candidates<T>, key: string, id: string, value: T): void {
  const normalized = key.trim().normalize('NFC');
  if (!normalized) return;
  const matches = candidates.get(normalized) ?? new Map<string, T>();
  matches.set(id, value);
  candidates.set(normalized, matches);
}

function unique<T>(candidates: Candidates<T>, key: string): T | undefined {
  const matches = candidates.get(key);
  return matches?.size === 1 ? matches.values().next().value : undefined;
}

function references(values: readonly string[]): string[] {
  return normalizeWikiLinkList(values).flatMap((value) => {
    const target = value.split(/[#^]/u, 1)[0]!.trim().normalize('NFC');
    return !target || target.length > 1024 || unsafeText(target) ? [] : [target];
  });
}

function knowledgeDirectory(path: string): string {
  return parentPath(path.slice('02知识库/'.length));
}

function isExplicitReference(reference: string): boolean {
  return reference.includes('/') || /\.md$/iu.test(reference);
}

function topicAssignments(materials: readonly MaterialRecord[], knowledge: readonly KnowledgeRecord[]): Map<string, string[]> {
  // Keep every indexed identity in the candidate set, including hidden originals:
  // visibility must not make an ambiguous bare link appear unique.
  const candidates: Candidates<Identity> = new Map();
  const exactCandidates: Candidates<Identity> = new Map();
  const directories: Candidates<string> = new Map();
  const exactDirectories: Candidates<string> = new Map();
  const validKnowledge: KnowledgeRecord[] = [];
  for (const [kind, records] of [['material', materials], ['knowledge', knowledge]] as const) {
    for (const record of records) {
      const identity = identityFor(kind, record);
      if (!identity) continue;
      const relative = identity.path.slice((kind === 'material' ? '01图书馆/' : '02知识库/').length);
      for (const key of [identity.path, identity.path.slice(0, -3), relative, relative.slice(0, -3)]) {
        addCandidate(exactCandidates, key, `${kind}\0${identity.path}`, identity);
      }
      for (const key of [relative.split('/').at(-1)!.slice(0, -3), identity.title]) {
        addCandidate(candidates, key, `${kind}\0${identity.path}`, identity);
      }
      if (kind === 'knowledge') {
        validKnowledge.push(record as KnowledgeRecord);
        let directory = knowledgeDirectory(identity.path);
        while (directory) {
          addCandidate(exactDirectories, directory, directory, directory);
          addCandidate(exactDirectories, `02知识库/${directory}`, directory, directory);
          addCandidate(directories, directory.split('/').at(-1)!, directory, directory);
          addCandidate(directories, folderLabel(directory, 'topic'), directory, directory);
          directory = parentPath(directory);
        }
      }
    }
  }
  const assignments = new Map<string, Set<string>>();
  const assign = (materialPath: string, directory: string) => {
    if (!directory || directory === '@unclassified') return;
    const paths = assignments.get(materialPath) ?? new Set<string>();
    paths.add(directory);
    assignments.set(materialPath, paths);
  };
  for (const material of materials) {
    for (const reference of references(material.topics ?? [])) {
      const directoryCandidates = isExplicitReference(reference) ? exactDirectories : directories;
      const noteCandidates = isExplicitReference(reference) ? exactCandidates : candidates;
      const matchCount = (directoryCandidates.get(reference)?.size ?? 0) + (noteCandidates.get(reference)?.size ?? 0);
      if (matchCount !== 1) continue;
      const directory = unique(directoryCandidates, reference);
      if (directory !== undefined) assign(material.path, directory);
      else {
        const target = unique(noteCandidates, reference);
        if (target?.kind === 'knowledge') assign(material.path, knowledgeDirectory(target.path));
      }
    }
    for (const reference of references(material.generatedKnowledge)) {
      const target = unique(isExplicitReference(reference) ? exactCandidates : candidates, reference);
      if (target?.kind === 'knowledge') assign(material.path, knowledgeDirectory(target.path));
    }
  }
  for (const record of validKnowledge) {
    for (const reference of references(record.sourceMaterials)) {
      const target = unique(isExplicitReference(reference) ? exactCandidates : candidates, reference);
      if (target?.kind === 'material') assign(target.path, knowledgeDirectory(record.path));
    }
  }
  return new Map(materials.map((material) => {
    const paths = [...(assignments.get(material.path) ?? [])];
    // A more specific membership also belongs to its ancestors; don't show the
    // same original again as a direct file at the ancestor level.
    const deepest = paths.filter((path) => !paths.some((other) => other.startsWith(`${path}/`)));
    return [material.path, deepest.length ? deepest.sort(ordered) : ['@unclassified']];
  }));
}

function folderLabel(path: string, mode: LibraryPage['mode']): string {
  if (path === '') return '全部资料';
  if (mode === 'topic' && path === '@unclassified') return '待分类';
  const name = path.split('/').at(-1)!;
  if (mode === 'source') return path.includes('/') ? name : name.replace(/^来自/u, '') || name;
  return name.replace(/^\d+[\s._、-]*/u, '') || name;
}

/** A read-only hierarchy built entirely from one index projection. */
export function buildLibraryCatalog(input: {
  materials: readonly MaterialRecord[];
  knowledge: readonly KnowledgeRecord[];
  trashed: ReadonlySet<string>;
  query: Pick<LibraryQuery, 'mode' | 'path' | 'status' | 'title'>;
}): Catalog {
  const mode = input.query.mode ?? 'topic';
  const path = input.query.path ?? '';
  validateLibraryPath(path, mode);
  const assignments = topicAssignments(input.materials, input.knowledge);
  const folders = new Map<string, Folder>();
  const ensureFolder = (directory: string): Folder => {
    const existing = folders.get(directory);
    if (existing) return existing;
    const folder: Folder = { path: directory, children: new Set(), all: new Set(), direct: new Set() };
    folders.set(directory, folder);
    if (directory) ensureFolder(parentPath(directory)).children.add(directory);
    return folder;
  };
  ensureFolder('');
  const matching = new Map<string, MaterialRecord>();
  const unclassified = new Set<string>();
  const search = input.query.title?.trim().toLocaleLowerCase();
  for (const material of input.materials) {
    if (input.trashed.has(material.path) || !identityFor('material', material)) continue;
    const topicPaths = assignments.get(material.path) ?? ['@unclassified'];
    const matches = (input.query.status === undefined || material.knowledgeStatus === input.query.status)
      && (!search || material.title.toLocaleLowerCase().includes(search));
    if (matches) {
      matching.set(material.path, material);
      if (topicPaths.includes('@unclassified')) unclassified.add(material.path);
    }
    const paths = mode === 'topic' ? topicPaths : [parentPath(material.path.slice('01图书馆/'.length))];
    for (const directory of paths) {
      const direct = ensureFolder(directory);
      if (!matches) continue;
      direct.direct.add(material.path);
      let current = directory;
      while (true) {
        ensureFolder(current).all.add(material.path);
        if (!current) break;
        current = parentPath(current);
      }
    }
  }
  const folder = folders.get(path);
  if (!folder) throw new PublicApiError('LIBRARY_FOLDER_NOT_FOUND', '这个资料目录已不存在，请返回全部资料或刷新。', 404);
  const breadcrumbPaths = [''];
  if (path) {
    const parts = path.split('/');
    for (let length = 1; length <= parts.length; length += 1) breadcrumbPaths.push(parts.slice(0, length).join('/'));
  }
  const selected = search ? folder.all : folder.direct;
  return {
    mode, path,
    breadcrumbs: breadcrumbPaths.map((path) => ({ path, label: folderLabel(path, mode) })),
    folders: search ? [] : [...folder.children].sort(ordered).map((path) => folders.get(path)!)
      .filter((child) => child.all.size > 0)
      .map((child) => ({ path: child.path, label: folderLabel(child.path, mode), count: child.all.size,
        folderCount: [...child.children].filter((path) => folders.get(path)!.all.size > 0).length })),
    items: [...selected].sort(ordered).map((path) => matching.get(path)!),
    total: folder.all.size,
    directTotal: selected.size,
    unclassifiedCount: unclassified.size
  };
}
