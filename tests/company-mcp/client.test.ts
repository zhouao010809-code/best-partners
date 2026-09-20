import { describe, expect, it, vi } from 'vitest';
import {
  CompanyMcpError,
  createCompanyMcpClient,
  loadCompanyMcpConfig
} from '../../company-mcp-server/client.js';

const csrf = 'c'.repeat(43);
const refreshedCsrf = 'd'.repeat(43);
const cookie = `company_session=${'s'.repeat(43)}`;
const sha = 'a'.repeat(64);
const now = '2026-09-20T00:00:00.000Z';
const project = {
  id: 'project-1', workspaceId: 'company', name: '教育代运营', status: 'active' as const,
  projectRoot: 'projects/project-1', sourceRoot: 'incoming/education', configSha256: sha,
  confidence: {}, selectedSkillIds: [], createdAt: now, updatedAt: now, dataCoverage: 'not_configured' as const
};
const proposal = {
  sourceRoot: 'incoming/education', sourceSha256: sha, suggestedName: '教育代运营', suggestedStatus: 'draft' as const,
  fields: {}, selectedSkillIds: [], entries: [], issues: []
};
const run = {
  id: 'run-1', projectId: project.id, sourceSha256: sha, state: 'proposed' as const,
  proposal, operationId: 'operation-1', createdAt: now, updatedAt: now
};

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function loginResponse(token = csrf): Response {
  return response({
    data: { user: { id: 'operator-1', displayName: '运营', role: 'operator' }, csrfToken: token },
    version: 1
  }, 200, { 'set-cookie': `${cookie}; Path=/api/company; HttpOnly; SameSite=Strict` });
}

const config = {
  origin: 'http://127.0.0.1:4399',
  displayName: '运营',
  password: 'private-password',
  writeEnabled: false,
  confirmEnabled: false,
  confirmIntent: null
} as const;

describe('company MCP HTTP client', () => {
  it('validates explicit configuration without returning credentials', () => {
    expect(loadCompanyMcpConfig({
      COMPANY_API_ORIGIN: config.origin,
      COMPANY_DISPLAY_NAME: config.displayName,
      COMPANY_PASSWORD: config.password
    })).toEqual(config);
    for (const origin of ['http://0.0.0.0:4399', 'http://192.168.1.20:4399', 'http://8.8.8.8:4399', 'http://[::ffff:0:0]:4399', 'file:///tmp/company', 'http://user:pass@host:4399', 'http://host:4399/path']) {
      expect(() => loadCompanyMcpConfig({
        COMPANY_API_ORIGIN: origin,
        COMPANY_DISPLAY_NAME: '运营',
        COMPANY_PASSWORD: 'secret'
      })).toThrowError(CompanyMcpError);
    }
    expect(() => loadCompanyMcpConfig({
      COMPANY_API_ORIGIN: config.origin,
      COMPANY_DISPLAY_NAME: config.displayName,
      COMPANY_PASSWORD: config.password,
      COMPANY_MCP_WRITE_ENABLED: 'true',
      COMPANY_MCP_CONFIRM_ENABLED: 'true'
    })).toThrowError(expect.objectContaining({ code: 'COMPANY_MCP_CONFIRM_INTENT_REQUIRED' }));
  });

  it('logs in once and reads projects with an opaque cookie', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(response({ data: { items: [project] }, version: 1 }));
    const client = createCompanyMcpClient(config, fetcher);

    const result = await client.listProjects();
    expect(result).toEqual({ items: [project] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST', redirect: 'error', headers: expect.objectContaining({ origin: config.origin })
    });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'GET', headers: { cookie }
    });
    expect(JSON.stringify(result)).not.toContain(config.password);
  });

  it('fails closed before login when proposal writes are disabled', async () => {
    const fetcher = vi.fn();
    const client = createCompanyMcpClient(config, fetcher);
    await expect(client.scanProjectFolder({ incomingPath: 'incoming/education' }))
      .rejects.toMatchObject({ code: 'COMPANY_MCP_WRITE_DISABLED', status: 403 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires a separate one-session confirmation gate', async () => {
    const fetcher = vi.fn();
    const client = createCompanyMcpClient({ ...config, writeEnabled: true }, fetcher);
    await expect(client.confirmProject('run-1', {
      sourceSha256: sha,
      name: '教育代运营',
      status: 'active',
      selectedSkillIds: []
    })).rejects.toMatchObject({ code: 'COMPANY_MCP_CONFIRM_DISABLED', status: 403 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('confirms only the exact host-authorized intent and consumes it before the request', async () => {
    const intent = {
      runId: 'run-1',
      sourceSha256: sha,
      name: '教育代运营',
      status: 'active' as const,
      selectedSkillIds: []
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(response({
        data: {
          project: { ...project, status: 'active' },
          run: { ...run, state: 'confirmed' },
          operationId: 'operation-confirmed'
        },
        version: 1
      }));
    const client = createCompanyMcpClient({
      ...config,
      writeEnabled: true,
      confirmEnabled: true,
      confirmIntent: intent
    }, fetcher);

    await expect(client.confirmProject(intent.runId, {
      sourceSha256: intent.sourceSha256,
      name: intent.name,
      status: intent.status,
      selectedSkillIds: intent.selectedSkillIds
    })).resolves.toMatchObject({ operationId: 'operation-confirmed' });
    await expect(client.confirmProject(intent.runId, {
      sourceSha256: intent.sourceSha256,
      name: intent.name,
      status: intent.status,
      selectedSkillIds: intent.selectedSkillIds
    })).rejects.toMatchObject({ code: 'COMPANY_MCP_CONFIRM_INTENT_CONSUMED' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refreshes a stale CSRF token once and retries the exact scan request', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(response({ error: { code: 'CSRF_INVALID', message: 'CSRF token rejected', operationId: 'op' } }, 403))
      .mockResolvedValueOnce(response({ data: { user: { id: 'operator-1', displayName: '运营', role: 'operator' }, csrfToken: refreshedCsrf }, version: 1 }))
      .mockResolvedValueOnce(response({ data: { reused: false, run, project: { ...project, status: 'draft' }, proposal }, version: 1 }));
    const client = createCompanyMcpClient({ ...config, writeEnabled: true }, fetcher);

    await expect(client.scanProjectFolder({ incomingPath: 'incoming/education' }))
      .resolves.toMatchObject({ run: { id: 'run-1' }, proposal: { sourceRoot: 'incoming/education' } });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: expect.objectContaining({ 'x-csrf-token': csrf }) });
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({ headers: expect.objectContaining({ 'x-csrf-token': refreshedCsrf }) });
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[3]?.[1]?.body);
  });

  it.each(['/Users/shared/company/projects/project-1', '../personal', 'file:///Users/shared/secret'])('rejects an otherwise valid project path %s', async (projectRoot) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(response({ data: { items: [{ ...project, projectRoot }] }, version: 1 }));
    const client = createCompanyMcpClient(config, fetcher);

    await expect(client.listProjects()).rejects.toMatchObject({ code: 'COMPANY_RESPONSE_PATH_UNSAFE' });
  });

  it('rejects unsafe Skill reference paths', async () => {
    const skill = {
      id: sha, name: '教育方法', description: '只读', revision: sha,
      folderId: null, folderName: null, markdown: '# Skill', references: ['/Users/shared/secret.md']
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(response({ data: skill, version: 1 }));
    const client = createCompanyMcpClient(config, fetcher);

    await expect(client.getSkill(sha)).rejects.toMatchObject({ code: 'COMPANY_RESPONSE_PATH_UNSAFE' });
  });
});
