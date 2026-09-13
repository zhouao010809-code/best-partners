// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '../../src/client/App.js';

describe('App', () => {
  it('opens the local read-only workspace', () => {
    render(<App />);
    expect(screen.getByLabelText('最佳拍档')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '大脑总览' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
    expect(screen.queryByLabelText('当前模式：只读')).not.toBeInTheDocument();
  });
});
