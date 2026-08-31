import { describe, expect, it } from 'vitest';
import {
  MAX_CURSOR_LENGTH,
  knowledgeQuerySchema,
  materialQuerySchema
} from '../../src/shared/api/schemas.js';

describe('API cursor schema', () => {
  it('accepts a cursor containing the worst-case JSON encoding of a maximum path', () => {
    const body = Buffer.from(JSON.stringify({
      version: 1,
      kind: 'material',
      filterSha256: 'a'.repeat(64),
      indexVersion: Number.MAX_SAFE_INTEGER,
      afterPath: '\u0001'.repeat(1024)
    }), 'utf8').toString('base64url');
    const worstCaseCursor = `${body}.${'b'.repeat(64)}`;
    const maximumCursor = `${'a'.repeat(MAX_CURSOR_LENGTH - 65)}.${'b'.repeat(64)}`;
    const oversizedCursor = `a${maximumCursor}`;

    expect(worstCaseCursor.length).toBeGreaterThan(8192);
    expect(materialQuerySchema.safeParse({ cursor: worstCaseCursor }).success).toBe(true);
    expect(knowledgeQuerySchema.safeParse({ cursor: worstCaseCursor }).success).toBe(true);
    expect(maximumCursor).toHaveLength(MAX_CURSOR_LENGTH);
    expect(materialQuerySchema.safeParse({ cursor: maximumCursor }).success).toBe(true);
    expect(materialQuerySchema.safeParse({ cursor: oversizedCursor }).success).toBe(false);
  });
});
