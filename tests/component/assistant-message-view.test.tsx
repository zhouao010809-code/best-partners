import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { AssistantMessageView } from '../../src/client/components/assistant/AssistantMessageView.js';
import type { AssistantReviewAction, AssistantPlanAction } from '../../src/shared/api/assistant.js';

afterEach(cleanup);
it('shows an empty result as finished and keeps its briefing reachable', () => {
  const action = { id: 'empty-run', type: 'review' as const, label: '查看导读', runId: 'empty-run', materialTitle: '原始资料', candidateCount: 0, committedCount: 0, discardedCount: 0, status: 'empty' as AssistantReviewAction['status'] };
  render(<MemoryRouter><AssistantMessageView message={{ id: 'message', role: 'assistant', text: '', sources: [], actions: [action] }} onFollowUp={() => {}} /></MemoryRouter>);
  expect(screen.getByText('已完成 · 无候选')).toBeVisible();
  expect(screen.getByText('本轮未发现适合保存的知识，可查看导读。')).toBeVisible();
  expect(screen.getByRole('link', { name: '查看导读' })).toHaveAttribute('href', '/extractions/empty-run');
  expect(screen.queryByText('候选经你确认后入库')).not.toBeInTheDocument();
  expect(screen.queryByText('已入库')).not.toBeInTheDocument();
  expect(screen.queryByText('已放弃')).not.toBeInTheDocument();
});

it('renders an archive plan before the archive receipt branch', () => {
  const plan: AssistantPlanAction = {
    id: '6f9c3b4e-9c3f-4d7a-8c5f-1a8e0e5f2f66', type: 'plan', kind: 'archive', label: '准备归档', status: 'pending',
    attachmentId: '7f9c3b4e-9c3f-4d7a-8c5f-1a8e0e5f2f66', sourceTitle: '资料.txt', sourceSha256: 'a'.repeat(64),
    targetPath: '01图书馆/来自个人/2026-09/资料', mainName: '原文.md', summary: '归档计划',
    createdAt: '2026-09-15T00:00:00.000Z', expiresAt: '2026-09-15T00:30:00.000Z'
  };
  render(<MemoryRouter><AssistantMessageView message={{ id: 'message', role: 'assistant', text: '', sources: [], actions: [plan] }} onFollowUp={() => {}} /></MemoryRouter>);
  expect(screen.getByRole('article', { name: '待确认的归档计划' })).toBeVisible();
  expect(screen.getByRole('button', { name: '确认归档' })).toBeVisible();
});

it('marks an assistant answer with the confirmed Skill name and short revision', () => {
  render(<MemoryRouter><AssistantMessageView
    message={{
      id: 'message',
      role: 'assistant',
      text: '回答',
      sources: [],
      actions: [],
      skillUse: { id: 'a'.repeat(64), name: '公众号写作', revision: 'b'.repeat(64), folderName: '写作' }
    }}
    onFollowUp={() => {}}
  /></MemoryRouter>);
  expect(screen.getByText(/已使用 Skill：公众号写作/u)).toBeVisible();
  expect(screen.getByText(/写作 · b{8}/u)).toBeVisible();
  expect(screen.queryByText(/[/\\]/u)).not.toBeInTheDocument();
});
