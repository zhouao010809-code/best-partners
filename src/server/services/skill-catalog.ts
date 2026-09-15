import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { PublicApiError } from '../../shared/api/errors.js';
import type {
  SkillDetail,
  SkillFolder,
  SkillSummary,
  SkillsPage
} from '../../shared/api/skills.js';
import { parseFrontmatter } from '../rules/frontmatter.js';

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_REFERENCE_COUNT = 1_000;
const MAX_ENTRIES = 1_000;
const SKILL_FILE = 'SKILL.md';
const DEFAULT_DESCRIPTION = 'No description provided.';
const RESERVED_DIRECTORY_NAMES = new Set(['env', 'scripts']);

export interface SkillCatalogService {
  list(): Promise<SkillsPage>;
  get(id: string): Promise<SkillDetail>;
  createFolder(name: string): Promise<SkillFolder>;
  move(skillId: string, folderId: string | null): Promise<SkillSummary>;
  resolveSource(skillId: string): Promise<string>;
}

type DiscoveredSkill = {
  readonly directoryName: string;
  readonly directoryPath: string;
  readonly directoryRealPath: string;
  readonly bytes: Buffer;
  readonly folder: SkillFolder | null;
};

type CatalogLayout = {
  readonly folders: SkillFolder[];
  readonly skills: DiscoveredSkill[];
};

function unavailable(): PublicApiError {
  return new PublicApiError(
    'SKILL_CATALOG_UNAVAILABLE',
    'Skill catalog is unavailable.',
    503
  );
}

function failure(code: string, message: string, status = 400): PublicApiError {
  return new PublicApiError(code, message, status);
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function skillId(directoryName: string): string {
  return digest(Buffer.from(directoryName, 'utf8'));
}

export function skillFolderId(folderName: string): string {
  return digest(Buffer.from(folderName, 'utf8'));
}

function isSafeName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0
    && !name.startsWith('.')
    && name !== '.'
    && name !== '..'
    && !RESERVED_DIRECTORY_NAMES.has(name.toLowerCase())
    && !/[\\/\0\u0000-\u001f\u007f]/u.test(name)
    && Buffer.byteLength(name, 'utf8') <= 255;
}

function normalizeField(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (
    normalized.length === 0
    || normalized.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return fallback;
  }
  return normalized;
}

async function readBoundedFile(path: string): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return undefined;

    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset
      );
      if (result.bytesRead === 0) return undefined;
      offset += result.bytesRead;
    }
    return bytes;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function createSkillCatalogService(input: {
  skillsRoot: string;
}): SkillCatalogService {
  const configuredRoot = resolve(input.skillsRoot);
  const configuredParent = dirname(configuredRoot);
  const configuredVault = dirname(configuredParent);

  async function fixedRoot(): Promise<string> {
    try {
      const [vaultStat, parentStat, rootStat] = await Promise.all([
        lstat(configuredVault),
        lstat(configuredParent),
        lstat(configuredRoot)
      ]);
      if (
        !vaultStat.isDirectory()
        || vaultStat.isSymbolicLink()
        || !parentStat.isDirectory()
        || parentStat.isSymbolicLink()
        || !rootStat.isDirectory()
        || rootStat.isSymbolicLink()
      ) {
        throw unavailable();
      }

      const canonicalVault = await realpath(configuredVault);
      const canonicalParent = await realpath(configuredParent);
      const canonicalRoot = await realpath(configuredRoot);
      const expectedParent = join(canonicalVault, basename(configuredParent));
      const expectedRoot = join(expectedParent, basename(configuredRoot));
      if (canonicalParent !== expectedParent || canonicalRoot !== expectedRoot) {
        throw unavailable();
      }
      return canonicalRoot;
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      throw unavailable();
    }
  }

  async function ensureDirectory(path: string): Promise<void> {
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      try {
        await mkdir(path);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw mkdirError;
        }
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
      }
    }
  }

  async function ensureRoot(): Promise<string> {
    try {
      const vaultStat = await lstat(configuredVault);
      if (!vaultStat.isDirectory() || vaultStat.isSymbolicLink()) {
        throw unavailable();
      }
      await ensureDirectory(configuredParent);
      await ensureDirectory(configuredRoot);
      return await fixedRoot();
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      throw unavailable();
    }
  }

  async function verifyChildDirectory(
    parent: string,
    name: string
  ): Promise<{ path: string; realPath: string } | undefined> {
    if (!isSafeName(name)) return undefined;
    const path = join(parent, name);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
      const realPath = await realpath(path);
      if (dirname(realPath) !== parent || basename(realPath) !== name) {
        return undefined;
      }
      return { path, realPath };
    } catch {
      return undefined;
    }
  }

  async function discoverSkill(
    parent: string,
    directoryName: string,
    folder: SkillFolder | null
  ): Promise<DiscoveredSkill | undefined> {
    const directory = await verifyChildDirectory(parent, directoryName);
    if (!directory) return undefined;

    const skillPath = join(directory.path, SKILL_FILE);
    try {
      const stat = await lstat(skillPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES) {
        return undefined;
      }
      const realSkillPath = await realpath(skillPath);
      if (
        dirname(realSkillPath) !== directory.realPath
        || basename(realSkillPath) !== SKILL_FILE
      ) {
        return undefined;
      }
      const bytes = await readBoundedFile(skillPath);
      if (!bytes) return undefined;
      return {
        directoryName,
        directoryPath: directory.path,
        directoryRealPath: directory.realPath,
        bytes,
        folder
      };
    } catch {
      return undefined;
    }
  }

  async function hasDirectSkillMarker(path: string): Promise<boolean> {
    try {
      await lstat(join(path, SKILL_FILE));
      return true;
    } catch {
      return false;
    }
  }

  async function layout(root: string): Promise<CatalogLayout> {
    let names: string[];
    try {
      names = (await readdir(root)).sort((a, b) => a.localeCompare(b));
    } catch {
      throw unavailable();
    }

    const folders: SkillFolder[] = [];
    const skills: DiscoveredSkill[] = [];
    for (const name of names) {
      const directory = await verifyChildDirectory(root, name);
      if (!directory) continue;

      if (await hasDirectSkillMarker(directory.path)) {
        const discovered = await discoverSkill(root, name, null);
        if (discovered) skills.push(discovered);
        continue;
      }

      const folder: SkillFolder = {
        id: skillFolderId(name),
        name,
        skillCount: 0
      };
      let children: string[];
      try {
        children = (await readdir(directory.path)).sort((a, b) => a.localeCompare(b));
      } catch {
        folders.push(folder);
        continue;
      }
      for (const child of children) {
        const discovered = await discoverSkill(directory.path, child, folder);
        if (discovered) skills.push(discovered);
      }
      folder.skillCount = skills.filter((skill) => skill.folder?.id === folder.id).length;
      folders.push(folder);
    }

    const duplicateNames = new Set<string>();
    const seenNames = new Set<string>();
    for (const skill of skills) {
      if (seenNames.has(skill.directoryName)) duplicateNames.add(skill.directoryName);
      seenNames.add(skill.directoryName);
    }
    if (duplicateNames.size > 0) {
      throw failure('SKILL_LAYOUT_CONFLICT', 'Skill layout contains duplicate names.', 409);
    }
    const uniqueSkills = skills;
    uniqueSkills.sort((a, b) => {
      const aUnclassified = a.folder === null ? 0 : 1;
      const bUnclassified = b.folder === null ? 0 : 1;
      return aUnclassified - bUnclassified
        || a.directoryName.localeCompare(b.directoryName)
        || skillId(a.directoryName).localeCompare(skillId(b.directoryName));
    });
    folders.sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of folders) {
      folder.skillCount = uniqueSkills.filter((skill) => skill.folder?.id === folder.id).length;
    }
    return { folders, skills: uniqueSkills.slice(0, MAX_ENTRIES) };
  }

  function parseMetadata(
    skill: DiscoveredSkill
  ): { summary: SkillSummary; markdown: string } | undefined {
    let data: Record<string, unknown> = {};
    let bodyBytes: Uint8Array = skill.bytes;
    try {
      const parsed = parseFrontmatter(skill.bytes);
      data = parsed.data;
      bodyBytes = parsed.bodyBytes;
    } catch {
      // Invalid frontmatter falls back to the directory name and full body.
    }

    let markdown: string;
    try {
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
    } catch {
      return undefined;
    }
    return {
      summary: {
        id: skillId(skill.directoryName),
        name: normalizeField(data.name, skill.directoryName, 256),
        description: normalizeField(data.description, DEFAULT_DESCRIPTION, 10_000),
        revision: digest(skill.bytes),
        folderId: skill.folder?.id ?? null,
        folderName: skill.folder?.name ?? null
      },
      markdown
    };
  }

  async function references(skill: DiscoveredSkill): Promise<string[]> {
    try {
      const names = (await readdir(skill.directoryPath))
        .sort((a, b) => a.localeCompare(b));
      const result: string[] = [];
      for (const name of names) {
        if (!isSafeName(name) || name === SKILL_FILE || !name.endsWith('.md')) {
          continue;
        }
        const path = join(skill.directoryPath, name);
        try {
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const realPath = await realpath(path);
          if (dirname(realPath) !== skill.directoryRealPath || basename(realPath) !== name) {
            continue;
          }
          result.push(name);
        } catch {
          // References are optional and never make the skill unavailable.
        }
      }
      return result.slice(0, MAX_REFERENCE_COUNT);
    } catch {
      return [];
    }
  }

  async function locate(
    id: string
  ): Promise<{ root: string; catalog: CatalogLayout; skill: DiscoveredSkill }> {
    if (!/^[a-f0-9]{64}$/u.test(id)) {
      throw failure('SKILL_ID_INVALID', 'Skill id is invalid.');
    }
    const root = await fixedRoot();
    const catalog = await layout(root);
    const skill = catalog.skills.find((candidate) => skillId(candidate.directoryName) === id);
    if (!skill) throw failure('SKILL_NOT_FOUND', 'Skill was not found.', 404);
    return { root, catalog, skill };
  }

  async function get(id: string): Promise<SkillDetail> {
    const { skill } = await locate(id);
    const parsed = parseMetadata(skill);
    if (!parsed) throw failure('SKILL_NOT_FOUND', 'Skill was not found.', 404);
    return {
      ...parsed.summary,
      markdown: parsed.markdown,
      references: await references(skill)
    };
  }

  async function list(): Promise<SkillsPage> {
    const root = await fixedRoot();
    const catalog = await layout(root);
    const items = catalog.skills
      .map(parseMetadata)
      .filter((entry): entry is { summary: SkillSummary; markdown: string } => !!entry)
      .map((entry) => entry.summary);
    return {
      folders: catalog.folders,
      items: items.slice(0, MAX_ENTRIES)
    };
  }

  async function createFolder(name: string): Promise<SkillFolder> {
    if (!isSafeName(name)) {
      throw failure('SKILL_FOLDER_INVALID', 'Skill folder is invalid.');
    }
    const root = await ensureRoot();
    const path = join(root, name);
    try {
      await lstat(path);
      throw failure(
        'SKILL_FOLDER_CONFLICT',
        'Skill folder conflicts with an existing entry.',
        409
      );
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw failure(
          'SKILL_FOLDER_CONFLICT',
          'Skill folder conflicts with an existing entry.',
          409
        );
      }
    }
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw failure(
          'SKILL_FOLDER_CONFLICT',
          'Skill folder conflicts with an existing entry.',
          409
        );
      }
      throw unavailable();
    }
    if (!await verifyChildDirectory(root, name)) throw unavailable();
    return {
      id: skillFolderId(name),
      name,
      skillCount: 0
    };
  }

  async function move(
    id: string,
    targetFolderId: string | null
  ): Promise<SkillSummary> {
    if (
      targetFolderId !== null
      && !/^[a-f0-9]{64}$/u.test(targetFolderId)
    ) {
      throw failure('SKILL_FOLDER_INVALID', 'Skill folder is invalid.');
    }
    const { root, catalog, skill } = await locate(id);
    const target = targetFolderId === null
      ? null
      : catalog.folders.find((folder) => folder.id === targetFolderId);
    if (targetFolderId !== null && !target) {
      throw failure('SKILL_FOLDER_NOT_FOUND', 'Skill folder was not found.', 404);
    }

    const destination = target
      ? join(root, target.name, skill.directoryName)
      : join(root, skill.directoryName);
    const destinationRelative = relative(root, destination);
    if (
      destinationRelative.startsWith('..')
      || resolve(root, destinationRelative) !== destination
    ) {
      throw failure('SKILL_FOLDER_INVALID', 'Skill folder is invalid.');
    }
    if (destination === skill.directoryPath) {
      const parsed = parseMetadata(skill);
      if (!parsed) throw failure('SKILL_NOT_FOUND', 'Skill was not found.', 404);
      return parsed.summary;
    }

    try {
      await lstat(destination);
      throw failure(
        'SKILL_FOLDER_CONFLICT',
        'Skill folder conflicts with an existing entry.',
        409
      );
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable();
    }
    try {
      await rename(skill.directoryPath, destination);
    } catch {
      throw unavailable();
    }
    const moved = await locate(id);
    const parsed = parseMetadata(moved.skill);
    if (!parsed) throw failure('SKILL_NOT_FOUND', 'Skill was not found.', 404);
    return parsed.summary;
  }

  async function resolveSource(id: string): Promise<string> {
    const { skill } = await locate(id);
    const path = join(skill.directoryPath, SKILL_FILE);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES) {
        throw failure('SKILL_NOT_FOUND', 'Skill was not found.', 404);
      }
      const realPath = await realpath(path);
      if (
        dirname(realPath) !== skill.directoryRealPath
        || basename(realPath) !== SKILL_FILE
      ) {
        throw failure('SKILL_NOT_FOUND', 'Skill was not found.', 404);
      }
      if (!await readBoundedFile(path)) {
        throw failure('SKILL_NOT_FOUND', 'Skill was not found.', 404);
      }
      return path;
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      throw failure('SKILL_NOT_FOUND', 'Skill was not found.', 404);
    }
  }

  return {
    list,
    get,
    createFolder,
    move,
    resolveSource
  };
}
