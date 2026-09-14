import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantActionPlanCard } from '../../src/client/components/assistant/AssistantActionPlanCard.js';
import type { AssistantPlanAction } from '../../src/shared/api/assistant.js';

afterEach(cleanup);

const action = (status: AssistantPlanAction['status'] = 'pending'): AssistantPlanAction => ({
  id: '6f9c3b4e-9c3f-4d7a-8c5f-1a8e0e5f2f66',
  type: 'plan', kind: 'archive', label: '准备归档', status,
  attachmentId: '7f9c3b4e-9c3f-4d7a-8c5f-1a8e0e5f2f66', sourceTitle: '资料.pdf', sourceSha256: 'a'.repeat(64),
  targetPath: '01图书馆/来自个人/2026-09/资料', mainName: '原文.md', summary: '将《资料.pdf》归档到个人资料库。',
  createdAt: '2026-09-15T00:00:00.000Z', expiresAt: '2026-09-15T00:30:00.000Z'
});

it('shows the server target and only confirms after the final dialog button', async () => {
  const user = userEvent.setup(); const onResolved = vi.fn(async () => undefined);
  render(<AssistantActionPlanCard action={action()} onResolved={onResolved} onCancelled={vi.fn(async () => undefined)} />);
  expect(screen.getByRole('article', { name: '待确认的归档计划' })).toBeVisible();
  expect(screen.getByText('01图书馆/来自个人/2026-09/资料')).toBeVisible();
  expect(screen.getByText('尚未写入资料')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '确认归档' }));
  expect(screen.getByRole('dialog', { name: '确认归档' })).toBeVisible();
  expect(onResolved).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '最终确认归档' }));
  expect(onResolved).toHaveBeenCalledOnce();
});

it('shows a stale plan as not written and offers regeneration', () => {
  render(<AssistantActionPlanCard action={{ ...action('stale'), problem: '文件或解析版本已变化，未写入资料。' }} onResolved={vi.fn(async () => undefined)} onCancelled={vi.fn(async () => undefined)} onRegenerate={vi.fn()} />);
  expect(screen.getByText('文件已变化，未写入')).toBeVisible();
  expect(screen.queryByText('已归档')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重新生成计划' })).toBeVisible();
});

it('closes the confirmation dialog with Escape without confirming', async () => {
  const user = userEvent.setup(); const onResolved = vi.fn(async () => undefined);
  render(<AssistantActionPlanCard action={action()} onResolved={onResolved} onCancelled={vi.fn(async () => undefined)} />);
  await user.click(screen.getByRole('button', { name: '确认归档' })); await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(onResolved).not.toHaveBeenCalled();
});
