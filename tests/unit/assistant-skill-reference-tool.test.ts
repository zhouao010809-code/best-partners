import { expect, it, vi } from 'vitest';
import { createSkillReferenceTool } from '../../src/server/assistant/skill-reference-tool.js';

function fixture(markdown = 'abc😀def') {
  const controller = new AbortController();
  const paths = Array.from({ length: 11 }, (_, index) => `references/${index}.md`);
  const readReference = vi.fn(async (_id: string, path: string, _revision: string) => ({ path, revision: 'r1', markdown }));
  const tool = createSkillReferenceTool({ skillId: 'selected', skillRevision: 'confirmed', references: paths, readReference, signal: controller.signal });
  return { controller, paths, readReference, tool };
}

it('rejects unlisted paths and attempts to override the selected skill before reading', async () => {
  const f = fixture();
  for (const path of ['../SKILL.md', '/etc/passwd', 'references/unknown.md']) {
    await expect(f.tool.execute({ path })).rejects.toMatchObject({ code: 'ASSISTANT_SKILL_REFERENCE_NOT_ALLOWED' });
  }
  await expect(f.tool.execute({ path: f.paths[0], skillId: 'another' })).rejects.toMatchObject({ code: 'ASSISTANT_TOOL_INPUT_INVALID' });
  expect(f.readReference).not.toHaveBeenCalled();
});

it('paginates without splitting a surrogate pair and pins the confirmed skill', async () => {
  const f = fixture();
  expect(await f.tool.execute({ path: f.paths[0], length: 4 })).toMatchObject({ content: 'abc', nextOffset: 3, truncated: true });
  expect(await f.tool.execute({ path: f.paths[0], offset: 3, length: 5 })).toMatchObject({ content: '😀def', nextOffset: 8, truncated: false });
  expect(f.readReference).toHaveBeenCalledWith('selected', f.paths[0], 'confirmed');
});

it('rejects a fragment too short to advance past an emoji', async () => {
  const f = fixture('😀text');
  await expect(f.tool.execute({ path: f.paths[0], length: 1 })).rejects.toMatchObject({ code: 'ASSISTANT_TOOL_INPUT_INVALID' });
});

it('rejects an offset inside a surrogate pair', async () => {
  const f = fixture('😀text');
  await expect(f.tool.execute({ path: f.paths[0], offset: 1, length: 2 })).rejects.toMatchObject({ code: 'ASSISTANT_TOOL_INPUT_INVALID' });
});

it('rejects a reference changed between fragments', async () => {
  const f = fixture();
  await f.tool.execute({ path: f.paths[0], length: 2 });
  f.readReference.mockResolvedValueOnce({ path: f.paths[0]!, revision: 'r2', markdown: 'changed' });
  await expect(f.tool.execute({ path: f.paths[0], offset: 2 })).rejects.toMatchObject({ code: 'ASSISTANT_SKILL_REFERENCE_CHANGED' });
});

it('revokes reads after cancellation, including an in-flight result', async () => {
  const f = fixture();
  let finish!: () => void;
  f.readReference.mockImplementationOnce(async (_id, path) => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { path, revision: 'r1', markdown: 'private' };
  });
  const pending = f.tool.execute({ path: f.paths[0] });
  f.controller.abort();
  finish();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await expect(f.tool.execute({ path: f.paths[0] })).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.readReference).toHaveBeenCalledTimes(1);
});

it('enforces document and character budgets', async () => {
  const f = fixture('a'.repeat(12_000));
  for (let index = 0; index < 10; index++) await f.tool.execute({ path: f.paths[index], length: 1 });
  await expect(f.tool.execute({ path: f.paths[10], length: 1 })).rejects.toMatchObject({ code: 'ASSISTANT_READ_LIMIT' });
  const g = fixture('a'.repeat(12_000));
  for (let index = 0; index < 5; index++) await g.tool.execute({ path: g.paths[0], length: 12_000 });
  await expect(g.tool.execute({ path: g.paths[0], length: 1 })).rejects.toMatchObject({ code: 'ASSISTANT_READ_LIMIT' });
  expect(g.readReference).toHaveBeenCalledTimes(5);
});

it('reserves the budget for concurrent reads', async () => {
  const f = fixture();
  let finish!: () => void;
  const pendingRead = new Promise<void>(resolve => { finish = resolve; });
  f.readReference.mockImplementation(async (_id, path) => {
    await pendingRead;
    return { path, revision: 'r1', markdown: 'a'.repeat(12_000) };
  });
  const pending = Array.from({ length: 5 }, () => f.tool.execute({ path: f.paths[0], length: 12_000 }));
  await expect(f.tool.execute({ path: f.paths[0], length: 1 })).rejects.toMatchObject({ code: 'ASSISTANT_READ_LIMIT' });
  finish();
  await Promise.all(pending);
  expect(f.readReference).toHaveBeenCalledTimes(5);
});

it('masks internal filesystem failures and rejects invalid ranges', async () => {
  const f = fixture();
  f.readReference.mockRejectedValueOnce(new Error('EACCES /Users/private/secret'));
  await expect(f.tool.execute({ path: f.paths[0] })).rejects.toMatchObject({ code: 'ASSISTANT_SKILL_REFERENCE_FAILED', message: '无法读取这份 Skill 参考文档，请刷新 Skill 库后重试。' });
  for (const args of [{ offset: 100 }, { offset: -1 }, { length: 12001 }]) {
    await expect(f.tool.execute({ path: f.paths[0], ...args })).rejects.toMatchObject({ code: 'ASSISTANT_TOOL_INPUT_INVALID' });
  }
});
