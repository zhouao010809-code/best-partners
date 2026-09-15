import { USAGE_STATUSES } from '../src/server/rules/knowledge-schema.js';
import type { UsageStatus } from '../src/shared/domain/records.js';
import { VaultReaderError, type VaultReader, type KnowledgeRead } from './vault-reader.js';

const MAX_SEARCH_FILES = 1_000;
const MAX_SEARCH_BYTES = 20 * 1024 * 1024;

export type SearchKnowledgeInput = {
  query: string;
  status?: UsageStatus | undefined;
  limit?: number | undefined;
};

export type SearchKnowledgeItem = {
  path: string;
  title: string;
  usageStatus: UsageStatus;
  knowledgeType: string;
  score: number;
  summary: string;
  rawSha256: string;
};

export type SearchKnowledgeResult = {
  items: SearchKnowledgeItem[];
  skippedCount: number;
  scannedBytes: number;
  truncated: boolean;
};

function normalize(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

function validateInput(input: SearchKnowledgeInput): { query: string; status?: UsageStatus; limit: number } {
  if (typeof input.query !== 'string' || input.query.length < 1 || input.query.length > 2_000 || input.query.includes('\0')) {
    throw new VaultReaderError('INVALID_LIMIT');
  }
  if (input.status !== undefined && !USAGE_STATUSES.includes(input.status)) {
    throw new VaultReaderError('INVALID_LIMIT');
  }
  const limit = input.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new VaultReaderError('INVALID_LIMIT');
  return { query: normalize(input.query), ...(input.status === undefined ? {} : { status: input.status }), limit };
}

function countMatches(value: string, query: string): number {
  let count = 0;
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(query, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(query.length, 1);
  }
  return count;
}

function scoreNote(note: KnowledgeRead, query: string): number {
  const recall = note.recallFields;
  const title = normalize(note.record.title);
  const recallText = [
    ...recall.topics,
    ...recall.keywords,
    ...recall.scenarios,
    recall.conclusion,
    ...recall.keyPoints,
    recall.boundary
  ].map(normalize).join('\n');
  const body = normalize(note.body);
  return countMatches(title, query) * 5 + countMatches(recallText, query) * 3 + countMatches(body, query);
}

export async function searchKnowledge(
  reader: VaultReader,
  input: SearchKnowledgeInput
): Promise<SearchKnowledgeResult> {
  const { query, status, limit } = validateInput(input);
  const paths = await reader.listKnowledgeFiles();
  const matches: SearchKnowledgeItem[] = [];
  let skippedCount = 0;
  let scannedBytes = 0;
  let truncated = paths.length > MAX_SEARCH_FILES;
  for (const path of paths.slice(0, MAX_SEARCH_FILES)) {
    let note: KnowledgeRead;
    try {
      note = await reader.readKnowledgeForSearch(path);
    } catch (error) {
      if (error instanceof VaultReaderError && error.code === 'INVALID_NOTE') {
        skippedCount += 1;
        continue;
      }
      throw error;
    }
    scannedBytes += note.totalBytes;
    if (scannedBytes > MAX_SEARCH_BYTES) {
      truncated = true;
      break;
    }
    if (status === undefined && note.record.usageStatus === '过时') continue;
    if (status !== undefined && note.record.usageStatus !== status) continue;
    const score = scoreNote(note, query);
    if (score <= 0) continue;
    matches.push({
      path: note.path,
      title: note.record.title,
      usageStatus: note.record.usageStatus,
      knowledgeType: note.record.knowledgeType,
      score,
      summary: note.recallFields.conclusion,
      rawSha256: note.rawSha256
    });
  }
  matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path, 'zh-CN'));
  return { items: matches.slice(0, limit), skippedCount, scannedBytes, truncated };
}
