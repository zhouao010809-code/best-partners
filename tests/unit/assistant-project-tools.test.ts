import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createProjectTools } from '../../src/server/assistant/project-tools.js';
import type { ProjectService, ProjectWritePlanService } from '../../src/shared/api/projects.js';
import type { AssistantEvent } from '../../src/server/assistant/types.js';
import { PublicApiError } from '../../src/shared/api/errors.js';

const projectId = randomUUID();
const revision = 3;

function fixture(message = '分析这个项目') {
  const events: AssistantEvent[] = [];
  const readFile = vi.fn(async (_id: string, path: string) => ({
    relativePath: path,
    kind: 'file' as const,
    origin: 'source' as const,
    parseStatus: 'readable' as const,
    sha256: 'a'.repeat(64),
    content: '# 项目简报\n获客内容证据😀',
    totalCharacters: 18,
    truncated: false
  }));
  const projectService = {
    listFiles: vi.fn(async () => ({ items: [{ relativePath: 'brief.md', kind: 'file' as const, origin: 'source' as const, parseStatus: 'readable' as const, sha256: 'a'.repeat(64) }], total: 1, revision })),
    readFile,
    refresh: vi.fn(async () => ({ id: projectId, displayName: 'A项目', sourceRevision: revision, availability: 'ready' as const, outputRoot: 'AI工作区' as const, fileCount: 1, readableFileCount: 1, issueCount: 0, createdAt: '', updatedAt: '' }))
  } as unknown as ProjectService;
  const proposeDraft = vi.fn(async () => ({ id: randomUUID(), type: 'project-write' as const, label: '保存到内容草稿', status: 'pending' as const, projectId, projectName: 'A项目', category: '内容草稿' as const, targetPath: 'AI工作区/内容草稿/2026-09-22-选题.md', contentSha256: 'b'.repeat(64), sourceRevision: revision, summary: '摘要', createdAt: '2026-09-22T00:00:00.000Z', expiresAt: '2026-09-22T01:00:00.000Z' }));
  const tools = createProjectTools({ projectService, writePlans: { proposeDraft } as unknown as ProjectWritePlanService, projectId, projectRevision: revision, conversationId: randomUUID(), messageId: randomUUID(), userMessage: message, model: 'test', signal: new AbortController().signal, emit: event => events.push(event), sourceAllocator: (() => { let count = 0; return { next: () => `S${++count}` }; })() });
  return { tools, events, projectService, proposeDraft, execute: (name: string, value: unknown) => tools.find(tool => tool.name === name)!.execute(value) };
}

it('keeps project file tools bound to one project and emits opaque citations', async () => {
  const f = fixture();
  expect(await f.execute('search_project_files', { query: '获客', limit: 5 })).toMatchObject({ items: [{ path: `project:${projectId}/brief.md` }] });
  expect(f.events.find(event => event.type === 'source')).toMatchObject({ source: { path: `project:${projectId}/brief.md` } });
  await expect(f.execute('read_project_file', { path: '../B/brief.md' })).rejects.toMatchObject({ code: 'PROJECT_SCOPE_LIMIT' });
  await expect(f.execute('read_project_file', { path: `/private/${projectId}/brief.md` })).rejects.toMatchObject({ code: 'PROJECT_SCOPE_LIMIT' });
  expect(f.projectService.readFile).not.toHaveBeenCalled();
});

it('shares one source allocator with project tools and never exposes a global write primitive', async () => {
  const f = fixture();
  expect(f.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['search_project_files', 'read_project_file', 'save_project_draft', 'propose_project_edit', 'refresh_project_index']));
  expect(f.tools.map(tool => tool.name)).not.toContain('write_file');
  const first = await f.execute('search_project_files', { query: '获客', limit: 5 });
  const second = await f.execute('read_project_file', { path: 'brief.md', length: 4 });
  expect(first).toMatchObject({ items: [{ sourceId: 'S1' }] });
  expect(second).toMatchObject({ sourceId: 'S1' });
  expect((second as { markdown: string }).markdown).toBe('# 项目');
});

it('reads the path returned by project search as the same file and citation as its relative path', async () => {
  const f = fixture();
  const result = await f.execute('search_project_files', { query: '获客' }) as { items: { path: string; relativePath: string; sourceId: string }[] };
  const hit = result.items[0]!;
  await expect(f.execute('read_project_file', { path: hit.path, length: 4 })).resolves.toMatchObject({
    relativePath: hit.relativePath, path: hit.path, sourceId: hit.sourceId, markdown: '# 项目'
  });
  expect(f.projectService.readFile).toHaveBeenCalledWith(projectId, hit.relativePath);
  await expect(f.execute('read_project_file', { path: hit.relativePath, length: 4 })).resolves.toMatchObject({ sourceId: hit.sourceId });
});

it.each([
  `project:${randomUUID()}/brief.md`,
  `project:${projectId}`,
  `project:${projectId}/`,
  `project:${projectId}//brief.md`,
  `project:${projectId}/../brief.md`,
  `project:${projectId}/./brief.md`,
  `project:${projectId}/C:/brief.md`,
  `project:${projectId}/brief\\file.md`,
  `project:${projectId}/project:${projectId}/brief.md`,
  `Project:${projectId}/brief.md`,
  `project://${projectId}/brief.md`,
  `project:/brief.md`,
  '/private/brief.md',
  'file:///private/brief.md',
  'https://example.com/brief.md',
  'C:/brief.md',
  '../brief.md',
  'brief\u0000.md'
])('rejects a foreign, malformed, or unsafe project read path before reading: %s', async path => {
  const f = fixture();
  await expect(f.execute('read_project_file', { path })).rejects.toMatchObject({ code: 'PROJECT_SCOPE_LIMIT' });
  expect(f.projectService.readFile).not.toHaveBeenCalled();
});

it('reports matched search entries separately from returned files and does not imply a full inventory', async () => {
  const f = fixture();
  vi.mocked(f.projectService.listFiles).mockResolvedValueOnce({
    items: [
      { relativePath: 'brief.md', kind: 'file', origin: 'source', parseStatus: 'readable' },
      { relativePath: 'brief.docx', kind: 'file', origin: 'source', parseStatus: 'unsupported' },
      { relativePath: 'briefs', kind: 'directory', origin: 'source', parseStatus: 'unsupported' }
    ], total: 7, revision
  });
  await expect(f.execute('search_project_files', { query: 'brief', limit: 3 })).resolves.toMatchObject({
    items: [{ relativePath: 'brief.md' }, { relativePath: 'brief.docx' }], matchedCount: 7, returnedCount: 2, unsupportedCount: 1, hasMore: true,
    coverage: 'query-matches',
    message: expect.stringContaining('不代表项目文件总数'),
    readHint: expect.stringContaining('relativePath')
  });
});

it('keeps project edit proposals restricted to relative paths', async () => {
  const f = fixture();
  await expect(f.execute('propose_project_edit', {
    path: `project:${projectId}/brief.md`, replacement: '替换正文', rationale: '修正错别字'
  })).rejects.toMatchObject({ code: 'PROJECT_SCOPE_LIMIT' });
  expect(f.projectService.readFile).not.toHaveBeenCalled();
});

it('only proposes a project draft after explicit save intent', async () => {
  const f = fixture('帮我分析选题，不要保存到项目');
  await expect(f.execute('save_project_draft', { category: '内容草稿', title: '选题', summary: '摘要', content: '正文' })).rejects.toMatchObject({ code: 'ASSISTANT_INTENT_REQUIRED' });
  expect(f.proposeDraft).not.toHaveBeenCalled();

  const saving = fixture('请把这个方案保存到项目');
  await expect(saving.execute('save_project_draft', { category: '内容草稿', title: '选题', summary: '摘要', content: '正文' })).resolves.toMatchObject({ status: 'awaiting_confirmation' });
  expect(saving.proposeDraft).toHaveBeenCalledWith(expect.objectContaining({ projectId, expectedRevision: revision, content: '正文' }));
  expect(saving.events.some(event => event.type === 'action')).toBe(true);
});

it('returns a bounded edit proposal without writing source files', async () => {
  const f = fixture();
  const result = await f.execute('propose_project_edit', { path: 'brief.md', replacement: '替换正文', rationale: '修正错别字' });
  expect(result).toMatchObject({ path: 'brief.md', replacement: '替换正文', originalSha256: 'a'.repeat(64) });
  expect(f.projectService.readFile).toHaveBeenCalledWith(projectId, 'brief.md');
});
