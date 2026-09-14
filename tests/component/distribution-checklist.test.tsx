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
    await waitFor(() => expect(screen.getByText(/文件导入和粘贴文本入口始终可用/u)).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: '安装并配置' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/安装未完成/u));
    expect(screen.getByText(/插件不是必需条件/u)).toBeVisible();
  });
});
