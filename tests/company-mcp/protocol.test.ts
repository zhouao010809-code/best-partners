import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transports: StdioClientTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.close()));
});

describe('company MCP stdio protocol', () => {
  it('fails closed without configuration and does not print secrets', async () => {
    const environment = { ...process.env };
    delete environment.COMPANY_API_ORIGIN;
    delete environment.COMPANY_DISPLAY_NAME;
    delete environment.COMPANY_PASSWORD;
    const child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('company-mcp-server/index.ts')], {
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
    expect(stderr).toContain('COMPANY_API_ORIGIN_REQUIRED');
    expect(stderr).not.toContain('COMPANY_PASSWORD');
  }, 15_000);

  it('lists exactly the seven bounded company tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['node_modules/tsx/dist/cli.mjs', 'company-mcp-server/index.ts'],
      env: {
        ...process.env,
        COMPANY_API_ORIGIN: 'http://127.0.0.1:4399',
        COMPANY_DISPLAY_NAME: 'Operator',
        COMPANY_PASSWORD: 'not-used-before-tool-call'
      } as Record<string, string>,
      stderr: 'pipe'
    });
    transports.push(transport);
    const client = new Client({ name: 'company-mcp-test-client', version: '0.1.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual([
      'company.list_projects',
      'company.get_project',
      'company.scan_project_folder',
      'company.get_project_proposal',
      'company.confirm_project',
      'company.list_skills',
      'company.get_skill'
    ]);
    expect(listed.tools.find(tool => tool.name === 'company.confirm_project')?.description)
      .toMatch(/explicitly confirm/u);
    expect(listed.tools.find(tool => tool.name === 'company.list_projects')?.annotations)
      .toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(listed.tools.find(tool => tool.name === 'company.scan_project_folder')?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(listed.tools.find(tool => tool.name === 'company.confirm_project')?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  }, 15_000);
});
