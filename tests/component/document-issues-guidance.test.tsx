import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DocumentIssuePage } from '../../src/client/api/client.js';
import { DocumentIssuesPanel } from '../../src/client/components/DocumentIssuesPanel.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const listDocumentIssues = vi.fn();
const getDocumentDetail = vi.fn();
const runtime = {
  api: { listDocumentIssues, getDocumentDetail },
  health: { status: 'ready', data: { index: { status: 'ready' } } },
  dataRevision: 0
};
const missingAttributes = {
  path: '01图书馆/待确认/缺少属性.md', code: 'FRONTMATTER_INVALID', message: 'FRONTMATTER_OPENING_DELIMITER_MISSING'
} as const;
const invalidField = {
  path: '01图书馆/待确认/状态不明确.md', code: 'INVALID_FIELD', field: '知识入库状态', message: 'INTERNAL_SCHEMA_DETAIL'
} as const;

vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => runtime }));

beforeEach(() => {
  listDocumentIssues.mockResolvedValue(ok({ items: [missingAttributes] }));
  getDocumentDetail.mockResolvedValue(ok({ path: missingAttributes.path, markdown: '保留的原始正文' }));
  vi.stubGlobal('xiaozhaoDesktop', undefined);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

it('explains each issue with a rule-based next step without guessing replacement metadata', async () => {
  const items: DocumentIssuePage['items'] = [missingAttributes, invalidField,
    { path: '02知识库/旧知识.md', code: 'UNEXPECTED_TYPE', field: '类型', message: 'Expected 类型: 知识笔记' },
    { path: '01图书馆/格式错误.md', code: 'FRONTMATTER_INVALID', message: 'FRONTMATTER_INVALID' }];
  listDocumentIssues.mockResolvedValue(ok({ items }));
  render(<DocumentIssuesPanel />);
  expect(await screen.findByText(/文件开头缺少可识别的属性区块/u)).toBeVisible();
  expect(screen.getByText(/「知识入库状态」缺失或格式不符合当前规则/u)).toBeVisible();
  expect(screen.getByText(/「类型」与所在目录的规则不一致/u)).toBeVisible();
  expect(screen.getByText(/属性区块格式无法读取/u)).toBeVisible();
  expect(screen.getByText(/在编辑器中核对文件开头的属性/u)).toHaveTextContent('当前大脑规则');
  expect(screen.getByText(/保存后等待扫描再重新读取列表/u)).toHaveTextContent('扫描可能有延迟');
  expect(screen.getByText(/不会计入未提炼牌堆/u)).toBeVisible();
  expect(screen.queryByText('INTERNAL_SCHEMA_DETAIL')).not.toBeInTheDocument();
  expect(screen.queryByText(/自动补齐|一键修复/u)).not.toBeInTheDocument();
});

it('keeps the full relative path and read-only original usable without a desktop reveal bridge', async () => {
  const user = userEvent.setup();
  render(<DocumentIssuesPanel />);
  expect(await screen.findByText(missingAttributes.path, { exact: true })).toBeVisible();
  expect(screen.getByText(/可按下方相对路径在当前大脑文件夹中找到文件/u)).toBeVisible();
  expect(screen.queryByRole('button', { name: /在 Finder 中定位/u })).not.toBeInTheDocument();
  const originalButton = screen.getByRole('button', { name: '查看原文：缺少属性' });
  await user.click(originalButton);
  expect(await screen.findByText('保留的原始正文')).toBeVisible();
  expect(getDocumentDetail).toHaveBeenCalledExactlyOnceWith(missingAttributes.path, expect.any(AbortSignal));
  await user.click(screen.getByRole('button', { name: '关闭原文' }));
  expect(originalButton).toHaveFocus();
});

it('reports reveal failures on the affected row and retries the exact relative path', async () => {
  const revealDocument = vi.fn().mockRejectedValueOnce(new Error('NATIVE_DETAIL')).mockResolvedValue(undefined);
  vi.stubGlobal('xiaozhaoDesktop', { revealDocument });
  listDocumentIssues.mockResolvedValue(ok({ items: [missingAttributes, invalidField] }));
  const user = userEvent.setup();
  render(<DocumentIssuesPanel />);
  const button = await screen.findByRole('button', { name: `在 Finder 中定位：${missingAttributes.path}` });
  const row = button.closest('li')!;
  await user.click(button);
  expect(await within(row).findByRole('alert')).toHaveTextContent('未能在 Finder 中定位');
  expect(revealDocument).toHaveBeenNthCalledWith(1, missingAttributes.path);
  const otherRow = screen.getByRole('button', { name: `在 Finder 中定位：${invalidField.path}` }).closest('li')!;
  expect(within(otherRow).queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('NATIVE_DETAIL')).not.toBeInTheDocument();
  await user.click(within(row).getByRole('button', { name: `重新在 Finder 中定位：${missingAttributes.path}` }));
  expect(revealDocument).toHaveBeenNthCalledWith(2, missingAttributes.path);
  expect(await within(row).findByRole('status')).toHaveTextContent('已请求在 Finder 中定位');
  expect(within(row).queryByRole('alert')).not.toBeInTheDocument();
});

it('prevents repeated reveal requests while a row is pending', async () => {
  let finish!: () => void;
  const revealDocument = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  vi.stubGlobal('xiaozhaoDesktop', { revealDocument });
  const user = userEvent.setup();
  render(<DocumentIssuesPanel />);
  const button = await screen.findByRole('button', { name: `在 Finder 中定位：${missingAttributes.path}` });
  await user.dblClick(button);
  expect(button).toBeDisabled();
  expect(revealDocument).toHaveBeenCalledExactlyOnceWith(missingAttributes.path);
  await act(async () => { finish(); });
  expect(button).toBeEnabled();
  expect(screen.getByRole('status')).toHaveTextContent('已请求在 Finder 中定位');
});
