import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCompanyWorkspace } from '../../src/server/company/company-paths.js';
import { createProjectService, type ProjectService } from '../../src/server/company/project-service.js';
import { openStateKernel, type NormalStateKernel } from '../../src/server/db/database.js';

const roots: string[] = [];
const kernels: NormalStateKernel[] = [];

afterEach(async () => {
  for (const kernel of kernels.splice(0)) kernel.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ source: string; workspace: Awaited<ReturnType<typeof ensureCompanyWorkspace>>; service: ProjectService; reopen: () => ProjectService; failOnce: () => ProjectService }> {
  const root = await mkdtemp(join(tmpdir(), 'company-restart-'));
  roots.push(root);
  const appDataDir = join(root, 'state');
  const vaultRealRoot = join(root, 'vault');
  const workspaceRoot = join(root, 'company-workspace');
  const source = join(root, '客户B餐饮项目');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(source, { recursive: true });
  await mkdir(vaultRealRoot, { recursive: true });
  await writeFile(join(source, '项目说明.md'), '客户名称：好味餐饮');
  const workspace = await ensureCompanyWorkspace(workspaceRoot, appDataDir);
  const open = (beforeConfirm?: () => void) => {
    const kernel = openStateKernel({ appDataDir, vaultRealRoot });
    if (kernel.mode !== 'normal') throw new Error('expected normal kernel');
    kernels.push(kernel);
    return createProjectService({ database: kernel.db, workspace: { id: 'company', ...workspace }, ...(beforeConfirm === undefined ? {} : { beforeConfirm }) });
  };
  let shouldFail = true;
  const failOnce = () => open(() => {
    if (shouldFail) {
      shouldFail = false;
      throw new Error('simulated confirmation interruption');
    }
  });
  return { source, workspace, service: open(), reopen: open, failOnce };
}

describe('company project confirmation recovery', () => {
  it('resumes a proposed confirmation after a service restart without duplicating the project', async () => {
    const { source, workspace, service, reopen, failOnce } = await setup();
    const draft = await service.scan({ sourceRoot: source });

    await expect(failOnce().confirm(draft.run.id, {
      sourceSha256: draft.proposal.sourceSha256,
      name: '好味餐饮代运营',
      status: 'active',
      actorId: 'operator-1'
    })).rejects.toThrow('simulated confirmation interruption');
    expect((await service.getDraft(draft.run.id)).run.state).toBe('proposed');

    const resumed = await reopen().confirm(draft.run.id, {
      sourceSha256: draft.proposal.sourceSha256,
      name: '好味餐饮代运营',
      status: 'active',
      actorId: 'operator-1'
    });
    expect(resumed.project.status).toBe('active');
    expect((await reopen().list()).filter(item => item.id === resumed.project.id)).toHaveLength(1);
    expect(await readFile(join(workspace.projectsPath, resumed.project.id, 'raw', '项目说明.md'), 'utf8')).toContain('好味餐饮');
  });

  it('rejects a stale proposal without changing its state, then allows a fresh proposal', async () => {
    const { source, service } = await setup();
    const draft = await service.scan({ sourceRoot: source });
    await writeFile(join(source, '项目说明.md'), '客户名称：好味餐饮\n新增资料');
    await expect(service.confirm(draft.run.id, {
      sourceSha256: draft.proposal.sourceSha256,
      name: '好味餐饮代运营',
      status: 'active'
    })).rejects.toMatchObject({ code: 'COMPANY_SOURCE_CHANGED' });
    expect((await service.getDraft(draft.run.id)).run.state).toBe('proposed');
    const fresh = await service.scan({ sourceRoot: source });
    expect(fresh.run.id).not.toBe(draft.run.id);
  });
});
