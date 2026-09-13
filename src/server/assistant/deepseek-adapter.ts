import { createDeepSeek } from '@ai-sdk/deepseek';
import { ToolLoopAgent, isStepCount, jsonSchema, tool } from 'ai';
import { PublicApiError } from '../../shared/api/errors.js';
import type { AssistantModel } from '../../shared/api/assistant.js';
import type { ModelCredentialsPort } from '../ai/model-credentials.js';
import { normalizeModelApiKey } from '../ai/model-credentials.js';
import { DEEPSEEK_HOST, DEEPSEEK_MODEL } from '../ai/deepseek-provider.js';
import type { AssistantAdapter } from './types.js';
import { ASSISTANT_OUTPUT_RESERVE_TOKENS, assertAssistantContextBudget, deepSeekModelCapacity, estimateAssistantContext } from './context-budget.js';
import { deepSeekUsageStep } from './usage.js';

const EFFORTS = ['max', 'high', 'low'];
const toolLabel = (name: string) => name.startsWith('search_') ? '查找资料' : ({ read_document: '阅读依据', submit_candidates: '保存候选',
  list_attachments: '查看附件', read_attachment: '阅读附件', archive_attachment: '归档附件', prepare_attachment_extraction: '准备附件提炼', prepare_extraction: '准备提炼' } as Record<string, string>)[name] ?? '执行工具';
const toolActivity = (name: string) => name.startsWith('search_') ? '正在查找相关资料' : ({ read_document: '正在阅读原文', submit_candidates: '正在校验并保存候选',
  list_attachments: '正在查看本轮附件', read_attachment: '正在阅读所选附件页码', archive_attachment: '正在保留原件并归档',
  prepare_attachment_extraction: '正在保留原件并准备所选页码的提炼依据', prepare_extraction: '正在准备提炼依据' } as Record<string, string>)[name] ?? '正在执行工具';
const knownV4 = (model: string) => model === 'deepseek-v4-pro' || model === 'deepseek-v4-flash';
const knownModels = (): AssistantModel[] => [{ id: DEEPSEEK_MODEL, name: 'DeepSeek V4 Pro', reasoningEfforts: EFFORTS, recommended: true, capacity: deepSeekModelCapacity(DEEPSEEK_MODEL)! },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoningEfforts: EFFORTS, capacity: deepSeekModelCapacity('deepseek-v4-flash')! }];
function publicFailure(error: unknown): PublicApiError {
  if (error instanceof PublicApiError) return error;
  const code = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
  return new PublicApiError('ASSISTANT_PROVIDER_FAILED', code === 401 || code === 403 ? 'DeepSeek 密钥未通过验证，请在设置中更新密钥。'
    : code === 429 ? 'DeepSeek 请求过于频繁或额度暂不可用，请稍后重试。'
      : code === 400 || code === 404 ? 'DeepSeek 未接受所选模型或请求，请检查模型可用性；本次没有切换到其他模型。'
        : 'DeepSeek 本次响应未完成，请稍后重试。', 502);
}

/** Model-specific transport; the AI SDK owns multi-step tool execution and streaming. */
export function createDeepSeekAssistantAdapter(input: { credentials: ModelCredentialsPort; fetch?: typeof fetch }): AssistantAdapter {
  const fetch: typeof globalThis.fetch = (url, init) => (input.fetch ?? globalThis.fetch)(url, { ...init, redirect: 'error' });
  type Catalog = { models: AssistantModel[]; problem?: string; unavailable?: boolean };
  let catalog: { revision: string; fetchedAt: number; value: Catalog } | undefined;
  let fetching: { revision: string; done: Promise<Catalog> } | undefined;
  async function modelCatalog(revision: string): Promise<Catalog> {
    if (catalog?.revision === revision && Date.now() - catalog.fetchedAt < 60_000) return catalog.value;
    if (fetching?.revision === revision) return fetching.done;
    const done = (async (): Promise<Catalog> => {
      let value: Catalog;
      try {
        let key: string;
        try { key = normalizeModelApiKey(input.credentials.getKey()); }
        catch { throw new PublicApiError('ASSISTANT_CATALOG_AUTH', '无法读取已保存的 DeepSeek 密钥，请在设置中重新保存。', 409); }
        const response = await fetch(`https://${DEEPSEEK_HOST}/models`, { method: 'GET', signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${key}` } });
        if ([401, 402, 403].includes(response.status)) {
          await response.body?.cancel();
          throw new PublicApiError('ASSISTANT_CATALOG_AUTH', response.status === 402 ? 'DeepSeek 账户额度不可用，请检查账户余额后重试。'
            : 'DeepSeek 密钥未通过验证，请在设置中更新密钥。', response.status);
        }
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('CATALOG_UNAVAILABLE'); }
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 256_000) throw new Error('CATALOG_TOO_LARGE');
            chunks.push(chunk.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data) || body.data.length === 0 || body.data.length > 128) throw new Error('CATALOG_INVALID');
        const ids = [...new Set(body.data.map((item: unknown) => typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'string' ? item.id : ''))];
        if (ids.some((id) => !id || id.length > 160 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(id))) throw new Error('CATALOG_INVALID');
        const known = knownModels();
        const models = ids.map((id) => known.find((model) => model.id === id) ?? { id, name: id, reasoningEfforts: [], ...(deepSeekModelCapacity(id) ? { capacity: deepSeekModelCapacity(id)! } : {}) });
        models.sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended) || a.id.localeCompare(b.id));
        value = { models, ...(!ids.includes(DEEPSEEK_MODEL) ? { problem: '当前账号的模型列表未包含 V4 Pro，请主动选择可用模型；不会自动切换到 Flash。' } : {}) };
      } catch (error) {
        value = { models: catalog?.revision === revision ? catalog.value.models : knownModels(),
          ...(error instanceof PublicApiError ? { problem: error.message, unavailable: true }
            : { problem: '模型目录暂时未能刷新，正在显示上次目录或内置的 V4 Pro / Flash；不会自动更换已选模型。' }) };
      }
      try { if (input.credentials.status().revision === revision) catalog = { revision, fetchedAt: Date.now(), value }; } catch { /* Credential failure is reported by describe. */ }
      return value;
    })();
    fetching = { revision, done };
    try { return await done; } finally { if (fetching?.done === done) fetching = undefined; }
  }
  return {
    id: 'deepseek',
    async describe() {
      let status: ReturnType<ModelCredentialsPort['status']>;
      try { status = input.credentials.status(); }
      catch { status = { available: false, configured: false, revision: '', problem: '暂时无法读取已保存的模型配置。' }; }
      let currentCatalog: Catalog = status.available && status.configured && !status.problem ? await modelCatalog(status.revision) : { models: knownModels() };
      try {
        const current = input.credentials.status();
        if (current.revision !== status.revision) currentCatalog = { models: knownModels(), problem: '模型配置已变化，请刷新模型目录。' };
        status = current;
      } catch { status = { available: false, configured: false, revision: '', problem: '暂时无法读取已保存的模型配置。' }; }
      return { id: 'deepseek', name: 'DeepSeek', status: !status.available || status.problem || currentCatalog.unavailable ? 'unavailable' : status.configured ? 'ready' : 'unconfigured',
        models: currentCatalog.models, defaultModel: DEEPSEEK_MODEL, defaultEffort: 'max',
        ...(status.problem || currentCatalog.problem ? { problem: status.problem ?? currentCatalog.problem } : {}) };
    },
    async run(request) {
      request.signal.throwIfAborted();
      if (!request.model.trim() || request.model.length > 160 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(request.model)) throw new PublicApiError('ASSISTANT_MODEL_INVALID', '请选择有效的 DeepSeek 模型。', 400);
      if (request.effort !== undefined && !EFFORTS.includes(request.effort)) throw new PublicApiError('ASSISTANT_EFFORT_INVALID', '请选择有效的思考强度。', 400);
      if (!knownV4(request.model) && request.effort) throw new PublicApiError('ASSISTANT_EFFORT_INVALID', '此模型尚未声明可选思考档位，请使用模型默认设置。', 400);
      const status = input.credentials.status();
      if (!status.available || status.problem) throw new PublicApiError('MODEL_UNAVAILABLE', status.problem ?? '当前连接无法安全读取密钥，请使用个人桌面 App。', 503);
      if (!status.configured) throw new PublicApiError('MODEL_KEY_REQUIRED', '请先在设置中保存 DeepSeek API Key。', 409);
      let key: string;
      try { key = normalizeModelApiKey(input.credentials.getKey()); }
      catch { throw new PublicApiError('MODEL_KEY_STORAGE_FAILED', '无法读取已保存的密钥，请在设置中重新保存。', 409); }
      const provider = createDeepSeek({ apiKey: key, baseURL: `https://${DEEPSEEK_HOST}`, fetch });
      const capacity = request.capacity ?? deepSeekModelCapacity(request.model);
      const outputReserveTokens = Math.min(request.outputReserveTokens ?? ASSISTANT_OUTPUT_RESERVE_TOKENS, capacity?.maxOutputTokens ?? ASSISTANT_OUTPUT_RESERVE_TOKENS);
      const agent = new ToolLoopAgent({
        model: provider(request.model), instructions: request.system,
        tools: Object.fromEntries(request.tools.map((entry) => [entry.name, tool({ description: entry.description, inputSchema: jsonSchema(entry.inputSchema),
          execute: async (value) => { request.signal.throwIfAborted(); return entry.execute(value); } })])),
        stopWhen: isStepCount(16), maxRetries: 0, maxOutputTokens: outputReserveTokens,
        prepareStep: ({ messages }) => {
          request.signal.throwIfAborted();
          const estimate = estimateAssistantContext({ system: request.system, messages, tools: request.tools, outputReserveTokens, ...(capacity ? { capacity } : {}) });
          request.emit({ type: 'context-estimate', estimate });
          assertAssistantContextBudget(estimate);
        },
        ...(knownV4(request.model) ? { providerOptions: { deepseek: { thinking: { type: 'enabled' }, reasoningEffort: request.effort ?? 'max' } } } : {}),
        onToolExecutionStart: ({ toolCall }) => {
          request.emit({ type: 'step', id: toolCall.toolCallId, toolName: toolCall.toolName, label: toolLabel(toolCall.toolName), status: 'running' });
          request.emit({ type: 'activity', text: toolActivity(toolCall.toolName) });
        },
        onToolExecutionEnd: ({ toolCall, toolOutput }) => request.emit({ type: 'step', id: toolCall.toolCallId, toolName: toolCall.toolName,
          label: toolLabel(toolCall.toolName), status: toolOutput.type === 'tool-error' ? 'failed' : 'completed' })
      });
      try {
        const stream = await agent.stream({ messages: request.messages, abortSignal: request.signal, timeout: { totalMs: 300_000, chunkMs: 90_000 } });
        let outputLength = 0;
        let modelStep = 0;
        for await (const part of stream.fullStream) {
          request.signal.throwIfAborted();
          if (part.type === 'text-delta') {
            outputLength += part.text.length;
            if (outputLength > 200_000) throw new PublicApiError('ASSISTANT_OUTPUT_LIMIT', '本次回复达到长度上限，请缩小问题后继续。', 400);
            request.emit({ type: 'text', text: part.text });
          } else if (part.type === 'finish-step') request.emit({ type: 'usage', usage: deepSeekUsageStep(part.usage.raw, ++modelStep) });
          else if (part.type === 'reasoning-start') request.emit({ type: 'activity', text: '正在思考' });
          else if (part.type === 'error') throw part.error;
          else if (part.type === 'abort') throw new PublicApiError('ASSISTANT_TIMEOUT', 'DeepSeek 本次响应等待超时，请稍后继续。', 504);
        }
        const reason = await stream.finishReason;
        if (reason === 'length') throw new PublicApiError('ASSISTANT_OUTPUT_LIMIT', '所选模型的本次输出达到长度上限，请缩小问题后继续。', 400);
        if (reason === 'error' || reason === 'tool-calls') throw new PublicApiError('ASSISTANT_STEP_LIMIT', '本轮执行尚未完成，请根据已返回的进度继续；没有切换模型。', 400);
      } catch (error) {
        request.signal.throwIfAborted();
        throw publicFailure(error);
      }
    }
  };
}
