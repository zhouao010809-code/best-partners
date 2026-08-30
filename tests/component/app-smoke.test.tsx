// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '../../src/client/App.js';

describe('App', () => {
  it('names the product and reports safe initialization', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '小兆大脑' })).toBeInTheDocument();
    expect(screen.getByText('安全初始化中')).toBeInTheDocument();
  });
});
