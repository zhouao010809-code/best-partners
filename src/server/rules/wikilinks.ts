const WIKILINK = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/gu;

export function extractWikiLinks(markdown: string): string[] {
  const links: string[] = [];
  for (const match of markdown.matchAll(WIKILINK)) {
    const target = match[1]?.trim();
    if (target !== undefined && target.length > 0) links.push(target);
  }
  return links;
}

export function normalizeWikiLinkList(values: readonly string[]): string[] {
  return values.flatMap((value) => {
    const links = extractWikiLinks(value);
    return links.length > 0 ? links : [value.trim()].filter(Boolean);
  });
}

/** Shared identity normalization for catalog lookup and destructive-action previews. */
export function normalizeWikiLinkTargets(values: readonly string[]): string[] {
  return normalizeWikiLinkList(values).map(value => value.split(/[#^]/u, 1)[0]!.trim().normalize('NFC')).filter(Boolean);
}
