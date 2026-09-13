import { isMap, isSeq, parseDocument, visit } from 'yaml';
import type { KnowledgeRecord, MaterialRecord, ParsedNote } from '../../shared/domain/records.js';
import { sha256Bytes } from '../vault/raw-bytes.js';
import { parseKnowledgeNote } from './knowledge-schema.js';
import { parseLibraryNote } from './library-schema.js';

const COMPLETE_WIKILINK = /^\[\[[^\[\]\r\n]+\]\]$/u;
const INLINE_WIKILINKS = /^\[\[[^\[\]\r\n]+\]\](?:[ \t]*,[ \t]*\[\[[^\[\]\r\n]+\]\])*$/u;

function readHeader(bytes: Uint8Array): { yaml: string; bodyBytes: Uint8Array } | undefined {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf ? 3 : 0;
  const openingEnd = view.indexOf(0x0a, start);
  if (openingEnd < 0 || !/^---\r?$/u.test(view.toString('utf8', start, openingEnd))) return;

  let lineStart = openingEnd + 1;
  while (lineStart < view.byteLength) {
    const newline = view.indexOf(0x0a, lineStart);
    const lineEnd = newline < 0 ? view.byteLength : newline;
    const delimiter = view.toString('utf8', lineStart, lineEnd);
    if (delimiter === '---' || (newline >= 0 && delimiter === '---\r')) {
      try {
        return {
          yaml: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(openingEnd + 1, lineStart)),
          bodyBytes: bytes.subarray(newline < 0 ? lineEnd : newline + 1)
        };
      } catch { return; }
    }
    if (newline < 0) return;
    lineStart = newline + 1;
  }
}

function normalizeHeaderForRead(yaml: string, linkFields: readonly string[]): string {
  const originalDocument = parseDocument(yaml);
  // Legacy compatibility is confined to block mappings. Flow scalars may contain
  // unindented field-looking lines that are text, not actual root properties.
  if (!isMap(originalDocument.contents) || originalDocument.contents.flow) return yaml;
  let containsAlias = false;
  visit(originalDocument, { Alias: () => { containsAlias = true; return visit.BREAK; } });
  if (containsAlias) return yaml;
  const normalized = yaml.split('\n').map((line) => {
    const match = /^([^\s:]+):[ \t]*(.*?)(\r?)$/u.exec(line);
    if (!match) return line;
    const [, field, rawValue, ending] = match;
    const value = rawValue!.trim();
    if (linkFields.includes(field!) && INLINE_WIKILINKS.test(value)) {
      const links = value.match(/\[\[[^\[\]\r\n]+\]\]/gu)!;
      return `${field}: ${JSON.stringify(links)}${ending}`;
    }
    if (field === '作者' && /^@[A-Za-z0-9_]+$/u.test(value)) {
      return `${field}: ${JSON.stringify(value)}${ending}`;
    }
    // Only a complete, single-line legacy remark; comments and structured values stay invalid.
    if (field === '备注' && /^[^\s"'\[\]{}>&*!|#].*:[ \t]+/u.test(value) && !/(?:^|\s)#/u.test(value)) {
      const scalar = parseDocument(`备注: ${value}\n`);
      if (scalar.errors.length > 0 && scalar.errors.every((error) => error.code === 'BLOCK_AS_IMPLICIT_KEY')) {
        return `${field}: ${JSON.stringify(value)}${ending}`;
      }
    }
    return line;
  }).join('\n');

  const document = parseDocument(normalized, { uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents)) return normalized;
  const replacements: { start: number; end: number; text: string }[] = [];
  for (const field of linkFields) {
    const list = document.get(field, true);
    if (!isSeq(list) || list.tag) continue;
    for (const item of list.items) {
      if (!isSeq(item) || item.tag || !item.range) continue;
      const [start, end] = item.range;
      const source = normalized.slice(start, end);
      // Source tokens distinguish a wikilink from an arbitrary nested YAML sequence.
      if (COMPLETE_WIKILINK.test(source)) replacements.push({ start, end, text: JSON.stringify(source) });
    }
  }
  let result = normalized;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return result;
}

function parseNoteForRead<T extends { rawSha256: string }>(
  bytes: Uint8Array,
  path: string,
  upstreamVersion: string | undefined,
  parseStrict: (bytes: Uint8Array, path: string, upstreamVersion?: string) => ParsedNote<T>,
  linkFields: readonly string[]
): ParsedNote<T> {
  const original = parseStrict(bytes, path, upstreamVersion);
  if (original.record) return original;
  if (original.issues.some((issue) => issue.code === 'FRONTMATTER_INVALID'
    && issue.message !== 'FRONTMATTER_YAML_INVALID')) return original;
  const header = readHeader(bytes);
  if (!header) return original;
  const normalized = normalizeHeaderForRead(header.yaml, linkFields);
  if (normalized === header.yaml) return original;

  // Reuse the complete strict schema; these synthetic bytes must never be written or hashed as the source.
  const candidate = parseStrict(new TextEncoder().encode(`---\n${normalized}---\n`), path, upstreamVersion);
  if (!candidate.record) return original;
  return {
    record: { ...candidate.record, rawSha256: sha256Bytes(bytes) },
    issues: [],
    bodyBytes: header.bodyBytes
  };
}

/** Read projection only. Write validation must continue to use parseLibraryNote. */
export function parseLibraryNoteForRead(
  bytes: Uint8Array,
  path = 'unknown.md',
  upstreamVersion?: string
): ParsedNote<MaterialRecord> {
  return parseNoteForRead(bytes, path, upstreamVersion, parseLibraryNote, ['所属主题', '生成知识']);
}

/** Read projection only. Write validation must continue to use parseKnowledgeNote. */
export function parseKnowledgeNoteForRead(
  bytes: Uint8Array,
  path = 'unknown.md',
  upstreamVersion?: string
): ParsedNote<KnowledgeRecord> {
  return parseNoteForRead(bytes, path, upstreamVersion, parseKnowledgeNote, ['所属主题', '来源资料']);
}
