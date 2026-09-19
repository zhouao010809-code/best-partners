import { z } from 'zod';
import type { AttachmentSelection } from '../../shared/api/attachments.js';
import { attachmentArchiveRequestSchema, type AttachmentArchiveRequest } from '../../shared/api/attachments.js';
import type { AssistantPlanAction, AssistantSource } from '../../shared/api/assistant.js';
import { PublicApiError } from '../../shared/api/errors.js';
import type { AttachmentService } from '../attachments/service.js';
import type { ReadService } from '../services/read-service.js';
import type { ExtractionService } from '../services/extraction-service.js';
import { createBrainTools } from './brain-tools.js';
import { attachmentIntent } from './attachment-intent.js';
import { evidenceFragment } from './presentation.js';
import type { AssistantEvent, AssistantTool, AssistantToolEffect } from './types.js';

const readInput = z.strictObject({ id: z.uuid(), page: z.number().int().positive().optional(), offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(12_000).default(8000) });
const prepareInput = z.strictObject({ id: z.uuid(), readingState: z.enum(['未看', '已看']).default('未看') });
type AttachmentPort = Pick<AttachmentService, 'get' | 'readPages' | 'archive'>;
export type AttachmentArchiveProposalRequest = {
  id: string;
  selection: { id: string; startPage: number; endPage: number };
  fields?: AttachmentArchiveRequest['fields'];
};

/** Combines file and vault tools while keeping file scope and write intent outside the model. */
export function createAssistantTools(input: {
  readService: ReadService; extractionService?: ExtractionService; attachmentService?: AttachmentPort;
  /** Company tools are opt-in and must be supplied by the company composition root. */
  companyTools?: readonly AssistantTool[];
  proposeArchive?: (request: AttachmentArchiveProposalRequest, signal?: AbortSignal) => Promise<AssistantPlanAction>;
  markActionPending?: () => void;
  attachments: AttachmentSelection[]; userMessage: string; scope: 'brain' | 'current'; contextPath?: string;
  model: string; signal: AbortSignal; emit(event: AssistantEvent): void;
}): AssistantTool[] {
  const selected = new Map(input.attachments.map((selection, index) => [selection.id, { selection, sourceId: `S${index + 1}` }]));
  const additionalPaths = new Set<string>();
  const paths = new Map<string, AttachmentSelection>();
  const intent = attachmentIntent(input.userMessage);
  const emitted = new Map<string, AssistantSource>();
  // A provider may return multiple tool calls in the same step. Keep one
  // durable proposal per attachment for this model turn so concurrent calls
  // cannot create two confirmation cards for the same write.
  const proposedArchives = new Map<string, AssistantPlanAction | Promise<AssistantPlanAction>>();
  let readCharacters = 0;
  const active = () => input.signal.throwIfAborted();
  const port = () => {
    if (!input.attachmentService) throw new PublicApiError('ATTACHMENT_UNAVAILABLE', '当前连接不支持文件输入，请使用新版桌面应用。', 503);
    return input.attachmentService;
  };
  const chosen = (id: string) => {
    active();
    const value = selected.get(id);
    if (!value) throw new PublicApiError('ASSISTANT_ATTACHMENT_SCOPE', '只能读取或处理本轮用户选中的文件。', 403);
    const attachment = port().get(id);
    if (attachment.status !== 'ready') throw new PublicApiError('ATTACHMENT_NOT_READY', attachment.problem || '文件尚未完成读取，请等待或重试。', 409);
    const startPage = value.selection.startPage ?? 1;
    const endPage = value.selection.endPage ?? attachment.pageCount ?? 1;
    return { ...value, attachment, startPage, endPage };
  };
  const rememberPath = (id: string, materialPath: string) => {
    additionalPaths.add(materialPath);
    paths.set(materialPath, selected.get(id)!.selection);
  };
  for (const selection of input.attachments) {
    const record = port().get(selection.id);
    if (record.archive?.state === 'archived' && record.archive.materialPath) rememberPath(selection.id, record.archive.materialPath);
  }
  async function requireSelectedText(id: string) {
    const { startPage, endPage } = chosen(id);
    for (let page = startPage; page <= endPage; page += 50) {
      const result = await port().readPages({ id, startPage: page, endPage: Math.min(page + 49, endPage) }, input.signal);
      active();
      if (result.pages.some(value => value.text.trim())) return;
    }
    throw new PublicApiError('ATTACHMENT_SELECTION_EMPTY', '所选页面没有可提炼的文字，可能是空白页或扫描页。请改选有文字的页面；当前版本尚未提供 OCR。', 409);
  }
  async function sourceRange(path: string) {
    const selection = paths.get(path);
    if (!selection) return;
    const { attachment, startPage, endPage } = chosen(selection.id);
    if (intent.extract) await requireSelectedText(selection.id);
    const detail = await input.readService.getDocumentDetail(path);
    active();
    const marker = (page: number) => `<!-- xiaozhao-page:${attachment.sha256}:${page} -->`;
    const offset = detail.markdown.indexOf(marker(startPage));
    const next = endPage < (attachment.pageCount ?? 1) ? detail.markdown.indexOf(marker(endPage + 1)) : detail.markdown.length;
    if (offset < 0 || next <= offset) throw new PublicApiError('ATTACHMENT_SOURCE_CHANGED', '归档正文的页码标记已变化，请核对来源后重新提炼。', 409);
    return { offset, length: next - offset, label: `${attachment.name} · 第 ${startPage}–${endPage} 页`, sourceRawSha256: detail.versionMarker.rawSha256,
      coversWholeSource: startPage === 1 && endPage === attachment.pageCount };
  }
  const brainTools = createBrainTools({ ...input, ...(input.companyTools === undefined ? {} : { companyTools: input.companyTools }), additionalPaths, sourceOffset: selected.size,
    canPreparePath: path => !paths.has(path) || intent.extract, resolveExtractionRange: sourceRange });
  if (!selected.size) return brainTools;
  function tool<T extends z.ZodType>(name: string, description: string, schema: T, execute: (value: z.output<T>) => Promise<unknown>, effect?: AssistantToolEffect): AssistantTool {
    return { name, description, inputSchema: z.toJSONSchema(schema, { io: 'input' }), execute: async value => {
      active();
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new PublicApiError('ASSISTANT_TOOL_INPUT_INVALID', '文件工具参数不符合要求，请按定义重新调用。', 400);
      try { return await execute(parsed.data); }
      catch (error) {
        active();
        if (error instanceof PublicApiError) throw error;
        throw new PublicApiError('ASSISTANT_ATTACHMENT_FAILED', '本次文件操作未完成，原件和已完成步骤保留，请重试。', 409);
      }
    }, ...(effect ? { effect } : {}) };
  }
  async function archive(request: z.infer<typeof attachmentArchiveRequestSchema>, mode: 'propose' | 'execute' = 'propose') {
    const { attachment, startPage, endPage } = chosen(request.id);
    if (!intent.archive) throw new PublicApiError('ASSISTANT_INTENT_REQUIRED', '本轮用户没有明确要求归档或提炼附件，请先回答当前问题；如需保存，请用户直接说“归档这个文件”。', 403);
    if (mode === 'propose') {
      if (!input.proposeArchive) throw new PublicApiError('ASSISTANT_ACTION_UNAVAILABLE', '当前问问暂时不能安全执行归档，请更新桌面应用后重试。', 503);
      const existing = proposedArchives.get(request.id);
      if (existing) {
        const action = await existing;
        return { status: 'awaiting_confirmation', actionId: action.id, message: '归档计划已生成，等待用户确认；尚未写入资料。' };
      }
      const proposal = input.proposeArchive({ id: request.id, selection: { id: request.id, startPage, endPage }, fields: request.fields }, input.signal);
      proposedArchives.set(request.id, proposal);
      let action: AssistantPlanAction;
      try { action = await proposal; }
      catch (error) { proposedArchives.delete(request.id); throw error; }
      proposedArchives.set(request.id, action);
      input.emit({ type: 'action', action });
      input.markActionPending?.();
      return { status: 'awaiting_confirmation', actionId: action.id, message: '归档计划已生成，等待用户确认；尚未写入资料。' };
    }
    input.emit({ type: 'attachment-archive-started', attachmentId: request.id });
    const result = await port().archive(request, input.signal);
    if (result.state !== 'archived') throw new PublicApiError('ATTACHMENT_ARCHIVE_REVIEW', '归档仍需核验，已保存恢复记录；请在附件卡片继续归档。', 409);
    rememberPath(request.id, result.materialPath);
    input.emit({ type: 'action', action: { id: `archive:${result.operationId}:${request.id}`, type: 'archive', label: '打开归档资料', attachmentId: request.id,
      materialPath: result.materialPath, materialTitle: attachment.name, operationId: result.operationId,
      status: 'archived', duplicate: result.duplicate, indexed: result.indexed } });
    active();
    return result;
  }
  return [...brainTools,
    tool('list_attachments', '列出本轮用户选中的文件和可读取页码，元数据不等于已读取正文。仅本轮选择可见。', z.strictObject({}), async () => ({
      attachments: input.attachments.map(({ id }) => { const item = chosen(id); return { id, name: item.attachment.name, totalPages: item.attachment.pageCount, startPage: item.startPage, endPage: item.endPage, archivedPath: item.attachment.archive?.materialPath }; }),
      canArchive: intent.archive, canExtract: intent.extract
    })),
    tool('read_attachment', '读取选中文件的一页文字，引用返回的 sourceId，说明页码。每次最多12000字符，长页通过nextOffset继续；不能把部分页内容说成全文。', readInput, async ({ id, page, offset, length }) => {
      const item = chosen(id);
      const selectedPage = page ?? item.startPage;
      if (selectedPage < item.startPage || selectedPage > item.endPage) throw new PublicApiError('ASSISTANT_ATTACHMENT_SCOPE', '该页不在本轮用户选择的范围内。', 403);
      const result = await port().readPages({ id, startPage: selectedPage, endPage: selectedPage }, input.signal);
      active();
      const fullText = result.pages.find(value => value.page === selectedPage)?.text ?? '';
      if (offset > fullText.length) throw new PublicApiError('ATTACHMENT_PAGE_RANGE', '读取位置超出这一页的文字范围。', 400);
      const text = fullText.slice(offset, offset + length);
      if (readCharacters + text.length > 80_000) throw new PublicApiError('ASSISTANT_READ_LIMIT', '本轮附件读取量已达到上限，请依据已读内容回答，或缩小页码范围继续。', 400);
      readCharacters += text.length;
      const source = emitted.get(id) ?? { id: item.sourceId, path: `attachment:${id}`, attachmentId: id, title: item.attachment.name, kind: 'read' as const, evidence: [] };
      const evidence = evidenceFragment(fullText, result.textRevision, offset, length);
      if (evidence) { evidence.page = selectedPage; source.evidence ??= []; if (source.evidence.length < 16 && !source.evidence.some(old => old.page === selectedPage && old.offset === offset && old.length === evidence.length)) source.evidence.push(evidence); }
      emitted.set(id, source); input.emit({ type: 'source', source: structuredClone(source) });
      return { sourceId: item.sourceId, id, name: item.attachment.name, page: selectedPage, text, offset, totalCharacters: fullText.length,
        totalPages: result.totalPages, selectedRange: { startPage: item.startPage, endPage: item.endPage },
        truncated: result.truncated || offset > 0 || offset + text.length < fullText.length,
        ...(offset + text.length < fullText.length ? { nextOffset: offset + text.length } : {}) };
    }),
    tool('archive_attachment', '仅当本轮用户明确要求归档所选文件时可用。先生成归档计划，等待用户确认；不会在本轮直接写入。仅总结/问答不归档。', attachmentArchiveRequestSchema, archive, 'propose-write'),
    tool('prepare_attachment_extraction', '仅在用户明确要求提炼附件时调用。先保留原件，再为用户选中页码准备提炼证据与规则；依据返回内容生成结构化候选后调用submit_candidates。不会自动正式入库。', prepareInput, async ({ id, readingState }) => {
      chosen(id);
      if (!intent.extract) throw new PublicApiError('ASSISTANT_INTENT_REQUIRED', '本轮尚未明确要求提炼文件，请先按当前问题回答。', 403);
      await requireSelectedText(id);
      const result = await archive({ id }, 'execute');
      active();
      if (!result || typeof result !== 'object' || typeof (result as { materialPath?: unknown }).materialPath !== 'string') {
        throw new PublicApiError('ATTACHMENT_ARCHIVE_REVIEW', '归档计划已生成，完成提炼前需要先确认归档。', 409);
      }
      const materialPath = (result as { materialPath: string }).materialPath;
      return brainTools.find(candidate => candidate.name === 'prepare_extraction')!.execute({ path: materialPath, readingState });
    })
  ];
}
