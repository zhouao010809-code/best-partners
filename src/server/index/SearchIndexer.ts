import type { SchemaIssue } from '../../shared/domain/records.js';
import { createHash } from 'node:crypto';
import { parseKnowledgeNote } from '../rules/knowledge-schema.js';
import { parseLibraryNote } from '../rules/library-schema.js';
import type { VaultGateway, VersionedBytes } from '../vault/VaultGateway.js';
import { sha256Bytes } from '../vault/raw-bytes.js';
import { canonicalJson, type IndexedFile, type IndexRepository } from './index-repository.js';

const INDEX_ROOTS = ['01图书馆', '02知识库'] as const;

type IndexRoot = typeof INDEX_ROOTS[number];

type StagedScan = {
  readonly paths: string[];
  readonly files: IndexedFile[];
  readonly issues: SchemaIssue[];
  readonly manifestEntries: StagedManifestEntry[];
  cursor: number;
};

type StagedManifestEntry = {
  readonly path: string;
  readonly rawSha256: string;
  readonly upstreamVersion?: string;
  readonly contract: unknown;
};

export type IndexRefreshResult = {
  status: 'refreshing' | 'ready';
  checked: number;
  total: number;
  version: number;
};

function isHiddenSegment(segment: string): boolean {
  return segment.startsWith('.');
}

function validateDirectEntry(entry: string): { name: string; directory: boolean } {
  if (
    entry.length === 0
    || entry.includes('\\')
    || entry.includes('\0')
    || entry.startsWith('/')
  ) {
    throw new Error('MALFORMED_DIRECTORY_ENTRY');
  }

  const directory = entry.endsWith('/');
  const name = directory ? entry.slice(0, -1) : entry;
  if (
    name.length === 0
    || name === '.'
    || name === '..'
    || name.includes('/')
  ) {
    throw new Error('MALFORMED_DIRECTORY_ENTRY');
  }
  return { name, directory };
}

function rootForPath(path: string): IndexRoot {
  if (path.startsWith('01图书馆/')) return '01图书馆';
  if (path.startsWith('02知识库/')) return '02知识库';
  throw new Error('INDEX_PATH_OUTSIDE_ALLOWED_ROOTS');
}

function assertRawResponse(path: string, raw: VersionedBytes): void {
  if (raw.path !== path || raw.rawSha256 !== sha256Bytes(raw.bytes)) {
    throw new Error('VAULT_RAW_METADATA_MISMATCH');
  }
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

export class SearchIndexer {
  version = 0;
  private stagedScan: StagedScan | undefined;
  private committedManifestSha256: string | undefined;
  private readonly gateway: VaultGateway;
  private readonly repository: IndexRepository;
  private readonly maxRawReadsPerPoll: number;

  constructor(input: {
    gateway: VaultGateway;
    repository: IndexRepository;
    maxRawReadsPerPoll: number;
  }) {
    if (!Number.isSafeInteger(input.maxRawReadsPerPoll) || input.maxRawReadsPerPoll <= 0) {
      throw new Error('INVALID_INDEX_READ_BUDGET');
    }
    this.gateway = input.gateway;
    this.repository = input.repository;
    this.maxRawReadsPerPoll = input.maxRawReadsPerPoll;
  }

  async refresh(): Promise<IndexRefreshResult> {
    try {
      if (this.stagedScan === undefined) {
        this.stagedScan = {
          paths: await this.listAllowedMarkdown(),
          files: [],
          issues: [],
          manifestEntries: [],
          cursor: 0
        };
      }

      const scan = this.stagedScan;
      const end = Math.min(scan.cursor + this.maxRawReadsPerPoll, scan.paths.length);
      while (scan.cursor < end) {
        const path = scan.paths[scan.cursor];
        if (path === undefined) throw new Error('INDEX_SCAN_CURSOR_INVALID');
        await this.stageFile(scan, path);
        scan.cursor += 1;
      }

      if (scan.cursor < scan.paths.length) {
        return {
          status: 'refreshing',
          checked: scan.cursor,
          total: scan.paths.length,
          version: this.version
        };
      }

      const currentPaths = await this.listAllowedMarkdown();
      if (!samePaths(scan.paths, currentPaths)) {
        this.stagedScan = {
          paths: currentPaths,
          files: [],
          issues: [],
          manifestEntries: [],
          cursor: 0
        };
        return {
          status: 'refreshing',
          checked: 0,
          total: currentPaths.length,
          version: this.version
        };
      }

      const manifestSha256 = createHash('sha256')
        .update(canonicalJson(scan.manifestEntries), 'utf8')
        .digest('hex');
      const projectionChanged = this.repository.applyBatch({ files: scan.files, issues: scan.issues });
      if (
        this.version === 0
        || projectionChanged
        || manifestSha256 !== this.committedManifestSha256
      ) {
        this.version += 1;
      }
      this.committedManifestSha256 = manifestSha256;
      const result: IndexRefreshResult = {
        status: 'ready',
        checked: scan.cursor,
        total: scan.paths.length,
        version: this.version
      };
      this.stagedScan = undefined;
      return result;
    } catch (error) {
      this.stagedScan = undefined;
      throw error;
    }
  }

  private async listAllowedMarkdown(): Promise<string[]> {
    const paths: string[] = [];
    for (const root of INDEX_ROOTS) await this.walkDirectory(root, paths);
    return [...new Set(paths)].sort();
  }

  private async walkDirectory(directory: string, paths: string[]): Promise<void> {
    const entries = await this.gateway.listDirectory(directory);
    const seenEntries = new Set<string>();
    for (const entry of entries) {
      if (seenEntries.has(entry)) throw new Error('MALFORMED_DIRECTORY_ENTRY');
      seenEntries.add(entry);
      const direct = validateDirectEntry(entry);
      if (isHiddenSegment(direct.name)) continue;
      const path = `${directory}/${direct.name}`;
      if (direct.directory) {
        await this.walkDirectory(path, paths);
      } else if (direct.name.endsWith('.md')) {
        paths.push(path);
      }
    }
  }

  private async stageFile(scan: StagedScan, path: string): Promise<void> {
    const raw = await this.gateway.readRaw(path);
    assertRawResponse(path, raw);
    const root = rootForPath(path);
    if (root === '01图书馆') {
      const parsed = parseLibraryNote(raw.bytes, path, raw.upstreamVersion);
      if (parsed.record !== undefined) {
        scan.files.push({ kind: 'material', record: parsed.record });
      }
      scan.issues.push(...parsed.issues);
      scan.manifestEntries.push({
        path,
        rawSha256: raw.rawSha256,
        ...(raw.upstreamVersion === undefined ? {} : { upstreamVersion: raw.upstreamVersion }),
        contract: parsed.record === undefined
          ? { kind: 'issue', issues: parsed.issues }
          : { kind: 'material', record: parsed.record }
      });
      return;
    }

    const parsed = parseKnowledgeNote(raw.bytes, path, raw.upstreamVersion);
    if (parsed.record !== undefined) {
      scan.files.push({ kind: 'knowledge', record: parsed.record });
    }
    scan.issues.push(...parsed.issues);
    scan.manifestEntries.push({
      path,
      rawSha256: raw.rawSha256,
      ...(raw.upstreamVersion === undefined ? {} : { upstreamVersion: raw.upstreamVersion }),
      contract: parsed.record === undefined
        ? { kind: 'issue', issues: parsed.issues }
        : { kind: 'knowledge', record: parsed.record }
    });
  }
}
