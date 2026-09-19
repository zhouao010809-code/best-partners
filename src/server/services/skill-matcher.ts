import type { SkillMatchCandidate } from '../../shared/api/skills.js';
import { skillMatchCandidateSchema } from '../../shared/api/skills.js';
import type { SkillCatalogService } from './skill-catalog.js';

const MAX_CANDIDATES = 3;
const MAX_QUERY_TERMS = 2_048;
const MAX_MATCHED_MARKDOWN_CHARACTERS = 32_000;
const MIN_SCORE = 6;

type MatchField = 'name' | 'description' | 'markdown';

type ScoredCandidate = {
  candidate: SkillMatchCandidate;
  score: number;
};

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function englishWords(value: string): Set<string> {
  return new Set(value.match(/[a-z0-9]+/gu)?.filter((word) => word.length >= 2) ?? []);
}

function chineseTerms(value: string): string[] {
  const terms = new Set<string>();
  const runs = value.match(/\p{Script=Han}+/gu) ?? [];
  for (let size = 12; size >= 2 && terms.size < MAX_QUERY_TERMS; size -= 1) {
    for (const run of runs) {
      if (run.length < size) continue;
      for (let offset = 0; offset <= run.length - size; offset += 1) {
        terms.add(run.slice(offset, offset + size));
        if (terms.size >= MAX_QUERY_TERMS) break;
      }
      if (terms.size >= MAX_QUERY_TERMS) break;
    }
  }
  return [...terms];
}

function matchedTerm(
  field: string,
  queryEnglish: Set<string>,
  queryChinese: string[]
): { length: number; kind: 'english' | 'chinese' } | undefined {
  const normalized = normalize(field);
  if (!normalized) return undefined;

  const fieldEnglish = englishWords(normalized);
  let englishMatches = 0;
  for (const word of queryEnglish) {
    if (fieldEnglish.has(word)) englishMatches += 1;
  }
  const chinese = queryChinese.find((term) => normalized.includes(term));
  const chineseLength = chinese?.length ?? 0;
  const englishLength = englishMatches * 2;
  if (chineseLength === 0 && englishLength === 0) return undefined;
  return chineseLength >= englishLength
    ? { length: chineseLength, kind: 'chinese' }
    : { length: englishLength, kind: 'english' };
}

function scoreField(
  field: string,
  kind: MatchField,
  queryEnglish: Set<string>,
  queryChinese: string[]
): { score: number; kind: MatchField } | undefined {
  const match = matchedTerm(field, queryEnglish, queryChinese);
  if (!match) return undefined;
  const weight = kind === 'name' ? 12 : kind === 'description' ? 6 : 1;
  return { score: match.length * weight, kind };
}

function reason(kind: MatchField): string {
  if (kind === 'name') return 'Skill 名称与当前任务匹配';
  if (kind === 'description') return 'Skill 说明与当前任务匹配';
  return 'Skill 方法内容与当前任务匹配';
}

export interface SkillMatcherService {
  match(message: string): Promise<SkillMatchCandidate[]>;
}

export function createSkillMatcherService(input: {
  catalog: SkillCatalogService;
}): SkillMatcherService {
  return {
    async match(message) {
      const normalizedMessage = normalize(message);
      if (!normalizedMessage) return [];
      const queryEnglish = englishWords(normalizedMessage);
      const queryChinese = chineseTerms(normalizedMessage);
      const documents = input.catalog.matchDocuments
        ? await input.catalog.matchDocuments()
        : await (async () => {
          const page = await input.catalog.list();
          const loaded = [];
          for (const summary of page.items) {
            try {
              loaded.push(await input.catalog.get(summary.id));
            } catch {
              // A disappearing or unreadable Skill is not a usable candidate.
            }
          }
          return loaded;
        })();
      const scored: ScoredCandidate[] = [];

      for (const detail of documents) {
        const matches = [
          scoreField(detail.name, 'name', queryEnglish, queryChinese),
          scoreField(detail.description, 'description', queryEnglish, queryChinese),
          scoreField(
            detail.markdown.slice(0, MAX_MATCHED_MARKDOWN_CHARACTERS),
            'markdown',
            queryEnglish,
            queryChinese
          )
        ].filter((entry): entry is { score: number; kind: MatchField } => entry !== undefined);
        const score = matches.reduce((total, entry) => total + entry.score, 0);
        if (score < MIN_SCORE) continue;
        const strongest = [...matches].sort((left, right) => right.score - left.score)[0]!;
        const candidate = skillMatchCandidateSchema.parse({
          id: detail.id,
          name: detail.name,
          description: detail.description,
          folderName: detail.folderName,
          revision: detail.revision,
          reason: reason(strongest.kind)
        });
        scored.push({ candidate, score });
      }

      return scored
        .sort((left, right) => right.score - left.score
          || left.candidate.id.localeCompare(right.candidate.id))
        .slice(0, MAX_CANDIDATES)
        .map((entry) => entry.candidate);
    }
  };
}
