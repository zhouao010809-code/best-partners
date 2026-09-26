import type { CreationReferenceSelection } from '../../shared/api/project-creations.js';
import type { ProjectFileDetail, ProjectService } from '../../shared/api/projects.js';
import { PublicApiError } from '../../shared/api/errors.js';

export function creationReferenceScopeError(): PublicApiError {
  return new PublicApiError('CREATION_REFERENCE_SCOPE', '本次只能读取已勾选的项目原始资料；如需其他资料，请先调整参考资料范围。', 403);
}

/** Preflight validates a byte-backed parsed snapshot. Only later tool reads establish model evidence. */
export async function selectedCreationProjectService(input: {
  projectService: ProjectService;
  projectId: string;
  revision: number;
  selection: CreationReferenceSelection;
  signal: AbortSignal;
}): Promise<ProjectService> {
  const paths = new Set(input.selection.paths);
  async function readSelected(id: string, path: string): Promise<ProjectFileDetail> {
    input.signal.throwIfAborted();
    if (id !== input.projectId || !paths.has(path)) throw creationReferenceScopeError();
    try {
      const detail = await input.projectService.readFile(id, path, input.signal);
      input.signal.throwIfAborted();
      if (detail.relativePath !== path || detail.kind !== 'file' || detail.origin !== 'source' || detail.parseStatus !== 'readable' || typeof detail.content !== 'string') throw new Error('Selected original source is unreadable');
      return structuredClone(detail);
    } catch {
      input.signal.throwIfAborted();
      throw new PublicApiError('CREATION_REFERENCE_UNAVAILABLE', `已选资料“${path}”已移走、不可读取或不再是原始资料。请刷新项目并重新选择参考资料后重试；本次未生成建议。`, 409);
    }
  }
  const selectedFiles: ProjectFileDetail[] = [];
  for (const path of paths) selectedFiles.push(await readSelected(input.projectId, path));
  return {
    ...input.projectService,
    async readFile(id, path) {
      input.signal.throwIfAborted();
      if (id !== input.projectId || !paths.has(path)) throw creationReferenceScopeError();
      // Both search and every fragment read use the same validated snapshot.
      // A later disk edit cannot pair new text with the earlier raw-byte hash.
      return structuredClone(selectedFiles.find(file => file.relativePath === path)!);
    },
    async listFiles(id, query) {
      input.signal.throwIfAborted();
      if (id !== input.projectId) throw creationReferenceScopeError();
      const tokens = (query.search ?? '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
      const matched = query.origin === 'output' ? [] : selectedFiles.filter(file => {
        const haystack = `${file.relativePath}\n${file.content ?? ''}`.toLocaleLowerCase();
        return tokens.every(token => haystack.includes(token));
      });
      // Filtering occurs before the requested limit; no unselected metadata or
      // global match count can escape, even for a file beyond the first page.
      return { items: matched.slice(0, query.limit ?? 50).map(({ content: _content, totalCharacters: _total, truncated: _truncated, ...metadata }) => metadata), total: matched.length, revision: input.revision };
    }
  };
}
