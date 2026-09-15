import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBrainFixture, KNOWLEDGE_PATH } from './fixtures.js';

const fixtures: Array<Awaited<ReturnType<typeof createBrainFixture>>> = [];
const transports: StdioClientTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map(async (transport) => {
    await transport.close();
  }));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe('brain MCP stdio protocol', () => {
  it('fails closed when the vault environment is missing without printing a path', async () => {
    const environment = { ...process.env };
    delete environment.XIAOZHAO_VAULT_ROOT;
    const child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('mcp-server/index.ts')], {
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('INVALID_ROOT');
    expect(stderr).not.toContain('/Users/');
  }, 15_000);

  it('initializes, lists only four read tools, and calls a tool', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('node_modules/tsx/dist/cli.mjs'), resolve('mcp-server/index.ts')],
      env: { ...process.env, XIAOZHAO_VAULT_ROOT: fixture.root } as Record<string, string>,
      stderr: 'pipe'
    });
    transports.push(transport);
    const client = new Client({ name: 'brain-mcp-test-client', version: '0.1.0' });
    await client.connect(transport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'search_knowledge',
      'read_knowledge',
      'read_source',
      'get_source_evidence'
    ]);
    expect(listed.tools.map((tool) => tool.name)).not.toContain('write_file');

    const result = await client.callTool({ name: 'read_knowledge', arguments: { path: KNOWLEDGE_PATH } });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('证据方法') })
    ]));

    const unsafe = await client.callTool({ name: 'read_knowledge', arguments: { path: '/etc/passwd' } });
    expect(unsafe.isError).toBe(true);
    expect(JSON.stringify(unsafe)).not.toContain(fixture.root);
  }, 15_000);
});
