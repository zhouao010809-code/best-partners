import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanProjectFolder, stageProjectSource } from '../../src/server/company/project-ingestion.js';

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'company-ingestion-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('company project ingestion', () => {
  it('returns a stable sorted manifest and source hash', async () => {
    const base = await fixture();
    const source = join(base, '客户A教育项目');
    await mkdir(join(source, '课程资料'), { recursive: true });
    await mkdir(join(source, '品牌素材'), { recursive: true });
    await mkdir(join(source, '.git'), { recursive: true });
    await writeFile(join(source, '机构介绍.md'), '# 机构\n客户：明德培训\n服务开始：2026-01-01\n');
    await writeFile(join(source, '课程资料', '课程表.pdf'), 'pdf-bytes');
    await writeFile(join(source, '课程资料', '试听课说明.md'), '试听');
    await writeFile(join(source, '品牌素材', 'logo.png'), Buffer.from([1, 2, 3]));
    await writeFile(join(source, '.DS_Store'), 'ignore');
    await writeFile(join(source, '.git', 'config'), 'ignore');

    const first = await scanProjectFolder(source);
    const second = await scanProjectFolder(source);
    expect(first.sourceRoot).toBe(await realpath(source));
    expect(first.suggestedName).toBe('客户A教育项目');
    expect(first.suggestedClientName).toBe('明德培训');
    expect(first.suggestedStatus).toBe('draft');
    expect(first.selectedSkillIds).toEqual([]);
    expect(first.sourceSha256).toBe(second.sourceSha256);
    expect(first.entries.map(entry => entry.relativePath)).toEqual([
      '品牌素材',
      '品牌素材/logo.png',
      '机构介绍.md',
      '课程资料',
      '课程资料/试听课说明.md',
      '课程资料/课程表.pdf'
    ]);
    expect(first.entries.some(entry => entry.relativePath.includes('.DS_Store'))).toBe(false);
    expect(first.entries.some(entry => entry.relativePath.startsWith('.git/'))).toBe(false);
    expect(first.fields.clientName).toMatchObject({ confidence: 'inferred', value: '明德培训' });
    expect(first.fields.serviceStart).toMatchObject({ confidence: 'inferred', value: '2026-01-01' });
    expect(first.fields.serviceEnd).toMatchObject({ confidence: 'unknown' });
  });

  it('fails closed for symlinks and oversized files', async () => {
    const base = await fixture();
    const source = join(base, 'source');
    const outside = join(base, 'outside.txt');
    await mkdir(source, { recursive: true });
    await writeFile(outside, 'outside');
    await symlink(outside, join(source, 'escape.txt'));
    await expect(scanProjectFolder(source)).rejects.toThrow(/symlink/i);

    await rm(join(source, 'escape.txt'));
    await writeFile(join(source, 'large.bin'), '0123456789');
    await expect(scanProjectFolder(source, { maxFileBytes: 4 })).rejects.toThrow(/size|oversize/i);
  });

  it('extracts only explicit fields from a small YAML metadata file', async () => {
    const base = await fixture();
    const source = join(base, '餐饮项目');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'project.yaml'), 'clientName: "食研所"\nserviceStart: 2026/02/03\nserviceEnd: 2026-03-04\nnotes: "不应被当作事实"\n');

    const first = await scanProjectFolder(source);
    await utimes(join(source, 'project.yaml'), new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
    const second = await scanProjectFolder(source);
    expect(first.fields.clientName).toMatchObject({ confidence: 'inferred', value: '食研所' });
    expect(first.fields.serviceStart).toMatchObject({ confidence: 'inferred', value: '2026-02-03' });
    expect(first.fields.serviceEnd).toMatchObject({ confidence: 'inferred', value: '2026-03-04' });
    expect(first.sourceSha256).toBe(second.sourceSha256);
    expect(first.fields.notes).toBeUndefined();
  });

  it('stages bytes and manifest atomically without changing the source', async () => {
    const base = await fixture();
    const source = join(base, 'source');
    const incoming = join(base, 'incoming');
    await mkdir(source, { recursive: true });
    await mkdir(incoming, { recursive: true });
    await writeFile(join(source, '说明.md'), '原始内容');
    const before = await readFile(join(source, '说明.md'));

    const staged = await stageProjectSource({ sourceRoot: source, incomingRoot: incoming, runId: 'run-1' });
    expect(await readFile(join(staged.stagingRoot, '说明.md'), 'utf8')).toBe('原始内容');
    expect(await readFile(join(source, '说明.md'))).toEqual(before);
    expect(JSON.parse(await readFile(staged.manifestPath, 'utf8'))).toMatchObject({
      sourceRoot: await realpath(source),
      sourceSha256: staged.proposal.sourceSha256
    });
    expect(await readdir(incoming)).toEqual(['run-1']);
  });

  it('cleans only the run staging directory when a copy fails', async () => {
    const base = await fixture();
    const source = join(base, 'source');
    const incoming = join(base, 'incoming');
    await mkdir(source, { recursive: true });
    await mkdir(incoming, { recursive: true });
    await writeFile(join(source, 'a.txt'), 'a');
    await writeFile(join(source, 'b.txt'), 'b');

    await expect(stageProjectSource({
      sourceRoot: source,
      incomingRoot: incoming,
      runId: 'run-fail',
      copyFile: async () => { throw new Error('injected copy failure'); }
    })).rejects.toThrow('injected copy failure');
    expect(await readdir(incoming)).toEqual([]);
    expect(await readFile(join(source, 'a.txt'), 'utf8')).toBe('a');
  });

  it('does not replace a concurrently published run with the same id', async () => {
    const base = await fixture();
    const source = join(base, 'source');
    const incoming = join(base, 'incoming');
    await mkdir(source, { recursive: true });
    await mkdir(incoming, { recursive: true });
    await writeFile(join(source, 'a.txt'), 'a');

    const results = await Promise.allSettled([
      stageProjectSource({ sourceRoot: source, incomingRoot: incoming, runId: 'same-run' }),
      stageProjectSource({ sourceRoot: source, incomingRoot: incoming, runId: 'same-run' })
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await readdir(incoming)).toEqual(['same-run']);
    expect(await readFile(join(incoming, 'same-run', 'source-manifest.json'), 'utf8')).toContain('"version": 1');
  });
});
