import { constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildVaultManifest,
  collectCursorPages,
  compareVaultManifests,
  createObservedFetch,
  formatSmokeOutcome,
  runRealVaultReadSmoke,
  toSafeSmokeOutcome,
  validateSmokeEnvironment
} from '../../scripts/real-vault-read-smoke.js';

const temporaryDirectories: string[] = [];

async function createVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'brain-smoke-test-'));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(join(root, '00大脑规则')),
    mkdir(join(root, '01图书馆')),
    mkdir(join(root, '02知识库'))
  ]);
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true
  })));
});

describe('real vault read smoke safety contracts', () => {
  it('blocks a non-literal false write gate and missing credentials', () => {
    expect(validateSmokeEnvironment({
      WRITE_ENABLED: '0',
      VAULT_REAL_ROOT: '/private/vault',
      OBSIDIAN_API_URL: 'https://127.0.0.1:27124',
      OBSIDIAN_API_KEY: 'secret'
    })).toEqual({ ok: false, code: 'WRITE_ENABLED_REQUIRED' });

    expect(validateSmokeEnvironment({
      WRITE_ENABLED: 'false',
      VAULT_REAL_ROOT: '/private/vault',
      OBSIDIAN_API_URL: 'https://127.0.0.1:27124'
    })).toEqual({ ok: false, code: 'CREDENTIALS_REQUIRED' });

    expect(validateSmokeEnvironment({
      WRITE_ENABLED: 'false',
      VAULT_REAL_ROOT: '/private/vault',
      OBSIDIAN_API_URL: 'http://127.0.0.1:27124',
      OBSIDIAN_API_KEY: 'secret'
    })).toEqual({ ok: false, code: 'HTTPS_REQUIRED' });
  });

  it('blocks before any vault walk or network when a credential is absent', async () => {
    const createManifest = vi.fn();
    const fetchImplementation = vi.fn();

    const result = await runRealVaultReadSmoke({
      env: {
        WRITE_ENABLED: 'false',
        VAULT_REAL_ROOT: '/must-not-be-read',
        OBSIDIAN_API_URL: 'https://127.0.0.1:27124'
      },
      createManifest,
      fetchImplementation
    });

    expect(result).toEqual({ status: 'blocked', code: 'CREDENTIALS_REQUIRED' });
    expect(createManifest).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('refuses an overlapping system temp base before creating app data', async () => {
    const prefix = 'xiaozhao-brain-read-smoke-';
    const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith(prefix)));
    const createManifest = vi.fn();
    const fetchImplementation = vi.fn();

    const result = await runRealVaultReadSmoke({
      env: {
        WRITE_ENABLED: 'false',
        VAULT_REAL_ROOT: tmpdir(),
        OBSIDIAN_API_URL: 'https://127.0.0.1:27124',
        OBSIDIAN_API_KEY: 'secret'
      },
      createManifest,
      fetchImplementation
    });
    const created = (await readdir(tmpdir()))
      .filter((name) => name.startsWith(prefix) && !before.has(name));
    temporaryDirectories.push(...created.map((name) => join(tmpdir(), name)));

    expect(result).toEqual({ status: 'failed', code: 'TEMP_OVERLAP' });
    expect(created).toEqual([]);
    expect(createManifest).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('refuses to recursively remove a replacement at the owned temp path', async () => {
    const root = await createVault();
    const prefix = 'xiaozhao-brain-read-smoke-';
    const existing = new Set((await readdir(tmpdir())).filter((name) => name.startsWith(prefix)));
    let replacementPath: string | undefined;
    let manifestCalls = 0;

    const result = await runRealVaultReadSmoke({
      env: {
        WRITE_ENABLED: 'false',
        VAULT_REAL_ROOT: root,
        OBSIDIAN_API_URL: 'https://127.0.0.1:27124',
        OBSIDIAN_API_KEY: 'secret'
      },
      createManifest: async (vaultRoot) => {
        manifestCalls += 1;
        if (manifestCalls === 1) {
          const created = (await readdir(tmpdir()))
            .filter((name) => name.startsWith(prefix) && !existing.has(name));
          if (created.length !== 1 || created[0] === undefined) {
            throw new Error('owned temp was not discoverable');
          }
          replacementPath = join(tmpdir(), created[0]);
          const retainedOriginalPath = `${replacementPath}-original`;
          temporaryDirectories.push(retainedOriginalPath, replacementPath);
          // Keep the original inode allocated so filesystems cannot reuse it for the replacement.
          await rename(replacementPath, retainedOriginalPath);
          await mkdir(replacementPath);
          await writeFile(join(replacementPath, 'replacement-marker'), 'keep');
        }
        return buildVaultManifest(vaultRoot);
      },
      fetchImplementation: vi.fn(async () => {
        throw new Error('stop before external network');
      }) as typeof fetch
    });

    if (replacementPath === undefined) throw new Error('replacement path missing');
    expect(result).toEqual({ status: 'failed', code: 'TEMP_CLEANUP_FAILED' });
    await expect(readFile(join(replacementPath, 'replacement-marker'), 'utf8'))
      .resolves.toBe('keep');
  });

  it('rejects a symlink anywhere inside the protected manifest roots', async () => {
    if (constants.O_NOFOLLOW === undefined) throw new Error('O_NOFOLLOW unavailable');
    const root = await createVault();
    await writeFile(join(root, 'outside.md'), 'outside');
    await symlink('../outside.md', join(root, '01图书馆', 'linked.md'));

    await expect(buildVaultManifest(root)).rejects.toMatchObject({
      code: 'MANIFEST_UNSAFE'
    });
  });

  it('detects content changes between before and after manifests', async () => {
    const root = await createVault();
    const note = join(root, '02知识库', 'note.md');
    await writeFile(note, 'before');
    const before = await buildVaultManifest(root);

    await writeFile(note, 'after!');
    const after = await buildVaultManifest(root);

    expect(compareVaultManifests(before, after)).toBe(1);
    expect(before.aggregateSha256).not.toBe(after.aggregateSha256);
  });

  it('treats a protected vault root identity replacement as a manifest change', async () => {
    const root = await createVault();
    await writeFile(join(root, '00大脑规则', 'rule.md'), 'same bytes');
    const manifest = await buildVaultManifest(root);

    expect(compareVaultManifests(manifest, {
      ...manifest,
      rootDev: `${manifest.rootDev}-replacement`
    })).toBe(1);
  });

  it('fails closed on repeated cursors and repeated paths', async () => {
    await expect(collectCursorPages(async (cursor) => cursor === undefined
      ? { items: [{ path: '01图书馆/a.md' }], nextCursor: 'same' }
      : { items: [{ path: '01图书馆/b.md' }], nextCursor: 'same' }
    )).rejects.toMatchObject({ code: 'API_CURSOR_REPEAT' });

    await expect(collectCursorPages(async (cursor) => cursor === undefined
      ? { items: [{ path: '02知识库/a.md' }], nextCursor: 'next' }
      : { items: [{ path: '02知识库/a.md' }] }
    )).rejects.toMatchObject({ code: 'API_PATH_REPEAT' });
  });

  it('records only fixed method/category counters and retains no URL, path, header, or key', async () => {
    const secret = 'top-secret-api-key';
    const privatePath = '02知识库/private-note.md';
    const delegated = vi.fn(async () => new Response('{}'));
    const observed = createObservedFetch(delegated as typeof fetch);

    await observed.fetch(
      `https://127.0.0.1:27124/vault/${encodeURIComponent(privatePath)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${secret}`, Accept: 'text/markdown' } }
    );
    await expect(observed.fetch('https://127.0.0.1:27124/vault/01%E5%9B%BE%E4%B9%A6%E9%A6%86/', {
      method: 'POST',
      body: privatePath
    })).rejects.toMatchObject({ code: 'VAULT_MUTATION_OBSERVED' });
    await expect(observed.fetch(
      'https://127.0.0.1:27124/open/02%E7%9F%A5%E8%AF%86%E5%BA%93/private-note.md',
      { method: 'GET' }
    )).rejects.toMatchObject({ code: 'VAULT_OPEN_OBSERVED' });

    const snapshot = observed.snapshot();
    expect(snapshot).toEqual({
      vaultGetCount: 1,
      vaultNonGetCount: 1,
      openCount: 1,
      categories: {
        root: 0,
        openapi: 0,
        vaultDirectory: 1,
        vaultRaw: 1,
        vaultDocumentMap: 0,
        open: 1,
        other: 0
      }
    });
    expect(delegated).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(JSON.stringify(snapshot)).not.toContain(privatePath);
  });

  it('formats unknown failures as one allowlisted JSON line without leaking details', () => {
    const secret = 'top-secret-api-key';
    const outcome = toSafeSmokeOutcome(
      new Error(`/Users/example/private-vault ${secret}`),
      'failed'
    );
    const output = formatSmokeOutcome(outcome);

    expect(outcome).toEqual({ status: 'failed', code: 'SMOKE_FAILED' });
    expect(output.endsWith('\n')).toBe(true);
    expect(output.trim().split('\n')).toHaveLength(1);
    expect(output).not.toContain(secret);
    expect(output).not.toContain('/Users/');
  });

  it('runs the real index and injected GET APIs against a temporary read-only vault', async () => {
    const root = await createVault();
    await Promise.all([
      writeFile(join(root, '01图书馆', '材料.md'), `---
类型: 原始资料
处理状态: 未归档
来源平台: B站
原始标题: 测试材料
作者:
原始链接:
采集日期: 2026-09-01
所属主题: [测试]
关键词: [只读]
知识入库状态: 未提炼
生成知识: []
备注:
---
材料正文
`),
      writeFile(join(root, '01图书馆', '坏格式.md'), '没有 frontmatter'),
      writeFile(join(root, '01图书馆', '错误类型.md'), `---
类型: 知识笔记
---
`),
      writeFile(join(root, '02知识库', '知识.md'), `---
类型: 知识笔记
来源类型: 人工输入
使用状态: AI总结
知识类型: 方法
所属主题: [测试]
关键词: [只读]
来源资料: []
适用场景: [验收]
核心结论: 只读链路可验证
关键要点: [不写正式大脑]
使用边界: 仅用于测试
创建日期: 2026-09-01
更新日期: 2026-09-01
备注:
---
# 知识正文
`),
      writeFile(join(root, '02知识库', '无效字段.md'), `---
类型: 知识笔记
来源类型: 不合法
---
`)
    ]);

    const methods: string[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      methods.push(request.method);
      if (request.method !== 'GET') throw new Error('unexpected mutation');
      if (request.headers.get('authorization') !== 'Bearer smoke-secret') {
        throw new Error('missing authorization');
      }
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/vault/')) return new Response(null, { status: 404 });
      const encoded = url.pathname.slice('/vault/'.length).replace(/\/$/u, '');
      const relativePath = encoded.split('/').map((part) => decodeURIComponent(part)).join('/');
      const localPath = join(root, ...relativePath.split('/'));
      if (url.pathname.endsWith('/')) {
        const files = (await readdir(localPath)).sort();
        return new Response(JSON.stringify({ files }), {
          headers: { 'content-type': 'application/json' }
        });
      }
      if (request.headers.get('accept') === 'application/vnd.olrapi.document-map+json') {
        return new Response(JSON.stringify({ version: 'temporary-v1' }), {
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(new Uint8Array(await readFile(localPath)), {
        headers: { 'content-type': 'text/markdown' }
      });
    });

    const outcome = await runRealVaultReadSmoke({
      env: {
        WRITE_ENABLED: 'false',
        VAULT_REAL_ROOT: root,
        APP_DATA_DIR: join(root, 'must-never-be-used'),
        OBSIDIAN_API_URL: 'https://127.0.0.1:27124',
        OBSIDIAN_API_KEY: 'smoke-secret'
      },
      fetchImplementation: fakeFetch as typeof fetch
    });

    expect(outcome).toMatchObject({
      status: 'passed',
      writeEnabled: false,
      manifest: { files: 5, changedFiles: 0 },
      index: {
        pendingMaterials: 1,
        activeKnowledge: 1,
        includeObsolete: 1,
        issueCount: 3
      },
      http: { vaultNonGetCount: 0 },
      detail: { rereadVerified: true }
    });
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(['GET']));
    const output = formatSmokeOutcome(outcome);
    expect(output).not.toContain(root);
    expect(output).not.toContain('smoke-secret');
  });
});
