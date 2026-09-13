import type { AssistantMessage, AssistantTokenCounts, AssistantUsageStep } from '../../shared/api/assistant.js';

const countKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens'] as const;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** DeepSeek's SDK supplies zeros for missing fields in a partial usage object.
 * Read the provider's raw receipt to preserve those fields as unknown instead.
 */
export function deepSeekUsageStep(raw: unknown, step: number): AssistantUsageStep {
  const receipt = object(raw);
  const inputTokens = count(receipt?.prompt_tokens);
  const outputTokens = count(receipt?.completion_tokens);
  const totalTokens = count(receipt?.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  const cachedInputTokens = count(receipt?.prompt_cache_hit_tokens);
  const reasoningTokens = count(object(receipt?.completion_tokens_details)?.reasoning_tokens);
  const values = { inputTokens, outputTokens, totalTokens, cachedInputTokens, reasoningTokens };
  return { step, measuredAt: new Date().toISOString(), status: inputTokens !== undefined && outputTokens !== undefined ? 'reported'
    : Object.values(values).some(value => value !== undefined) ? 'partial' : 'unavailable',
    ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) };
}

export function recordAssistantUsage(message: AssistantMessage, step: AssistantUsageStep): void {
  const usage = message.usage ??= { steps: [], total: {}, status: 'unavailable' };
  if (usage.steps.some(existing => existing.step === step.step)) return;
  usage.steps.push(structuredClone(step)); usage.steps.sort((a, b) => a.step - b.step);
  usage.latest = structuredClone(usage.steps.at(-1)!);
  const total: AssistantTokenCounts = {};
  for (const key of countKeys) {
    const values = usage.steps.flatMap(sample => sample[key] === undefined ? [] : [sample[key]!]);
    if (values.length) total[key] = values.reduce((sum, value) => sum + value, 0);
  }
  usage.total = total;
  usage.status = Object.keys(total).length ? 'partial' : 'unavailable';
}

export function finishAssistantUsage(message: AssistantMessage, successful: boolean): void {
  if (!message.usage) return;
  const usage = message.usage;
  usage.status = !Object.keys(usage.total).length ? 'unavailable'
    : successful && usage.steps.length > 0 && usage.steps.every(step => step.status === 'reported') ? 'complete' : 'partial';
}
