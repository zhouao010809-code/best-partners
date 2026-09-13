import { normalizeModelApiKey } from './model-credentials.js';

export const DEEPSEEK_HOST = 'api.deepseek.com';
export const DEEPSEEK_MODEL = 'deepseek-v4-pro';
// V4 Pro is the quality-first default. Historical Flash runs retain their model id.
// https://api-docs.deepseek.com/quick_start/pricing/
// Keep a smaller local budget for complete drafts; byte and time limits still apply.
const MAX_OUTPUT_TOKENS = 32768;
const MAX_REQUEST_BYTES = 512_000;
const MAX_RESPONSE_BYTES = 524_288;
const messagesByCode = {
  CANCELLED: '已取消本次提炼。',
  TIMEOUT: 'DeepSeek 响应超时，请稍后重新发起提炼。',
  AUTHENTICATION_FAILED: 'DeepSeek API Key 验证失败，请检查配置。',
  INSUFFICIENT_BALANCE: 'DeepSeek 账户余额不足，请补充余额后重试。',
  RATE_LIMITED: 'DeepSeek 请求过于频繁，请稍后重新发起提炼。',
  PROVIDER_UNAVAILABLE: '暂时无法连接 DeepSeek，请稍后重新发起提炼。',
  OUTPUT_TRUNCATED: 'DeepSeek 输出达到长度上限而截断，本次结果未保存，请重新预览后确认提炼。',
  INVALID_JSON: 'DeepSeek 返回的提炼内容不是有效 JSON，本次结果未保存，请重新预览后确认提炼。',
  INVALID_RESPONSE: 'DeepSeek 响应包格式不正确或未正常完成，本次结果未保存，请重新预览后确认提炼。',
  RESPONSE_TOO_LARGE: 'DeepSeek 返回内容超过大小限制，本次结果未保存，请缩小资料后重新提炼。',
  REQUEST_TOO_LARGE: '本次提炼内容超过大小限制，请缩小资料后重试。',
  INVALID_REQUEST: '提炼请求或 API Key 格式不正确。'
} as const;

export class DeepSeekError extends Error {
  constructor(readonly code: keyof typeof messagesByCode) {
    super(messagesByCode[code]);
    this.name = 'DeepSeekError';
  }
}

export interface DeepSeekMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

export interface DeepSeekProvider {
  readonly generate: (messages: readonly DeepSeekMessage[], apiKey: string, signal: AbortSignal) => Promise<unknown>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseCompletion(text: string): unknown {
  let body: Record<string, unknown> | undefined;
  try { body = object(JSON.parse(text)); } catch { throw new DeepSeekError('INVALID_RESPONSE'); }
  const choices = body?.choices;
  const choice = Array.isArray(choices) && choices.length === 1 ? object(choices[0]) : undefined;
  const message = object(choice?.message);
  if (message?.role !== 'assistant'
    || message.tool_calls !== undefined || message.function_call !== undefined) throw new DeepSeekError('INVALID_RESPONSE');
  // A truncated completion may also be invalid JSON; report the actual cause first.
  if (choice?.finish_reason === 'length') throw new DeepSeekError('OUTPUT_TRUNCATED');
  if (choice?.finish_reason !== 'stop' || typeof message.content !== 'string' || !message.content.trim()) throw new DeepSeekError('INVALID_RESPONSE');
  try { return JSON.parse(message.content) as unknown; } catch { throw new DeepSeekError('INVALID_JSON'); }
}

export function createDeepSeekProvider(input: {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
} = {}): DeepSeekProvider {
  const request = input.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const timeoutMs = input.timeoutMs ?? 120_000;
  return {
    async generate(messages, apiKey, signal) {
      if (signal.aborted) throw new DeepSeekError('CANCELLED');
      let key: string;
      try { key = normalizeModelApiKey(apiKey); } catch { throw new DeepSeekError('INVALID_REQUEST'); }
      if (!Array.isArray(messages) || messages.length === 0
        || messages.some((message) => !message || !['system', 'user'].includes(message.role) || typeof message.content !== 'string')) {
        throw new DeepSeekError('INVALID_REQUEST');
      }
      const body = JSON.stringify({ model: DEEPSEEK_MODEL,
        messages: messages.map(({ role, content }) => ({ role, content })),
        // Up to 12 candidates now include both their body and complete reusable metadata.
        stream: false, thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, max_tokens: MAX_OUTPUT_TOKENS });
      if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new DeepSeekError('REQUEST_TOO_LARGE');
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let failure: DeepSeekError | undefined;
      let rejectCancellation: (error: DeepSeekError) => void = () => {};
      const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
      const cancel = (code: 'TIMEOUT' | 'CANCELLED') => {
        if (failure) return;
        failure = new DeepSeekError(code);
        controller.abort();
        void reader?.cancel().catch(() => {});
        rejectCancellation(failure);
      };
      const onAbort = () => cancel('CANCELLED');
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => cancel('TIMEOUT'), timeoutMs);
      const run = async () => {
        const response = await request(`https://${DEEPSEEK_HOST}/chat/completions`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body
        });
        if (failure) { void response.body?.cancel().catch(() => {}); throw failure; }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new DeepSeekError(response.status === 401 || response.status === 403
            ? 'AUTHENTICATION_FAILED' : response.status === 402 ? 'INSUFFICIENT_BALANCE'
              : response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE');
        }
        if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
          void response.body?.cancel().catch(() => {});
          throw new DeepSeekError('RESPONSE_TOO_LARGE');
        }
        if (!response.body) throw new DeepSeekError('INVALID_RESPONSE');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const chunk = await reader.read();
          if (failure) throw failure;
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            void reader.cancel().catch(() => {});
            throw new DeepSeekError('RESPONSE_TOO_LARGE');
          }
          chunks.push(chunk.value);
        }
        return parseCompletion(Buffer.concat(chunks, bytes).toString('utf8'));
      };
      try { return await Promise.race([run(), cancellation]); }
      catch (error) {
        if (failure) throw failure;
        if (error instanceof DeepSeekError) throw error;
        throw new DeepSeekError('PROVIDER_UNAVAILABLE');
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    }
  };
}
