import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import { ProjectCreativeProfile } from '../../src/client/components/projects/ProjectCreativeProfile.js';

afterEach(cleanup);
const ok = <T,>(value: T) => ({ ok: true as const, value });
const blank = { projectId: 'project-a', revision: 0, audience: '', goal: '', style: '', facts: '', avoid: '', samples: [] };
const candidate = { id: 'suggestion', task: 'profile', reply: '', topics: [], createdAt: '2026-09-26', profile: { audience: '新手创作者', goal: '讲清实践方法', style: '简洁', facts: '', avoid: '夸大承诺' }, sources: [{ id: 'P1', title: '采访笔记', path: 'project:project-a/采访.md', kind: 'project', excerpt: '' }] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const getProfile = vi.fn(async () => ok(blank));
  const saveProfile = vi.fn(async (_projectId: string, input: Record<string, unknown>) => ok({ ...blank, ...input, revision: Number(input.expectedRevision) + 1 }));
  const suggest = vi.fn(async () => ok(candidate));
  const list = vi.fn(async () => ok({ items: [] }));
  const get = vi.fn();
  const api = { creations: { getProfile, saveProfile, suggest, list, get } } as unknown as ReadConsoleApi;
  return { api, getProfile, saveProfile, suggest, list, get };
}

it.each(['conflict', 'operation-error'])('keeps typed fields after a %s and requires an explicit save', async status => {
  const f = fixture(); const user = userEvent.setup();
  f.saveProfile.mockResolvedValueOnce({ ok: false, state: { status, message: '项目档案已被另一个窗口修改' } } as never);
  render(<ProjectCreativeProfile api={f.api} projectId="project-a" />);
  await user.click(screen.getByRole('button', { name: /项目创作档案/u }));
  await waitFor(() => expect(screen.getByLabelText('受众')).toBeEnabled());
  await user.type(screen.getByLabelText('受众'), '我的受众');
  expect(f.saveProfile).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '保存项目档案' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('另一个窗口');
  expect(screen.getByLabelText('受众')).toHaveValue('我的受众');
  expect(f.saveProfile).toHaveBeenCalledWith('project-a', expect.objectContaining({ audience: '我的受众', expectedRevision: 0 }));
});

it('previews fields and actual sources before adoption; adoption still does not save', async () => {
  const f = fixture(); const user = userEvent.setup();
  render(<ProjectCreativeProfile api={f.api} projectId="project-a" />);
  await user.click(screen.getByRole('button', { name: /项目创作档案/u }));
  await waitFor(() => expect(screen.getByLabelText('受众')).toBeEnabled());
  expect(f.suggest).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '从资料整理' }));
  expect(await screen.findByText('新手创作者')).toBeVisible();
  expect(screen.getByText('采访笔记')).toBeVisible();
  expect(screen.getByLabelText('受众')).toHaveValue('');
  await user.click(screen.getByRole('button', { name: '采用到表单' }));
  expect(screen.getByLabelText('受众')).toHaveValue('新手创作者');
  expect(f.saveProfile).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '保存项目档案' }));
  await waitFor(() => expect(f.saveProfile).toHaveBeenCalledTimes(1));
});

it('does not adopt a late candidate over edits made while it was generating', async () => {
  const f = fixture(); const user = userEvent.setup(); const late = deferred<ReturnType<typeof ok<typeof candidate>>>();
  f.suggest.mockReturnValueOnce(late.promise);
  render(<ProjectCreativeProfile api={f.api} projectId="project-a" />);
  await user.click(screen.getByRole('button', { name: /项目创作档案/u }));
  await waitFor(() => expect(screen.getByLabelText('受众')).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '从资料整理' }));
  await user.type(screen.getByLabelText('受众'), '新填写不能覆盖');
  await act(async () => late.resolve(ok(candidate)));
  expect(screen.getByRole('button', { name: '采用到表单' })).toBeDisabled();
  expect(screen.getByLabelText('受众')).toHaveValue('新填写不能覆盖');
});

it('discards a profile candidate without changing or saving typed fields', async () => {
  const f = fixture(); const user = userEvent.setup();
  render(<ProjectCreativeProfile api={f.api} projectId="project-a" />);
  await user.click(screen.getByRole('button', { name: /项目创作档案/u }));
  await waitFor(() => expect(screen.getByLabelText('受众')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('受众'), { target: { value: '我的手动填写' } });
  await user.click(screen.getByRole('button', { name: '从资料整理' }));
  await user.click(await screen.findByRole('button', { name: '放弃候选' }));
  expect(screen.queryByRole('region', { name: '档案候选预览' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('受众')).toHaveValue('我的手动填写');
  expect(f.saveProfile).not.toHaveBeenCalled();
});

it.each([false, true])('refreshes profile after lifecycle changes without overwriting dirty fields: %s', async dirty => {
  const f = fixture(); const onSaved = vi.fn(); const user = userEvent.setup();
  f.getProfile.mockResolvedValueOnce(ok({ ...blank, audience: '之前的受众', revision: 1 }));
  render(<ProjectCreativeProfile api={f.api} projectId="project-a" onSaved={onSaved} />);
  await user.click(screen.getByRole('button', { name: /项目创作档案/u }));
  await waitFor(() => expect(screen.getByLabelText('受众')).toHaveValue('之前的受众'));
  if (dirty) {
    fireEvent.change(screen.getByLabelText('受众'), { target: { value: '未保存的填写' } });
    await user.click(screen.getByRole('button', { name: '从资料整理' }));
    expect(await screen.findByRole('button', { name: '采用到表单' })).toBeEnabled();
  }
  f.getProfile.mockResolvedValue(ok({ ...blank, audience: '外部更新的受众', revision: 2 }));
  act(() => window.dispatchEvent(new CustomEvent('project-creation-lifecycle', { detail: { projectId: 'project-a' } })));
  await waitFor(() => expect(onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2 })));
  expect(screen.getByLabelText('受众')).toHaveValue(dirty ? '未保存的填写' : '外部更新的受众');
  if (dirty) {
    expect(screen.getByRole('button', { name: '保存项目档案' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '采用到表单' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '读取最新档案，保留我的填写' }));
    await user.click(screen.getByRole('button', { name: '保存项目档案' }));
    expect(f.saveProfile).toHaveBeenLastCalledWith('project-a', expect.objectContaining({ expectedRevision: 2, audience: '未保存的填写' }));
  }
});

it('does not let an older save response replace a newer profile learned from recycling a sample', async () => {
  const f = fixture(); const user = userEvent.setup(); const onSaved = vi.fn();
  f.getProfile.mockResolvedValueOnce(ok({ ...blank, revision: 1 }));
  const pendingSave = deferred<ReturnType<typeof ok<typeof blank>>>(); f.saveProfile.mockReturnValueOnce(pendingSave.promise);
  render(<ProjectCreativeProfile api={f.api} projectId="project-a" onSaved={onSaved} />);
  await user.click(screen.getByRole('button', { name: /项目创作档案/u }));
  await waitFor(() => expect(screen.getByLabelText('受众')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('受众'), { target: { value: '提交中的填写' } });
  await user.click(screen.getByRole('button', { name: '保存项目档案' }));
  f.getProfile.mockResolvedValue(ok({ ...blank, revision: 3, audience: '回收样稿后的新档案' }));
  act(() => window.dispatchEvent(new CustomEvent('project-creation-lifecycle', { detail: { projectId: 'project-a' } })));
  await waitFor(() => expect(onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 3 })));
  await act(async () => pendingSave.resolve(ok({ ...blank, revision: 2, audience: '提交中的填写' })));
  expect(onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 3 }));
  expect(screen.getByRole('button', { name: '保存项目档案' })).toBeDisabled();
  expect(screen.getByLabelText('受众')).toHaveValue('提交中的填写');
});

it('keeps edits made during saving and notifies with the saved profile only', async () => {
  const f = fixture(); const user = userEvent.setup(); const late = deferred<ReturnType<typeof ok<typeof blank>>>(); const onSaved = vi.fn();
  f.saveProfile.mockReturnValueOnce(late.promise);
  render(<ProjectCreativeProfile api={f.api} projectId="project-a" onSaved={onSaved} />);
  await user.click(screen.getByRole('button', { name: /项目创作档案/u }));
  await waitFor(() => expect(screen.getByLabelText('受众')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('受众'), { target: { value: '已提交' } });
  await user.click(screen.getByRole('button', { name: '保存项目档案' }));
  fireEvent.change(screen.getByLabelText('受众'), { target: { value: '继续编辑' } });
  await act(async () => late.resolve(ok({ ...blank, revision: 1, audience: '已提交' })));
  expect(screen.getByLabelText('受众')).toHaveValue('继续编辑');
  expect(screen.getByText(/未保存的填写不会用于创作/u)).toBeVisible();
  expect(onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ audience: '已提交', revision: 1 }));
});

it('ignores late results and aborts generation after switching project', async () => {
  const f = fixture(); const user = userEvent.setup(); const late = deferred<ReturnType<typeof ok<typeof candidate>>>();
  f.suggest.mockReturnValueOnce(late.promise);
  const view = render(<ProjectCreativeProfile api={f.api} projectId="project-a" />);
  await user.click(screen.getByRole('button', { name: /项目创作档案/u }));
  await waitFor(() => expect(screen.getByLabelText('受众')).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '从资料整理' }));
  const signal = (f.suggest.mock.calls[0] as unknown as [string, unknown, AbortSignal])[2];
  f.getProfile.mockResolvedValueOnce(ok({ ...blank, projectId: 'project-b' }));
  view.rerender(<ProjectCreativeProfile api={f.api} projectId="project-b" />);
  await act(async () => late.resolve(ok(candidate)));
  expect(signal.aborted).toBe(true);
  expect(screen.queryByText('新手创作者')).not.toBeInTheDocument();
});

it('keeps a previously selected immutable sample when the creation gets a newer final version', async () => {
  const f = fixture(); const user = userEvent.setup();
  const selected = { creationId: 'creation-1', versionId: 'version-1' };
  f.getProfile.mockResolvedValueOnce(ok({ ...blank, revision: 1, samples: [selected] } as never));
  f.list.mockResolvedValueOnce(ok({ items: [{ id: 'creation-1', projectId: 'project-a', title: '新版标题', finalVersionId: 'version-2' }] } as never));
  f.get.mockResolvedValue(ok({ item: { id: 'creation-1', projectId: 'project-a', finalVersionId: 'version-2' }, versions: [{ id: 'version-1', creationId: 'creation-1', number: 1, title: '当时的标题' }, { id: 'version-2', creationId: 'creation-1', number: 2, title: '新版标题' }] }));
  render(<ProjectCreativeProfile api={f.api} projectId="project-a" />);
  await user.click(screen.getByRole('button', { name: /项目创作档案/u }));
  await user.click(await screen.findByText('定稿范例'));
  expect(await screen.findByText('当时的标题 · 第 1 版')).toBeVisible();
  fireEvent.change(screen.getByLabelText('受众'), { target: { value: '仍用旧定稿' } });
  await user.click(screen.getByRole('button', { name: '保存项目档案' }));
  expect(f.saveProfile).toHaveBeenCalledWith('project-a', expect.objectContaining({ samples: [selected] }));
});

it('reports the initially saved revision and preserves typed fields when switching to compact mode', async () => {
  const f = fixture(); const onSaved = vi.fn(); const user = userEvent.setup();
  f.getProfile.mockResolvedValueOnce(ok({ ...blank, revision: 4 }));
  const view = render(<ProjectCreativeProfile api={f.api} projectId="project-a" onSaved={onSaved} />);
  await user.click(screen.getByRole('button', { name: /项目创作档案/u }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 })));
  fireEvent.change(screen.getByLabelText('受众'), { target: { value: '尚未保存' } });
  view.rerender(<ProjectCreativeProfile api={f.api} projectId="project-a" onSaved={onSaved} compact />);
  expect(screen.queryByLabelText('受众')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /项目创作档案/u }));
  expect(screen.getByLabelText('受众')).toHaveValue('尚未保存');
});

it('reloads the current revision after a conflict without replacing the user edits', async () => {
  const f = fixture(); const user = userEvent.setup();
  f.saveProfile.mockResolvedValueOnce({ ok: false, state: { status: 'conflict', message: '版本冲突' } } as never);
  render(<ProjectCreativeProfile api={f.api} projectId="project-a" />);
  await user.click(screen.getByRole('button', { name: /项目创作档案/u }));
  await waitFor(() => expect(screen.getByLabelText('受众')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('受众'), { target: { value: '我的填写' } });
  await user.click(screen.getByRole('button', { name: '保存项目档案' }));
  f.getProfile.mockResolvedValueOnce(ok({ ...blank, audience: '另一窗口保存的值', revision: 2 }));
  await user.click(await screen.findByRole('button', { name: '读取最新档案，保留我的填写' }));
  expect(screen.getByLabelText('受众')).toHaveValue('我的填写');
  expect(screen.getByText('当前生效档案 · 第 2 版')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '保存项目档案' }));
  expect(f.saveProfile).toHaveBeenLastCalledWith('project-a', expect.objectContaining({ audience: '我的填写', expectedRevision: 2 }));
});

it('limits selected samples to three and never offers another project creations', async () => {
  const f = fixture(); const user = userEvent.setup();
  f.getProfile.mockResolvedValueOnce(ok({ ...blank, revision: 1, samples: [1, 2, 3].map(id => ({ creationId: `creation-${id}`, versionId: `version-${id}` })) } as never));
  f.list.mockResolvedValueOnce(ok({ items: [{ id: 'creation-4', projectId: 'project-a', title: '本项目可选定稿', finalVersionId: 'version-4' }, { id: 'other-creation', projectId: 'project-b', title: '其他项目保密稿件', finalVersionId: 'other-version' }] } as never));
  f.get.mockImplementation(async (_project: string, id: string) => ok({ item: { id, projectId: 'project-a' }, versions: [{ id: id.replace('creation', 'version'), creationId: id, number: 1, title: id }] }));
  render(<ProjectCreativeProfile api={f.api} projectId="project-a" />);
  await user.click(screen.getByRole('button', { name: /项目创作档案/u }));
  await user.click(await screen.findByText('定稿范例'));
  expect(await screen.findByRole('button', { name: '本项目可选定稿 · 选择定稿' })).toBeDisabled();
  expect(screen.queryByText('其他项目保密稿件')).not.toBeInTheDocument();
  expect(f.get.mock.calls.every(call => call[0] === 'project-a')).toBe(true);
});
