import type { LearningSelection } from '../../shared/api/learning.js';
import { PublicApiError } from '../../shared/api/errors.js';
import type { AttachmentSelection } from '../../shared/api/attachments.js';
import type { ProjectService, ProjectWritePlanService } from '../../shared/api/projects.js';
import type { ReadService } from '../services/read-service.js';
import type { ExtractionService } from '../services/extraction-service.js';
import type { AttachmentService } from '../attachments/service.js';
import { createAttachmentTools } from './attachment-tools.js';
import { createBrainTools } from './brain-tools.js';
import { createProjectTools } from './project-tools.js';
import { createAssistantSourceAllocator, type AssistantEvent, type AssistantTool } from './types.js';
import type { AssistantPlanAction } from '../../shared/api/assistant.js';
import type { AttachmentArchiveProposalRequest } from './attachment-tools.js';

export interface ToolFactoryInput {
  readService: ReadService;
  projectService?: ProjectService;
  projectWritePlans?: ProjectWritePlanService;
  scope: 'brain' | 'current' | 'project';
  contextPath?: string;
  purpose?: 'learning';
  selection?: LearningSelection;
  projectId?: string;
  projectRevision?: number;
  allowCandidateWrites?: boolean;
  sourceAllocator?: { next(): string };
  attachments: AttachmentSelection[];
  extractionService?: ExtractionService;
  attachmentService?: Pick<AttachmentService, 'get' | 'readPages' | 'archive'>;
  conversationId: string;
  messageId: string;
  userMessage: string;
  model: string;
  signal: AbortSignal;
  emit: (event: AssistantEvent) => void;
  proposeArchive?: (request: AttachmentArchiveProposalRequest, signal?: AbortSignal) => Promise<AssistantPlanAction>;
  markActionPending?: () => void;
  companyTools?: readonly AssistantTool[];
}

export type AssistantToolContext = Omit<ToolFactoryInput, 'readService'>;

/** Compose the personal tool set at one explicit runtime scope. */
export function createAssistantTools(input: ToolFactoryInput): AssistantTool[] {
  const sourceAllocator = input.sourceAllocator ?? createAssistantSourceAllocator();
  if (input.purpose === 'learning') {
    if (!input.selection || input.scope !== 'current' || input.contextPath !== input.selection.path || input.attachments.length || input.projectId) {
      throw new PublicApiError('ASSISTANT_LEARNING_CONFLICT', '学习会话只能使用固定的当前资料，请重新选择。', 409);
    }
    return createBrainTools({ readService: input.readService, scope: 'current', contextPath: input.selection.path,
      expectedRevision: input.selection.revision, allowCandidateWrites: false, sourceAllocator,
      model: input.model, signal: input.signal, emit: input.emit });
  }
  const brainTools = createBrainTools({
    ...input,
    scope: input.scope === 'current' ? 'current' : 'brain',
    ...(input.scope === 'current' && input.contextPath ? { contextPath: input.contextPath } : {}),
    ...(input.scope === 'project' ? { allowCandidateWrites: false } : { allowCandidateWrites: input.allowCandidateWrites ?? true }),
    sourceAllocator
  });
  if (input.scope === 'project') {
    if (!input.projectService || !input.projectWritePlans || !input.projectId || input.projectRevision === undefined) throw new Error('PROJECT_DEPENDENCIES_REQUIRED');
    return [...brainTools, ...createProjectTools({ projectService: input.projectService, writePlans: input.projectWritePlans, projectId: input.projectId, projectRevision: input.projectRevision, conversationId: input.conversationId, messageId: input.messageId, userMessage: input.userMessage, model: input.model, signal: input.signal, emit: input.emit, sourceAllocator })];
  }
  const attachmentTools = createAttachmentTools({
    ...input,
    scope: input.scope === 'current' ? 'current' : 'brain',
    ...(input.scope === 'current' && input.contextPath ? { contextPath: input.contextPath } : {}),
    sourceAllocator,
    ...(input.allowCandidateWrites === undefined ? {} : { allowCandidateWrites: input.allowCandidateWrites })
  });
  const brainNames = new Set(brainTools.map(tool => tool.name));
  return [...brainTools, ...attachmentTools.filter(tool => !brainNames.has(tool.name))];
}
