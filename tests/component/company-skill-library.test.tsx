// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CompanyAppShell } from '../../src/client/company/CompanyAppShell.js';
import { CompanySkillLibraryPage } from '../../src/client/pages/company/CompanySkillLibraryPage.js';
import type { CompanyApi } from '../../src/client/components/company/company-api.js';

const revision = 'a'.repeat(64);
const session = { user: { id: 'operator', displayName: '老板', role: 'operator' as const }, csrfToken: 'c'.repeat(43) };
const summary = { id: revision, name: '教育内容策划', description: '教育项目的方法论', revision, folderId: null, folderName: null };
const detail = { ...summary, markdown: '# 教育内容策划\n\n这是方法正文。', references: ['REFERENCE.md'] };

function apiFixture(): CompanyApi {
  return {
    auth: { bootstrap: vi.fn(), login: vi.fn(), session: vi.fn(async () => ({ ok: true as const, value: session })), logout: vi.fn() },
    projects: { list: vi.fn(), scan: vi.fn(), draft: vi.fn(), confirm: vi.fn(), get: vi.fn() },
    skills: { list: vi.fn(async () => ({ ok: true as const, value: { folders: [], items: [summary] } })), get: vi.fn(async () => ({ ok: true as const, value: detail })) }
  };
}

function renderPage(api: CompanyApi) {
  return render(<MemoryRouter initialEntries={['/company/skills']}><Routes><Route element={<CompanyAppShell api={api} initialSession={session} />}><Route path="company/skills" element={<CompanySkillLibraryPage />} /></Route></Routes></MemoryRouter>);
}

afterEach(() => cleanup());

describe('CompanySkillLibraryPage', () => {
  it('lists company Skills and filters by category metadata', async () => {
    const user = userEvent.setup();
    const api = apiFixture();
    renderPage(api);
    expect(await screen.findByRole('heading', { name: '教育内容策划' })).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: '搜索 Skill' }), '不存在');
    expect(screen.getByText('还没有匹配的 Skill')).toBeVisible();
  });

  it('opens a read-only Skill detail without exposing mutation controls', async () => {
    const user = userEvent.setup();
    const api = apiFixture();
    renderPage(api);
    await user.click(await screen.findByRole('button', { name: '查看方法' }));
    expect(document.querySelector('#company-skill-detail-title')).toHaveTextContent('教育内容策划');
    expect(screen.getByText('这是方法正文。')).toBeVisible();
    expect(screen.getByText('REFERENCE.md')).toBeVisible();
    expect(screen.queryByRole('button', { name: /新建|移动|执行/u })).not.toBeInTheDocument();
    expect(api.skills.get).toHaveBeenCalledWith(revision);
  });
});
