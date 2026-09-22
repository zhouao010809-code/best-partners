import type { AttachmentSelection } from '../../../shared/api/attachments.js';
export const ASSISTANT_INTENT_EVENT = 'xiaozhao:ask';
export const ASSISTANT_REVIEW_EVENT = 'xiaozhao:review-updated';
export const PROJECT_WORKSPACE_UPDATED_EVENT = 'xiaozhao:project-workspace-updated';
export type AssistantIntent = {
  prompt: string;
  contextPath?: string;
  scope?: 'brain' | 'current' | 'project';
  projectId?: string;
  projectRevision?: number;
  attachments?: AttachmentSelection[];
};
export function askAssistant(intent: AssistantIntent) {
  window.dispatchEvent(new CustomEvent<AssistantIntent>(ASSISTANT_INTENT_EVENT, { detail: intent }));
}
