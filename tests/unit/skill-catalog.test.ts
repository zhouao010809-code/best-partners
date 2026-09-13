import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PublicApiError } from '../../src/shared/api/errors.js';
import { createSkillCatalogService, skillId } from '../../src/server/services/skill-catalog.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xiaozhao-skill-catalog-'));
  roots.push(root);
  return root;
}

async function skill(root: string, name: string, body: string): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), body);
}

it('discovers only safe direct skills, keeps ids opaque, and returns bounded detail', async () => {
  const root = await fixture();
  await skill(root, 'writer', `---\nname: Writer\ndescription: Drafts clear copy\n---\n\n# Writer\n\nUse the method.\n`);
  await writeFile(join(root, 'writer', 'REFERENCE.md'), '# Reference\n');
  await writeFile(join(root, 'writer', 'notes.txt'), 'not exposed');
  await skill(root, 'fallback', '# No frontmatter\n\nFallback body\n');
  await mkdir(join(root, '.hidden'));
  await writeFile(join(root, '.env'), 'SECRET=do-not-read');
  await skill(root, 'scripts', '# Reserved directory');
  await skill(root, 'env', '# Reserved directory');
  const outside = await mkdtemp(join(tmpdir(), 'xiaozhao-skill-outside-'));
  roots.push(outside);
  await skill(outside, 'outside', '# outside');
  await symlink(join(outside, 'outside'), join(root, 'linked'));

  const service = createSkillCatalogService({ skillsRoot: root });
  const items = await service.list();
  expect(items).toHaveLength(2);
  expect(items.map((item) => item.name)).toEqual(['fallback', 'Writer']);
  expect(items.some((item) => ['scripts', 'env'].includes(item.name))).toBe(false);
  expect(items.every((item) => /^[a-f0-9]{64}$/u.test(item.id))).toBe(true);
  expect(items.every((item) => !item.id.includes('/'))).toBe(true);
  expect(items.find((item) => item.name === 'Writer')).toMatchObject({
    description: 'Drafts clear copy',
    revision: expect.stringMatching(/^[a-f0-9]{64}$/u)
  });
  const writer = items.find((item) => item.name === 'Writer')!;
  await expect(service.get(writer.id)).resolves.toMatchObject({
    ...writer,
    markdown: '\n# Writer\n\nUse the method.\n',
    references: ['REFERENCE.md']
  });
});

it('keeps canonically equivalent directory names on distinct opaque ids', async () => {
  const root = await fixture();
  const decomposed = 'e\u0301';
  const composed = 'é';
  await skill(root, decomposed, '# Decomposed');
  await skill(root, composed, '# Composed');

  const items = await createSkillCatalogService({ skillsRoot: root }).list();
  // APFS may normalize the two directory names to one entry. The ID
  // invariant is still asserted directly, and on a non-normalizing filesystem
  // the catalog must expose both entries without a collision.
  expect(skillId(decomposed)).not.toBe(skillId(composed));
  if (items.length === 2) expect(new Set(items.map((item) => item.id)).size).toBe(2);
});

it('rejects traversal, absolute, malformed, and unknown ids as public errors', async () => {
  const root = await fixture();
  await skill(root, 'writer', '# Writer');
  const service = createSkillCatalogService({ skillsRoot: root });
  for (const id of ['../writer', '/tmp/writer', 'not-an-id']) {
    await expect(service.get(id)).rejects.toMatchObject({ code: 'SKILL_ID_INVALID', statusCode: 400 });
  }
  await expect(service.get('a'.repeat(64))).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND', statusCode: 404 });
});

it('reports an unavailable catalog when the fixed root is absent or unsafe', async () => {
  const root = await fixture();
  const service = createSkillCatalogService({ skillsRoot: join(root, 'missing') });
  await expect(service.list()).rejects.toMatchObject({ code: 'SKILL_CATALOG_UNAVAILABLE', statusCode: 503 });

  const outside = await fixture();
  const link = join(root, 'skills-link');
  await symlink(outside, link);
  await expect(createSkillCatalogService({ skillsRoot: link }).list())
    .rejects.toMatchObject({ code: 'SKILL_CATALOG_UNAVAILABLE', statusCode: 503 });
});

it('rejects a parent symlink that would move the catalog outside the configured vault', async () => {
  const vault = await fixture();
  const outside = await fixture();
  await skill(join(outside, 'skills'), 'outside', '# Outside');
  await symlink(outside, join(vault, '.claude'));

  const service = createSkillCatalogService({ skillsRoot: join(vault, '.claude', 'skills') });
  await expect(service.list()).rejects.toMatchObject({
    code: 'SKILL_CATALOG_UNAVAILABLE',
    statusCode: 503
  });
});

it('rejects a symlink at the catalog root itself', async () => {
  const vault = await fixture();
  const outside = await fixture();
  await skill(outside, 'outside', '# Outside');
  await mkdir(join(vault, '.claude'));
  await symlink(outside, join(vault, '.claude', 'skills'));

  const service = createSkillCatalogService({ skillsRoot: join(vault, '.claude', 'skills') });
  await expect(service.list()).rejects.toMatchObject({
    code: 'SKILL_CATALOG_UNAVAILABLE',
    statusCode: 503
  });
});

it('omits symlinked, oversized, and non-regular skill files', async () => {
  const root = await fixture();
  const valid = join(root, 'valid');
  await mkdir(valid);
  await writeFile(join(valid, 'SKILL.md'), '# Valid');
  const oversized = join(root, 'oversized');
  await mkdir(oversized);
  await writeFile(join(oversized, 'SKILL.md'), Buffer.alloc(256 * 1024 + 1, 97));
  const outside = await fixture();
  await writeFile(join(outside, 'SKILL.md'), '# Outside');
  await symlink(join(outside, 'SKILL.md'), join(root, 'valid', 'LINK.md'));
  await expect(createSkillCatalogService({ skillsRoot: root }).list()).resolves.toHaveLength(1);
});

it('keeps service errors typed rather than leaking filesystem paths', async () => {
  const root = await fixture();
  const service = createSkillCatalogService({ skillsRoot: root });
  try {
    await service.get('../secret');
  } catch (error) {
    expect(error).toBeInstanceOf(PublicApiError);
    expect(String(error)).not.toContain(root);
  }
});
