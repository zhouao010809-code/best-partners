import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLibraryNote } from '../../src/server/rules/library-schema.js';
import { parseKnowledgeNote } from '../../src/server/rules/knowledge-schema.js';
const material = readFileSync('tests/fixtures/library-valid.md', 'utf8');
const knowledge = readFileSync('tests/fixtures/knowledge-valid.md', 'utf8');
describe('single-note projection respects public response bounds', () => {
  it('diagnoses an oversized title before it can break the entire material page', () => {
    const bytes = Buffer.from(material.replace('一份可提炼的资料', '长'.repeat(1001)));
    const before = Buffer.from(bytes);
    const result = parseLibraryNote(bytes, '01图书馆/长标题.md');
    expect(result.record).toBeUndefined();
    expect(result.issues).toHaveLength(1);
    expect(bytes).toEqual(before);
  });
  it('accepts the title limit without changing the source', () => {
    const result = parseLibraryNote(Buffer.from(material.replace('一份可提炼的资料', '长'.repeat(1000))), '01图书馆/正常.md');
    expect(result.record?.title).toHaveLength(1000);
    expect(result.issues).toEqual([]);
  });
  it('diagnoses oversized knowledge recall metadata per file', () => {
    const result = parseKnowledgeNote(Buffer.from(knowledge.replace('关键词: [检索, 召回]', `关键词: [${'长'.repeat(513)}]`)), '02知识库/知识.md');
    expect(result.record).toBeUndefined();
    expect(result.issues).toHaveLength(1);
  });
});
