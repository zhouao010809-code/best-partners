import type { AssistantContextEstimate, AssistantModelCapacity } from '../../shared/api/assistant.js';
import { PublicApiError } from '../../shared/api/errors.js';
import type { AssistantTool } from './types.js';

export const ASSISTANT_OUTPUT_RESERVE_TOKENS = 32_768;
export const ASSISTANT_HISTORY_MESSAGES = 24;
export const ASSISTANT_CONVERSATION_MESSAGES = 100;

/** A conservative planning estimate, not a tokenizer or a provider usage receipt. */
export function estimateAssistantContext(input: { system: string; messages: unknown[]; tools: AssistantTool[]; outputReserveTokens: number; capacity?: AssistantModelCapacity }): AssistantContextEstimate {
  const prompt = { system: input.system, messages: input.messages, tools: input.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  // Count UTF-8 bytes plus framing headroom so dense Unicode and tool schemas
  // are included. The approximation is deliberately identified in the API.
  const inputTokens = Buffer.byteLength(JSON.stringify(prompt), 'utf8') + 32 * (input.messages.length + input.tools.length + 1);
  return { inputTokens, method: 'utf8-conservative-v1', status: !input.capacity ? 'capacity-unknown'
    : inputTokens + input.outputReserveTokens > input.capacity.contextWindowTokens ? 'over-budget' : 'within-budget' };
}

export function assertAssistantContextBudget(estimate: AssistantContextEstimate): void {
  if (estimate.status === 'over-budget') throw new PublicApiError('ASSISTANT_CONTEXT_LIMIT', '按保守估算，本轮上下文与输出预留已超过模型容量。请缩小问题、减少资料范围或开启新对话；没有截断原文或自动重试。', 413);
}

/** Official published limits checked 2026-09-10; unknown IDs stay unknown.
 * https://api-docs.deepseek.com/quick_start/pricing/
 * https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono/
 * The official integration uses decimal 1,000,000 / 384,000, also conservative
 * against the 1,048,576 context size in the official Codex integration.
 */
export function deepSeekModelCapacity(model: string): AssistantModelCapacity | undefined {
  if (!['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)) return undefined;
  return { contextWindowTokens: 1_000_000, maxOutputTokens: 384_000, sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/', verifiedAt: '2026-09-10' };
}
