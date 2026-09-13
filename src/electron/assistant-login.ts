/** Only the official OAuth entry can leave the local app through this bridge. */
export function validateAssistantLoginUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16_384) throw new Error('AI_LOGIN_URL_INVALID');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('AI_LOGIN_URL_INVALID');
  return url.href;
}
