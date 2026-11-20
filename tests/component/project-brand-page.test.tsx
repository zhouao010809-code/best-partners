// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectBrandProfile } from '../../src/shared/api/projects.js';
import { ProjectBrandPage } from '../../src/client/pages/ProjectBrandPage.js';

const empty: ProjectBrandProfile = { category: '', positioning: '', purchaseReason: '', evidence: [], claims: [], revision: 0 };
const ok = <T,>(value: T) => ({ ok: true as const, value });
const get = vi.fn();
const getBrand = vi.fn();
const saveBrand = vi.fn();
const api = { projects: { get, getBrand, saveBrand } };
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => ({ api }) }));

function renderPage() {
  return render(<MemoryRouter initialEntries={['/projects/a/brand']}>
    <Link to="/projects/b/brand">切换到乙项目</Link>
    <Routes><Route path="/projects/:id/brand" element={<ProjectBrandPage />} /></Routes>
  </MemoryRouter>);
}

beforeEach(() => {
  get.mockImplementation(async (id: string) => ok({ displayName: id === 'a' ? '甲项目' : '乙项目' }));
  getBrand.mockResolvedValue(ok(empty));
  saveBrand.mockImplementation(async (_id, { expectedRevision, ...fields }) => ok({ ...fields, revision: expectedRevision + 1 }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('keeps both editable detail tables when navigating between views and saves them with the overview', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: '编辑品牌资料' }));
  expect(within(screen.getByRole('table', { name: '项目概览' })).getAllByRole('columnheader').map(cell => cell.textContent))
    .toEqual(['项目名', '品类', '品牌定位', '购买理由']);
  await user.type(screen.getByRole('textbox', { name: '品牌定位' }), '定位甲');
  await user.click(screen.getByRole('button', { name: '添加证据' }));
  await user.type(screen.getByRole('textbox', { name: '依据 1' }), '事实甲');
  await user.type(screen.getByRole('textbox', { name: '出处 1' }), '资料一');
  await user.click(screen.getByRole('link', { name: '核心宣传主张' }));
  await user.click(screen.getByRole('button', { name: '添加主张' }));
  await user.type(screen.getByRole('textbox', { name: '主张内容 1' }), '主张甲');
  await user.click(screen.getByRole('link', { name: '证据链' }));
  expect(screen.getByRole('textbox', { name: '依据 1' })).toHaveValue('事实甲');
  await user.click(screen.getByRole('button', { name: '保存' }));
  expect(saveBrand).toHaveBeenCalledWith('a', {
    category: '', positioning: '定位甲', purchaseReason: '', evidence: [{ fact: '事实甲', source: '资料一' }],
    claims: [{ claim: '主张甲' }], expectedRevision: 0
  });
  expect(await screen.findByText('品牌资料已保存。')).toBeVisible();
  expect(within(screen.getByRole('table', { name: '证据链' })).getByText('事实甲')).toBeVisible();
  await user.click(screen.getByRole('link', { name: '核心宣传主张' }));
  expect(within(screen.getByRole('table', { name: '核心宣传主张' })).getByText('主张甲')).toBeVisible();
});

it('keeps an edit on a version conflict and fetches the new revision when the draft is explicitly discarded', async () => {
  const user = userEvent.setup();
  saveBrand.mockResolvedValueOnce({ ok: false, code: 'PROJECT_BRAND_REVISION_CONFLICT', state: { status: 'conflict', message: '已有更新。' } });
  getBrand.mockResolvedValueOnce(ok({ ...empty, revision: 2 })).mockResolvedValueOnce(ok({ ...empty, category: '最新品类', revision: 3 }));
  renderPage();
  await user.click(await screen.findByRole('button', { name: '编辑品牌资料' }));
  await user.type(screen.getByRole('textbox', { name: '品类' }), '我的草稿');
  await user.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('已有更新');
  expect(screen.getByRole('textbox', { name: '品类' })).toHaveValue('我的草稿');
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '放弃草稿并读取最新版' }));
  expect(await screen.findByText('最新品类')).toBeVisible();
});

it('resets the editor when switching project and cancels display of the old response', async () => {
  const user = userEvent.setup();
  getBrand.mockResolvedValueOnce(ok({ ...empty, category: '甲品类' })).mockResolvedValueOnce(ok(empty));
  renderPage();
  await user.click(await screen.findByRole('button', { name: '编辑品牌资料' }));
  await user.click(screen.getByRole('button', { name: '添加证据' }));
  await user.type(screen.getByRole('textbox', { name: '依据 1' }), '甲项目填写');
  const signal: AbortSignal = getBrand.mock.calls[0]![1];
  await user.click(screen.getByRole('link', { name: '切换到乙项目' }));
  expect(await screen.findByRole('link', { name: '乙项目' })).toHaveAttribute('href', '/projects/b');
  expect(screen.queryByText('甲品类')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(signal.aborted).toBe(true);
  expect(saveBrand).not.toHaveBeenCalled();
});
