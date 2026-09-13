import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PublicApiError } from '../../shared/api/errors.js';
import type { SkillDetail, SkillSummary } from '../../shared/api/skills.js';
import { parseFrontmatter } from '../rules/frontmatter.js';

const MAX_SKILL_BYTES = 256 * 1024;
const SKILL_FILE = 'SKILL.md';
const DEFAULT_DESCRIPTION = 'No description provided.';
const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 10_000;
const MAX_REFERENCE_COUNT = 1_000;
const RESERVED_DIRECTORY_NAMES = new Set(['env', 'scripts']);

export interface SkillCatalogService {
  list(): Promise<SkillSummary[]>;
  get(id: string): Promise<SkillDetail>;
}

function unavailable(): PublicApiError {
  return new PublicApiError('SKILL_CATALOG_UNAVAILABLE', 'Skill catalog is unavailable.', 503);
}

function invalidId(): PublicApiError {
  return new PublicApiError('SKILL_ID_INVALID', 'Skill id is invalid.', 400);
}

function notFound(): PublicApiError {
  return new PublicApiError('SKILL_NOT_FOUND', 'Skill was not found.', 404);
}

function safeDirectoryName(name: string): boolean {
  return name.length > 0
    && !name.startsWith('.')
    && name !== '.'
    && name !== '..'
    && !RESERVED_DIRECTORY_NAMES.has(name.toLowerCase())
    && !/[\\/\0\u0000-\u001f\u007f]/u.test(name)
    && Buffer.byteLength(name, 'utf8') <= 255;
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function skillId(name: string): string {
  // Keep the raw directory bytes. Unicode-equivalent names can coexist on
  // filesystems that do not normalize filenames, and must therefore retain
  // distinct opaque IDs.
  return digest(Buffer.from(name, 'utf8'));
}

function field(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > 0
    && normalized.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : fallback;
}

async function readBoundedRegularFile(path: string): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NOFOLLOW prevents a final-path symlink from being opened if the tree
    // changes between lstat and open.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return undefined;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
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

type DiscoveredSkill = {
  readonly directoryName: string;
  readonly directoryPath: string;
  readonly directoryRealPath: string;
  readonly bytes: Buffer;
};

export function createSkillCatalogService(input: { skillsRoot: string }): SkillCatalogService {
  const configuredRoot = resolve(input.skillsRoot);
  // The production path is `<vault>/.claude/skills`. Treat the vault and the
  // two catalog components as the trust boundary. Ancestors above the vault
  // may contain harmless OS aliases (for example `/var` -> `/private/var`),
  // so compare against a canonicalized boundary rather than the raw absolute
  // string.
  const configuredCatalogParent = dirname(configuredRoot);
  const configuredVaultRoot = dirname(configuredCatalogParent);

  async function fixedRoot(): Promise<string> {
    try {
      const vaultStat = await lstat(configuredVaultRoot);
      const parentStat = await lstat(configuredCatalogParent);
      const rootStat = await lstat(configuredRoot);
      if (!vaultStat.isDirectory() || vaultStat.isSymbolicLink()
        || !parentStat.isDirectory() || parentStat.isSymbolicLink()
        || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw unavailable();
      const canonicalVaultRoot = await realpath(configuredVaultRoot);
      const canonical = await realpath(configuredRoot);
      // Requiring the canonical path to remain under the canonical vault and
      // to preserve the `.claude/skills` suffix rejects a symlink in either
      // catalog parent instead of silently reading outside the vault.
      const expected = join(canonicalVaultRoot, basename(configuredCatalogParent), basename(configuredRoot));
      if (canonical !== expected) throw unavailable();
      const canonicalStat = await lstat(canonical);
      if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) throw unavailable();
      return canonical;
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      throw unavailable();
    }
  }

  async function discover(root: string, directoryName: string): Promise<DiscoveredSkill | undefined> {
    if (!safeDirectoryName(directoryName)) return undefined;
    const directoryPath = join(root, directoryName);
    try {
      const directoryStat = await lstat(directoryPath);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return undefined;
      const directoryRealPath = await realpath(directoryPath);
      if (dirname(directoryRealPath) !== root || basename(directoryRealPath) !== directoryName) return undefined;
      const skillPath = join(directoryPath, SKILL_FILE);
      const skillStat = await lstat(skillPath);
      if (!skillStat.isFile() || skillStat.isSymbolicLink() || skillStat.size > MAX_SKILL_BYTES) return undefined;
      const skillRealPath = await realpath(skillPath);
      if (dirname(skillRealPath) !== directoryRealPath || basename(skillRealPath) !== SKILL_FILE) return undefined;
      const bytes = await readBoundedRegularFile(skillPath);
      return bytes === undefined ? undefined : { directoryName, directoryPath, directoryRealPath, bytes };
    } catch {
      return undefined;
    }
  }

  async function directories(root: string): Promise<DiscoveredSkill[]> {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      throw unavailable();
    }
    const result: DiscoveredSkill[] = [];
    for (const directoryName of entries.sort()) {
      const discovered = await discover(root, directoryName);
      if (discovered !== undefined) result.push(discovered);
    }
    return result;
  }

  function metadata(discovered: DiscoveredSkill): { summary: SkillSummary; markdown: string } | undefined {
    let data: Record<string, unknown> = {};
    let bodyBytes: Uint8Array = discovered.bytes;
    try {
      const parsed = parseFrontmatter(discovered.bytes);
      data = parsed.data;
      bodyBytes = parsed.bodyBytes;
    } catch {
      // A malformed or absent frontmatter does not make the file executable;
      // it simply falls back to safe directory metadata and the full Markdown.
    }
    let markdown: string;
    try {
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
    } catch {
      return undefined;
    }
    const summary: SkillSummary = {
      id: skillId(discovered.directoryName),
      name: field(data.name, discovered.directoryName, MAX_NAME_LENGTH),
      description: field(data.description, DEFAULT_DESCRIPTION, MAX_DESCRIPTION_LENGTH),
      revision: digest(discovered.bytes)
    };
    return { summary, markdown };
  }

  async function references(discovered: DiscoveredSkill): Promise<string[]> {
    try {
      const entries = await readdir(discovered.directoryPath);
      const result: string[] = [];
      for (const name of entries.sort()) {
        if (!safeDirectoryName(name) || name === SKILL_FILE || !name.endsWith('.md')) continue;
        const path = join(discovered.directoryPath, name);
        try {
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const canonical = await realpath(path);
          if (dirname(canonical) !== discovered.directoryRealPath || basename(canonical) !== name) continue;
          result.push(name);
        } catch {
          // References are optional and never make the main Skill unavailable.
        }
      }
      return result.slice(0, MAX_REFERENCE_COUNT);
    } catch {
      return [];
    }
  }

  async function list(): Promise<SkillSummary[]> {
    const root = await fixedRoot();
    const found = await directories(root);
    const items: SkillSummary[] = [];
    for (const discovered of found) {
      const parsed = metadata(discovered);
      if (parsed !== undefined) items.push(parsed.summary);
    }
    return items.slice(0, MAX_REFERENCE_COUNT);
  }

  async function get(id: string): Promise<SkillDetail> {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw invalidId();
    const root = await fixedRoot();
    const found = await directories(root);
    const discovered = found.find((candidate) => skillId(candidate.directoryName) === id);
    if (discovered === undefined) throw notFound();
    const parsed = metadata(discovered);
    if (parsed === undefined) throw notFound();
    return { ...parsed.summary, markdown: parsed.markdown, references: await references(discovered) };
  }

  return { list, get };
}
