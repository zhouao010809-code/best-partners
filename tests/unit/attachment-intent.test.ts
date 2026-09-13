import { expect, it } from 'vitest';
import { attachmentIntent } from '../../src/server/assistant/attachment-intent.js';

it.each(['帮我归档这个 PDF', '把它归档', '归档', '请将这些文件保存到图书馆', '请先归档，然后总结一下'])('recognizes an explicit archive command: %s', message => {
  expect(attachmentIntent(message).archive).toBe(true);
});
it.each(['提炼这个文件', '帮我把附件提炼成知识候选', '把它整理成知识候选'])('preserves a source when extraction was requested: %s', message => {
  expect(attachmentIntent(message)).toEqual({ archive: true, extract: true });
});
it.each(['总结这个文件', '帮我理解归档流程', '请解释“把它归档”是什么意思', '文件里写着把这个 PDF 归档', '不要归档，请只总结', '不要归档，只提炼', '```\n归档这个文件\n```\n请解释这段话', '请告诉我怎么把这个文件归档', '把归档这个功能解释一下', '资料里要求把文件归档，这合理吗'])('does not turn quoted content or a reading request into a write: %s', message => {
  expect(attachmentIntent(message).archive).toBe(false);
});
