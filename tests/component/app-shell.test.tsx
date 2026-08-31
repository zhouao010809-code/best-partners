// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from '../../src/client/App.js';
import { PageState } from '../../src/client/components/PageState.js';

const MAIN_NAVIGATION_NAMES = [
  '大脑总览',
  '提炼队列',
  '知识库',
  '操作记录',
  '系统连接'
] as const;

function setPath(path: string): void {
  window.history.replaceState(null, '', path);
}

describe('black-glass application shell', () => {
  beforeEach(() => setPath('/'));
  afterEach(() => cleanup());

  it('exposes skip, sidebar, navigation, and main-content landmarks', () => {
    render(<App />);

    expect(screen.getByRole('link', { name: '跳到主内容' })).toHaveAttribute(
      'href',
      '#main-content'
    );
    expect(screen.getByRole('complementary', { name: '小兆大脑侧边栏' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('contains five and only five main navigation destinations', () => {
    render(<App />);

    const navigation = screen.getByRole('navigation', { name: '主导航' });
    const links = within(navigation).getAllByRole('link');
    expect(links).toHaveLength(5);
    expect(links.map((link) => link.textContent?.trim())).toEqual(MAIN_NAVIGATION_NAMES);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/',
      '/queue',
      '/knowledge',
      '/operations',
      '/connections'
    ]);
  });

  it('marks the current destination and keeps connection state out of links', () => {
    setPath('/knowledge');
    render(<App />);

    expect(screen.getByRole('link', { name: '知识库' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    const connection = screen.getByRole('status', { name: '本地连接状态' });
    expect(connection).toHaveTextContent('连接待检查');
    expect(connection).not.toHaveTextContent('已连接');
    expect(connection).toHaveClass('connection-badge--pending');
    expect(connection.closest('a')).toBeNull();
  });

  it.each([
    ['/', '大脑总览'],
    ['/queue/', '提炼队列'],
    ['/knowledge/', '知识库'],
    ['/operations/', '操作记录'],
    ['/connections/', '系统连接']
  ])('normalizes the canonical page identity for %s', (path, heading) => {
    setPath(path);
    render(<App />);

    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
  });

  it.each([
    ['/extractions/material-01', '提炼工作区'],
    ['/write-plans/plan-01', '写入计划']
  ])('routes %s without adding it to the sidebar', (path, heading) => {
    setPath(path);
    render(<App />);

    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    const navigation = screen.getByRole('navigation', { name: '主导航' });
    expect(within(navigation).getAllByRole('link')).toHaveLength(5);
    expect(within(navigation).queryByText(heading)).not.toBeInTheDocument();
  });

  it('moves focus to the page heading after client-side navigation only', async () => {
    const user = userEvent.setup();
    render(<App />);

    const initialHeading = screen.getByRole('heading', { level: 1, name: '大脑总览' });
    expect(initialHeading).not.toHaveFocus();

    await user.click(screen.getByRole('link', { name: '提炼队列' }));
    expect(screen.getByRole('heading', { level: 1, name: '提炼队列' })).toHaveFocus();
  });
});

describe('complete page state system', () => {
  afterEach(() => cleanup());

  const cases = [
    ['loading', '正在加载'],
    ['empty', '暂无数据'],
    ['refreshing', '正在刷新'],
    ['disconnected', '连接已断开'],
    ['validation-error', '数据校验失败'],
    ['operation-error', '操作失败'],
    ['busy', '系统繁忙'],
    ['success', '操作成功'],
    ['conflict', '版本冲突'],
    ['recovery-required', '需要恢复']
  ] as const;

  it.each(cases)('renders %s with a visible label and named icon', (status, label) => {
    render(<PageState state={{ status }} />);

    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByRole('img', { name: `${label}图标` })).toBeInTheDocument();
  });

  it('announces busy work without presenting it as a fatal alert', () => {
    render(<PageState state={{ status: 'busy', message: '索引任务正在执行' }} />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('索引任务正在执行');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
