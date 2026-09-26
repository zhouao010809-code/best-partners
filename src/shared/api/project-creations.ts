import { z } from 'zod';
import { assistantSourceSchema } from './assistant.js';
import { projectRelativePathSchema } from './projects.js';
import { successEnvelopeSchema } from './schemas.js';

const revisionSchema = z.number().int().positive();
const titleSchema = z.string().trim().min(1).max(255);
const briefSchema = z.string().max(4000);
const bodySchema = z.string().max(60000);
const sourcesSchema = z.array(assistantSourceSchema).max(100);
const editableFields = {
  kind: z.enum(['topic', 'script']), title: titleSchema, brief: briefSchema, body: bodySchema,
  audience: z.string().max(2000), angle: z.string().max(2000), rationale: z.string().max(4000), sources: sourcesSchema
};
export const projectCreationSchema = z.strictObject({
  ...editableFields, id: z.uuid(), projectId: z.uuid(), revision: revisionSchema,
  finalVersionId: z.uuid().optional(), createdAt: z.string(), updatedAt: z.string()
});
export const creationCreateSchema = z.strictObject({
  ...editableFields, brief: briefSchema.default(''), body: bodySchema.default(''),
  audience: editableFields.audience.default(''), angle: editableFields.angle.default(''),
  rationale: editableFields.rationale.default(''), sources: sourcesSchema.default([])
});
export const creationSaveSchema = z.strictObject({ ...editableFields, expectedRevision: revisionSchema });
export const creationSnapshotSchema = z.strictObject({ expectedRevision: revisionSchema, finalize: z.boolean() });
export const creationVersionSchema = z.strictObject({
  id: z.uuid(), creationId: z.uuid(), number: revisionSchema, title: titleSchema, brief: briefSchema,
  body: bodySchema, sources: sourcesSchema, createdAt: z.string()
});
export const creationTopicSchema = z.strictObject({
  title: titleSchema, audience: editableFields.audience, angle: editableFields.angle, rationale: editableFields.rationale
});
const replacementSchema = z.strictObject({ before: bodySchema, after: bodySchema, start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .refine(value => value.end >= value.start && value.end - value.start === value.before.length, { message: '替换范围与原文不一致' });
export const creationSuggestionSchema = z.strictObject({
  id: z.uuid(), task: z.enum(['topics', 'script', 'revise', 'discuss']), reply: z.string().max(60000),
  topics: z.array(creationTopicSchema).max(20), body: bodySchema.optional(), replacement: replacementSchema.optional(),
  sources: sourcesSchema, baseRevision: revisionSchema.optional(), createdAt: z.string()
});
export const creationExchangeSchema = z.strictObject({
  id: z.uuid(), instruction: z.string().min(1).max(4000), suggestion: creationSuggestionSchema, createdAt: z.string()
});
export const creationDetailSchema = z.strictObject({ item: projectCreationSchema, versions: z.array(creationVersionSchema), messages: z.array(creationExchangeSchema).max(100) });
export const creationGenerateRequestSchema = z.strictObject({
  task: z.enum(['topics', 'script', 'revise', 'discuss']), instruction: z.string().trim().min(1).max(4000),
  itemId: z.uuid().optional(), expectedRevision: revisionSchema.optional(), model: z.string().min(1).max(200).optional(),
  selection: z.strictObject({ text: z.string().min(1).max(60000), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).optional()
}).superRefine((value, context) => {
  if ((value.itemId === undefined) !== (value.expectedRevision === undefined)) context.addIssue({ code: 'custom', path: ['expectedRevision'], message: '创作条目和版本号必须同时提供' });
  if ((value.task === 'script' || value.task === 'revise') && value.itemId === undefined) context.addIssue({ code: 'custom', path: ['itemId'], message: '请先选择创作条目' });
  if (value.selection && (value.task !== 'revise' || value.selection.end < value.selection.start || value.selection.end - value.selection.start !== value.selection.text.length)) context.addIssue({ code: 'custom', path: ['selection'], message: '选区与原文不一致' });
});
export const creationProjectParamsSchema = z.strictObject({ projectId: z.uuid() });
export const creationParamsSchema = creationProjectParamsSchema.extend({ creationId: z.uuid() });
export const creationVersionParamsSchema = creationParamsSchema.extend({ versionId: z.uuid() });
export const creationExportSchema = z.strictObject({ path: projectRelativePathSchema, versionId: z.uuid() });
export const creationListResponseSchema = successEnvelopeSchema(z.strictObject({ items: z.array(projectCreationSchema) }));
export const creationDetailResponseSchema = successEnvelopeSchema(creationDetailSchema);
export const creationSuggestionResponseSchema = successEnvelopeSchema(creationSuggestionSchema);
export const creationExportResponseSchema = successEnvelopeSchema(creationExportSchema);

export type ProjectCreation = z.infer<typeof projectCreationSchema>;
export type CreationCreate = z.input<typeof creationCreateSchema>;
export type CreationSave = z.infer<typeof creationSaveSchema>;
export type CreationVersion = z.infer<typeof creationVersionSchema>;
export type CreationDetail = z.infer<typeof creationDetailSchema>;
export type CreationExchange = z.infer<typeof creationExchangeSchema>;
export type CreationSuggestion = z.infer<typeof creationSuggestionSchema>;
export type CreationTopic = z.infer<typeof creationTopicSchema>;
export type CreationGenerateRequest = z.infer<typeof creationGenerateRequestSchema>;
export type CreationExport = z.infer<typeof creationExportSchema>;
export interface ProjectCreationService {
  list(projectId: string): Promise<ProjectCreation[]>;
  get(projectId: string, id: string): Promise<CreationDetail>;
  create(projectId: string, input: CreationCreate): Promise<CreationDetail>;
  save(projectId: string, id: string, input: CreationSave): Promise<CreationDetail>;
  snapshot(projectId: string, id: string, input: { expectedRevision: number; finalize: boolean }): Promise<CreationDetail>;
  exportVersion(projectId: string, id: string, versionId: string): Promise<CreationExport>;
  recordExchange(projectId: string, id: string, input: { instruction: string; suggestion: CreationSuggestion }): Promise<void>;
}
export type CreationService = ProjectCreationService;
export type CreationGenerator = (projectId: string, request: CreationGenerateRequest, signal?: AbortSignal) => Promise<CreationSuggestion>;
