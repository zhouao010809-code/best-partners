import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DistributionChecklist } from '../../src/client/components/first-run/DistributionChecklist.js';

describe('DistributionChecklist', () => {
  it('shows non-blocking fallback and preserves retryable connection state', async () => {
    const bridge = {
      getClipperStatus: vi.fn().mockResolvedValue({ installed: false, connected: false }),
      installClipperHost: vi.fn().mockRejectedValue(new Error('failed')),
      openClipperInstall: vi.fn().mockResolvedValue(undefined)
    };
    render(<DistributionChecklist bridge={bridge} />);
    await waitFor(() => expect(screen.getByText(/文件导入和粘贴文本不受影响/u)).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: '配置连接' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/配置未完成/u));
    expect(screen.getByRole('button', { name: '配置连接' })).toBeEnabled();
    expect(screen.getByText(/文件导入和粘贴文本不受影响/u)).toBeVisible();
  });
});
