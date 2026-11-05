import { INGESTION_IMAGE_MAX_CHARACTERS } from '../../shared/api/ingestion.js';
import { PublicApiError } from '../../shared/api/errors.js';
import { patchSource } from './note-format.js';

function tooLarge(): never {
  throw new PublicApiError('SOURCE_INGESTION_TOO_LARGE', '原文过长，超出当前入库及恢复记录的容量（50 万字符，含新增知识引用）。请先拆分原文再提炼；缩小选区不能解决。原文和已有候选均已保留。', 413);
}

export function assertSourceImageCapacity(...images: string[]): void {
  if (images.some(image => image.length > INGESTION_IMAGE_MAX_CHARACTERS)) tooLarge();
}

/** Reserve the largest permitted batch of links before sending a selected range. */
export function assertSourcePreparationCapacity(before: Buffer): void {
  assertSourceImageCapacity(before.toString('utf8'));
  const patched = patchSource(before, [], '部分入库').toString('utf8');
  // Up to 12 target paths, each <= 1024 UTF-16 units. JSON can escape a
  // unit to six characters, plus wiki-link delimiters, quotes and a comma.
  const maximumNewLinks = 12 * (1024 * 6 + 7);
  if (patched.length + maximumNewLinks > INGESTION_IMAGE_MAX_CHARACTERS) tooLarge();
}
