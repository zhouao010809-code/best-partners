import type { AssistantProvider, AssistantSource, AssistantAction, AssistantUsageStep, AssistantContextEstimate, AssistantModelCapacity } from '../../shared/api/assistant.js';

export const ASSISTANT_MAX_SOURCES = 50;

export interface AssistantTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: unknown): Promise<unknown>;
}
export type AssistantEvent = { type: 'text'; text: string } | { type: 'activity'; text: string } | { type: 'source'; source: AssistantSource } | { type: 'action'; action: AssistantAction }
  | { type: 'step'; id: string; toolName: string; label: string; status: 'running' | 'completed' | 'failed' }
  | { type: 'usage'; usage: AssistantUsageStep }
  | { type: 'attachment-archive-started'; attachmentId: string }
  | { type: 'context-estimate'; estimate: AssistantContextEstimate };
export interface AssistantRunInput {
  model: string;
  effort?: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: AssistantTool[];
  capacity?: AssistantModelCapacity;
  outputReserveTokens?: number;
  signal: AbortSignal;
  emit(event: AssistantEvent): void;
}
export interface AssistantAdapter {
  readonly id: string;
  describe(): Promise<AssistantProvider>;
  run(input: AssistantRunInput): Promise<void>;
  login?(): Promise<{ authUrl?: string; message: string }>;
  close?(): Promise<void>;
}
