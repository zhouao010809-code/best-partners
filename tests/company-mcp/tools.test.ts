import { expect, it, vi } from 'vitest';
import { createCompanyToolHandlers } from '../../company-mcp-server/tools.js';
import type { CompanyMcpClient } from '../../company-mcp-server/client.js';

function fixture(): CompanyMcpClient {
  return {
    listProjects: vi.fn(async () => ({ items: [] })),
    getProject: vi.fn(async projectId => ({ projectId })),
    scanProjectFolder: vi.fn(async input => ({ input, state: 'proposed' })),
    getProjectProposal: vi.fn(async runId => ({ runId })),
    confirmProject: vi.fn(async (runId, input) => ({ runId, input, state: 'confirmed' })),
    listSkills: vi.fn(async () => ({ items: [] })),
    getSkill: vi.fn(async id => ({ id }))
  };
}

function value(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(result.content.find(item => item.type === 'text')?.text ?? '{}');
}

it('keeps confirmation explicit and rejects unknown or unsafe inputs', async () => {
  const client = fixture();
  const handlers = createCompanyToolHandlers(client);
  const invalid = await handlers.scan_project_folder({ incomingPath: '../secret' });
  expect(invalid.isError).toBe(true);
  expect(client.scanProjectFolder).not.toHaveBeenCalled();

  const confirmed = await handlers.confirm_project({
    runId: 'run-1', sourceSha256: 'a'.repeat(64), name: '教育项目', status: 'active', selectedSkillIds: []
  });
  expect(confirmed.isError).not.toBe(true);
  expect(value(confirmed)).toMatchObject({ runId: 'run-1', state: 'confirmed' });
  expect(client.confirmProject).toHaveBeenCalledOnce();
});
