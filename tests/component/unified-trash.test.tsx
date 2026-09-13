import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppRouter } from '../../src/client/app/router.js';
import { browserReadConsoleApi } from '../../src/client/api/client.js';
import type { ConsoleRuntime } from '../../src/client/app/ConsoleRuntime.js';
import { KnowledgeDetail } from '../../src/client/components/KnowledgeDetail.js';
import { MaterialTrashProvider } from '../../src/client/components/MaterialTrash.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const base = { status: 'trashed' as const, createdAt: '2026-09-07T00:00:00Z', indexed: true };
const documents = [
  { ...base, id: '11111111-1111-4111-8111-111111111111', title: '采访原文', materialPath: '01图书馆/来自个人/采访原文.md' },
  { ...base, id: '22222222-2222-4222-8222-222222222222', title: '等待提炼', materialPath: '01图书馆/来自个人/等待提炼.md', origin: 'queue' as const },
  { ...base, id: '33333333-3333-4333-8333-333333333333', title: '知识方法', materialPath: '02知识库/方法/知识方法.md', origin: 'knowledge' as const }
];
const packet = { id: '44444444-4444-4444-8444-444444444444', title: '剪藏资料包', name: '资料包', kind: 'directory' as const, fileCount: 3, bytes: 2048, status: 'trashed' as const, createdAt: base.createdAt };
const token = '55555555-5555-4555-8555-555555555555';
const trash = { list: vi.fn(), get: vi.fn(), preview: vi.fn(), commit: vi.fn(), restore: vi.fn(), retry: vi.fn(), previewDelete: vi.fn(), delete: vi.fn() };
const intakeTrash = { ...trash, list: vi.fn(), get: vi.fn(), preview: vi.fn(), commit: vi.fn(), restore: vi.fn(), retry: vi.fn(), previewDelete: vi.fn(), delete: vi.fn() };
let runtime: ConsoleRuntime;
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));
function open(path = '/trash') { return render(<MemoryRouter initialEntries={[path]}><AppRouter api={runtime.api} /></MemoryRouter>); }
beforeEach(() => {
  localStorage.clear();
  runtime = { health: { status: 'loading' }, dataRevision: 0, refreshHealth: vi.fn(async () => {}), api: { ...browserReadConsoleApi, trash, intakeTrash,
    getHealth: vi.fn().mockResolvedValue({ ok: false, state: { status: 'disconnected', message: '测试连接' } }) } };
  trash.list.mockResolvedValue(ok({ items: documents })); intakeTrash.list.mockResolvedValue(ok({ items: [packet] }));
  trash.restore.mockImplementation(async (id: string) => ok({ ...documents.find(item => item.id === id), status: 'restored' }));
  intakeTrash.previewDelete.mockResolvedValue(ok({ ...packet, token, expiresAt: '2099-01-01T00:00:00Z' }));
  intakeTrash.delete.mockResolvedValue(ok({ ...packet, status: 'deleted', deletedAt: base.createdAt }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear(); });

it('offers moving a single note to the recycle bin from the knowledge reader with the exact knowledge scope', async () => {
  const note = documents[2]!;
  trash.preview.mockResolvedValue(ok({ ...note, bytes: 500, expiresAt: '2099-01-01T00:00:00Z', referencedKnowledge: [] }));
  const user = userEvent.setup();
  render(<MemoryRouter><MaterialTrashProvider onChanged={() => {}}><KnowledgeDetail record={{ path: note.materialPath, title: note.title }} resource={{ status: 'loading' }} openState="idle" onClose={() => {}} onOpen={() => {}} /></MaterialTrashProvider></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: '移入回收站：知识方法' }));
  const dialog = await screen.findByRole('dialog', { name: '移入回收站' });
  expect(await within(dialog).findByText(/只移动选中的这一篇知识 Markdown/)).toBeVisible();
  expect(trash.preview).toHaveBeenCalledExactlyOnceWith(note.materialPath, 'knowledge');
  expect(trash.commit).not.toHaveBeenCalled();
});

it('opens one recycle workspace with real source counts, selectable papers, and title/path search', async () => {
  const user = userEvent.setup(); open();
  expect(await screen.findByRole('heading', { name: '回收站', level: 1 })).toBeVisible();
  expect(await screen.findByRole('tab', { name: '全部 4' })).toBeVisible();
  for (const label of ['收件箱', '档案库', '提炼队列', '知识库']) expect(screen.getByRole('tab', { name: `${label} 1` })).toBeVisible();
  expect(screen.queryByRole('button', { name: /^恢复：/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: '选择：知识方法' }));
  expect(screen.getByRole('button', { name: '恢复：知识方法' })).toBeVisible();
  await user.type(screen.getByRole('searchbox', { name: '搜索回收站' }), '来自个人');
  expect(screen.queryByRole('button', { name: '选择：知识方法' })).toBeNull();
  expect(screen.getByRole('button', { name: '选择：采访原文' })).toBeVisible();
  await user.click(screen.getByRole('tab', { name: '收件箱 1' }));
  expect(screen.getByText('没有匹配的资料')).toBeVisible();
  expect(trash.restore).not.toHaveBeenCalled(); expect(intakeTrash.delete).not.toHaveBeenCalled();
});

it('redirects the old library recycle route to the unified workspace', async () => {
  open('/library?view=trash');
  expect(await screen.findByRole('heading', { name: '回收站', level: 1 })).toBeVisible();
  expect(await screen.findByRole('tab', { name: '全部 4' })).toBeVisible();
});

it('refreshes the sidebar count when navigating to the recycle workspace after an external change', async () => {
  trash.list.mockResolvedValue(ok({ items: [] })); intakeTrash.list.mockResolvedValue(ok({ items: [] }));
  const user = userEvent.setup(); open('/not-found');
  const link = await screen.findByRole('link', { name: '回收站' });
  expect(link).toHaveTextContent('0');
  expect(link).toHaveAccessibleDescription('0 份暂存');
  trash.list.mockResolvedValue(ok({ items: documents })); intakeTrash.list.mockResolvedValue(ok({ items: [packet] }));
  await user.click(link);
  expect(await screen.findByRole('tab', { name: '全部 4' })).toBeVisible();
  expect(link).toHaveTextContent('4');
  expect(link).toHaveAccessibleDescription('4 份暂存');
});

it('shows a failed source as unavailable without inventing a zero count', async () => {
  intakeTrash.list.mockResolvedValue({ ok: false, state: { status: 'disconnected', message: '资料包服务暂不可用' } });
  open(); expect(await screen.findByRole('tab', { name: '收件箱 —' })).toBeVisible();
  expect(await screen.findByText(/收件箱：资料包服务暂不可用/)).toBeVisible();
  expect(screen.queryByText('回收站为空')).toBeNull();
  expect(screen.getByRole('tab', { name: '档案库 1' })).toBeVisible();
  const link = screen.getByRole('link', { name: '回收站' });
  expect(link).toHaveAccessibleDescription('回收站数量暂不可用');
  expect(link).not.toHaveTextContent('0');
});

it('confirms the complete packet scope and saves the token before permanently deleting it', async () => {
  intakeTrash.delete.mockImplementation(async (id: string, confirmedToken: string) => {
    expect(JSON.parse(localStorage.getItem('brain-intake-trash-pending-operation')!)).toMatchObject({ id, action: 'delete', token: confirmedToken });
    intakeTrash.list.mockResolvedValue(ok({ items: [{ ...packet, status: 'deleted', deletedAt: base.createdAt }] }));
    return ok({ ...packet, status: 'deleted', deletedAt: base.createdAt });
  });
  const user = userEvent.setup(); open();
  await user.click(await screen.findByRole('button', { name: '选择：剪藏资料包' }));
  await user.click(screen.getByRole('button', { name: '彻底删除：剪藏资料包' }));
  const dialog = await screen.findByRole('dialog', { name: '彻底删除收件箱资料包' });
  expect(within(dialog).getByText(/整个资料包及其自带附件将被彻底删除/)).toBeVisible();
  expect(intakeTrash.delete).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: '确认彻底删除' }));
  expect(await screen.findByRole('heading', { name: '已彻底删除' })).toBeVisible();
  expect(intakeTrash.delete).toHaveBeenCalledExactlyOnceWith(packet.id, token);
  expect(trash.delete).not.toHaveBeenCalled();
});
