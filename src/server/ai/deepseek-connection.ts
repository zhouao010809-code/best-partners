import { DEEPSEEK_HOST, DEEPSEEK_MODEL } from './deepseek-provider.js';
import { normalizeModelApiKey } from './model-credentials.js';

const MAX_RESPONSE_BYTES = 16_384;
// Verified 2026-09-09 against the official Chat Completions and Error Codes docs.
// https://api-docs.deepseek.com/api/create-chat-completion/
// https://api-docs.deepseek.com/quick_start/error_codes/
const REQUEST_BODY = JSON.stringify({ model: DEEPSEEK_MODEL,
  messages: [{ role: 'user', content: 'Reply with OK only.' }],
  thinking: { type: 'disabled' }, stream: false, max_tokens: 16 });
const messages = {
  AUTHENTICATION_FAILED: '密钥验证失败，请在 DeepSeek 平台确认密钥有效后，在这里更新密钥。',
  INSUFFICIENT_BALANCE: 'DeepSeek 账户余额不足，请在 DeepSeek 平台补充余额后重新验证。',
  RATE_LIMITED: 'DeepSeek 请求过于频繁，请稍后重新验证。',
  PROVIDER_UNAVAILABLE: 'DeepSeek 服务暂时不可用，请稍后重新验证。',
  NETWORK_ERROR: '无法连接 DeepSeek，请检查网络连接或代理设置后重试。',
  TIMEOUT: '连接验证超过 20 秒，请检查网络连接或稍后重新验证。',
  INVALID_REQUEST: 'DeepSeek 未接受当前模型的测试请求，请更新应用后重新验证。',
  INVALID_KEY: '密钥格式不正确，请重新复制并保存有效密钥后再验证。',
  INVALID_RESPONSE: 'DeepSeek 未返回完整有效的测试响应，请稍后重新验证。',
  RESPONSE_TOO_LARGE: 'DeepSeek 的测试响应超过大小限制，请稍后重新验证。',
  CANCELLED: '本次连接验证已取消。'
} as const;

export class DeepSeekConnectionError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = 'DeepSeekConnectionError'; }
}

export interface DeepSeekConnectionVerifier {
  verify(apiKey: string, signal: AbortSignal): Promise<void>;
}

function validateCompletion(text: string): void {
  const record = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  let body: Record<string, unknown> | undefined;
  try { body = record(JSON.parse(text)); } catch { throw new DeepSeekConnectionError('INVALID_RESPONSE'); }
  const choices = body?.choices;
  const choice = Array.isArray(choices) && choices.length === 1 ? record(choices[0]) : undefined;
  const message = record(choice?.message);
  if (choice?.finish_reason !== 'stop' || message?.role !== 'assistant'
    || typeof message.content !== 'string' || !message.content.trim()
    || message.tool_calls !== undefined || message.function_call !== undefined) throw new DeepSeekConnectionError('INVALID_RESPONSE');
}

/** A separate capability: callers cannot provide prompts, documents or model options. */
export function createDeepSeekConnectionVerifier(input: { fetch?: typeof fetch; timeoutMs?: number } = {}): DeepSeekConnectionVerifier {
  const request = input.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  return {
    async verify(apiKey, signal) {
      if (signal.aborted) throw new DeepSeekConnectionError('CANCELLED');
      let key: string;
      try { key = normalizeModelApiKey(apiKey); } catch { throw new DeepSeekConnectionError('INVALID_KEY'); }
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let failure: DeepSeekConnectionError | undefined;
      let rejectCancellation: (error: DeepSeekConnectionError) => void = () => {};
      const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
      const cancel = (code: 'CANCELLED' | 'TIMEOUT') => {
        if (failure) return;
        failure = new DeepSeekConnectionError(code); controller.abort();
        void reader?.cancel().catch(() => {}); rejectCancellation(failure);
      };
      const onAbort = () => cancel('CANCELLED');
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => cancel('TIMEOUT'), input.timeoutMs ?? 20_000);
      const run = async () => {
        const response = await request(`https://${DEEPSEEK_HOST}/chat/completions`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: REQUEST_BODY
        });
        if (failure) { void response.body?.cancel().catch(() => {}); throw failure; }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new DeepSeekConnectionError(response.status === 401 || response.status === 403 ? 'AUTHENTICATION_FAILED'
            : response.status === 402 ? 'INSUFFICIENT_BALANCE' : response.status === 429 ? 'RATE_LIMITED'
              : response.status === 400 || response.status === 422 ? 'INVALID_REQUEST' : 'PROVIDER_UNAVAILABLE');
        }
        if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
          void response.body?.cancel().catch(() => {}); throw new DeepSeekConnectionError('RESPONSE_TOO_LARGE');
        }
        if (!response.body) throw new DeepSeekConnectionError('INVALID_RESPONSE');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let bytes = 0;
        for (;;) {
          const chunk = await reader.read();
          if (failure) throw failure;
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); throw new DeepSeekConnectionError('RESPONSE_TOO_LARGE'); }
          chunks.push(chunk.value);
        }
        validateCompletion(Buffer.concat(chunks, bytes).toString('utf8'));
      };
      try { await Promise.race([run(), cancellation]); }
      catch (error) {
        if (failure) throw failure;
        if (error instanceof DeepSeekConnectionError) throw error;
        throw new DeepSeekConnectionError('NETWORK_ERROR');
      } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
    }
  };
}
