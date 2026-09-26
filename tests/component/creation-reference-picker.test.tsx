import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { ProjectFile } from '../../src/shared/api/projects.js';
import { CreationReferencePicker } from '../../src/client/components/projects/CreationReferencePicker.js';

afterEach(cleanup);
const ok = <T,>(value: T) => ({ ok: true as const, value });
const file = (relativePath: string, extra: Partial<ProjectFile> = {}): ProjectFile => ({ relativePath, kind: 'file', origin: 'source', parseStatus: 'readable', ...extra });
function fixture(items: ProjectFile[]) {
  const files = vi.fn(async (_id: string, query: { search?: string }) => ok({ items: items.filter(item => !query.search || item.relativePath.includes(query.search)), total: items.length, revision: 1 }));
  const read = vi.fn(async (_id: string, path: string) => ok(file(path)));
  return { files, read, api: { projects: { files, file: read } } as unknown as ReadConsoleApi };
}
async function expand() { const user = userEvent.setup(); await user.click(screen.getByText('本条参考资料')); return user; }

it('only enables readable source files and applies a nonempty choice explicitly', async () => {
  const f = fixture([file('采访.md'), file('图片.png', { parseStatus: 'unsupported' }), file('文件夹', { kind: 'directory' }), file('AI工作区/草稿.md', { origin: 'output' })]); const changed = vi.fn();
  render(<CreationReferencePicker api={f.api} projectId="project-a" onChange={changed} />);
  const user = await expand();
  await user.click(screen.getByRole('radio', { name: '只用所选资料' }));
  expect(screen.getByRole('button', { name: '应用资料选择' })).toBeDisabled();
  await user.click(await screen.findByRole('checkbox', { name: '采访.md' }));
  expect(screen.getByRole('checkbox', { name: /图片.png/u })).toBeDisabled();
  expect(screen.queryByRole('checkbox', { name: /文件夹/u })).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: /AI工作区/u })).not.toBeInTheDocument();
  expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '应用资料选择' }));
  expect(changed).toHaveBeenCalledWith({ mode: 'selected', paths: ['采访.md'] });
});

it('retains selected files outside the current search and prevents a 21st file', async () => {
  const items = Array.from({ length: 21 }, (_, index) => file(`资料${index}.md`)); const f = fixture(items); const changed = vi.fn();
  render(<CreationReferencePicker api={f.api} projectId="project-a" value={{ mode: 'selected', paths: items.slice(0, 20).map(item => item.relativePath) }} onChange={changed} />);
  await expand();
  expect(await screen.findByRole('checkbox', { name: '资料20.md' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: '搜索参考资料' }), { target: { value: '资料20' } });
  await waitFor(() => expect(f.files).toHaveBeenLastCalledWith('project-a', { origin: 'source', search: '资料20', limit: 200 }, expect.any(AbortSignal)));
  expect(screen.getByRole('button', { name: '移除参考资料：资料0.md' })).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
});

it('keeps missing selected paths visible without silently changing the saved selection', async () => {
  const f = fixture([]); const changed = vi.fn(); f.read.mockResolvedValueOnce({ ok: false, state: { status: 'operation-error', message: '资料不存在' } } as never);
  render(<CreationReferencePicker api={f.api} projectId="project-a" value={{ mode: 'selected', paths: ['已移走.md'] }} onChange={changed} />);
  await expand();
  expect(await screen.findByText(/资料不存在/u)).toBeVisible();
  expect(screen.getByRole('button', { name: '移除参考资料：已移走.md' })).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
});

it('discards delayed file results when the selected project changes', async () => {
  const f = fixture([]); let resolve!: (value: ReturnType<typeof ok<{ items: ProjectFile[]; total: number; revision: number }>>) => void;
  f.files.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const view = render(<CreationReferencePicker api={f.api} projectId="project-a" onChange={vi.fn()} />);
  const user = await expand(); await user.click(screen.getByRole('radio', { name: '只用所选资料' }));
  view.rerender(<CreationReferencePicker api={f.api} projectId="project-b" onChange={vi.fn()} />);
  await act(async () => resolve(ok({ items: [file('旧项目资料.md')], total: 1, revision: 1 })));
  await expand(); await user.click(screen.getByRole('radio', { name: '只用所选资料' }));
  expect(screen.queryByText('旧项目资料.md')).not.toBeInTheDocument();
});
