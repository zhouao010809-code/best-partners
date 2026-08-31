import { z } from 'zod';
import { PublicApiError } from '../../shared/api/errors.js';

export function parseApiInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.length === 0 ? 'request' : issue.path.join('.');
    if (fields[key] === undefined) fields[key] = 'Invalid value';
  }
  throw new PublicApiError(
    'VALIDATION_ERROR',
    'Request validation failed',
    400,
    fields
  );
}

export function parseApiOutput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('API_OUTPUT_INVALID');
  return parsed.data;
}
