import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { AssistantMessageView } from '../../src/client/components/assistant/AssistantMessageView.js';
import type { AssistantReviewAction } from '../../src/shared/api/assistant.js';

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
