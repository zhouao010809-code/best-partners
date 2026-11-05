import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
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

async function setup(): Promise<{ source: string; workspace: Awaited<ReturnType<typeof ensureCompanyWorkspace>>; service: ProjectService; reopen: () => ProjectService; failOnce: () => ProjectService; failAfterPublish: () => ProjectService }> {
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
  const open = (beforeConfirm?: () => void, afterPublish?: () => void) => {
    const kernel = openStateKernel({ appDataDir, vaultRealRoot });
    if (kernel.mode !== 'normal') throw new Error('expected normal kernel');
    kernels.push(kernel);
    return createProjectService({ database: kernel.db, workspace: { id: 'company', ...workspace },
      ...(beforeConfirm === undefined ? {} : { beforeConfirm }),
      ...(afterPublish === undefined ? {} : { afterPublish }) });
  };
  let shouldFail = true;
  const failOnce = () => open(() => {
    if (shouldFail) {
      shouldFail = false;
      throw new Error('simulated confirmation interruption');
    }
  });
  let shouldFailAfterPublish = true;
  const failAfterPublish = () => open(undefined, () => {
    if (shouldFailAfterPublish) {
      shouldFailAfterPublish = false;
      throw new Error('simulated post-publish interruption');
    }
  });
  return { source, workspace, service: open(), reopen: open, failOnce, failAfterPublish };
}

describe('company project confirmation recovery', () => {
  it('confirms a legacy version 1 staging layout after restarting the service', async () => {
    const { source, workspace, service, reopen } = await setup();
    const draft = await service.scan({ sourceRoot: source });
    const staging = join(workspace.incomingPath, draft.run.id);
    for (const name of await readdir(join(staging, 'raw'))) {
      await rename(join(staging, 'raw', name), join(staging, name));
    }
    await rmdir(join(staging, 'raw'));
    const manifestPath = join(staging, 'source-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: 1 }));

    const result = await reopen().confirm(draft.run.id, {
      sourceSha256: draft.proposal.sourceSha256, name: '旧版待确认项目', status: 'active'
    });
    expect(result.run.state).toBe('confirmed');
    expect(await readFile(join(workspace.projectsPath, result.project.id, 'raw', '项目说明.md'), 'utf8')).toBe('客户名称：好味餐饮');
  });

  it('preserves a source file named source-manifest.json through publication and restart recovery', async () => {
    const { source, workspace, service, reopen, failAfterPublish } = await setup();
    const original = '{"userData":"keep exactly"}';
    await writeFile(join(source, 'source-manifest.json'), original);
    const draft = await service.scan({ sourceRoot: source });
    const confirmation = { sourceSha256: draft.proposal.sourceSha256, name: '带同名清单的项目', status: 'active' as const };
    await expect(failAfterPublish().confirm(draft.run.id, confirmation)).rejects.toThrow('simulated post-publish interruption');

    const result = await reopen().confirm(draft.run.id, confirmation);
    const projectRoot = join(workspace.projectsPath, result.project.id);
    expect(result.run.state).toBe('confirmed');
    expect(await readFile(join(projectRoot, 'raw', 'source-manifest.json'), 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(join(projectRoot, 'source-manifest.json'), 'utf8'))).toMatchObject({ version: 2, sourceSha256: draft.proposal.sourceSha256 });
    expect(await readFile(join(source, 'source-manifest.json'), 'utf8')).toBe(original);
  });

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

  it('does not let a resumed confirmation change an already published config', async () => {
    const { source, workspace, service, reopen, failAfterPublish } = await setup();
    const draft = await service.scan({ sourceRoot: source });
    await expect(failAfterPublish().confirm(draft.run.id, {
      sourceSha256: draft.proposal.sourceSha256,
      name: '好味餐饮代运营',
      status: 'active'
    })).rejects.toThrow('simulated post-publish interruption');

    await expect(reopen().confirm(draft.run.id, {
      sourceSha256: draft.proposal.sourceSha256,
      name: '改名后的项目',
      status: 'active'
    })).rejects.toMatchObject({ code: 'COMPANY_PROJECT_ROOT_CONFLICT' });

    const resumed = await reopen().confirm(draft.run.id, {
      sourceSha256: draft.proposal.sourceSha256,
      name: '好味餐饮代运营',
      status: 'active'
    });
    expect(await readFile(join(workspace.projectsPath, resumed.project.id, '项目配置.yaml'), 'utf8')).toContain('name: 好味餐饮代运营');
  });
});
