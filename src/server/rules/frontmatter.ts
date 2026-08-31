import { parseDocument, visit } from 'yaml';

export type ParsedFrontmatter = {
  data: Record<string, unknown>;
  bodyBytes: Uint8Array;
};

export class FrontmatterError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'FrontmatterError';
  }
}

function lineEnd(bytes: Uint8Array, start: number): { contentEnd: number; nextStart: number } {
  for (let index = start; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a) {
      return {
        contentEnd: index > start && bytes[index - 1] === 0x0d ? index - 1 : index,
        nextStart: index + 1
      };
    }
  }
  return { contentEnd: bytes.byteLength, nextStart: bytes.byteLength };
}

function isDelimiter(bytes: Uint8Array, start: number, end: number): boolean {
  return end - start === 3
    && bytes[start] === 0x2d
    && bytes[start + 1] === 0x2d
    && bytes[start + 2] === 0x2d;
}

function locateFrontmatter(bytes: Uint8Array): {
  yamlStart: number;
  yamlEnd: number;
  bodyStart: number;
} {
  const documentStart = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const opening = lineEnd(bytes, documentStart);
  if (
    !isDelimiter(bytes, documentStart, opening.contentEnd)
    || opening.nextStart === bytes.byteLength
  ) {
    throw new FrontmatterError('FRONTMATTER_OPENING_DELIMITER_MISSING');
  }

  let currentStart = opening.nextStart;
  while (currentStart <= bytes.byteLength) {
    const current = lineEnd(bytes, currentStart);
    if (isDelimiter(bytes, currentStart, current.contentEnd)) {
      return {
        yamlStart: opening.nextStart,
        yamlEnd: currentStart,
        bodyStart: current.nextStart
      };
    }
    if (current.nextStart === bytes.byteLength) break;
    currentStart = current.nextStart;
  }

  throw new FrontmatterError('FRONTMATTER_CLOSING_DELIMITER_MISSING');
}

export function parseFrontmatter(bytes: Uint8Array): ParsedFrontmatter {
  const location = locateFrontmatter(bytes);
  let yamlText: string;
  try {
    yamlText = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes.subarray(location.yamlStart, location.yamlEnd));
  } catch {
    throw new FrontmatterError('FRONTMATTER_INVALID_UTF8');
  }

  const document = parseDocument(yamlText, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new FrontmatterError('FRONTMATTER_YAML_INVALID');
  }

  let containsAlias = false;
  visit(document, {
    Alias: () => {
      containsAlias = true;
      return visit.BREAK;
    }
  });
  if (containsAlias) {
    throw new FrontmatterError('FRONTMATTER_ALIAS_FORBIDDEN');
  }

  const data: unknown = document.toJS({ maxAliasCount: 0 });
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new FrontmatterError('FRONTMATTER_OBJECT_REQUIRED');
  }

  return {
    data: data as Record<string, unknown>,
    bodyBytes: bytes.subarray(location.bodyStart)
  };
}
