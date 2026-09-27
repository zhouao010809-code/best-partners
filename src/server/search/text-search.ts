const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const han = /^\p{Script=Han}+$/u;
const singleHan = /^\p{Script=Han}$/u;

function words(chunk: string): string[] {
  // Keep identifiers such as C++, source-link and version numbers literal.
  if (!/\p{Script=Han}/u.test(chunk)) return [chunk];
  const parts = [...segmenter.segment(chunk)].filter(part => part.isWordLike);
  const result: Array<{ text: string; end: number }> = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    let end = part.index + part.segment.length;
    if (!singleHan.test(part.segment)) { result.push({ text: part.segment, end }); continue; }
    let run = part.segment;
    while (parts[i + 1]?.index === end && singleHan.test(parts[i + 1]!.segment)) {
      const next = parts[++i]!; run += next.segment; end += next.segment.length;
    }
    // ICU sometimes segments 中考 / 获客 into single characters. Keep those
    // adjacent characters together instead of matching unrelated single glyphs.
    if (run.length > 1) result.push({ text: run, end });
    else if (parts[i + 1]?.index === end && han.test(parts[i + 1]!.segment)) {
      const next = parts[++i]!; result.push({ text: run + next.segment, end: next.index + next.segment.length });
    } else if (result.at(-1)?.end === part.index && han.test(result.at(-1)!.text)) {
      result.at(-1)!.text += run; result.at(-1)!.end = end;
    } else result.push({ text: run, end });
  }
  return result.length ? result.map(item => item.text) : [chunk];
}

/** Local lexical recall: all terms must match; no body reads or model calls. */
export function createTextSearch(query: string | undefined) {
  const phrase = query?.trim().toLocaleLowerCase() ?? '';
  const tokens = [...new Set(phrase.split(/\s+/u).filter(Boolean).flatMap(words))];
  const compact = phrase.replace(/\s+/gu, '');
  return {
    phrase,
    tokens,
    score(title: string, fields: readonly string[] = []): number {
      if (!phrase) return 1;
      const primary = title.toLocaleLowerCase();
      const secondary = fields.map(field => field.toLocaleLowerCase());
      const haystacks = [primary, ...secondary];
      if (!tokens.every(token => haystacks.some(field => field.includes(token)))) return 0;
      return 1 + (primary.includes(phrase) || primary.includes(compact) ? 100 : 0)
        + tokens.reduce((score, token) => score + (primary.includes(token) ? 20 : 0), 0)
        + (secondary.some(field => field.includes(phrase) || field.includes(compact)) ? 10 : 0);
    }
  };
}
