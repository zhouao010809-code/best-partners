import { expect, it } from 'vitest';
import { createTextSearch } from '../../src/server/search/text-search.js';

it.each(['中、高考', '中-考', '小红书获客', 'C++', 'AI-2026', '中考/高考'])('preserves an existing literal match for %s', query => {
  expect(createTextSearch(query).score(query)).toBeGreaterThan(0);
});

it('does not combine Han characters across punctuation boundaries', () => {
  expect(createTextSearch('中、高考').tokens).not.toContain('中高考');
  expect(createTextSearch('中-考').tokens).not.toContain('中考');
});
