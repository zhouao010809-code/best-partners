import { expect, it } from 'vitest';
import { validateAssistantLoginUrl } from '../../src/electron/assistant-login.js';

it('opens only HTTPS official login hosts through the desktop bridge', () => {
  expect(validateAssistantLoginUrl('https://auth.openai.com/oauth/authorize?state=abc')).toContain('auth.openai.com');
  for (const url of ['file:///tmp/a', 'https://auth.openai.com.evil.test/', 'https://auth.openai.com@evil.test/', 'https://user:pw@auth.openai.com/', 'http://chatgpt.com/', 'https://chatgpt.com:8888/', null]) expect(() => validateAssistantLoginUrl(url)).toThrow();
});
