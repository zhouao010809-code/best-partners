import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MaterialTrashProvider, useMaterialTrash } from '../../src/client/components/MaterialTrash.js';
import { useIntakeTrash } from '../../src/client/pages/intake/useIntakeTrash.js';
import { TrashPage } from '../../src/client/pages/TrashPage.js';
import { browserReadConsoleApi } from '../../src/client/api/client.js';
import type { ConsoleRuntime } from '../../src/client/app/ConsoleRuntime.js';
import type { TrashEntry } from '../../src/shared/api/trash.js';
import type { IntakeTrashEntry } from '../../src/shared/api/intake-trash.js';

const id = '62b6b258-8469-45ac-ae2e-a3c6a46af160';
const token = '6e2553b8-5a80-41c6-858b-30f98e7a91c0';
const documentEntry: TrashEntry = { id, materialPath: '01图书馆/来自个人/资料.md', title: '资料', status: 'trashed', indexed: true, createdAt: '2026-09-07T00:00:00Z' };
const packet: IntakeTrashEntry = { id, name: '剪藏资料包', title: '资料包', kind: 'directory', fileCount: 3, bytes: 2048, status: 'trashed', createdAt: documentEntry.createdAt };
const expiresAt = '2099-01-01T00:00:00Z';
const storage = { document: 'brain-trash-pending-operation', packet: 'brain-intake-trash-pending-operation' };
const ok = <T,>(value: T) => ({ ok: true as const, value });
const service = () => ({ list: vi.fn(), get: vi.fn(), preview: vi.fn(), commit: vi.fn(), restore: vi.fn(), retry: vi.fn(), previewDelete: vi.fn(), delete: vi.fn() });
const trash = service(); const intakeTrash = service();
let runtime: ConsoleRuntime;
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));

function MaterialActions({ origin = 'library' }: { origin?: 'library' | 'queue' | 'knowledge' }) {
  const controls = useMaterialTrash();
  const navigate = useNavigate(); const initialOpenDelete = useRef(controls.openDelete).current;
  return <><button onClick={() => controls.open({ path: documentEntry.materialPath, title: documentEntry.title, origin })}>移入回收站</button>
    <button onClick={() => controls.openDelete(documentEntry)}>调用删除入口</button>
    <button onClick={() => initialOpenDelete(documentEntry)}>调用旧删除入口</button>
    <button onClick={() => navigate('/library')}>离开回收站</button></>;
}
function PacketActions({ allowPermanentDelete }: { allowPermanentDelete?: boolean }) {
  const controls = useIntakeTrash(() => {}, allowPermanentDelete === undefined ? {} : { allowPermanentDelete });
  const navigate = useNavigate(); const initialOpenDelete = useRef(controls.openDelete).current;
  return <><button onClick={() => controls.open(packet)}>移入回收站</button>
    <button onClick={() => controls.openDelete(packet)}>调用删除入口</button>
    <button onClick={() => initialOpenDelete(packet)}>调用旧删除入口</button>
    <button onClick={() => navigate('/intake')}>离开回收站</button>{controls.dialog}</>;
}
beforeEach(() => {
  localStorage.clear();
  runtime = { dataRevision: 0, health: { status: 'loading' }, refreshHealth: vi.fn(async () => {}), api: { ...browserReadConsoleApi, trash, intakeTrash } };
  trash.list.mockResolvedValue(ok({ items: [documentEntry] })); intakeTrash.list.mockResolvedValue(ok({ items: [packet] }));
  trash.preview.mockResolvedValue(ok({ ...documentEntry, bytes: 500, expiresAt, referencedKnowledge: [] }));
  intakeTrash.preview.mockResolvedValue(ok({ ...packet, expiresAt }));
  trash.commit.mockResolvedValue(ok(documentEntry)); intakeTrash.commit.mockResolvedValue(ok(packet));
  trash.get.mockResolvedValue(ok({ ...documentEntry, status: 'deleting', indexed: false }));
  intakeTrash.get.mockResolvedValue(ok({ ...packet, status: 'deleting' }));
  trash.previewDelete.mockResolvedValue(ok({ ...documentEntry, bytes: 500, expiresAt, referencedKnowledge: [], token }));
  intakeTrash.previewDelete.mockResolvedValue(ok({ ...packet, expiresAt, token }));
  trash.delete.mockResolvedValue(ok({ ...documentEntry, status: 'deleted', deletedAt: documentEntry.createdAt }));
  intakeTrash.delete.mockResolvedValue(ok({ ...packet, status: 'deleted', deletedAt: packet.createdAt }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear(); });

it.each(['library', 'queue', 'knowledge'] as const)('does not offer permanent deletion after moving a document from /%s', async origin => {
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[`/${origin}`]}><MaterialTrashProvider onChanged={() => {}}><MaterialActions origin={origin} /></MaterialTrashProvider></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: '移入回收站' }));
  await user.click(await screen.findByRole('button', { name: '确认移入回收站' }));
  const dialog = await screen.findByRole('dialog', { name: '回收操作结果' });
  expect(within(dialog).queryByRole('button', { name: /彻底删除/ })).toBeNull();
  expect(within(dialog).getByRole('link', { name: '查看回收站' })).toHaveAttribute('href', '/trash');
  expect(trash.commit).toHaveBeenCalledExactlyOnceWith(id);
  expect(trash.previewDelete).not.toHaveBeenCalled(); expect(trash.delete).not.toHaveBeenCalled();
});

it.each([
  { route: '/library', allowPermanentDelete: undefined },
  { route: '/trash', allowPermanentDelete: undefined },
  { route: '/library', allowPermanentDelete: true },
])('blocks direct document delete requests at $route with capability $allowPermanentDelete', async ({ route, allowPermanentDelete }) => {
  const user = userEvent.setup();
  const capability = allowPermanentDelete === undefined ? {} : { allowPermanentDelete };
  render(<MemoryRouter initialEntries={[route]}><MaterialTrashProvider onChanged={() => {}} {...capability}><MaterialActions /></MaterialTrashProvider></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: '调用删除入口' }));
  expect(trash.previewDelete).not.toHaveBeenCalled(); expect(trash.delete).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '确认彻底删除' })).toBeNull();
});

it.each([
  { route: '/intake', allowPermanentDelete: undefined },
  { route: '/trash', allowPermanentDelete: undefined },
  { route: '/intake', allowPermanentDelete: true },
])('blocks direct packet delete requests at $route with capability $allowPermanentDelete', async ({ route, allowPermanentDelete }) => {
  const user = userEvent.setup();
  const capability = allowPermanentDelete === undefined ? {} : { allowPermanentDelete };
  render(<MemoryRouter initialEntries={[route]}><PacketActions {...capability} /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: '调用删除入口' }));
  expect(intakeTrash.previewDelete).not.toHaveBeenCalled(); expect(intakeTrash.delete).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '确认彻底删除' })).toBeNull();
});

it.each(['document', 'packet'] as const)('preserves a pending %s deletion on its source page and guides continuation to /trash', async kind => {
  const pending = { id, title: kind === 'document' ? documentEntry.title : packet.title, action: 'delete', token,
    ...(kind === 'document' ? { materialPath: documentEntry.materialPath } : { name: packet.name }) };
  localStorage.setItem(storage[kind], JSON.stringify(pending));
  const user = userEvent.setup();
  const source = render(<MemoryRouter initialEntries={[kind === 'document' ? '/library' : '/intake']}>
    {kind === 'document' ? <MaterialTrashProvider onChanged={() => {}}><MaterialActions /></MaterialTrashProvider> : <PacketActions />}
  </MemoryRouter>);
  expect(screen.queryByRole('button', { name: /重试删除|重新确认彻底删除/ })).toBeNull();
  expect(screen.getByRole('link', { name: '前往回收站处理' })).toHaveAttribute('href', '/trash');
  await user.click(screen.getByRole('button', { name: '查询本次结果' }));
  expect(await screen.findByRole('heading', { name: '正在彻底删除' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /重试删除|重新确认彻底删除/ })).toBeNull();
  expect(JSON.parse(localStorage.getItem(storage[kind])!)).toEqual(pending);
  expect(trash.delete).not.toHaveBeenCalled(); expect(intakeTrash.delete).not.toHaveBeenCalled();
  source.unmount();
  render(<MemoryRouter initialEntries={['/trash']}><TrashPage /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: '查询本次结果' }));
  await user.click(await screen.findByRole('button', { name: '重新确认彻底删除' }));
  const confirmation = await screen.findByRole('button', { name: '确认彻底删除' });
  expect(trash.delete).not.toHaveBeenCalled(); expect(intakeTrash.delete).not.toHaveBeenCalled();
  await user.click(confirmation);
  expect(await screen.findByRole('heading', { name: '已彻底删除' })).toBeVisible();
  expect((kind === 'document' ? trash : intakeTrash).delete).toHaveBeenCalledExactlyOnceWith(id, token);
});

it.each(['document', 'packet'] as const)('closes an open %s deletion preview and revokes old callbacks when leaving /trash', async kind => {
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/trash']}>
    {kind === 'document' ? <MaterialTrashProvider onChanged={() => {}} allowPermanentDelete><MaterialActions /></MaterialTrashProvider> : <PacketActions allowPermanentDelete />}
  </MemoryRouter>);
  await user.click(screen.getByRole('button', { name: '调用删除入口' }));
  expect(await screen.findByRole('button', { name: '确认彻底删除' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '离开回收站' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(screen.getByRole('button', { name: '调用旧删除入口' }));
  expect((kind === 'document' ? trash : intakeTrash).previewDelete).toHaveBeenCalledTimes(1);
  expect(trash.delete).not.toHaveBeenCalled(); expect(intakeTrash.delete).not.toHaveBeenCalled();
});
