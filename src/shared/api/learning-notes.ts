import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';
import { learningSelectionSchema } from './learning.js';

export const learningNoteFieldsSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(100_000),
  selection: learningSelectionSchema,
  conversationId: z.uuid(),
  messageId: z.uuid()
});
export const learningNoteSaveSchema = learningNoteFieldsSchema.extend({ expectedRevision: z.number().int().nonnegative() });
export const learningNoteSchema = learningNoteFieldsSchema.extend({
  id: z.uuid(), revision: z.number().int().positive(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime()
});
export const learningNoteQuerySchema = z.strictObject({
  path: learningSelectionSchema.shape.path.optional(), conversationId: z.uuid().optional()
}).refine(query => query.path !== undefined || query.conversationId !== undefined, '请选择资料或会话后查看学习笔记。');
export const learningNoteListSchema = z.strictObject({ notes: z.array(learningNoteSchema) });
export const learningNoteListResponseSchema = successEnvelopeSchema(learningNoteListSchema);
export const learningNoteResponseSchema = successEnvelopeSchema(z.strictObject({ note: learningNoteSchema }));
export type LearningNote = z.infer<typeof learningNoteSchema>;
export type LearningNoteSave = z.infer<typeof learningNoteSaveSchema>;
export type LearningNoteQuery = z.infer<typeof learningNoteQuerySchema>;
export type LearningNoteList = z.infer<typeof learningNoteListSchema>;
