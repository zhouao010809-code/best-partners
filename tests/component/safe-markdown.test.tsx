// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeMarkdown } from '../../src/client/components/SafeMarkdown.js';

describe('SafeMarkdown', () => {
  afterEach(() => cleanup());

  it('drops raw executable and embedded HTML without creating dangerous attributes', () => {
    const markdown = [
      '# 安全正文',
      '<script>window.__unsafe = true</script>',
      '<iframe src="https://attacker.invalid"></iframe>',
      '<object data="https://attacker.invalid/payload"></object>',
      '<img src="x" onerror="window.__unsafe = true">',
      '<button onclick="window.__unsafe = true">不应成为按钮</button>'
    ].join('\n\n');

    const { container } = render(<SafeMarkdown>{markdown}</SafeMarkdown>);

    expect(screen.getByRole('heading', { name: '安全正文' })).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('object')).toBeNull();
    expect(container.querySelector('[onerror], [onclick]')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('allows only absolute HTTP links and hardens every external anchor', () => {
    render(
      <SafeMarkdown>
        {'[安全 HTTPS](https://example.com/path?q=1)\n\n[安全 HTTP](HTTP://example.org/docs)'}
      </SafeMarkdown>
    );

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
    }
  });

  it.each([
    ['javascript:alert%281%29', '脚本协议'],
    ['JaVaScRiPt:alert%281%29', '大小写脚本'],
    ['%6A%61%76%61%73%63%72%69%70%74%3Aalert%281%29', '编码脚本'],
    ['javascript&#x3A;alert%281%29', '实体脚本'],
    ['data:text/html;base64,PHNjcmlwdD4=', '数据协议'],
    ['file:///etc/passwd', '文件协议'],
    ['mailto:person@example.com', '邮件协议'],
    ['obsidian://open?vault=brain', 'Obsidian 协议'],
    ['./relative-note', '相对路径'],
    ['/root-relative', '根相对路径']
  ])('renders rejected destination %s as text, never as a link', (destination, label) => {
    const { container } = render(
      <SafeMarkdown>{`[${label}](${destination})`}</SafeMarkdown>
    );

    expect(screen.getByText(label)).toBeVisible();
    expect(container.querySelector('a')).toBeNull();
  });

  it('supports GFM structure without enabling raw HTML', () => {
    render(
      <SafeMarkdown>
        {'| 字段 | 值 |\n| --- | --- |\n| 状态 | 可用 |\n\n- [x] 已校验'}
      </SafeMarkdown>
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});
