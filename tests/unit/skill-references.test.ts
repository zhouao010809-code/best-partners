import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PublicApiError } from '../../src/shared/api/errors.js';
import { createSkillCatalogService, skillId } from '../../src/server/services/skill-catalog.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), 'xiaozhao-skill-references-'));
  roots.push(vault);
  const root = join(vault, '.claude', 'skills');
  const directory = join(root, 'jingwei');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), '# Jingwei\nRead references/workflow.md.');
  const catalog = createSkillCatalogService({ skillsRoot: root });
  const skill = await catalog.get(skillId('jingwei'));
  const write = async (path: string, body: string | Buffer = '# Reference') => {
    const absolute = join(directory, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, body);
  };
  return { vault, root, directory, catalog, skill, write };
}

it('retains direct Markdown and enumerates nested references while skipping unrelated, hidden and unsafe entries', async () => {
  const f = await fixture();
  for (const path of ['REFERENCE.md', 'references/workflow.md', 'references/templates/video.md', 'assets/ignored.md', 'references/.private.md', 'references/.hidden/secret.md', 'references/scripts/run.md', 'references/env/secret.md', 'references/notes.txt']) await f.write(path);
  await symlink(join(f.directory, 'REFERENCE.md'), join(f.directory, 'references', 'linked.md'));
  await symlink(join(f.directory, 'references', 'templates'), join(f.directory, 'references', 'linked-directory'));
  const detail = await f.catalog.get(f.skill.id);
  expect(detail.references).toEqual(['REFERENCE.md', 'references/templates/video.md', 'references/workflow.md'].sort((a, b) => a.localeCompare(b)));
});

it('reads only the selected skill reference and reports a digest of the raw UTF-8 bytes', async () => {
  const f = await fixture();
  const bytes = Buffer.from('\uFEFF# 工作流\r\n先确定目标客户。\r\n');
  await f.write('references/workflow.md', bytes);
  await expect(f.catalog.readReference!(f.skill.id, 'references/workflow.md', f.skill.revision)).resolves.toEqual({
    path: 'references/workflow.md', revision: createHash('sha256').update(bytes).digest('hex'), markdown: '# 工作流\r\n先确定目标客户。\r\n'
  });
  await f.write('REFERENCE.md', '# Direct');
  await expect(f.catalog.readReference!(f.skill.id, 'REFERENCE.md', f.skill.revision)).resolves.toMatchObject({ markdown: '# Direct' });
});

it('rejects paths outside the enumerable reference whitelist without exposing filesystem paths', async () => {
  const f = await fixture();
  for (const path of ['assets/other.md', '.hidden.md', 'references/scripts/run.md', 'references/env/config.md']) await f.write(path);
  for (const path of ['/tmp/private.md', '../other.md', 'references/../SKILL.md', 'references\\private.md', 'references//private.md', 'references/./private.md', 'SKILL.md', 'assets/other.md', '.hidden.md', 'references/scripts/run.md', 'references/env/config.md', 'references/' + 'a'.repeat(250) + '.md']) {
    const error = await f.catalog.readReference!(f.skill.id, path, f.skill.revision).catch(value => value);
    expect(error).toBeInstanceOf(PublicApiError);
    expect(error).toMatchObject({ code: 'SKILL_REFERENCE_PATH_INVALID', statusCode: 400 });
    expect(String(error)).not.toContain(f.vault);
  }
});

it('rejects changed skill revisions and missing references with retryable public messages', async () => {
  const f = await fixture();
  await f.write('references/workflow.md');
  await expect(f.catalog.readReference!(f.skill.id, 'references/missing.md', f.skill.revision)).rejects.toMatchObject({ code: 'SKILL_REFERENCE_NOT_FOUND', statusCode: 404, message: expect.stringContaining('重新') });
  await f.write('SKILL.md', '# Changed');
  await expect(f.catalog.readReference!(f.skill.id, 'references/workflow.md', f.skill.revision)).rejects.toMatchObject({ code: 'SKILL_REFERENCE_STALE', statusCode: 409, message: expect.stringContaining('重新') });
});

it('rejects oversized and invalid UTF-8 reference bodies while allowing the exact byte limit', async () => {
  const f = await fixture();
  await f.write('references/large.md', Buffer.alloc(256 * 1024 + 1, 97));
  await f.write('references/invalid.md', Buffer.from([0xc3, 0x28]));
  await f.write('references/bounded.md', Buffer.alloc(256 * 1024, 97));
  for (const path of ['references/large.md', 'references/invalid.md']) {
    await expect(f.catalog.readReference!(f.skill.id, path, f.skill.revision)).rejects.toMatchObject({ code: 'SKILL_REFERENCE_UNREADABLE', statusCode: 422 });
  }
  const result = await f.catalog.readReference!(f.skill.id, 'references/bounded.md', f.skill.revision);
  expect(result.markdown).toHaveLength(256 * 1024);
});

it('rejects symlinked reference files and parent directories even when replaced after discovery', async () => {
  const f = await fixture();
  await f.write('references/workflow.md', '# Visible');
  await f.catalog.get(f.skill.id);
  const outside = join(f.vault, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'workflow.md'), 'SECRET');
  await rm(join(f.directory, 'references', 'workflow.md'));
  await symlink(join(outside, 'workflow.md'), join(f.directory, 'references', 'workflow.md'));
  await expect(f.catalog.readReference!(f.skill.id, 'references/workflow.md', f.skill.revision)).rejects.toMatchObject({ code: 'SKILL_REFERENCE_NOT_FOUND' });
  await rm(join(f.directory, 'references'), { recursive: true });
  await symlink(outside, join(f.directory, 'references'));
  await expect(f.catalog.readReference!(f.skill.id, 'references/workflow.md', f.skill.revision)).rejects.toMatchObject({ code: 'SKILL_REFERENCE_NOT_FOUND' });
  await rename(f.directory, join(f.root, 'saved'));
  await symlink(join(f.root, 'saved'), f.directory);
  await expect(f.catalog.readReference!(f.skill.id, 'references/workflow.md', f.skill.revision)).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
});

it('bounds reference counts, path bytes and directory depth', async () => {
  const f = await fixture();
  const paths = Array.from({ length: 1002 }, (_, index) => `references/${String(index).padStart(4, '0')}.md`);
  await Promise.all(paths.map(path => f.write(path)));
  const detail = await f.catalog.get(f.skill.id);
  expect(detail.references).toHaveLength(1000);
  expect(new Set(detail.references).size).toBe(1000);
  const excluded = paths.find(path => !detail.references.includes(path))!;
  await expect(f.catalog.readReference!(f.skill.id, excluded, f.skill.revision)).rejects.toMatchObject({ code: 'SKILL_REFERENCE_NOT_FOUND' });
  await rm(join(f.directory, 'references'), { recursive: true });
  await f.write('references/' + '目录/'.repeat(8) + 'too-deep.md');
  await f.write('references/' + '长'.repeat(81) + '.md');
  await f.write('references/' + 'nested/'.repeat(3) + 'valid.md');
  const bounded = await f.catalog.get(f.skill.id);
  expect(bounded.references).toEqual(['references/' + 'nested/'.repeat(3) + 'valid.md']);
});
