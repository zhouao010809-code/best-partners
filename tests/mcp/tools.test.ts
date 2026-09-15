import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrainToolHandlers } from '../../mcp-server/tools.js';
import { createVaultReader } from '../../mcp-server/vault-reader.js';
import {
  createBrainFixture,
  KNOWLEDGE_PATH,
  OUTDATED_PATH,
  SOURCE_PATH
} from './fixtures.js';

const fixtures: Array<Awaited<ReturnType<typeof createBrainFixture>>> = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function resultValue(result: { content: Array<{ type: string; text?: string }> }): any {
  const text = result.content.find((item) => item.type === 'text')?.text;
  return JSON.parse(text ?? '{}');
}

describe('brain MCP tool handlers', () => {
  it('searches recall fields, excludes outdated notes by default, and reports skipped files', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const handlers = createBrainToolHandlers(await createVaultReader(fixture.root));
    const defaultResult = resultValue(await handlers.search_knowledge({ query: '证据', limit: 20 }));
    expect(defaultResult.items.map((item: { path: string }) => item.path)).toEqual([KNOWLEDGE_PATH]);
    expect(defaultResult.skippedCount).toBe(1);
    expect(defaultResult.truncated).toBe(false);
    expect(defaultResult.scannedBytes).toBeGreaterThan(0);

    const outdatedResult = resultValue(await handlers.search_knowledge({ query: '证据', status: '过时', limit: 20 }));
    expect(outdatedResult.items.map((item: { path: string }) => item.path)).toContain(OUTDATED_PATH);
  });

  it('reads knowledge, source, and evidence through structured JSON', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const handlers = createBrainToolHandlers(await createVaultReader(fixture.root));
    expect(resultValue(await handlers.read_knowledge({ path: KNOWLEDGE_PATH })).record.title).toBe('证据方法');
    expect(resultValue(await handlers.read_source({ path: SOURCE_PATH })).record.sourcePlatform).toBe('个人');
    expect(resultValue(await handlers.get_source_evidence({ path: SOURCE_PATH, query: '逐字核验' })).passages).toHaveLength(1);
  });

  it('returns a safe error for invalid paths and never writes files', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const before = await readFile(`${fixture.root}/${KNOWLEDGE_PATH}`);
    const handlers = createBrainToolHandlers(await createVaultReader(fixture.root));
    const result = await handlers.read_knowledge({ path: '/etc/passwd' });
    expect(result.isError).toBe(true);
    expect(resultValue(result).code).toBe('PATH_NOT_ALLOWED');
    expect(JSON.stringify(result)).not.toContain(fixture.root);
    expect(await readFile(`${fixture.root}/${KNOWLEDGE_PATH}`)).toEqual(before);
  });
});
