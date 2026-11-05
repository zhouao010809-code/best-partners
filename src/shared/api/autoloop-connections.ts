import { z } from 'zod';
import { API_VERSION } from './schemas.js';

export const connectionIdSchema = z.enum(['desktop', 'feishu', 'dingtalk', 'wecom', 'slack', 'discord', 'github', 'gitlab', 'hub']);
export const autoloopConnectionSaveInputSchema = z.strictObject({
  enabled: z.boolean(),
  user: z.string().trim().regex(/^ou_[A-Za-z0-9_-]+$/u).optional(),
  answerers: z.array(z.string().regex(/^ou_[A-Za-z0-9_-]+$/u)).max(100).optional(),
  url: z.url().max(4000).optional(),
  secret: z.string().min(8).max(1024).regex(/^[^\r\n\0'"]+$/u).optional(),
  publicUrl: z.union([z.url().max(2000), z.literal('')]).optional()
});
export const autoloopConnectionItemSchema = z.strictObject({
  id: connectionIdSchema, name: z.string(), kind: z.enum(['channel', 'source', 'hub']),
  enabled: z.boolean(), configured: z.boolean(), status: z.enum(['configured', 'needs-setup', 'unavailable']),
  message: z.string(), secretConfigured: z.boolean(),
  settings: z.strictObject({ user: z.string().optional(), answerers: z.array(z.string()).optional(), publicUrl: z.string().optional() })
});
export const autoloopConnectionsSchema = z.strictObject({ connections: z.array(autoloopConnectionItemSchema), restartRequired: z.boolean() });
export const autoloopConnectionProbeSchema = z.strictObject({ id: connectionIdSchema, ok: z.boolean(), message: z.string(), checks: z.array(z.strictObject({ name: z.string(), ok: z.boolean(), message: z.string() })) });
export const autoloopConnectionSaveSchema = z.strictObject({ ok: z.literal(true), restartRequired: z.boolean() });
export const autoloopLifecycleInputSchema = z.strictObject({ action: z.enum(['restart', 'start', 'stop']) });
export const autoloopLifecycleSchema = z.strictObject({ ok: z.literal(true), message: z.string() });
const response = <T extends z.ZodType>(data: T) => z.strictObject({ version: z.literal(API_VERSION), data });
export const autoloopConnectionsResponseSchema = response(autoloopConnectionsSchema);
export const autoloopConnectionSaveResponseSchema = response(autoloopConnectionSaveSchema);
export const autoloopConnectionProbeResponseSchema = response(autoloopConnectionProbeSchema);
export const autoloopLifecycleResponseSchema = response(autoloopLifecycleSchema);
export type AutoloopConnectionId = z.infer<typeof connectionIdSchema>;
export type AutoloopConnectionItem = z.infer<typeof autoloopConnectionItemSchema>;
export type AutoloopConnections = z.infer<typeof autoloopConnectionsSchema>;
export type AutoloopConnectionSaveInput = z.infer<typeof autoloopConnectionSaveInputSchema>;
export type AutoloopConnectionProbe = z.infer<typeof autoloopConnectionProbeSchema>;
export interface AutoloopConnectionsService {
  list(): Promise<AutoloopConnections>;
  save(id: AutoloopConnectionId, input: AutoloopConnectionSaveInput): Promise<z.infer<typeof autoloopConnectionSaveSchema>>;
  probe(id: AutoloopConnectionId): Promise<AutoloopConnectionProbe>;
  lifecycle(action: z.infer<typeof autoloopLifecycleInputSchema>['action']): Promise<z.infer<typeof autoloopLifecycleSchema>>;
}
