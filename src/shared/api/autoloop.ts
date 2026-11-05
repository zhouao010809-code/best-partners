import { z } from 'zod';
import { API_VERSION } from './schemas.js';

export const autoloopCardSchema = z.strictObject({ id: z.number().int().positive(), kind: z.string(), title: z.string(), text: z.string(), options: z.array(z.string()), state: z.string() });
export const autoloopConnectionSchema = z.strictObject({ connected: z.boolean(), message: z.string().optional() });
const taskOptions = {
  workspaceId: z.string().trim().min(1).max(200).optional(),
  agentId: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9_.:/-]+$/).optional(),
  skillId: z.string().trim().min(1).max(200).optional(),
  notify: z.boolean().optional()
};
export const autoloopChoicesSchema = z.strictObject({
  workspaces: z.array(z.strictObject({ id: z.string(), name: z.string(), kind: z.enum(['isolated', 'vault', 'project']), available: z.boolean() })),
  agents: z.array(z.strictObject({ id: z.string(), name: z.string(), use: z.string(), model: z.string().optional(), effort: z.string().optional(), available: z.boolean() })),
  skills: z.array(z.strictObject({ id: z.string(), name: z.string(), description: z.string() })),
  notificationsAvailable: z.boolean()
});
export const autoloopTaskSchema = z.strictObject({
  ...taskOptions, id: z.uuid(), title: z.string(), instructions: z.string(), createdAt: z.string(),
  status: z.enum(['dispatching', 'queued', 'running', 'waiting', 'done', 'failed', 'cancelled', 'unknown']),
  summary: z.string(), runId: z.number().int().positive().nullable(), cards: z.array(autoloopCardSchema)
});
export const autoloopCreateInputSchema = z.strictObject({ ...taskOptions, requestId: z.uuid(), title: z.string().trim().min(1).max(200), instructions: z.string().trim().min(1).max(20_000) });
export const autoloopAnswerInputSchema = z.strictObject({ cardId: z.number().int().positive(), choice: z.number().int().nonnegative().optional(), text: z.string().trim().min(1).max(4_000).optional() }).refine(value => value.choice !== undefined || value.text !== undefined, '请选择一个选项或填写回答');
export const autoloopIdSchema = z.strictObject({ id: z.uuid() });
export const autoloopTaskListSchema = z.strictObject({ connection: autoloopConnectionSchema, tasks: z.array(autoloopTaskSchema) });
export const autoloopTaskDetailSchema = z.strictObject({ connection: autoloopConnectionSchema, task: autoloopTaskSchema, result: z.string(), timeline: z.array(z.strictObject({ id: z.number().int(), at: z.string(), text: z.string() })) });
const response = <T extends z.ZodType>(data: T) => z.strictObject({ version: z.literal(API_VERSION), data });
export type AutoloopChoices = z.infer<typeof autoloopChoicesSchema>;
export const autoloopChoicesResponseSchema = response(autoloopChoicesSchema);
export const autoloopTaskListResponseSchema = response(autoloopTaskListSchema);
export const autoloopTaskDetailResponseSchema = response(autoloopTaskDetailSchema);
export const autoloopCreateResponseSchema = response(z.strictObject({ task: autoloopTaskSchema }));
export const autoloopActionResponseSchema = response(z.strictObject({ ok: z.literal(true) }));
export type AutoloopCard = z.infer<typeof autoloopCardSchema>;
export type AutoloopConnection = z.infer<typeof autoloopConnectionSchema>;
export type AutoloopTask = z.infer<typeof autoloopTaskSchema>;
export type AutoloopTaskList = z.infer<typeof autoloopTaskListSchema>;
export type AutoloopTaskDetail = z.infer<typeof autoloopTaskDetailSchema>;
export type AutoloopCreateInput = z.infer<typeof autoloopCreateInputSchema>;
export type AutoloopAnswerInput = z.infer<typeof autoloopAnswerInputSchema>;
export interface AutoloopService {
  choices(): Promise<AutoloopChoices>;
  list(): Promise<AutoloopTaskList>;
  create(input: AutoloopCreateInput): Promise<{ task: AutoloopTask }>;
  detail(id: string): Promise<AutoloopTaskDetail>;
  answer(id: string, input: AutoloopAnswerInput): Promise<{ ok: true }>;
  cancel(id: string): Promise<{ ok: true }>;
}
