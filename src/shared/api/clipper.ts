import { z } from 'zod';

export const CLIPPER_EXTENSION_ID = 'gabimlllmnckfcpcoheepplnkfebfkda';
export const CLIPPER_HOST_NAME = 'local.bestpartners.clipper';
export const clipperPayloadSchema = z.object({
  packetId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  title: z.string().trim().min(1).max(300), url: z.string().url().refine(v => /^https?:\/\//.test(v)),
  content: z.string().max(10 * 1024 * 1024), clippedAt: z.string().datetime()
}).strict();
export const clipperMessageSchema = z.object({ extensionId: z.literal(CLIPPER_EXTENSION_ID), token: z.string().min(16).max(256), payload: clipperPayloadSchema }).strict();
export type ClipperPayload = z.infer<typeof clipperPayloadSchema>;
export type ClipperMessage = z.infer<typeof clipperMessageSchema>;
