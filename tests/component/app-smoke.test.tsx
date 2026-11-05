// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../../src/client/App.js';

afterEach(cleanup);

describe('App', () => {
  it('opens the local read-only workspace', async () => {
    // Settle bootstrap's async fallback while the DOM still exists, then
    // unmount the shell before Vitest tears down its window and effects.
    await act(async () => { render(<App />); });
    expect(screen.getByLabelText('最佳拍档')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '大脑总览' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
    expect(screen.queryByLabelText('当前模式：只读')).not.toBeInTheDocument();
  });
});
