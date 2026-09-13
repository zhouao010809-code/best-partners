import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { IntakeFileImport } from '../../src/client/pages/intake/IntakeFileImport.js';
import type { ReadConsoleApi } from '../../src/client/api/client.js';
import type { Attachment } from '../../src/shared/api/attachments.js';

const record: Attachment = { id: 'c907cae1-e36b-4f8c-b493-166027c9b98d', name: '自己的笔记.txt', mediaType: 'text/plain', size: 20, sha256: 'a'.repeat(64), status: 'ready', pageCount: 1, textBytes: 20, createdAt: '2026-09-10', updatedAt: '2026-09-10' };
afterEach(cleanup);
function fixture() {
  const attachments = { list: vi.fn(async () => ({ ok: true, value: { attachments: [] } })), get: vi.fn(async () => ({ ok: true, value: { attachment: record } })),
    upload: vi.fn(async (..._args: unknown[]) => ({ ok: true, value: { attachment: record } })), archive: vi.fn(), retry: vi.fn(), cancel: vi.fn(), pages: vi.fn() };
  const api = { attachments } as unknown as ReadConsoleApi;
  render(<MemoryRouter><IntakeFileImport api={api} onArchived={vi.fn()} /></MemoryRouter>);
  return attachments;
}
function enterText() {
  fireEvent.click(screen.getByRole('button', { name: '粘贴文本' }));
  fireEvent.change(screen.getByLabelText('资料标题'), { target: { value: '自己的笔记' } });
  fireEvent.change(screen.getByLabelText('粘贴正文'), { target: { value: '这是自己输入的原始资料。' } });
}
it('keeps the submitted paste stable while uploading and presents the preserved file afterward', async () => {
  const service = fixture();
  let finish!: (value: { ok: boolean; value: { attachment: Attachment } }) => void;
  service.upload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  enterText(); fireEvent.click(screen.getByRole('button', { name: '添加为临时资料' }));
  expect(screen.getByLabelText('资料标题')).toBeDisabled(); expect(screen.getByLabelText('粘贴正文')).toBeDisabled();
  await act(async () => finish({ ok: true, value: { attachment: record } }));
  expect(await screen.findByText('自己的笔记.txt')).toBeVisible();
  expect(service.archive).not.toHaveBeenCalled();
});
it('reuses the same file identity and batch when a pasted upload response is lost', async () => {
  const service = fixture(); service.upload.mockRejectedValueOnce(new Error('response lost'));
  enterText(); fireEvent.click(screen.getByRole('button', { name: '添加为临时资料' }));
  await screen.findByText(/文字保存回应中断/u);
  expect(screen.getByLabelText('粘贴正文')).toHaveValue('这是自己输入的原始资料。');
  fireEvent.click(screen.getByRole('button', { name: '添加为临时资料' }));
  await waitFor(() => expect(service.upload).toHaveBeenCalledTimes(2));
  expect(service.upload.mock.calls[1]).toEqual(service.upload.mock.calls[0]);
});
