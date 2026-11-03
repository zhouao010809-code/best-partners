import { extname } from 'node:path';
import { parseAttachment } from '../attachments/parser.js';
import { createImageEvidenceReader, type ImageEvidenceReader } from './image-evidence.js';

export const SEARCH_CONTENT_INPUT_LIMIT = 20 * 1024 * 1024;
const TEXT_LIMIT = 512 * 1024;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp']);
export interface SearchContent { text: string; partial: boolean }
export type WorkdiskSearchContentReader = (input: { name: string; bytes: Buffer }, signal: AbortSignal) => Promise<SearchContent>;
export function supportsSearchContent(name: string): boolean { const extension = extname(name).toLowerCase(); return extension === '.pdf' || IMAGE_EXTENSIONS.has(extension); }

/** Local text only: image labels are not evidence that a word appears in a file. */
export function createWorkdiskSearchContentReader(input: {
  parserWorkerPath?: string | URL; imageHelperPath?: string | URL; imageEvidenceReader?: ImageEvidenceReader;
} = {}): WorkdiskSearchContentReader {
  const readImage = input.imageEvidenceReader ?? (input.imageHelperPath ? createImageEvidenceReader({ helperPath: input.imageHelperPath }) : undefined);
  return async (source, signal) => {
    signal.throwIfAborted();
    if (!Buffer.isBuffer(source.bytes) || source.bytes.length > SEARCH_CONTENT_INPUT_LIMIT || !supportsSearchContent(source.name)) return { text: '', partial: true };
    if (extname(source.name).toLowerCase() === '.pdf') {
      const parsed = await parseAttachment(source.bytes, 'application/pdf', signal, input.parserWorkerPath);
      if (parsed.status !== 'ready') return { text: '', partial: true };
      const text = parsed.pages.map(page => page.text).join('\n\n');
      return { text: text.slice(0, TEXT_LIMIT), partial: text.length > TEXT_LIMIT };
    }
    if (!readImage) return { text: '', partial: true };
    const parsed = await readImage(source.bytes, signal);
    return parsed.status === 'ready' ? { text: parsed.text, partial: parsed.sampled } : { text: '', partial: true };
  };
}

/** A bounded, process-local cache. Nothing is written beside the user's documents. */
export function createSearchContentCache() {
  const entries = new Map<string, { content: SearchContent; bytes: number; expires: number }>();
  let size = 0;
  function remove(key: string) { const entry = entries.get(key); if (entry) { size -= entry.bytes; entries.delete(key); } }
  return {
    get(key: string): SearchContent | undefined {
      const entry = entries.get(key); if (!entry) return undefined;
      if (entry.expires < Date.now()) { remove(key); return undefined; }
      entries.delete(key); entries.set(key, entry); return entry.content;
    },
    set(key: string, content: SearchContent) {
      remove(key);
      // Also bound injected readers; production extractors already enforce this limit.
      const bounded = { text: content.text.slice(0, TEXT_LIMIT), partial: content.partial || content.text.length > TEXT_LIMIT };
      const bytes = bounded.text.length * 2 + key.length * 2 + 128;
      entries.set(key, { content: bounded, bytes, expires: bounded.partial && !bounded.text ? Date.now() + 30_000 : Infinity }); size += bytes;
      while (entries.size > 2_000 || size > 16 * 1024 * 1024) remove(entries.keys().next().value!);
      return bounded;
    },
    clear() { entries.clear(); size = 0; }
  };
}

export function cancellableSearch<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { void operation.catch(() => undefined); reject(signal.reason); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
