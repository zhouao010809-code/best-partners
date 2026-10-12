import { z } from 'zod';

/** Reader-selected text is a user snapshot, not a verified Markdown offset. */
export const learningSelectionSchema = z.strictObject({
  path: z.string().min(1).max(1024).refine(path => /^(?:01图书馆|02知识库)\/.+\.md$/u.test(path)
    && !/[\\\u0000-\u001f\u007f]/u.test(path) && path.split('/').every(part => !!part && !part.startsWith('.')), '请选择有效的图书馆资料或知识文档。'),
  title: z.string().trim().min(1).max(512),
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  text: z.string().trim().min(1).refine(text => Array.from(text).length <= 6000, '选中文字不能超过 6000 字，请缩小选择。')
});
export type LearningSelection = z.infer<typeof learningSelectionSchema>;
