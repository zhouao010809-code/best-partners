import { z } from 'zod';

const completeText = (maximum: number) => z.string().trim().min(1).max(maximum);

/** Editable drafts retain empty fields without inventing missing knowledge. */
export const knowledgeContentDraftSchema = z.strictObject({
  keywords: z.array(z.string().max(80)).max(6),
  scenarios: z.array(z.string().max(300)).max(3),
  conclusion: z.string().max(600),
  keyPoints: z.array(z.string().max(300)).max(4),
  boundary: z.string().max(600),
  quotes: z.array(z.string().max(3000)).max(8),
  summaries: z.array(z.string().max(1000)).max(3)
});

/** Full content; the knowledge body is carried separately in candidate.coreContent. */
export const knowledgeContentSchema = z.strictObject({
  keywords: z.array(completeText(80)).min(3).max(6),
  scenarios: z.array(completeText(300)).min(2).max(3),
  conclusion: completeText(600),
  keyPoints: z.array(completeText(300)).min(2).max(4),
  boundary: completeText(600),
  quotes: z.array(completeText(3000)).max(8),
  summaries: z.array(completeText(1000)).min(1).max(3)
});

export type KnowledgeContent = z.infer<typeof knowledgeContentSchema>;
