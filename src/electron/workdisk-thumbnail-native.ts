import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createNativeThumbnailRenderer(helper: URL | string) {
  const helperPath = helper instanceof URL ? fileURLToPath(helper) : helper;
  if (!isAbsolute(helperPath) || helperPath.includes('\0')) throw new Error('THUMBNAIL_HELPER_PATH_INVALID');
  return (fd: number, kind: 'image' | 'video', signal: AbortSignal): Promise<string | null> => new Promise(resolve => {
    if (signal.aborted) { resolve(null); return; }
    const child = spawn(helperPath, [kind], { shell: false, env: {}, stdio: ['ignore', 'pipe', 'ignore', fd] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const abort = () => { failed = true; child.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) abort();
      else if (!failed) chunks.push(chunk);
    });
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      const jpeg = Buffer.concat(chunks);
      resolve(failed || code !== 0 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 ? null : `data:image/jpeg;base64,${jpeg.toString('base64')}`);
    });
  });
}
