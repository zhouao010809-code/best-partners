import { Worker } from 'node:worker_threads';
export type ParsedAttachment = { status: 'ready' | 'needs-ocr' | 'encrypted' | 'failed'; pages: { page: number; text: string }[]; parser: string; problem?: string };
export async function parseAttachment(bytes: Buffer, mediaType: string, signal: AbortSignal, workerPath?: string | URL): Promise<ParsedAttachment> {
  signal.throwIfAborted();
  if (mediaType !== 'application/pdf') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (bytes.length > 2 * 1024 * 1024) return { status: 'failed', pages: [], parser: 'utf8-v1', problem: '文字超过本次本地解析的 2 MiB 范围，原件已保留；请拆分后重试。' };
      return { status: text.trim() ? 'ready' : 'failed', pages: [{ page: 1, text }], parser: 'utf8-v1', ...(!text.trim() ? { problem: '文件没有可用文字，原件已保留。' } : {}) };
    } catch { return { status: 'failed', pages: [], parser: 'utf8-v1', problem: '文件不是有效的 UTF-8 文本，原件已保留。' }; }
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath ?? new URL('./pdf-worker.mjs', import.meta.url), { workerData: { bytes }, resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 } });
    let done = false;
    const finish = (result?: ParsedAttachment, error?: unknown) => {
      if (done) return; done = true; clearTimeout(timeout); signal.removeEventListener('abort', aborted); void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const aborted = () => finish(undefined, signal.reason ?? new Error('ATTACHMENT_CANCELLED'));
    const timeout = setTimeout(() => finish({ status: 'failed', pages: [], parser: 'pdfjs', problem: '本地 PDF 解析超时，原件已保留；可重试或拆分文件。' }), 60_000);
    signal.addEventListener('abort', aborted, { once: true });
    worker.once('message', (message: ParsedAttachment) => finish(message));
    worker.once('error', () => finish({ status: 'failed', pages: [], parser: 'pdfjs', problem: '本地 PDF 解析器未能完成，原件已保留，请重试。' }));
    worker.once('exit', () => { if (!done) finish({ status: 'failed', pages: [], parser: 'pdfjs', problem: '本地 PDF 解析中断，原件已保留。' }); });
    if (signal.aborted) aborted();
  });
}
