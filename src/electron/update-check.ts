import { z } from 'zod';
export type { UpdateCheckResult } from '../shared/desktop/update.js';
import type { UpdateCheckResult } from '../shared/desktop/update.js';

export const RELEASES_URL = 'https://api.github.com/repos/zhouao010809-code/best-partners/releases?per_page=20';
export const RELEASE_PAGE_URL = 'https://github.com/zhouao010809-code/best-partners/releases';

const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  html_url: z.string(),
  body: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});
const releasesSchema = z.array(releaseSchema);

type ParsedVersion = { major: string; minor: string; patch: string; prerelease: string[] };

export type UpdateCheckerInput = {
  currentVersion: string;
  releasesUrl?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
};

function parseVersion(value: string): ParsedVersion | null {
  const match = versionPattern.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && (part.length > 1 && part.startsWith('0')))) return null;
  return { major: match[1]!, minor: match[2]!, patch: match[3]!, prerelease };
}

function compareIntegerStrings(left: string, right: string): number {
  const a = left.replace(/^0+(?=\d)/, '');
  const b = right.replace(/^0+(?=\d)/, '');
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a === b ? 0 : (a > b ? 1 : -1);
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const comparison = compareIntegerStrings(left[key], right[key]);
    if (comparison) return comparison;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : (left.prerelease.length ? -1 : 1);
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return compareIntegerStrings(a, b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

function isOfficialUrl(value: string, expectedPath: string): boolean {
  try {
    const url = new URL(value);
    const authority = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/]+)/iu)?.[1];
    return url.protocol === 'https:' && url.hostname === 'github.com' && authority === 'github.com' && !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === expectedPath;
  } catch {
    return false;
  }
}

function cleanNotes(body: string): string {
  return Array.from(body
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(```|`|~~|[*_#>])/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .trim())
    .slice(0, 4000)
    .join('');
}

type UpdateErrorCode = 'UPDATE_FEED_UNAVAILABLE' | 'UPDATE_FEED_INVALID' | 'UPDATE_VERSION_INVALID';

function errorResult(currentVersion: string, code: UpdateErrorCode, message: string): UpdateCheckResult {
  return { status: 'error', currentVersion, code, message, releaseUrl: RELEASE_PAGE_URL };
}

export async function checkForUpdate(input: UpdateCheckerInput): Promise<UpdateCheckResult> {
  const current = parseVersion(input.currentVersion);
  if (!current) return errorResult(input.currentVersion, 'UPDATE_VERSION_INVALID', '当前应用版本号无效。');

  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(input.releasesUrl ?? RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'best-partners-update-check' },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return errorResult(input.currentVersion, 'UPDATE_FEED_UNAVAILABLE', '暂时无法检查更新。');
  }
  if (!response.ok) return errorResult(input.currentVersion, 'UPDATE_FEED_UNAVAILABLE', '暂时无法检查更新。');

  let parsedJson: unknown;
  try {
    parsedJson = await response.json();
  } catch {
    return errorResult(input.currentVersion, 'UPDATE_FEED_INVALID', '更新信息格式无效。');
  }
  const parsed = releasesSchema.safeParse(parsedJson);
  if (!parsed.success) return errorResult(input.currentVersion, 'UPDATE_FEED_INVALID', '更新信息格式无效。');

  const candidates = parsed.data
    .filter((release) => !release.draft)
    .map((release) => ({ release, version: parseVersion(release.tag_name) }))
    .filter((entry): entry is { release: z.infer<typeof releaseSchema>; version: ParsedVersion } => entry.version !== null)
    .filter(({ version, release }) => compareVersions(version, current) > 0 && (!version.prerelease.length || current.prerelease.length) && (!release.prerelease || current.prerelease.length))
    .map(({ release, version }) => {
      if (!isOfficialUrl(release.html_url, `/zhouao010809-code/best-partners/releases/tag/${release.tag_name}`)) return null;
      const asset = release.assets.find((item) => /arm64[^/]*\.dmg$/iu.test(item.name) && isOfficialUrl(item.browser_download_url, `/zhouao010809-code/best-partners/releases/download/${release.tag_name}/${item.name}`));
      if (!asset) return null;
      return { release, version, asset };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => compareVersions(b.version, a.version));

  const winner = candidates[0];
  if (!winner) {
    return { status: 'up-to-date', currentVersion: input.currentVersion, checkedAt: (input.now ?? (() => new Date()))().toISOString() };
  }
  const result: Extract<UpdateCheckResult, { status: 'available' }> = {
    status: 'available',
    currentVersion: input.currentVersion,
    version: [winner.version.major, winner.version.minor, winner.version.patch].join('.') + (winner.version.prerelease.length ? `-${winner.version.prerelease.join('.')}` : ''),
    releaseUrl: winner.release.html_url,
    assetUrl: winner.asset.browser_download_url,
    notes: winner.release.body ? cleanNotes(winner.release.body) : '',
  };
  if (winner.release.published_at) result.publishedAt = winner.release.published_at;
  return result;
}
