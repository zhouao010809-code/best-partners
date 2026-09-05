import { describe, expect, it } from 'vitest';
import { createDesktopWindowPolicy } from '../../src/electron/window-policy.js';

describe('desktop window boundary', () => {
  const policy = () => createDesktopWindowPolicy('http://127.0.0.1:49231');
  it('allows only the exact local origin without credentials', () => {
    expect(policy().allowNavigation('http://127.0.0.1:49231/knowledge')).toBe(true);
    for (const url of ['http://127.0.0.1:49232/', 'http://localhost:49231/', 'file:///tmp/a', 'https://example.com', 'http://user@127.0.0.1:49231/']) {
      expect(policy().allowNavigation(url)).toBe(false);
    }
  });
  it('limits explicit external opens to https and Obsidian', () => {
    expect(policy().allowExternal('https://example.com/')).toBe(true);
    expect(policy().allowExternal('obsidian://open?vault=x&file=y')).toBe(true);
    for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'data:text/html,x', 'http://example.com', 'mailto:x@y.com', 'invalid']) {
      expect(policy().allowExternal(url)).toBe(false);
    }
  });
});
