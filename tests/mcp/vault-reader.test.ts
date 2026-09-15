import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVaultReader } from '../../mcp-server/vault-reader.js';
import {
  createBrainFixture,
  KNOWLEDGE_PATH,
  SOURCE_PATH
} from './fixtures.js';

const fixtures: Array<Awaited<ReturnType<typeof createBrainFixture>>> = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe('VaultReader safety and bounded reads', () => {
  it('rejects a root that is missing a required brain section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaozhao-brain-mcp-incomplete-'));
    try {
      await mkdir(join(root, '01图书馆'));
      await expect(createVaultReader(root)).rejects.toMatchObject({ code: 'INVALID_ROOT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a required section symlink that points outside the vault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaozhao-brain-mcp-section-'));
    const outside = await mkdtemp(join(tmpdir(), 'xiaozhao-brain-mcp-outside-'));
    try {
      await Promise.all(['00大脑规则', '02知识库', '03大讲堂'].map((name) => mkdir(join(root, name))));
      await symlink(outside, join(root, '01图书馆'));
      await expect(createVaultReader(root)).rejects.toMatchObject({ code: 'INVALID_ROOT' });
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true })
      ]);
    }
  });

  it('reads a knowledge note and preserves hash, body, and line metadata', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const reader = await createVaultReader(fixture.root);
    const result = await reader.readKnowledge(KNOWLEDGE_PATH);
    expect(result.path).toBe(KNOWLEDGE_PATH);
    expect(result.record.title).toBe('证据方法');
    expect(result.body).toContain('正文也提到证据链');
    expect(result.rawSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.lineCount).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it.each([
    '/etc/passwd',
    '02知识库/../01图书馆/个人/原始证据.md',
    '02知识库\\决策\\证据方法.md',
    '02知识库/决策/\0.md',
    '02知识库/.隐藏.md',
    '02知识库/决策/证据方法.txt',
    '03大讲堂/任意.md'
  ])('rejects unsafe path %s without echoing it', async (path) => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const reader = await createVaultReader(fixture.root);
    await expect(reader.readMarkdown(path)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(reader.readMarkdown(path)).rejects.not.toThrow(path);
  });

  it('distinguishes a missing file from a read failure', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const reader = await createVaultReader(fixture.root);
    await expect(reader.readMarkdown('01图书馆/个人/不存在.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a symlink that resolves outside the vault', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    if (!fixture.outsideSymlinkPath) return;
    const reader = await createVaultReader(fixture.root);
    await expect(reader.readMarkdown(fixture.outsideSymlinkPath)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
  });

  it('does not recurse forever through an in-vault directory symlink cycle', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    try {
      await symlink(join(fixture.root, '02知识库/决策'), join(fixture.root, '02知识库/决策/循环'), 'dir');
    } catch {
      return;
    }
    const reader = await createVaultReader(fixture.root);
    const paths = await reader.listKnowledgeFiles();
    expect(paths).toContain(KNOWLEDGE_PATH);
    expect(paths.filter((path) => path === KNOWLEDGE_PATH)).toHaveLength(1);
  });

  it('marks bounded reads as truncated without changing the source file', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const before = await readFile(`${fixture.root}/${SOURCE_PATH}`);
    const reader = await createVaultReader(fixture.root);
    const result = await reader.readSource(SOURCE_PATH, 32);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(32);
    expect(await readFile(`${fixture.root}/${SOURCE_PATH}`)).toEqual(before);
  });

  it('rejects a physically huge file before reading or parsing it', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const hugePath = '01图书馆/个人/过大.md';
    await writeFile(`${fixture.root}/${hugePath}`, '');
    await truncate(`${fixture.root}/${hugePath}`, 16 * 1024 * 1024 + 1);
    const reader = await createVaultReader(fixture.root);
    await expect(reader.readMarkdown(hugePath)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('finds source evidence with one-based original line numbers', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const reader = await createVaultReader(fixture.root);
    const result = await reader.findEvidence(SOURCE_PATH, '逐字核验', 8);
    expect(result.passages).toHaveLength(1);
    expect(result.passages[0]).toMatchObject({ startLine: 17, endLine: 17 });
    expect(result.passages[0]?.excerpt).toContain('逐字核验');
  });

  it('returns no fabricated evidence and keeps evidence scoped to sources', async () => {
    const fixture = await createBrainFixture(); fixtures.push(fixture);
    const reader = await createVaultReader(fixture.root);
    await expect(reader.findEvidence(SOURCE_PATH, '不存在的证据')).resolves.toMatchObject({ passages: [] });
    await expect(reader.findEvidence(KNOWLEDGE_PATH, '证据')).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
  });
});
