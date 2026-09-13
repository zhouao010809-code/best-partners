import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { getDocument, version } from 'pdfjs-dist/legacy/build/pdf.mjs';

const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
let task;
try {
  task = getDocument({ data: new Uint8Array(workerData.bytes), cMapUrl: join(pdfjsRoot, 'cmaps') + sep, cMapPacked: true, standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + sep, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0, stopAtErrors: true });
  const document = await task.promise;
  if (document.numPages > 2000) throw new Error('PDF_PAGE_LIMIT');
  const pages = []; let total = 0;
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      if (text && !/\s$/u.test(text) && item.str && !/^\s/u.test(item.str)) text += ' ';
      text += item.str;
      if (item.hasEOL) text += '\n';
    }
    text = text.trim(); total += Buffer.byteLength(text);
    if (total > 2 * 1024 * 1024) throw new Error('PDF_TEXT_LIMIT');
    pages.push({ page: number, text }); page.cleanup();
  }
  parentPort.postMessage({ status: pages.some(page => page.text.trim()) ? 'ready' : 'needs-ocr', pages, parser: `pdfjs-${version}` });
} catch (error) {
  parentPort.postMessage({ status: error?.name === 'PasswordException' ? 'encrypted' : 'failed', pages: [], parser: `pdfjs-${version}`, problem: error?.name === 'PasswordException' ? '这份 PDF 需要密码，请先在本机解锁后重新添加。原件已保留。' : ['PDF_PAGE_LIMIT', 'PDF_TEXT_LIMIT'].includes(error?.message) ? 'PDF 页数或可读文字超出本次本地解析范围，原件已保留；请拆分后重试。' : 'PDF 无法解析，可能已经损坏；原件已保留。' });
} finally { await task?.destroy(); }
