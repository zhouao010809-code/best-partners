import { z } from 'zod';
import { API_VERSION } from './schemas.js';
import { isIsoCalendarDate } from '../domain/iso-date.js';

export const intakePlatforms = ['B站', 'YouTube', '抖音', '小红书', '公众号', '飞书', 'X推特', 'Reddit', '小宇宙', '独立站', '个人', '其他'] as const;
const filename = z.string().min(1).max(255).refine((v) => v !== '.' && v !== '..' && !/[\0/\\]/u.test(v));
export const intakeFieldsSchema = z.strictObject({
  platform: z.enum(intakePlatforms), title: z.string().trim().min(1).max(500),
  collectedAt: z.string().refine(isIsoCalendarDate), author: z.string().max(1000).optional(), url: z.string().max(4000).optional()
});
export const intakePreviewRequestSchema = z.strictObject({ name: filename, mainName: filename, fields: intakeFieldsSchema });
export const intakeOutcomeSchema = z.strictObject({ id: z.uuid(), target: z.string().max(4096),
  state: z.enum(['pending', 'archived', 'needs-review']), indexed: z.boolean() });
export const intakeListSchema = z.strictObject({
  available: z.boolean(), automaticArchive: z.literal(false), problem: z.string().max(1000).optional(),
  items: z.array(z.strictObject({ name: filename, kind: z.enum(['file', 'directory']), mainCandidates: z.array(filename).max(100),
    fields: intakeFieldsSchema.partial(), problem: z.string().max(1000).optional() })).max(200),
  operations: z.array(intakeOutcomeSchema.omit({ indexed: true })).max(200)
});
export const intakePreviewSchema = z.strictObject({ token: z.uuid(), target: z.string().max(4096),
  mainName: filename, markdown: z.string().max(30000), truncated: z.boolean(), expiresAt: z.string() });
export const intakeTokenSchema = z.strictObject({ token: z.uuid() });
export const intakeResumeSchema = z.strictObject({ id: z.uuid() });
const envelope = <T extends z.ZodType>(data: T) => z.strictObject({ data, version: z.literal(API_VERSION) });
export const intakeListResponseSchema = envelope(intakeListSchema);
export const intakePreviewResponseSchema = envelope(intakePreviewSchema);
export const intakeOutcomeResponseSchema = envelope(intakeOutcomeSchema);
export type IntakeList = z.infer<typeof intakeListSchema>;
export type IntakePreview = z.infer<typeof intakePreviewSchema>;
export type IntakePreviewRequest = z.infer<typeof intakePreviewRequestSchema>;
export type IntakeOutcome = z.infer<typeof intakeOutcomeSchema>;
