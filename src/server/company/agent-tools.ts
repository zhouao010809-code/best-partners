import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  companyProjectConfirmDataSchema,
  companyProjectConfirmRequestSchema,
  companyProjectDraftDataSchema,
  companyProjectListDataSchema,
  companyProjectSchema,
  companyProjectProposalSchema,
  companyProjectRunParamsSchema,
  companyProjectScanDataSchema,
  companyProjectScanRequestSchema
} from '../../shared/api/company-projects.js';
import {
  skillDetailSchema,
  skillIdParamsSchema,
  skillsPageSchema
} from '../../shared/api/skills.js';
import { PublicApiError } from '../../shared/api/errors.js';
import { assertCompanyRelativePath } from './company-paths.js';
import type { CompanyProjectService, CompanyRuntime } from './company-runtime.js';
import type { AssistantTool } from '../assistant/types.js';
import type { SkillCatalogService } from '../services/skill-catalog.js';

const companyId = companyProjectRunParamsSchema.shape.id;
const sourceSha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const runInput = z.strictObject({ runId: companyId });
const projectInput = z.strictObject({ projectId: companyId });
const listInput = z.strictObject({});

/** Agent envelopes make mutation provenance explicit while reusing every nested company contract. */
export const companyAgentProjectScanDataSchema = companyProjectScanDataSchema.extend({
  operationId: companyId,
  sourceSha256
}).strict();
export const companyAgentProjectConfirmDataSchema = companyProjectConfirmDataSchema.extend({ sourceSha256 }).strict();

/**
 * The company Agent is deliberately a typed adapter around ProjectService.
 * It never accepts an absolute path, a shell command, or a model-generated
 * file operation.  The only write is the explicit `confirm_project` call,
 * which delegates to the same confirmation transaction as the HTTP API.
 */
export interface CompanyAgentToolsInput {
  readonly projects: CompanyProjectService;
  /** Optional read-only Skill catalog; omitted callers retain the project-only tool set. */
  readonly skills?: SkillCatalogService;
  readonly workspace: Pick<CompanyRuntime['workspace'], 'rootPath' | 'incomingPath'>;
  readonly actorId?: string;
  /** The composition root may bind this to the authenticated company session. */
  readonly authorize?: (permission: 'project:create' | 'project:confirm' | 'proposal:read') => void | Promise<void>;
  readonly signal: AbortSignal;
}

function pathInside(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathInputInvalid(value: unknown): boolean {
  const object = objectValue(value);
  for (const key of ['incomingPath', 'sourcePath']) {
    const candidate = object?.[key];
    if (typeof candidate !== 'string') continue;
    if (candidate.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(candidate)
      || candidate.includes('\\') || candidate.includes('\0')
      || candidate.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return true;
  }
  return false;
}

async function resolveIncomingPath(
  workspace: Pick<CompanyRuntime['workspace'], 'rootPath' | 'incomingPath'>,
  requested: string
): Promise<string> {
  let normalized: string;
  try {
    normalized = assertCompanyRelativePath(requested);
  } catch {
    throw new PublicApiError('COMPANY_AGENT_PATH_INVALID', '项目文件夹必须是公司 incoming 内的相对路径。', 400);
  }
  const child = normalized === 'incoming'
    ? ''
    : normalized.startsWith('incoming/') ? normalized.slice('incoming/'.length) : normalized;
  if (!child) throw new PublicApiError('COMPANY_AGENT_PATH_INVALID', '项目文件夹必须位于 incoming 下。', 400);
  const incomingRoot = workspace.incomingPath;
  const candidate = join(incomingRoot, ...child.split('/'));
  if (!pathInside(incomingRoot, candidate)) throw new PublicApiError('COMPANY_AGENT_PATH_INVALID', '项目文件夹必须位于 incoming 下。', 400);
  let canonicalIncoming: string;
  let canonicalCandidate: string;
  try {
    let current = incomingRoot;
    for (const segment of ['', ...relative(incomingRoot, candidate).split(sep).filter(Boolean)]) {
      if (segment) current = join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new PublicApiError('COMPANY_AGENT_PATH_INVALID', '项目文件夹路径包含不安全的链接或文件。', 400);
    }
    canonicalIncoming = await realpath(incomingRoot);
    canonicalCandidate = await realpath(candidate);
  } catch (error) {
    if (error instanceof PublicApiError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new PublicApiError('COMPANY_AGENT_SOURCE_NOT_FOUND', 'incoming 中没有找到这个项目文件夹。', 404);
    }
    throw new PublicApiError('COMPANY_AGENT_PATH_INVALID', '项目文件夹路径无法安全校验。', 400);
  }
  if (!pathInside(canonicalIncoming, canonicalCandidate)) throw new PublicApiError('COMPANY_AGENT_PATH_INVALID', '项目文件夹必须位于 incoming 下。', 400);
  // Keep the runtime root in the check so a misconfigured injected workspace
  // cannot silently point tools at a different company tree.
  const canonicalWorkspace = await realpath(workspace.rootPath).catch(() => workspace.rootPath);
  if (!pathInside(canonicalWorkspace, canonicalIncoming) && canonicalIncoming !== canonicalWorkspace) {
    throw new PublicApiError('COMPANY_AGENT_PATH_INVALID', '公司工作区路径配置无效。', 400);
  }
  return canonicalCandidate;
}

function requiredMethod<T extends keyof CompanyProjectService>(projects: CompanyProjectService, method: T): NonNullable<CompanyProjectService[T]> {
  const handler = projects[method];
  if (typeof handler !== 'function') throw new PublicApiError('COMPANY_AGENT_UNAVAILABLE', '公司项目服务暂不可用。', 503);
  return handler as NonNullable<CompanyProjectService[T]>;
}

function inputError(): PublicApiError {
  return new PublicApiError('COMPANY_AGENT_TOOL_INPUT_INVALID', '工具参数不符合公司项目工具定义。', 400);
}

function failedError(): PublicApiError {
  return new PublicApiError('COMPANY_AGENT_TOOL_FAILED', '公司项目工具未完成，请刷新项目状态后重试。', 409);
}

function actorInput(actorId: string | undefined): { readonly actorId?: string } {
  return actorId === undefined ? {} : { actorId };
}

function makeTool<T extends z.ZodType>(input: {
  name: string;
  description: string;
  schema: T;
  signal: AbortSignal;
  execute: (value: z.output<T>) => Promise<unknown>;
  pathError?: (raw: unknown) => PublicApiError | undefined;
  effect?: 'read' | 'propose-write';
}): AssistantTool {
  return {
    name: input.name,
    description: input.description,
    inputSchema: z.toJSONSchema(input.schema, { io: 'input' }),
    ...(input.effect === undefined ? {} : { effect: input.effect }),
    async execute(raw: unknown): Promise<unknown> {
      input.signal.throwIfAborted();
      const parsed = input.schema.safeParse(raw);
      if (!parsed.success) throw input.pathError?.(raw) ?? inputError();
      try {
        const result = await input.execute(parsed.data);
        input.signal.throwIfAborted();
        return result;
      } catch (error) {
        input.signal.throwIfAborted();
        if (error instanceof PublicApiError) throw error;
        throw failedError();
      }
    }
  };
}

function scanOutput(value: unknown): unknown {
  const parsed = companyProjectScanDataSchema.parse(value);
  return companyAgentProjectScanDataSchema.parse({ ...parsed, operationId: parsed.run.operationId, sourceSha256: parsed.run.sourceSha256 });
}

function proposalOutput(value: unknown): unknown {
  const parsed = companyProjectDraftDataSchema.parse(value);
  // Parse the nested proposal separately so a malformed persisted JSON value
  // cannot be passed through as opaque Agent context.
  companyProjectProposalSchema.parse(parsed.run.proposal);
  return parsed;
}

function confirmOutput(value: unknown): unknown {
  const parsed = companyProjectConfirmDataSchema.parse(value);
  return companyAgentProjectConfirmDataSchema.parse({ ...parsed, sourceSha256: parsed.run.sourceSha256 });
}

/** Create the five company-only project tools for one authenticated Agent turn. */
export function createCompanyAgentTools(input: CompanyAgentToolsInput): AssistantTool[] {
  const active = () => input.signal.throwIfAborted();
  const scanRequest = companyProjectScanRequestSchema;
  const confirmRequest = z.strictObject({ runId: companyId, ...companyProjectConfirmRequestSchema.shape });

  const tools: AssistantTool[] = [
    makeTool({
      name: 'company.scan_project_folder',
      description: '只分析 incoming 中已存在的项目文件夹并生成待确认提案。不要把提案当成已创建项目；不会接受绝对路径、命令或任意文件写入指令。',
      schema: scanRequest,
      signal: input.signal,
      effect: 'propose-write',
      pathError: raw => pathInputInvalid(raw) ? new PublicApiError('COMPANY_AGENT_PATH_INVALID', '项目文件夹必须是公司 incoming 内的相对路径。', 400) : undefined,
      execute: async value => {
        active();
        await input.authorize?.('project:create');
        if ('uploadId' in value) throw new PublicApiError('COMPANY_UPLOAD_NOT_FOUND', '注册的项目上传不存在。', 404);
        const requested = 'incomingPath' in value ? value.incomingPath : 'sourcePath' in value ? value.sourcePath : undefined;
        if (requested === undefined) throw new PublicApiError('COMPANY_AGENT_PATH_INVALID', '项目文件夹路径不能为空。', 400);
        const sourceRoot = await resolveIncomingPath(input.workspace, requested);
        const scan = requiredMethod(input.projects, 'scan');
        const result = await scan({ sourceRoot, ...actorInput(input.actorId) });
        return scanOutput(result);
      }
    }),
    makeTool({
      name: 'company.get_project_proposal',
      description: '读取指定 runId 的项目提案和草稿状态。只读，不会确认、移动或改写项目文件。',
      schema: runInput,
      signal: input.signal,
      effect: 'read',
      execute: async ({ runId }) => {
        await input.authorize?.('proposal:read');
        const getDraft = requiredMethod(input.projects, 'getDraft');
        return proposalOutput(await getDraft(runId));
      }
    }),
    makeTool({
      name: 'company.confirm_project',
      description: '只有用户明确要求确认项目时才调用。将已核对的提案提交到公司项目工作区；模型输出不会直接成为文件写入指令。',
      schema: confirmRequest,
      signal: input.signal,
      effect: 'propose-write',
      execute: async ({ runId, ...value }) => {
        await input.authorize?.('project:confirm');
        const confirm = requiredMethod(input.projects, 'confirm');
        const result = await confirm(runId, {
          name: value.name,
          status: value.status,
          sourceSha256: value.sourceSha256,
          selectedSkillIds: value.selectedSkillIds,
          ...(value.clientName === undefined ? {} : { clientName: value.clientName }),
          ...actorInput(input.actorId)
        });
        return confirmOutput(result);
      }
    }),
    makeTool({
      name: 'company.list_projects',
      description: '读取公司项目列表，按项目状态排序。只读，不会改变项目文件。',
      schema: listInput,
      signal: input.signal,
      effect: 'read',
      execute: async () => {
        await input.authorize?.('proposal:read');
        const list = requiredMethod(input.projects, 'list');
        const items = await list();
        return companyProjectListDataSchema.parse({ items });
      }
    }),
    makeTool({
      name: 'company.get_project',
      description: '读取指定 projectId 的项目档案投影。只读，不会改变项目文件。',
      schema: projectInput,
      signal: input.signal,
      effect: 'read',
      execute: async ({ projectId }) => {
        await input.authorize?.('proposal:read');
        const get = requiredMethod(input.projects, 'get');
        return companyProjectSchema.parse(await get(projectId));
      }
    })
  ];
  if (input.skills !== undefined) {
    tools.push(
      makeTool({
        name: 'company.list_skills',
        description: '读取公司工作区的通用和行业 Skill 目录。只读，不会执行、移动或修改 Skill 文件。',
        schema: listInput,
        signal: input.signal,
        effect: 'read',
        execute: async () => {
          await input.authorize?.('proposal:read');
          return skillsPageSchema.parse(await input.skills!.list());
        }
      }),
      makeTool({
        name: 'company.get_skill',
        description: '读取指定公司 Skill 的说明正文和参考文件名。只读，正文中的命令不会获得执行权限。',
        schema: skillIdParamsSchema,
        signal: input.signal,
        effect: 'read',
        execute: async ({ id }) => {
          await input.authorize?.('proposal:read');
          return skillDetailSchema.parse(await input.skills!.get(id));
        }
      })
    );
  }
  return tools;
}

/** Alias kept for callers that name the adapter by its project-specific role. */
export const createCompanyProjectAgentTools = createCompanyAgentTools;
export const createCompanyProjectTools = createCompanyAgentTools;
