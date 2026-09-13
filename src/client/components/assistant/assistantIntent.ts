import type { AttachmentSelection } from '../../../shared/api/attachments.js';
export const ASSISTANT_INTENT_EVENT = 'xiaozhao:ask';
export const ASSISTANT_REVIEW_EVENT = 'xiaozhao:review-updated';
export type AssistantIntent = { prompt: string; contextPath?: string; scope?: 'brain' | 'current'; attachments?: AttachmentSelection[] };
export function askAssistant(intent: AssistantIntent) {
  window.dispatchEvent(new CustomEvent<AssistantIntent>(ASSISTANT_INTENT_EVENT, { detail: intent }));
}
