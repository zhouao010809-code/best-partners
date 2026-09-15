import { z } from 'zod';
import { successEnvelopeSchema } from './schemas.js';

export const companyRoleSchema = z.enum(['owner', 'operator', 'reviewer']);
export const companyCsrfTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const companyUserSchema = z.object({
  id: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  role: companyRoleSchema
}).strict();

const companyPasswordSchema = z.string().min(1).max(1024);
const companyDisplayNameSchema = z.string().trim().min(1).max(128);

export const companyBootstrapRequestSchema = z.object({
  operator: z.object({
    displayName: companyDisplayNameSchema,
    password: companyPasswordSchema
  }).strict(),
  reviewer: z.object({
    displayName: companyDisplayNameSchema,
    password: companyPasswordSchema
  }).strict()
}).strict();

export const companyLoginRequestSchema = z.object({
  displayName: companyDisplayNameSchema,
  password: companyPasswordSchema
}).strict();

export const companyBootstrapDataSchema = z.object({
  users: z.array(companyUserSchema).length(2)
}).strict();

export const companySessionDataSchema = z.object({
  user: companyUserSchema,
  csrfToken: companyCsrfTokenSchema
}).strict();

export const companyUserResponseSchema = successEnvelopeSchema(companyBootstrapDataSchema);
export const companySessionResponseSchema = successEnvelopeSchema(companySessionDataSchema);
